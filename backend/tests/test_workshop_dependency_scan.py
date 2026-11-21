"""Regression tests for the Workshop tab's dependency-resolution failures.

Three separate defects made dependency resolution look broken from the mods
workspace. Each is pinned here:

1. ``resolve-all-dependencies`` refetched every record older than six hours
   inline, one at a time, through the workshop rate limiter. A ~100-mod loadout
   took minutes, the browser gave up at its 30s timeout, and nginx logged the
   aborts as 499s. The scan must now serve stored records and stay inside its
   budget.
2. ``POST /servers/workshop/mod/{id}/refresh`` — the enrichment call the UI
   fires for a mod added from the Workshop tab — 404'd unless a record already
   existed, which is precisely what a freshly browsed mod does not have. The
   caller swallowed the 404, so new mods never got their dependency list.
3. ``_purge_stale_workshop_mods`` deleted every record not in a loadout on every
   save, wiping the tab's index (browsed mods, and dependencies, which are never
   in the loadout) and forcing the slow live refetch in (1).
"""
import time
import types

import pytest
from fastapi import HTTPException

from routes import servers as server_routes


# ── helpers ──────────────────────────────────────────────────────────────────


def _record(mod_id, *, deps=None, verified=True, hours_old=0, name=None, version="1.0.0"):
    from datetime import datetime, timedelta, timezone

    stamp = (datetime.now(timezone.utc) - timedelta(hours=hours_old)).isoformat()
    return {
        "mod_id": mod_id,
        "name": name or f"Mod {mod_id}",
        "version": version,
        "author": "Author",
        "thumbnail_url": f"https://example.invalid/{mod_id}.png",
        "dependencies": deps if deps is not None else [],
        "dependencies_verified": verified,
        "availability_status": "available",
        "last_fetched": stamp,
        "metadata_completeness": "full",
    }


class _FakeWorkshopMods:
    """Just enough of the motor collection for the resolve paths."""

    def __init__(self, records):
        self.records = {r["mod_id"]: dict(r) for r in records}
        self.refetch_queries = []

    async def find_one(self, query, projection=None):
        return self.records.get(query.get("mod_id"))

    def find(self, query, projection=None):
        ids = query.get("mod_id", {})
        if isinstance(ids, dict) and "$in" in ids:
            rows = [r for k, r in self.records.items() if k in set(ids["$in"])]
        else:
            rows = list(self.records.values())

        class _Cursor:
            def __init__(self, rows):
                self._rows = rows

            def __aiter__(self):
                self._it = iter(self._rows)
                return self

            async def __anext__(self):
                try:
                    return next(self._it)
                except StopIteration:
                    raise StopAsyncIteration

        return _Cursor(rows)

    async def delete_many(self, query):
        self.refetch_queries.append(query)
        return types.SimpleNamespace(deleted_count=3)


@pytest.fixture
def db_stub(monkeypatch):
    def _install(records, mods=None):
        collection = _FakeWorkshopMods(records)
        server = {"id": "srv-1", "mods": mods or []}
        monkeypatch.setattr(
            server_routes,
            "db",
            types.SimpleNamespace(
                workshop_mods=collection,
                managed_servers=types.SimpleNamespace(
                    find_one=_async_return(server),
                    find=lambda *a, **k: _async_return_list([]),
                ),
            ),
        )
        return collection

    monkeypatch.setattr(server_routes, "_schedule_workshop_backfill", lambda *a, **k: None)
    return _install


def _async_return(value):
    async def _inner(*args, **kwargs):
        return value

    return _inner


def _async_return_list(values):
    """Stand-in for a motor cursor: ``await find(...).to_list(None)``."""

    async def _to_list(limit=None):
        return values

    return types.SimpleNamespace(to_list=_to_list)


# ── 1. the scan must not refetch usable-but-stale records ────────────────────


