"""Root-cause analysis of Reforger boot failures (services.crash_analysis).

The dashboard used to surface the last or most frequent ``(E)`` line, which
for nearly every failed boot is the shutdown resource-leak report
(``ui/fonts/robotomono_msdf_28.edds``). These fixtures are trimmed copies of
real failed sessions from the live servers; each test pins that the cause,
the owning mod and the proposed fix come out right.
"""
import asyncio
import os
import struct
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

from services import addon_index, crash_analysis as ca  # noqa: E402
from services import server_health_monitor as mon  # noqa: E402

LEAK_TAIL = [
    "00:09:52.704 ENGINE    (E): Unable to initialize the game",
    "00:09:52.721 ENGINE       : Game destroyed.",
    "00:09:52.728 RESOURCES (E): ==== Resource leaks ====",
    "00:09:52.728 RESOURCES (E): ui/fonts/robotomono_msdf_28.edds   1",
]

COMPILE_CONSOLE = [
    "00:09:45.942 ENGINE       : CLI Params: -config /reforger/Configs/server-config.json",
    "00:09:50.646 BACKEND      : Required addons are ready to use.",
    "00:09:51.100  SCRIPT    (W): @\"scripts/Game/Workshop/SCR_AddonManager.c,876\": 'GetRefCount' is obsolete: Will be removed",
    "00:09:51.259  SCRIPT    (E): Can't compile \"Game\" script module!",
    "",
    "scripts/Game/Components/Awenzj_FlareRippleFireMode.c(25): Function 'Fire' is marked as override, but there is no function with this name in the base class",
    "00:09:51.331 ENGINE    (E): Cannot create game!",
    "00:09:51.331 ENGINE    (E): Addon loading failed {689910D4936BDF6C,C5CC273A68CA4908}",
] + LEAK_TAIL

COMPILE_CRASH_LOG = """
---------------------------------------------
Log /home/profile/logs/logs_2026-10-08_00-09-45/crash.log started at 2026-10-08 00:09:52 (2026-10-08 00:09:52 UTC)



------------------------------------
08.10 2026 00:09:52
Can't compile "Game" script module!

scripts/Game/Components/Awenzj_FlareRippleFireMode.c(25): Function 'Fire' is marked as override, but there is no function with this name in the base class

Runtime mode
CLI params: config /reforger/Configs/server-config.json backendlog  maxFPS 90
"""

SCENARIO_CONSOLE = [
    "00:26:03.910 BACKEND      : Required addons are ready to use.",
    "00:26:06.602    WORLD     (E): Unknown class 'SCR_ChimeraCharacter' at offset 21(0x15)",
    "00:26:06.753 BACKEND      : Loading dedicated server config.",
    "00:26:06.884 ENGINE    (E): Unable to read the mission header '{14FA3E05012B3DEE}Missions/Freedom-Of-The-Zone-FIXXXXX.conf'",
] + LEAK_TAIL

CONFIG_CONSOLE = [
    "08:08:43.922 BACKEND      : Loading dedicated server config.",
    "08:08:43.922  BACKEND      : JSON Schema Validation:",
    "08:08:43.922   BACKEND      : type error:",
    "08:08:43.922    BACKEND   (E): Param \"#/operating/disableNavmeshStreaming\" has an incorrect type. Expected \"array\", but the value is \"boolean\"",
    "08:08:43.922   BACKEND   (E): JSON is invalid!",
    "08:08:43.922  BACKEND   (E): There are errors in server config!",
    "08:08:43.922 BACKEND   (E): Unable to continue with a broken DS config! Shutdown!",
] + LEAK_TAIL

HEALTHY_CONSOLE = [
    "00:10:10.398 ENGINE       : Game successfully created.",
    "00:10:10.400 ENGINE       : Game destroyed.",
    "00:11:20.720    WORLD     (E): Unknown class 'SCR_ChimeraCharacter' at offset 21(0x15)",
    "00:11:32.161 BACKEND      : Server registered with address: 203.0.113.5:2001",
    "00:11:32.491 DEFAULT      : Entered online game state.",
    "02:12:01.315 ENGINE       : Game destroyed.",
    "02:12:01.371 RESOURCES (E): ==== Resource leaks ====",
    "02:12:01.371 RESOURCES (E): ui/fonts/robotomono_msdf_28.edds   1",
]

