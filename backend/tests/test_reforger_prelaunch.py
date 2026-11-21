"""Pre-launch script check: reading the engine's answer, and when it cannot be asked."""
import asyncio
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

from services import reforger_prelaunch as prelaunch  # noqa: E402

from tests.test_crash_analysis import make_addon  # noqa: E402

MODULE = " SCRIPT       : Module: Game; loaded 8478x files; 19600x classes; used 66185K of static memory\n"
OVER_LIMIT = MODULE + """ SCRIPT    (E): Virtual Machine Exception

Reason: NULL pointer to instance

Function: '#InitGlobals'
Stack trace:
 ENGINE    (E): Application crashed! Generated memory dump: /tmp/x.dmp
"""
STARTS = MODULE + "ENGINE       : Game successfully created.\n"
COMPILE_ERROR = """ SCRIPT    (E): @"Scripts/Game/A.c,14": Multiple declaration of class 'A'
 SCRIPT    (E): @"Scripts/Game/A.c,14": Multiple declaration of class 'A'
 SCRIPT    (E): @"Scripts/Game/B.c,9": Undefined function 'Keys.Find'
 SCRIPT    (E): Can't compile "Game" script module!
ENGINE    (E): Unable to initialize the game
"""
OTHER_CRASH = MODULE + """Reason: NULL pointer to instance

Function: 'OnPlayerSpawned'
 ENGINE    (E): Application crashed! Generated memory dump: /tmp/x.dmp
"""


def test_reads_each_engine_outcome():
    assert prelaunch.read_verdict(STARTS) == {
        "verdict": "starts", "script_files": 8478, "classes": 19600, "errors": [],
    }
    assert prelaunch.read_verdict(OVER_LIMIT)["verdict"] == "over_call_target_limit"
    assert prelaunch.read_verdict(OTHER_CRASH)["verdict"] == "crashed"
    assert prelaunch.read_verdict("GARRISON-NO-LOG\n")["verdict"] == "unknown"

    compile_error = prelaunch.read_verdict(COMPILE_ERROR)
    assert compile_error["verdict"] == "compile_error"
    assert compile_error["errors"] == [          # each error once, in order
        '@"Scripts/Game/A.c,14": Multiple declaration of class \'A\'',
        '@"Scripts/Game/B.c,9": Undefined function \'Keys.Find\'',
        'Can\'t compile "Game" script module!',
    ]


def test_check_script_runs_the_stock_engine_offline_with_the_whole_list():
    script = prelaunch.build_check_script(["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"])

    assert "./ArmaReforgerServer -server" in script          # the stock binary, never the patched copy
    assert ".calltargets18" not in script
    assert "-addons AAAAAAAAAAAAAAAA,BBBBBBBBBBBBBBBB" in script
    assert "-addonsDir /reforger/workshop/addons" in script
    assert "-config" not in script                           # never the live server's config


class FakeDocker:
    def __init__(self, output="", binary=b"engine", images=()):
        self.output, self.binary, self.images = output, binary, list(images)
        self.runs, self.commits, self.removed = [], [], []

    async def read_container_file(self, name, path, max_bytes):
        return self.binary

    async def image_exists(self, image):
        return image in self.images

    async def commit_container(self, name, repository, tag):
        self.commits.append((name, f"{repository}:{tag}"))
        self.images.append(f"{repository}:{tag}")
        return True, None

    async def list_image_tags(self, repository):
        return list(self.images)

    async def remove_image(self, image):
        self.removed.append(image)
        self.images.remove(image)

    async def run_once(self, **kwargs):
        self.runs.append(kwargs)
        return 0, self.output, None


def _server(tmp_path, mods):
    addons = tmp_path / "workshop" / "addons"
    addons.mkdir(parents=True)
    make_addon(addons, "Big_AAAAAAAAAAAAAAAA", name="Big", paths=["Scripts/Game/A.c"])
    return {
        "id": "srv-12345678", "container_name": "reforger-srv",
        "workshop_path": str(tmp_path / "workshop"), "profile_path": str(tmp_path / "profile"),
        "mods": mods,
    }


def test_a_check_snapshots_the_game_once_and_runs_offline_and_read_only(tmp_path, monkeypatch):
    docker = FakeDocker(output=OVER_LIMIT, images=["garrison-prelaunch:oldbuild00000000"])
    monkeypatch.setattr(prelaunch, "docker_agent", docker)
    server = _server(tmp_path, [{"modId": "AAAAAAAAAAAAAAAA", "name": "Big"}])

    async def scenario():
        first = await prelaunch.check_server(server)         # no snapshot of this game build yet
        await asyncio.gather(*prelaunch._snapshots_in_progress.values())
        return first, await prelaunch.check_server(server), await prelaunch.check_server(server)

    first, second, third = asyncio.run(scenario())

    assert first["verdict"] == "preparing"                      # told to come back, not left hanging
    assert second["verdict"] == "over_call_target_limit" and second["checked_mods"] == 1
    assert third["verdict"] == "over_call_target_limit"
    assert len(docker.commits) == 1                              # one snapshot per game build
    assert docker.removed == ["garrison-prelaunch:oldbuild00000000"]   # the previous build's is dropped
    run = docker.runs[0]
    assert run["image"] == docker.commits[0][1]
    assert {v["mode"] for v in run["volumes"].values()} == {"ro"}   # nothing of the server is writable
    assert "/reforger/workshop" in {v["bind"] for v in run["volumes"].values()}


def test_a_list_with_mods_not_downloaded_is_not_guessed_at(tmp_path, monkeypatch):
    docker = FakeDocker(output=STARTS)
    monkeypatch.setattr(prelaunch, "docker_agent", docker)
    server = _server(tmp_path, [
        {"modId": "AAAAAAAAAAAAAAAA", "name": "Big"},
        {"modId": "CCCCCCCCCCCCCCCC", "name": "Not here yet"},
    ])

    result = asyncio.run(prelaunch.check_server(server))

    assert result["verdict"] == "unavailable" and result["missing"] == ["Not here yet"]
    assert docker.runs == []


def test_no_game_install_anywhere_says_so(tmp_path, monkeypatch):
    docker = FakeDocker(binary=None)
    monkeypatch.setattr(prelaunch, "docker_agent", docker)
    server = _server(tmp_path, [{"modId": "AAAAAAAAAAAAAAAA", "name": "Big"}])

    result = asyncio.run(prelaunch.check_server(server))

    assert result["verdict"] == "unavailable" and "Start any server once" in result["reason"]
    assert docker.runs == []
