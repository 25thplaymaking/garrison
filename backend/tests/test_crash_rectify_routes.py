"""Crash-analysis routes: enrichment from the database and one-click fixes.

Rectify delegates to the existing routes (mod save, revision revert, file
delete, restart), so these tests patch those and pin what gets passed
through and what is refused against the live record.
"""
import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

import routes.servers as server_routes  # noqa: E402
import routes.servers_diagnosis as diag_routes  # noqa: E402
import routes.servers_files as file_routes  # noqa: E402

from tests.test_crash_analysis import SCENARIO_CONSOLE, make_addon, make_session  # noqa: E402

USER = {"id": "admin-1", "role": "admin"}


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, n):
        return self.rows[:n]


class _Coll:
    def __init__(self, rows=None, one=None):
        self.rows = rows or []
        self.one = one
        self.queries = []

    async def find_one(self, query, projection=None):
        return self.one

    def find(self, query=None, projection=None):
        self.queries.append(query)
        return _Cursor(self.rows)


@pytest.fixture
def env(monkeypatch, tmp_path):
    addons = tmp_path / "workshop" / "addons"
    addons.mkdir(parents=True)
    make_addon(addons, "Leftover_AAAAAAAAAAAAAAAA", name="Leftover")
    make_addon(addons, "Needed_BBBBBBBBBBBBBBBB", name="Needed")
    make_addon(addons, "Parent_CCCCCCCCCCCCCCCC", name="Parent", deps=["BBBBBBBBBBBBBBBB"])
    server = {
        "id": "srv",
        "name": "Fun Ops",
        "status": "crash_loop",
        "profile_path": str(tmp_path / "profile"),
        "workshop_path": str(tmp_path / "workshop"),
        "mods": [
            {"modId": "CCCCCCCCCCCCCCCC", "name": "Parent"},
            {"modId": "DDDDDDDDDDDDDDDD", "name": "Other", "version": "2.0.0"},
            {"modId": "EEEEEEEEEEEEEEEE", "name": "SAT", "system_managed": True},
        ],
    }
    db = SimpleNamespace(
        managed_servers=_Coll(one=server),
        workshop_mods=_Coll(rows=[{"mod_id": "69D6DB67983E6C2E", "name": "Freedom-Of-The-Zone-Map"}]),
        server_mod_revisions=_Coll(rows=[
            {"version": 58, "source": "mirror", "changed_at": "2026-10-08T00:10:02Z", "changed_by_name": "kestrel",
             "diff": {"removed": [{"mod_id": "69D6DB67983E6C2E", "name": "Freedom-Of-The-Zone-Map"}]}},
        ]),
    )
    monkeypatch.setattr(server_routes, "db", db)
    calls = SimpleNamespace(mods=None, restart=0, revert=None, delete=None, audits=[])

    async def fake_update(server_id, body, current_user):
        calls.mods = body.mods
        return {"message": "Mods updated", "count": len(body.mods)}

    async def fake_restart(server_id, current_user):
        calls.restart += 1
        return {"message": "restarting"}

    async def fake_revert(server_id, version, current_user):
        calls.revert = version
        return {"message": f"Reverted to revision {version}"}

    async def fake_delete(server_id, body, current_user):
        calls.delete = (body.root, body.paths)
        return {"deleted": body.paths}

    async def fake_audit(**kwargs):
        calls.audits.append(kwargs)

    monkeypatch.setattr(server_routes, "update_server_mods", fake_update)
    monkeypatch.setattr(server_routes, "restart_server", fake_restart)
    monkeypatch.setattr(server_routes, "revert_mod_revision", fake_revert)
    monkeypatch.setattr(file_routes, "delete_server_files", fake_delete)
    monkeypatch.setattr(diag_routes, "log_audit", fake_audit)
    return SimpleNamespace(server=server, db=db, calls=calls, root=tmp_path)


def rectify(**body):
    return asyncio.run(diag_routes.rectify_crash("srv", diag_routes.RectifyRequest(**body), current_user=USER))


def test_remove_mods_saves_the_filtered_list_then_restarts(env):
    result = rectify(type="remove_mods", mod_ids=["dddddddddddddddd"], restart=True)
    assert [m["modId"] for m in env.calls.mods] == ["CCCCCCCCCCCCCCCC", "EEEEEEEEEEEEEEEE"]
    assert env.calls.restart == 1
    assert result["ok"] is True
    assert env.calls.audits[0]["action_type"] == "server_crash_rectify"
    assert env.calls.audits[0]["after"]["removed"] == [{"mod_id": "DDDDDDDDDDDDDDDD", "name": "Other"}]