VME_CONSOLE = [
    "21:46:48.378        SCRIPT    (E): Virtual Machine Exception",
    "",
    "Reason: NULL pointer to instance",
    "",
    "Class:      'SCR_PlacingEditorComponent'",
    "Function: 'CreateEntityServer'",
    "Stack trace:",
    "Scripts/Game/Editor/Components/Editor/SCR_PlacingEditorComponent.c:528 Function CreateEntityServer",
    "Scripts/Game/Z/Editor/PO_EditorAuthority.c:547 Function CreateEntityServer",
    "22:21:17.900 WORLD        : UpdateEntities",
    "22:21:18.000 DEFAULT      : Entered online game state.",
]


def build_pak(paths):
    """Minimal FORM/PAC1 archive whose FILE chunk lists ``paths``."""
    tree: dict = {}
    for path in paths:
        node = tree
        parts = path.split("/")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = None

    def encode(name, node):
        raw = name.encode()
        if node is None:
            return bytes([1, len(raw)]) + raw + b"\0" * 24
        out = bytes([0, len(raw)]) + raw + struct.pack("<I", len(node))
        for key, child in node.items():
            out += encode(key, child)
        return out

    file_chunk = encode("", tree)
    body = (
        b"PAC1"
        + b"HEAD" + struct.pack(">I", 4) + b"\0\0\0\0"
        + b"DATA" + struct.pack(">I", 3) + b"abc"
        + b"FILE" + struct.pack(">I", len(file_chunk)) + file_chunk
    )
    return b"FORM" + struct.pack(">I", len(body)) + body


def make_addon(addons: Path, folder: str, *, paths=(), deps=(), name=None, version="1.0.0"):
    guid = folder.rsplit("_", 1)[1]
    root = addons / folder
    root.mkdir(parents=True)
    (root / "data.pak").write_bytes(build_pak(list(paths) or ["Prefabs/placeholder.et"]))
    dep_block = " ".join(f'"{d}"' for d in list(deps) + ["58D0FB3206B6F859"])
    (root / "addon.gproj").write_text(
        f'GameProject {{\n ID "x"\n GUID "{guid}"\n TITLE "{name or folder}"\n Dependencies {{\n  {dep_block}\n }}\n}}\n'
    )
    meta = '{"meta":{"id":"%s","name":"%s","versions":[{"version":"%s"}],"updatedAt":"2026-10-01T00:00:00Z"}}' % (
        guid, name or folder, version,
    )
    (root / "meta").write_bytes(b"\xef\xbb\xbf" + meta.encode())
    return root


def make_session(logs_root: Path, name: str, console, crash=None):
    session = logs_root / name
    session.mkdir(parents=True)
    (session / "console.log").write_text("\n".join(console) + "\n")
    if crash is not None:
        (session / "crash.log").write_text(crash)
    return session


@pytest.fixture
def world(tmp_path):
    addons = tmp_path / "workshop" / "addons"
    addons.mkdir(parents=True)
    make_addon(addons, "MH-60TweaksbyAwenzj_689910D4936BDF6C", name="Blackhawk Tweaks by Awenzj",
               paths=["scripts/Game/Components/Awenzj_FlareRippleFireMode.c"])
    # Same script under different case: the engine's spelling picks the copy used.
    make_addon(addons, "MH-60TweaksWCS8.3Fix_C5CC273A68CA4908", name="MH-60 Tweaks WCS 8.3 Fix",
               paths=["Scripts/Game/Components/Awenzj_FlareRippleFireMode.c"], deps=["689910D4936BDF6C"])
    make_addon(addons, "FreedomOfTheZoneMap_69D6DB67983E6C2E", name="Freedom-Of-The-Zone-Map",
               paths=["Missions/Freedom-Of-The-Zone-FIXXXXX.conf"])
    make_addon(addons, "ProjectOutbreakZombies_F1D4B9B5245B36ED", name="Project Outbreak Zombies",
               paths=["Scripts/Game/Z/Editor/PO_EditorAuthority.c"])
    mods = [
        {"modId": "689910D4936BDF6C", "name": "Blackhawk Tweaks"},
        {"modId": "C5CC273A68CA4908", "name": "MH-60 Fix"},
        {"modId": "F1D4B9B5245B36ED", "name": "Project Outbreak Zombies"},
    ]
    return SimpleNamespace(root=tmp_path, addons=addons, logs=tmp_path / "profile" / "logs", mods=mods)


