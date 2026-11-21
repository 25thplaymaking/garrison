"""Script budget: script files per loaded mod, and what taking one off frees.

Host panels rank a server's mods by the number of ``.c`` files they ship.
The engine loads the mod list plus its dependencies (leftover folders stay
unloaded), so only that set counts.
"""
import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

import routes.servers as server_routes  # noqa: E402
import routes.servers_diagnosis as diag_routes  # noqa: E402
from services import addon_index  # noqa: E402

from tests.test_crash_analysis import make_addon  # noqa: E402

USER = {"id": "admin-1", "role": "admin"}


def scripts(prefix, n):
    return [f"Scripts/Game/{prefix}/S{i}.c" for i in range(n)] + [f"Prefabs/{prefix}.et"]


@pytest.fixture
def addons(tmp_path):
    root = tmp_path / "workshop" / "addons"
    root.mkdir(parents=True)
    make_addon(root, "Big_AAAAAAAAAAAAAAAA", name="Big", paths=scripts("big", 40), deps=["CCCCCCCCCCCCCCCC"])
    make_addon(root, "Small_BBBBBBBBBBBBBBBB", name="Small", paths=scripts("small", 5), deps=["DDDDDDDDDDDDDDDD"])
    make_addon(root, "OnlyBig_CCCCCCCCCCCCCCCC", name="Only Big needs me", paths=scripts("cc", 7))
    make_addon(root, "Shared_DDDDDDDDDDDDDDDD", name="Shared lib", paths=scripts("dd", 11))
    make_addon(root, "Also_EEEEEEEEEEEEEEEE", name="Also uses shared", paths=scripts("ee", 2), deps=["DDDDDDDDDDDDDDDD"])
    make_addon(root, "Leftover_FFFFFFFFFFFFFFFF", name="Leftover", paths=scripts("ff", 99))
    return root


LISTED = ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB", "EEEEEEEEEEEEEEEE", "1111111111111111"]


def rows_by_id(result):
    return {row["mod_id"]: row for row in result["mods"]}


def test_counts_only_what_the_list_loads(addons):
    result = addon_index.script_budget(addons, LISTED, {"1111111111111111": "Not downloaded"})
    rows = rows_by_id(result)
    assert "FFFFFFFFFFFFFFFF" not in rows  # leftover folder: the engine never loads it
    assert result["total_scripts"] == 40 + 5 + 7 + 11 + 2
    assert result["loaded_count"] == 6 and result["listed_count"] == 4
    assert result["dependency_count"] == 2 and result["missing_count"] == 1
    assert [row["mod_id"] for row in result["mods"]][:2] == ["AAAAAAAAAAAAAAAA", "DDDDDDDDDDDDDDDD"]
    missing = rows["1111111111111111"]
    assert missing["name"] == "Not downloaded" and not missing["downloaded"] and missing["own"] == 0


def test_taking_a_mod_off_frees_the_dependencies_only_it_needs(addons):
    rows = rows_by_id(addon_index.script_budget(addons, LISTED))
    assert rows["AAAAAAAAAAAAAAAA"]["own"] == 40
    assert rows["AAAAAAAAAAAAAAAA"]["frees"] == 47  # its private dependency goes too
    assert rows["BBBBBBBBBBBBBBBB"]["frees"] == 5   # the shared lib stays for "Also"


def test_a_shared_dependency_frees_every_mod_that_needs_it(addons):
    shared = rows_by_id(addon_index.script_budget(addons, LISTED))["DDDDDDDDDDDDDDDD"]
    assert not shared["listed"] and shared["own"] == 11
    assert {d["mod_id"] for d in shared["needed_by"]} == {"BBBBBBBBBBBBBBBB", "EEEEEEEEEEEEEEEE"}
    assert shared["frees"] == 11 + 5 + 2 and shared["frees_mods"] == 3