@pytest.mark.asyncio
async def test_scan_serves_stale_usable_record_without_blocking(db_stub, monkeypatch):
    """A 30-hour-old record still answers the walk; no inline refetch."""
    stale = _record("A", deps=[{"mod_id": "B", "name": "Beta", "version": "2.0.0"}], hours_old=30)
    dep = _record("B", deps=[], verified=True, hours_old=30)
    db_stub([stale, dep], mods=[])

    refetches = []

    async def _no_fetch(mod_id, **kwargs):
        refetches.append(mod_id)
        raise AssertionError(f"_fetch_fresh_mod_record({mod_id}) must not be called")

    monkeypatch.setattr(server_routes, "_fetch_fresh_mod_record", _no_fetch)

    result = await server_routes.resolve_mod_dependencies(
        "srv-1",
        server_routes.ResolveDependenciesRequest(mod_id="A", existing_mod_ids=[]),
        current_user={"id": "u1"},
    )

    assert refetches == []
    assert [r["mod_id"] for r in result["resolved"]] == ["B", "A"]
    assert result["partial"] is False
    assert result["stale_count"] == 2
    assert all(r["metadata_stale"] is True for r in result["resolved"])


@pytest.mark.asyncio
async def test_scan_still_refetches_a_record_it_cannot_use(db_stub, monkeypatch):
    """An unverified empty dependency list is not usable — it would make the walk lie."""
    unusable = _record("A", deps=[], verified=False, hours_old=1)
    db_stub([unusable], mods=[])

    calls = []

    async def _fetch(mod_id, **kwargs):
        calls.append(mod_id)
        if mod_id != "A":
            return None
        return _record("A", deps=[{"mod_id": "B", "name": "Beta", "version": "2.0.0"}])

    monkeypatch.setattr(server_routes, "_fetch_fresh_mod_record", _fetch)

    result = await server_routes.resolve_mod_dependencies(
        "srv-1",
        server_routes.ResolveDependenciesRequest(mod_id="A", existing_mod_ids=[]),
        current_user={"id": "u1"},
    )

    assert "A" in calls, "an unusable record must be refetched"
    # Dependencies first, the requested mod last.
    assert [r["mod_id"] for r in result["resolved"]] == ["B", "A"]
    assert result["resolved"][1]["metadata_available"] is True


@pytest.mark.asyncio
async def test_scan_reports_partial_when_budget_is_spent(db_stub, monkeypatch):
    """Past the budget the walk returns what it has and flags itself incomplete."""
    db_stub([], mods=[])
    monkeypatch.setattr(server_routes, "_RESOLVE_SCAN_BUDGET_SECONDS", -1.0)
    monkeypatch.setattr(server_routes.time, "monotonic", lambda: time.time() + 10_000)

    async def _fetch(mod_id, **kwargs):
        raise AssertionError("no blocking fetch once the budget is spent")

    monkeypatch.setattr(server_routes, "_fetch_fresh_mod_record", _fetch)

    result = await server_routes.resolve_mod_dependencies(
        "srv-1",
        server_routes.ResolveDependenciesRequest(mod_id="Ghost", existing_mod_ids=[]),
        current_user={"id": "u1"},
    )

    assert result["partial"] is True
    assert result["unresolved_count"] == 1
    assert result["resolved"][0]["metadata_available"] is False


@pytest.mark.asyncio
async def test_resolve_all_stays_inside_the_budget_with_a_large_loadout(db_stub, monkeypatch):
    """A 120-mod loadout of stale records resolves without any inline refetch."""
    ids = [f"M{i:03d}" for i in range(120)]
    records = [
        _record(mod_id, deps=[{"mod_id": ids[i + 1], "name": f"Mod {ids[i + 1]}", "version": "1.0.0"}]
                if i + 1 < len(ids) else [], hours_old=48)
        for i, mod_id in enumerate(ids)
    ]
    db_stub(records, mods=[])

    async def _no_fetch(mod_id, **kwargs):
        raise AssertionError(f"must not refetch {mod_id} inline")

    monkeypatch.setattr(server_routes, "_fetch_fresh_mod_record", _no_fetch)

    started = time.monotonic()
    result = await server_routes.resolve_all_mod_dependencies(
        "srv-1",
        server_routes.ResolveAllDependenciesRequest(mod_ids=ids),
        current_user={"id": "u1"},
    )
    elapsed = time.monotonic() - started

    assert result["provider_count"] == len(ids) - 1, (
        "every mod but the leaf declares a dependency"
    )
    assert result["partial"] is False
    assert elapsed < 5.0, f"scan took {elapsed:.1f}s — it is refetching again"


# ── 2. the enrichment call must create the record it is asked about ──────────