def test_pak_index_lists_every_path(tmp_path):
    pak = tmp_path / "data.pak"
    pak.write_bytes(build_pak(["Scripts/Game/A.c", "Scripts/Game/Sub/B.c", "Prefabs/C.et"]))
    assert sorted(addon_index.read_pak_paths(pak)) == ["Prefabs/C.et", "Scripts/Game/A.c", "Scripts/Game/Sub/B.c"]
    (tmp_path / "junk.pak").write_bytes(b"not a pak")
    assert addon_index.read_pak_paths(tmp_path / "junk.pak") == []


def test_compile_error_beats_the_robotomono_leak_line(world):
    session = make_session(world.logs, "logs_2026-10-08_00-09-45", COMPILE_CONSOLE, COMPILE_CRASH_LOG)
    result = ca.analyze_session(session, addons_dir=world.addons, mods=world.mods)

    assert result["outcome"] == "failed_to_start"
    primary = result["primary"]
    assert primary["kind"] == "script_compile_error"
    assert primary["resources"] == ["scripts/Game/Components/Awenzj_FlareRippleFireMode.c"]
    assert primary["script_line"] == 25
    assert "robotomono" in result["noise_note"]
    # crash.log's "Log ... started at" banner is not a crash record.
    assert result["crash_records"] == 1
    assert not any(f["kind"] == "engine_crash" for f in result["findings"])

    # Lowercase "scripts/" in the log identifies the Awenzj copy, not the fix.
    assert [c["mod_id"] for c in result["culprits"]] == ["689910D4936BDF6C"]
    culprit = result["culprits"][0]
    assert culprit["name"] == "Blackhawk Tweaks by Awenzj"
    assert culprit["listed_dependents"] == [{"mod_id": "C5CC273A68CA4908", "name": "MH-60 Tweaks WCS 8.3 Fix"}]

    remove = next(a for a in result["actions"] if a["type"] == "remove_mods")
    # Removing only the culprit would not help: a listed dependent pulls it back in.
    assert remove["mod_ids"] == ["689910D4936BDF6C", "C5CC273A68CA4908"]
    assert result["actions"][-1]["type"] == "stop"


def test_rollback_offered_when_the_culprit_was_just_updated(world):
    console = ["00:04:59.164 BACKEND      : Updating 689910D4936BDF6C from 1.0.101 to 1.0.103"] + COMPILE_CONSOLE
    session = make_session(world.logs, "logs_2026-10-08_00-09-45", console, COMPILE_CRASH_LOG)
    result = ca.analyze_session(session, addons_dir=world.addons, mods=world.mods)
    pin = result["actions"][0]
    assert pin == {**pin, "type": "pin_version", "mod_id": "689910D4936BDF6C", "version": "1.0.101"}


def test_missing_scenario_proposes_restoring_its_mod(world):
    session = make_session(world.logs, "logs_2026-10-08_00-25-58", SCENARIO_CONSOLE)
    result = ca.analyze_session(session, addons_dir=world.addons, mods=world.mods)

    assert result["primary"]["kind"] == "scenario_unavailable"
    assert result["primary"]["scenario_id"].endswith("Freedom-Of-The-Zone-FIXXXXX.conf")
    assert [c["mod_id"] for c in result["culprits"]] == ["69D6DB67983E6C2E"]
    add = result["actions"][0]
    assert add["type"] == "add_mods" and add["mod_ids"] == ["69D6DB67983E6C2E"]
    assert any(a["type"] == "open_settings" and a["path"] == "game.scenarioId" for a in result["actions"])


def test_config_schema_error_names_the_parameter(tmp_path):
    session = make_session(tmp_path, "logs_2026-04-03_08-08-42", CONFIG_CONSOLE)
    result = ca.analyze_session(session)
    primary = result["primary"]
    assert primary["kind"] == "server_config_invalid"
    assert primary["config_params"][0]["path"] == "operating.disableNavmeshStreaming"
    assert result["actions"][0]["type"] == "open_settings"


def test_a_session_that_went_online_is_not_a_crash(tmp_path):
    session = make_session(tmp_path, "logs_2026-10-08_00-10-23", HEALTHY_CONSOLE)
    result = ca.analyze_session(session)
    assert result["outcome"] == "stopped"
    assert result["primary"] is None
    assert result["actions"] == []


def test_bootstrap_game_teardown_is_not_a_shutdown(tmp_path):
    # Every boot creates and destroys a bootstrap game before addons load.
    session = make_session(tmp_path, "logs_2026-10-08_00-04-02", HEALTHY_CONSOLE[:2])
    assert ca.analyze_session(session)["outcome"] == "ended_unexpectedly"


