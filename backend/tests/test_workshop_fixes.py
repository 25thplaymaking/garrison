"""Workshop fetching and mod-loadout defects found in live data (2026-10-08).

- Removed mods were re-fetched on every refresh pass (their tombstone never
  set ``last_fetched``) and every time their detail panel opened.
- The daily refresh re-scraped all ~4,450 cached records, starving
  interactive lookups of the shared Workshop rate limit, and restarted a full
  pass on every backend restart; dependencies of loadout mods were never
  fetched ahead of time.
- Blocked/private/unpublished flags on mods and dependencies were ignored,
  and pins below what a parent requires were never flagged, though both make
  the server's download fail with "assetDependenciesUnresolvable".
- Resolver order put a mod before its own dependencies.
- Mirroring could only be pushed from the source, and could silently drop the
  mod that ships the target's scenario.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

from routes import servers as server_routes  # noqa: E402
from services import workshop_ingest, workshop_proxy  # noqa: E402

USER = {"id": "admin-1", "role": "admin"}
NOW = datetime.now(timezone.utc)


def ago(**delta):
    return (NOW - timedelta(**delta)).isoformat()


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def sort(self, *args, **kwargs):
        return self

    def __aiter__(self):
        self._it = iter(self.rows)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration

    async def to_list(self, n=None):
        return self.rows if n is None else self.rows[:n]


def _matches(doc, query):
    for key, cond in (query or {}).items():
        value = doc
        for part in key.split("."):
            if isinstance(value, list):
                value = [v.get(part) if isinstance(v, dict) else None for v in value]
            else:
                value = (value or {}).get(part) if isinstance(value, dict) else None
        if isinstance(cond, dict):
            if "$in" in cond and value not in cond["$in"]:
                return False
            if "$nin" in cond and value in cond["$nin"]:
                return False
            if "$ne" in cond and value == cond["$ne"]:
                return False
            if "$regex" in cond:
                import re
                values = value if isinstance(value, list) else [value]
                if not any(re.search(cond["$regex"], v or "", re.I) for v in values):
                    return False
        elif value != cond:
            return False
    return True


class _Coll:
    def __init__(self, rows=()):
        self.rows = [dict(r) for r in rows]
        self.updates = []

    async def find_one(self, query, projection=None):
        return next((dict(r) for r in self.rows if _matches(r, query)), None)

    def find(self, query=None, projection=None):
        return _Cursor(dict(r) for r in self.rows if _matches(r, query))

    async def update_one(self, query, update, upsert=False):
        self.updates.append((query, update))
        for row in self.rows:
            if _matches(row, query):
                row.update(update.get("$set", {}))
                return
        if upsert:
            self.rows.append({**query, **update.get("$setOnInsert", {}), **update.get("$set", {})})


# ── refresh loop ───────────────────────────────────────────────────────────────


def test_tombstones_are_rechecked_weekly_not_every_pass():
    stale, tomb = ago(hours=24), ago(days=7)
    assert workshop_ingest.record_needs_refresh(None, stale, tomb) is True
    fresh_tomb = {"removed_from_workshop": True, "availability_checked_at": ago(days=1), "last_fetched": ago(days=1)}
    assert workshop_ingest.record_needs_refresh(fresh_tomb, stale, tomb) is False
    old_tomb = {"removed_from_workshop": True, "availability_checked_at": ago(days=8)}
    assert workshop_ingest.record_needs_refresh(old_tomb, stale, tomb) is True
    assert workshop_ingest.record_needs_refresh({"metadata_locked": True}, stale, tomb) is False
    assert workshop_ingest.record_needs_refresh({"last_fetched": ago(hours=30)}, stale, tomb) is True
    assert workshop_ingest.record_needs_refresh({"last_fetched": ago(hours=1)}, stale, tomb) is False


def test_removed_tombstone_records_its_fetch_time(monkeypatch):
    mods = _Coll()
    monkeypatch.setattr(workshop_ingest, "db", SimpleNamespace(workshop_mods=mods))
    asyncio.run(workshop_ingest._mark_mod_removed("AAAAAAAAAAAAAAAA", "not_found"))
    stored = mods.rows[0]
    assert stored["last_fetched"] and stored["removed_from_workshop"] is True
    assert stored["downloadable"] is False


def test_refresh_pass_covers_loadouts_and_their_dependencies_only(monkeypatch):
    servers = _Coll([{"mods": [{"modId": "AAAAAAAAAAAAAAAA"}]}])
    mods = _Coll([
        {"mod_id": "AAAAAAAAAAAAAAAA", "last_fetched": ago(hours=48), "dependencies": [{"mod_id": "BBBBBBBBBBBBBBBB"}]},
        # dependency with no record yet -> fetched ahead of time via the walk of B
        {"mod_id": "BBBBBBBBBBBBBBBB", "last_fetched": ago(hours=1), "dependencies": [{"mod_id": "CCCCCCCCCCCCCCCC"}]},
        # browsed, stale but complete -> not re-scraped
        {"mod_id": "DDDDDDDDDDDDDDDD", "last_fetched": ago(days=30)},
        # browsed and incomplete -> filled in (bounded)
        {"mod_id": "EEEEEEEEEEEEEEEE", "last_fetched": ago(days=30), "metadata_incomplete": True},
        # removed recently -> left alone
        {"mod_id": "FFFFFFFFFFFFFFFF", "removed_from_workshop": True, "metadata_incomplete": True,
         "availability_checked_at": ago(days=1)},
    ])
    monkeypatch.setattr(workshop_ingest, "db", SimpleNamespace(managed_servers=servers, workshop_mods=mods))
    fetched = []

    async def fake_fetch(mod_id, force_refresh=False):
        fetched.append(mod_id)

    async def no_sleep(_):
        return None

    monkeypatch.setattr(workshop_ingest, "fetch_mod_metadata", fake_fetch)
    monkeypatch.setattr(workshop_ingest.asyncio, "sleep", no_sleep)
    count = asyncio.run(workshop_ingest.run_refresh_pass(24))
    assert fetched == ["AAAAAAAAAAAAAAAA", "CCCCCCCCCCCCCCCC", "EEEEEEEEEEEEEEEE"]
    assert count == 3


def test_loop_resumes_its_schedule_after_a_restart(monkeypatch):
    state = _Coll([{"_id": "workshop_refresh_loop", "last_pass_at": NOW - timedelta(hours=20)}])
    monkeypatch.setattr(workshop_ingest, "db", SimpleNamespace(background_job_state=state))
    wait = asyncio.run(workshop_ingest._seconds_until_next_pass(24))
    assert 3.9 * 3600 < wait <= 4 * 3600


# ── workshop flags ─────────────────────────────────────────────────────────────


def _page(asset):
    return {"props": {"pageProps": {"asset": asset}}}


def test_detail_parser_keeps_availability_flags():
    parsed = workshop_proxy._parse_mod_details_from_json(_page({
        "id": "AAAAAAAAAAAAAAAA", "name": "Parent", "blocked": False, "private": True,
        "dependencies": [
            {"asset": {"id": "BBBBBBBBBBBBBBBB", "name": "Gone"}, "version": "1.0.0", "published": False, "blocked": True},
            {"asset": {"id": "CCCCCCCCCCCCCCCC", "name": "Fine"}, "version": "2.0.0", "published": True, "blocked": False},
        ],
    }))
    assert parsed["workshop_flags"]["private"] is True
    assert parsed["dependencies"][0]["unavailable"] == ["blocked", "unpublished"]
    assert "unavailable" not in parsed["dependencies"][1]
    normalized = workshop_ingest._normalize_metadata(parsed, "AAAAAAAAAAAAAAAA")
    assert normalized["downloadable"] is False


# ── validation ───────────────────────────────────────────────────────────────


def _validate(monkeypatch, records, mods):
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(
        managed_servers=_Coll([{"id": "srv"}]),
        mod_issues=_Coll(),
        workshop_mods=_Coll(records),
    ))
    body = server_routes.ModValidateRequest(mods=[server_routes.ModRef(**m) for m in mods])
    return asyncio.run(server_routes.validate_server_mods("srv", body, current_user=USER))


def test_pin_below_a_parents_requirement_is_a_conflict(monkeypatch):
    result = _validate(monkeypatch, [
        {"mod_id": "AAAAAAAAAAAAAAAA", "name": "Zombies", "dependencies": [{"mod_id": "BBBBBBBBBBBBBBBB", "version": "1.7.0"}]},
        {"mod_id": "BBBBBBBBBBBBBBBB", "name": "Creature Melee AI", "version": "1.9.0"},
        {"mod_id": "CCCCCCCCCCCCCCCC", "name": "Pinned Old", "version": "2.3.0"},
    ], [
        {"mod_id": "AAAAAAAAAAAAAAAA", "name": "Zombies"},
        {"mod_id": "BBBBBBBBBBBBBBBB", "name": "Creature Melee AI", "version": "1.3.0"},
        {"mod_id": "CCCCCCCCCCCCCCCC", "name": "Pinned Old", "version": "2.0.1"},
    ])
    by_type = {}
    for issue in result["issues"]:
        by_type.setdefault(issue["type"], []).append(issue)
    conflict = by_type["version_conflict"][0]
    assert conflict["mod_id"] == "BBBBBBBBBBBBBBBB"
    assert conflict["required_version"] == "1.7.0" and conflict["required_by"] == "AAAAAAAAAAAAAAAA"
    assert by_type["pinned_outdated"][0]["mod_id"] == "CCCCCCCCCCCCCCCC"
    assert result["blocking_count"] == 1


def test_unavailable_dependencies_are_found_down_the_tree(monkeypatch):
    result = _validate(monkeypatch, [
        {"mod_id": "AAAAAAAAAAAAAAAA", "name": "Overhaul", "dependencies": [{"mod_id": "BBBBBBBBBBBBBBBB", "name": "Mid"}]},
        {"mod_id": "BBBBBBBBBBBBBBBB", "name": "Mid", "dependencies": [
            {"mod_id": "CCCCCCCCCCCCCCCC", "name": "Private Dep", "unavailable": ["private"]},
            {"mod_id": "DDDDDDDDDDDDDDDD", "name": "Removed Dep"},
        ]},
        {"mod_id": "DDDDDDDDDDDDDDDD", "name": "Removed Dep", "removed_from_workshop": True},
        {"mod_id": "EEEEEEEEEEEEEEEE", "name": "Blocked", "downloadable": False, "workshop_flags": {"blocked": True}},
    ], [
        {"mod_id": "AAAAAAAAAAAAAAAA", "name": "Overhaul"},
        {"mod_id": "EEEEEEEEEEEEEEEE", "name": "Blocked"},
    ])
    unavailable = {(i["mod_id"], i.get("dependency_id")) for i in result["issues"] if i["type"] == "dependency_unavailable"}
    assert unavailable == {("BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC"), ("BBBBBBBBBBBBBBBB", "DDDDDDDDDDDDDDDD")}
    assert any(i["type"] == "not_downloadable" and i["mod_id"] == "EEEEEEEEEEEEEEEE" for i in result["issues"])


# ── resolver ───────────────────────────────────────────────────────────────


def test_dependency_first_order_places_every_mod_after_its_dependencies():
    entries = [
        {"mod_id": "ROOT", "dependencies": [{"mod_id": "A"}]},
        {"mod_id": "A", "dependencies": [{"mod_id": "B"}]},
        {"mod_id": "B", "dependencies": [{"mod_id": "A"}]},  # cycle is tolerated
        {"mod_id": "C", "dependencies": []},
    ]
    order = [e["mod_id"] for e in server_routes._dependency_first(entries, "ROOT")]
    assert order.index("B") < order.index("A") < order.index("ROOT")
    assert order[-1] == "ROOT" and set(order) == {"ROOT", "A", "B", "C"}


# ── details ────────────────────────────────────────────────────────────────


def test_details_serves_a_recent_tombstone_without_refetching(monkeypatch):
    tomb = {"mod_id": "AAAAAAAAAAAAAAAA", "removed_from_workshop": True, "availability_checked_at": ago(days=1)}
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(workshop_mods=_Coll([tomb])))
    calls = []

    async def fake_fetch(mod_id, force_refresh=False):
        calls.append(mod_id)
        return tomb

    monkeypatch.setattr(workshop_ingest, "fetch_and_store_mod", fake_fetch)
    result = asyncio.run(server_routes.get_workshop_mod_details("AAAAAAAAAAAAAAAA", refresh=False, current_user=USER))
    assert result["removed_from_workshop"] is True and calls == []


# ── mirror pull ─────────────────────────────────────────────────────────────


@pytest.fixture
def mirror_db(monkeypatch):
    source = {"id": "ops", "name": "Operations", "status": "running",
              "mods": [{"modId": "AAAAAAAAAAAAAAAA", "name": "Shared"}, {"modId": "BBBBBBBBBBBBBBBB", "name": "Ops Only"}]}
    target = {"id": "fun", "name": "Fun Ops", "status": "running", "sat_enabled": False,
              "config": {"game": {"scenarioId": "{14FA3E05012B3DEE}Missions/Freedom-Of-The-Zone-FIXXXXX.conf"}},
              "mods": [{"modId": "AAAAAAAAAAAAAAAA", "name": "Shared"}, {"modId": "69D6DB67983E6C2E", "name": "Freedom-Of-The-Zone-Map"}]}
    workshop = _Coll([{"mod_id": "69D6DB67983E6C2E", "name": "Freedom-Of-The-Zone-Map",
                       "scenarios": [{"scenario_id": "{14FA3E05012B3DEE}Missions/Freedom-Of-The-Zone-FIXXXXX.conf"}]}])
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=_Coll([source, target]), workshop_mods=workshop))
    return SimpleNamespace(source=source, target=target)


def test_preview_shows_the_diff_and_warns_about_the_scenario_mod(mirror_db):
    preview = asyncio.run(server_routes.preview_mod_mirror("fun", source_server_id="ops", current_user=USER))
    assert [m["mod_id"] for m in preview["diff"]["added"]] == ["BBBBBBBBBBBBBBBB"]
    assert [m["mod_id"] for m in preview["diff"]["removed"]] == ["69D6DB67983E6C2E"]
    warning = preview["scenario_warning"]
    assert warning and warning["providers"][0]["mod_id"] == "69D6DB67983E6C2E"
    assert "fail to start" in warning["message"]


def test_no_scenario_warning_when_the_provider_survives(mirror_db):
    mirror_db.source["mods"].append({"modId": "69D6DB67983E6C2E", "name": "Freedom-Of-The-Zone-Map"})
    preview = asyncio.run(server_routes.preview_mod_mirror("fun", source_server_id="ops", current_user=USER))
    assert preview["scenario_warning"] is None


def test_pull_delegates_to_the_gated_mirror_path(mirror_db, monkeypatch):
    captured = {}

    async def fake_mirror(source_id, body, current_user):
        captured.update(source=source_id, targets=body.target_server_ids, restart=body.restart_targets)
        return {"succeeded": 1}

    monkeypatch.setattr(server_routes, "mirror_server_mods", fake_mirror)
    body = server_routes.ModLoadoutPullRequest(source_server_id="ops", restart_target=True)
    assert asyncio.run(server_routes.pull_server_mods("fun", body, current_user=USER)) == {"succeeded": 1}
    assert captured == {"source": "ops", "targets": ["fun"], "restart": True}


def test_pull_from_itself_is_refused(mirror_db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        asyncio.run(server_routes.pull_server_mods(
            "fun", server_routes.ModLoadoutPullRequest(source_server_id="fun"), current_user=USER,
        ))
    assert exc.value.status_code == 400