@pytest.mark.asyncio
async def test_refresh_creates_record_for_a_mod_added_from_the_workshop_tab(db_stub, monkeypatch):
    """Browsing a mod leaves no cached record; refresh must not 404 on that."""
    collection = db_stub([], mods=[])
    assert collection.records == {}

    async def _fetch_mod_metadata(mod_id, force_refresh=False):
        return {
            **_record(mod_id, deps=[{"mod_id": "B", "name": "Beta", "version": "2.0.0"}]),
            "metadata_completeness": "full",
        }

    monkeypatch.setattr(
        "services.workshop_ingest.fetch_mod_metadata", _fetch_mod_metadata
    )

    result = await server_routes.refresh_workshop_mod("BrandNewMod", current_user={"id": "u1"})

    assert result["refreshed"] is True
    assert result["dependencies"] == [{"mod_id": "B", "name": "Beta", "version": "2.0.0"}]


@pytest.mark.asyncio
async def test_refresh_does_not_raise_for_an_unknown_record(db_stub, monkeypatch):
    """The old precondition raised HTTPException(404) before any fetch happened."""
    db_stub([], mods=[])

    async def _fetch_mod_metadata(mod_id, force_refresh=False):
        return None

    monkeypatch.setattr(
        "services.workshop_ingest.fetch_mod_metadata", _fetch_mod_metadata
    )

    try:
        result = await server_routes.refresh_workshop_mod("NopeMod", current_user={"id": "u1"})
    except HTTPException as exc:  # pragma: no cover - the regression we are fixing
        pytest.fail(f"refresh raised {exc.status_code} for a mod with no cached record")

    assert result["refreshed"] is False


# ── 3. the purge must not delete the tab's own index ─────────────────────────


class _PurgeWorkshopMods:
    def __init__(self, records=None):
        self.records = records or []
        self.deleted = None

    def find(self, query, projection=None):
        rows = list(self.records)

        class _Cursor:
            def __aiter__(self):
                self._it = iter(rows)
                return self

            async def __anext__(self):
                try:
                    return next(self._it)
                except StopIteration:
                    raise StopAsyncIteration

        return _Cursor()

    async def delete_many(self, query):
        self.deleted = query
        return types.SimpleNamespace(deleted_count=1)


@pytest.mark.asyncio
async def test_purge_only_touches_long_unused_records(monkeypatch):
    """Recently used records — every mod the tab is currently showing — survive."""
    # The loadout mod's own record names DEP1, so DEP1 is a dependency of a real
    # configuration even though it never appears in the loadout list.
    collection = _PurgeWorkshopMods([
        _record("LOADOUT1", deps=[{"mod_id": "DEP1", "name": "Dep One", "version": "1.0.0"}]),
    ])
    monkeypatch.setattr(
        server_routes,
        "db",
        types.SimpleNamespace(
            workshop_mods=collection,
            managed_servers=types.SimpleNamespace(
                find=lambda *a, **k: _async_return_list([{"mods": [{"mod_id": "LOADOUT1"}]}]),
            ),
        ),
    )

    await server_routes._purge_stale_workshop_mods()

    query = collection.deleted
    assert query is not None, "purge never ran"
    # Never in a loadout → previously deleted immediately; now age-gated.
    assert "$or" in query, "purge is not age-gated"
    rendered = repr(query)
    assert "last_fetched" in rendered
    # A dependency of a loadout mod must be protected from deletion.
    assert "DEP1" in query["mod_id"]["$nin"]
    assert "LOADOUT1" in query["mod_id"]["$nin"]
    assert query["metadata_locked"] == {"$ne": True}


@pytest.mark.asyncio
async def test_purge_skips_entirely_when_dependency_lookup_fails(monkeypatch):
    """Deleting with an unknown dependency set is the bug; better to purge nothing."""
    collection = _PurgeWorkshopMods()

    def _boom(*args, **kwargs):
        raise RuntimeError("mongo unavailable")

    monkeypatch.setattr(
        server_routes,
        "db",
        types.SimpleNamespace(
            workshop_mods=types.SimpleNamespace(find=_boom, delete_many=collection.delete_many),
            managed_servers=types.SimpleNamespace(
                find=lambda *a, **k: _async_return_list([{"mods": [{"mod_id": "LOADOUT1"}]}]),
            ),
        ),
    )

    await server_routes._purge_stale_workshop_mods()

    assert collection.deleted is None, "purged despite an incomplete protected set"