def test_script_counts_are_cached_until_the_pak_changes(addons, monkeypatch):
    folder = addons / "Small_BBBBBBBBBBBBBBBB"
    assert addon_index.count_scripts(folder) == 5
    calls = []
    real = addon_index.read_pak_paths
    monkeypatch.setattr(addon_index, "read_pak_paths", lambda pak: calls.append(pak) or real(pak))
    assert addon_index.count_scripts(folder) == 5 and calls == []


def test_route_reads_the_server_record(addons, monkeypatch, tmp_path):
    server = {
        "id": "srv", "status": "running", "workshop_path": str(tmp_path / "workshop"),
        "mods": [{"modId": m, "name": m} for m in LISTED],
    }

    class Coll:
        async def find_one(self, query, projection=None):
            return server if query.get("id") == "srv" else None

    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=Coll()))
    result = asyncio.run(diag_routes.get_script_budget("srv", current_user=USER))
    assert result["total_scripts"] == 65 and result["server_status"] == "running"
    with pytest.raises(HTTPException) as exc:
        asyncio.run(diag_routes.get_script_budget("nope", current_user=USER))
    assert exc.value.status_code == 404


CRASH_LOG = """Unhandled exception

Reason: NULL pointer to instance

Function: '#InitGlobals'
Stack trace:
scripts/Game/UI/HUD/AvailableActions/Conditions/Game/Character/SCR_CharacterHasGadgetInHandCondition.c:9 Function #InitGlobals
"""


def _budget(monkeypatch, addons, **server_fields):
    server = {"id": "srv", "status": "error", "mods": [], "workshop_path": str(addons.parent),
              "profile_path": str(addons.parent.parent / "profile"), **server_fields}

    class Coll:
        async def find_one(self, query, projection=None):
            return server

    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=Coll()))
    return asyncio.run(diag_routes.get_script_budget("srv", current_user=USER))["call_target_limit"]


def _session(addons, name, crash_text=None):
    session = addons.parent.parent / "profile" / "logs" / name
    session.mkdir(parents=True)
    (session / "console.log").write_text("ENGINE : Game successfully created.\n", encoding="utf-8")
    if crash_text is not None:
        (session / "crash.log").write_text(crash_text, encoding="utf-8")


def test_reports_a_start_that_died_at_the_call_target_limit(monkeypatch, addons):
    _session(addons, "logs_2026-11-18_10-00-00")
    _session(addons, "logs_2026-11-19_01-51-38", CRASH_LOG)

    limit = _budget(monkeypatch, addons)

    assert limit == {
        "patch_enabled": False, "limit": 131072, "stock_limit": 131072, "patched_limit": 262144,
        "hit": True, "hit_session": "logs_2026-11-19_01-51-38",
    }


def test_only_the_newest_start_counts_and_other_crashes_do_not(monkeypatch, addons):
    _session(addons, "logs_2026-11-18_10-00-00", CRASH_LOG)
    _session(addons, "logs_2026-11-19_02-00-00", "Reason: NULL pointer to instance\n\nFunction: 'OnPlayerSpawned'\n")

    limit = _budget(monkeypatch, addons, script_limit_patch=True)

    assert limit["hit"] is False and limit["hit_session"] is None
    assert limit["patch_enabled"] is True and limit["limit"] == 262144


def test_fix_button_saves_the_switch_through_the_gated_update_then_restarts(monkeypatch):
    calls = []

    async def update_server(server_id, body, current_user):
        calls.append(("update", server_id, body.model_dump(exclude_unset=True)))
        return {"ok": True}

    async def restart_server(server_id, current_user):
        calls.append(("restart", server_id))
        return {"ok": True}

    monkeypatch.setattr(server_routes, "update_server", update_server)
    monkeypatch.setattr(server_routes, "restart_server", restart_server)

    result = asyncio.run(diag_routes.set_script_limit_patch(
        "srv", diag_routes.ScriptLimitRequest(enabled=True), current_user=USER,
    ))

    assert calls == [("update", "srv", {"script_limit_patch": True}), ("restart", "srv")]
    assert result == {"ok": True, "script_limit_patch": True, "restart": {"ok": True}}