def test_remove_mods_refuses_ids_no_longer_listed_or_system_managed(env):
    with pytest.raises(HTTPException) as missing:
        rectify(type="remove_mods", mod_ids=["AAAAAAAAAAAAAAAA"])
    assert missing.value.status_code == 409
    with pytest.raises(HTTPException) as system:
        rectify(type="remove_mods", mod_ids=["EEEEEEEEEEEEEEEE"])
    assert system.value.status_code == 400
    assert env.calls.mods is None


def test_pin_version_sets_only_that_mod(env):
    rectify(type="pin_version", mod_id="CCCCCCCCCCCCCCCC", version="1.0.101")
    pinned = {m["modId"]: m.get("version") for m in env.calls.mods}
    assert pinned == {"CCCCCCCCCCCCCCCC": "1.0.101", "DDDDDDDDDDDDDDDD": "2.0.0", "EEEEEEEEEEEEEEEE": None}


def test_add_mods_appends_unpinned_entries_named_from_the_workshop(env):
    rectify(type="add_mods", mod_ids=["69D6DB67983E6C2E"])
    assert env.calls.mods[-1] == {"modId": "69D6DB67983E6C2E", "name": "Freedom-Of-The-Zone-Map"}


def test_delete_addon_only_removes_true_leftovers(env):
    rectify(type="delete_addon", mod_id="AAAAAAAAAAAAAAAA", folder="Leftover_AAAAAAAAAAAAAAAA")
    assert env.calls.delete == ("workshop", ["addons/Leftover_AAAAAAAAAAAAAAAA"])

    with pytest.raises(HTTPException) as needed:
        rectify(type="delete_addon", mod_id="BBBBBBBBBBBBBBBB", folder="Needed_BBBBBBBBBBBBBBBB")
    assert needed.value.status_code == 409  # a listed mod depends on it

    with pytest.raises(HTTPException) as traversal:
        rectify(type="delete_addon", mod_id="AAAAAAAAAAAAAAAA", folder="../Leftover_AAAAAAAAAAAAAAAA")
    assert traversal.value.status_code == 400


def test_unknown_action_is_rejected():
    with pytest.raises(ValueError):
        diag_routes.RectifyRequest(type="rm_rf")


def test_crash_analysis_route_enriches_with_the_revision_that_removed_the_scenario_mod(env):
    make_session(env.root / "profile" / "logs", "logs_2026-10-08_00-25-58", SCENARIO_CONSOLE)
    result = asyncio.run(diag_routes.get_crash_analysis("srv", session=None, current_user=USER))
    diagnosis = result["diagnosis"]
    assert diagnosis["primary"]["kind"] == "scenario_unavailable"
    revert = diagnosis["actions"][0]
    assert revert["type"] == "revert_revision" and revert["revision"] == 57
    assert "mirror" in revert["label"]
    add = next(a for a in diagnosis["actions"] if a["type"] == "add_mods")
    assert add["mod_ids"] == ["69D6DB67983E6C2E"]
    assert "logs_root" not in result


def test_an_older_removal_recommends_adding_the_mod_not_rolling_back(env):
    # Live case: the scenario mod was dropped by a revert days earlier and a
    # mirror has happened since; restoring that snapshot would discard it.
    env.db.server_mod_revisions.rows = [
        {"version": 58, "source": "mirror", "diff": {"removed": []}},
        {"version": 57, "source": "revert_to_v49", "changed_at": "2026-10-05T01:21:52Z",
         "diff": {"removed": [{"mod_id": "69D6DB67983E6C2E", "name": "Freedom-Of-The-Zone-Map"}]}},
    ]
    make_session(env.root / "profile" / "logs", "logs_2026-10-08_00-25-58", SCENARIO_CONSOLE)
    actions = asyncio.run(diag_routes.get_crash_analysis("srv", session=None, current_user=USER))["diagnosis"]["actions"]
    assert actions[0]["type"] == "add_mods"
    revert = next(a for a in actions if a["type"] == "revert_revision")
    assert revert["revision"] == 56
    assert "revert to revision 49" in revert["label"]
    assert "discards the 1 later mod change" in revert["detail"]


def test_crash_analysis_route_rejects_path_like_session_names(env):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(diag_routes.get_crash_analysis("srv", session="../../etc", current_user=USER))
    assert exc.value.status_code == 400