def test_vm_exception_blames_the_first_mod_frame_not_the_base_game(world):
    session = make_session(world.logs, "logs_2026-10-03_20-18-30", VME_CONSOLE)
    result = ca.analyze_session(session, addons_dir=world.addons, mods=world.mods)
    assert result["outcome"] == "stopped"
    assert result["primary"]["kind"] == "script_vm_exception"
    assert [c["mod_id"] for c in result["culprits"]] == ["F1D4B9B5245B36ED"]


def test_unresolvable_workshop_dependency_is_attributed(world):
    console = [
        '00:01:00.000 BACKEND   (E): [RestApi] ID:[4] TYPE:[WorkshopApi/GetDownloadListS2S] Error Code:400 - Bad Request, '
        'apiCode="workshopApi.assetDependenciesUnresolvable", uid="1-2", message="Dependencies of asset C5CC273A68CA4908 v. 1.0.0 couldn\'t be resolved"',
        "00:01:00.100 BACKEND   (E): 1 addons are not downloadable! Cannot start until they are removed from server config.",
    ] + LEAK_TAIL
    session = make_session(world.logs, "logs_2026-10-02_10-00-00", console)
    result = ca.analyze_session(session, addons_dir=world.addons, mods=world.mods)
    assert result["primary"]["kind"] == "workshop_unavailable"
    assert result["primary"]["mod_ids"] == ["C5CC273A68CA4908"]
    remove = next(a for a in result["actions"] if a["type"] == "remove_mods")
    assert remove["mod_ids"] == ["C5CC273A68CA4908"]


def test_diagnose_server_picks_latest_failure_and_flags_recovery(world):
    make_session(world.logs, "logs_2026-10-08_00-09-20", COMPILE_CONSOLE, COMPILE_CRASH_LOG)
    make_session(world.logs, "logs_2026-10-08_00-09-45", COMPILE_CONSOLE, COMPILE_CRASH_LOG)
    server = {
        "profile_path": str(world.root / "profile"),
        "workshop_path": str(world.root / "workshop"),
        "mods": world.mods,
    }
    result = ca.diagnose_server(server)
    diagnosis = result["diagnosis"]
    assert diagnosis["session"] == "logs_2026-10-08_00-09-45"
    assert diagnosis["repeat_count"] == 2
    assert diagnosis["stale"] is False
    assert [s["outcome"] for s in result["sessions"]] == ["failed_to_start", "failed_to_start"]

    make_session(world.logs, "logs_2026-10-08_00-10-09", HEALTHY_CONSOLE)
    recovered = ca.diagnose_server(server, running=True)
    assert recovered["sessions"][0]["outcome"] == "running"
    assert recovered["diagnosis"]["session"] == "logs_2026-10-08_00-09-45"
    assert recovered["diagnosis"]["stale"] is True

    with pytest.raises(FileNotFoundError):
        ca.diagnose_server(server, session="logs_2020-01-01_00-00-00")


def test_engine_error_summary_drops_leak_noise_and_ranks_cause_first():
    logs = "\n".join(
        f"2026-10-08T00:{i:02d}:00Z {line}"
        for i, line in enumerate(SCENARIO_CONSOLE * 3)
    )
    ranked = mon.summarize_engine_errors(logs)
    assert ranked[0].startswith("ENGINE    (E): Unable to read the mission header")
    assert not any("robotomono" in line or "Resource leaks" in line for line in ranked)


def test_health_monitor_names_the_cause_in_the_crash_loop_incident(world, monkeypatch):
    make_session(world.logs, "logs_2026-10-08_00-25-58", SCENARIO_CONSOLE)
    server = {
        "id": "fun-ops", "name": "Fun Ops",
        "profile_path": str(world.root / "profile"),
        "workshop_path": str(world.root / "workshop"),
        "mods": world.mods,
    }
    diagnosis = asyncio.run(mon.diagnose_failure(server))
    assert diagnosis["primary"]["kind"] == "scenario_unavailable"
    text = mon.describe_diagnosis(diagnosis)
    assert text.startswith("The configured scenario is not available")
    assert "Freedom-Of-The-Zone-Map (69D6DB67983E6C2E)" in text
    compact = mon.compact_diagnosis(diagnosis)
    assert compact["kind"] == "scenario_unavailable"
    assert compact["actions"][0]["type"] == "add_mods"
