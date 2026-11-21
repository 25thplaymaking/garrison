import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "x" * 48)
os.environ.setdefault("JWT_ALGORITHM", "HS256")

import routes.servers as server_routes  # noqa: E402
import services.workshop_ingest as workshop_ingest  # noqa: E402
import services.workshop_proxy as workshop_proxy  # noqa: E402
from models.server import ModLoadoutMirrorRequest  # noqa: E402
from routes.servers import ModJsonImportRequest, ModValidateRequest  # noqa: E402
from services.workshop_proxy import WorkshopModUnavailableError  # noqa: E402


class _WorkshopCollection:
    def __init__(self, existing=None):
        self.existing = existing
        self.update = None
        self.delete_filter = None

    async def find_one(self, query, projection=None):
        return self.existing

    async def update_one(self, query, update, **kwargs):
        self.update = update

    async def delete_many(self, query):
        self.delete_filter = query
        return SimpleNamespace(deleted_count=0)


class _ManagedServers:
    def __init__(self, servers):
        self.servers = {server["id"]: server for server in servers}
        self.updates = []

    async def find_one(self, query, projection=None):
        return self.servers.get(query.get("id"))

    async def update_one(self, query, update):
        self.updates.append((query, update))

    def find(self, query, projection=None):
        rows = list(self.servers.values())
        return SimpleNamespace(to_list=AsyncMock(return_value=rows))


def test_structured_next_not_found_page_is_authoritative_removed_signal():
    html = (
        '<html><script id="__NEXT_DATA__" type="application/json">'
        '{"props":{"pageProps":{}},"page":"/404","query":{}}'
        '</script></html>'
    )
    assert workshop_proxy._detail_page_reports_unavailable(html) is True
    assert workshop_proxy._detail_page_reports_unavailable(
        '<html><script id="__NEXT_DATA__">{"props":{"pageProps":{}}}</script></html>'
    ) is False


@pytest.mark.asyncio
async def test_refresh_metadata_does_not_update_created_at_twice(monkeypatch):
    workshop = _WorkshopCollection(existing={"mod_id": "626A8C89099C8F12"})
    monkeypatch.setattr(workshop_ingest, "db", SimpleNamespace(workshop_mods=workshop))
    monkeypatch.setattr(workshop_ingest, "_ws_get_cached", AsyncMock(return_value=None))
    monkeypatch.setattr(workshop_ingest, "_ws_set_cached", AsyncMock())
    monkeypatch.setattr(
        workshop_ingest,
        "_fetch_from_workshop",
        AsyncMock(return_value={
            "mod_id": "626A8C89099C8F12",
            "name": "Test Mod",
            "created_at": "2024-01-01T00:00:00Z",
        }),
    )

    await workshop_ingest.fetch_mod_metadata("626A8C89099C8F12")

    assert workshop.update is not None
    assert set(workshop.update.get("$set", {})).isdisjoint(workshop.update.get("$setOnInsert", {}))
    assert workshop.update["$set"]["created_at"] == "2024-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_authoritative_workshop_404_marks_mod_removed_without_erasing_metadata(monkeypatch):
    workshop = _WorkshopCollection(existing={
        "mod_id": "626A8C89099C8F12",
        "name": "Last Known Name",
        "version": "1.2.3",
        "dependencies": [{"mod_id": "DEPENDENCY"}],
    })
    monkeypatch.setattr(workshop_ingest, "db", SimpleNamespace(workshop_mods=workshop))
    monkeypatch.setattr(workshop_ingest, "_ws_get_cached", AsyncMock(return_value=None))
    monkeypatch.setattr(workshop_ingest, "_ws_set_cached", AsyncMock())
    monkeypatch.setattr(
        workshop_ingest,
        "_fetch_from_workshop",
        AsyncMock(side_effect=WorkshopModUnavailableError("626A8C89099C8F12")),
    )

    result = await workshop_ingest.fetch_mod_metadata(
        "626A8C89099C8F12", force_refresh=True
    )

    assert result["name"] == "Last Known Name"
    assert result["dependencies"] == [{"mod_id": "DEPENDENCY"}]
    assert result["removed_from_workshop"] is True
    assert result["availability_status"] == "removed"
    assert workshop.update["$set"]["removed_from_workshop"] is True
    assert "name" not in workshop.update["$set"]


@pytest.mark.asyncio
async def test_transient_workshop_failure_preserves_existing_availability_and_metadata(monkeypatch):
    existing = {
        "mod_id": "626A8C89099C8F12",
        "name": "Known Good Name",
        "version": "1.2.3",
        "availability_status": "available",
        "removed_from_workshop": False,
    }
    workshop = _WorkshopCollection(existing=existing)
    monkeypatch.setattr(workshop_ingest, "db", SimpleNamespace(workshop_mods=workshop))
    monkeypatch.setattr(workshop_ingest, "_ws_get_cached", AsyncMock(return_value=None))
    monkeypatch.setattr(workshop_ingest, "_ws_set_cached", AsyncMock())
    monkeypatch.setattr(
        workshop_ingest,
        "_fetch_from_workshop",
        AsyncMock(return_value=workshop_ingest._partial_record("626A8C89099C8F12")),
    )

    result = await workshop_ingest.fetch_mod_metadata(
        "626A8C89099C8F12", force_refresh=True
    )

    assert result["name"] == "Known Good Name"
    assert result["availability_status"] == "available"
    assert workshop.update["$set"].keys() == {
        "availability_checked_at", "availability_error"
    }


@pytest.mark.asyncio
async def test_successful_workshop_refresh_clears_removed_tombstone(monkeypatch):
    workshop = _WorkshopCollection(existing={
        "mod_id": "626A8C89099C8F12",
        "name": "Old Name",
        "removed_from_workshop": True,
        "availability_status": "removed",
        "removed_detected_at": "2026-01-01T00:00:00+00:00",
    })
    monkeypatch.setattr(workshop_ingest, "db", SimpleNamespace(workshop_mods=workshop))
    monkeypatch.setattr(workshop_ingest, "_ws_get_cached", AsyncMock(return_value=None))
    monkeypatch.setattr(workshop_ingest, "_ws_set_cached", AsyncMock())
    monkeypatch.setattr(
        workshop_ingest,
        "_fetch_from_workshop",
        AsyncMock(return_value=workshop_ingest._normalize_metadata(
            {"name": "Restored Name", "version": "2.0"},
            "626A8C89099C8F12",
        )),
    )

    result = await workshop_ingest.fetch_mod_metadata(
        "626A8C89099C8F12", force_refresh=True
    )

    assert result["removed_from_workshop"] is False
    assert workshop.update["$set"]["availability_status"] == "available"
    assert workshop.update["$set"]["removed_detected_at"] is None


@pytest.mark.asyncio
async def test_mod_validation_reports_removed_workshop_entry_without_deleting_it(monkeypatch):
    server = {"id": "server-1", "mods": [{"mod_id": "REMOVED", "name": "Gone Mod"}]}
    managed = _ManagedServers([server])

    class _CursorCollection:
        def __init__(self, rows):
            self.rows = rows

        def find(self, query, projection=None):
            return SimpleNamespace(to_list=AsyncMock(return_value=self.rows))

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(
            managed_servers=managed,
            mod_issues=_CursorCollection([]),
            workshop_mods=_CursorCollection([{
                "mod_id": "REMOVED",
                "name": "Gone Mod",
                "removed_from_workshop": True,
                "dependencies": [],
            }]),
        ),
    )

    result = await server_routes.validate_server_mods(
        "server-1",
        ModValidateRequest(mods=[{"mod_id": "REMOVED", "name": "Gone Mod"}]),
        current_user={"id": "u1"},
    )

    assert result["valid"] is False
    assert result["issues"][0]["type"] == "removed_from_workshop"
    assert "will not be deleted automatically" in result["issues"][0]["message"]
    assert managed.updates == []


@pytest.mark.asyncio
async def test_mirror_keeps_source_dependency_order_when_target_marks_mod_system_managed(monkeypatch):
    source = {
        "id": "source",
        "name": "Source",
        "mods": [
            {"mod_id": "DEPENDENCY", "name": "Dependency"},
            {"mod_id": "APPLICATION", "name": "Application"},
        ],
    }
    target = {
        "id": "target",
        "name": "Target",
        "sat_enabled": False,

        "mods": [{"mod_id": "APPLICATION", "name": "Application", "system_managed": True}],
    }
    managed = _ManagedServers([source, target])
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=managed))
    monkeypatch.setattr(server_routes, "write_config_file", AsyncMock(return_value=(True, "config.json")))
    monkeypatch.setattr(server_routes, "generate_reforger_config", lambda server: {"game": {}})
    monkeypatch.setattr(server_routes, "_sync_workshop_mod_metadata", AsyncMock())
    monkeypatch.setattr(server_routes, "_record_mod_revision", AsyncMock())
    monkeypatch.setattr(server_routes, "sync_server_notifications", AsyncMock())
    monkeypatch.setattr(server_routes, "log_audit", AsyncMock())

    result = await server_routes.mirror_server_mods(
        "source",
        ModLoadoutMirrorRequest(
            target_server_ids=["target"],
            preserve_system_managed=True,
            create_backups=False,
        ),
        current_user={"id": "u1", "username": "operator"},
    )

    assert result["succeeded"] == 1
    saved_mods = managed.updates[0][1]["$set"]["mods"]
    assert [mod["mod_id"] for mod in saved_mods] == ["DEPENDENCY", "APPLICATION"]
    assert saved_mods[1]["system_managed"] is True


@pytest.mark.asyncio
async def test_import_stores_required_system_mods(monkeypatch):
    server = {
        "id": "server-1",
        "name": "Primary",
        "sat_enabled": True,
        "mods": [],
    }
    managed = _ManagedServers([server])
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=managed))
    monkeypatch.setattr(server_routes, "write_config_file", AsyncMock(return_value=(True, "config.json")))
    monkeypatch.setattr(server_routes, "generate_reforger_config", lambda doc: {"game": {}})
    monkeypatch.setattr(server_routes, "_sync_workshop_mod_metadata", AsyncMock())
    monkeypatch.setattr(server_routes, "_record_mod_revision", AsyncMock())
    monkeypatch.setattr(server_routes, "log_audit", AsyncMock())

    await server_routes.import_mods_json(
        "server-1",
        ModJsonImportRequest(mods=[{"mod_id": "CUSTOM", "name": "Custom"}]),
        current_user={"id": "u1", "username": "operator"},
    )

    saved_mods = managed.updates[0][1]["$set"]["mods"]
    by_id = {mod.get("mod_id") or mod.get("modId"): mod for mod in saved_mods}
    assert list(by_id) == ["CUSTOM", server_routes.SERVER_SAT_REQUIRED_MOD_ID]
    assert by_id[server_routes.SERVER_SAT_REQUIRED_MOD_ID]["system_managed"] is True


@pytest.mark.asyncio
async def test_stale_workshop_purge_preserves_locked_metadata(monkeypatch):
    managed = _ManagedServers([{"id": "server-1", "mods": []}])
    workshop = _WorkshopCollection()
    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=managed, workshop_mods=workshop),
    )

    await server_routes._purge_stale_workshop_mods()

    assert workshop.delete_filter["metadata_locked"] == {"$ne": True}


@pytest.mark.asyncio
async def test_exact_mod_id_search_uses_direct_workshop_lookup(monkeypatch):
    import services.workshop_ingest as workshop_ingest_service
    import services.workshop_proxy as workshop_proxy

    direct_lookup = AsyncMock(return_value={
        "mod_id": "626A8C89099C8F12",
        "name": "Direct Match",
    })
    keyword_search = AsyncMock(return_value={"mods": [], "total": 0})
    monkeypatch.setattr(workshop_ingest_service, "fetch_mod_metadata", direct_lookup)
    monkeypatch.setattr(workshop_proxy, "search_workshop", keyword_search)

    result = await server_routes.search_workshop_live(
        q="626a8c89099c8f12",
        page=1,
        sort="popularity",
        tags=None,
        current_user={"id": "u1"},
    )

    direct_lookup.assert_awaited_once_with("626A8C89099C8F12")
    keyword_search.assert_not_awaited()
    assert result["mods"][0]["name"] == "Direct Match"


@pytest.mark.asyncio
async def test_live_search_results_are_added_to_local_workshop_index(monkeypatch):
    workshop = _WorkshopCollection(existing=None)
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(workshop_mods=workshop))

    await server_routes._index_workshop_search_results([
        {
            "mod_id": "626A8C89099C8F12",
            "name": "Indexed Mod",
            "author": "Author",
            "created_at": "2024-01-01T00:00:00Z",
        }
    ])

    assert workshop.update["$set"]["name"] == "Indexed Mod"
    assert workshop.update["$set"]["created_at"] == "2024-01-01T00:00:00Z"
    assert "indexed_at" in workshop.update["$setOnInsert"]
    assert set(workshop.update["$set"]).isdisjoint(workshop.update["$setOnInsert"])


@pytest.mark.asyncio
async def test_live_search_index_preserves_manual_and_overridden_metadata(monkeypatch):
    manual = _WorkshopCollection(existing={
        "mod_id": "626A8C89099C8F12",
        "name": "Curated Name",
        "metadata_source": "manual",
    })
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(workshop_mods=manual))

    await server_routes._index_workshop_search_results([
        {"mod_id": "626A8C89099C8F12", "name": "Live Name"}
    ])

    assert manual.update is None

    hybrid = _WorkshopCollection(existing={
        "mod_id": "626A8C89099C8F12",
        "name": "Curated Name",
        "manual_overrides": {"name": "Curated Name"},
    })
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(workshop_mods=hybrid))

    await server_routes._index_workshop_search_results([
        {
            "mod_id": "626A8C89099C8F12",
            "name": "Live Name",
            "thumbnail_url": "https://cdn.example/live.png",
        }
    ])

    assert hybrid.update["$set"]["name"] == "Curated Name"
    assert hybrid.update["$set"]["thumbnail_url"] == "https://cdn.example/live.png"
    assert hybrid.update["$set"]["metadata_source"] == "hybrid"


@pytest.mark.asyncio
async def test_live_search_index_cannot_overwrite_metadata_locked_after_its_read(monkeypatch):
    class _RacingWorkshopCollection:
        def __init__(self):
            self.doc = {
                "mod_id": "626A8C89099C8F12",
                "name": "Workshop Name",
                "metadata_source": "workshop",
                "metadata_locked": False,
            }
            self.update_applied = False
            self.update_query = None

        async def find_one(self, query, projection=None):
            snapshot = dict(self.doc)
            # Simulate an operator curating and locking this record immediately
            # after the indexer read it but before the indexer's write.
            self.doc.update({
                "name": "Curated Name",
                "metadata_source": "manual",
                "metadata_locked": True,
            })
            return snapshot

        async def update_one(self, query, update, upsert=False):
            self.update_query = query
            matches = self.doc.get("mod_id") == query.get("mod_id")
            if query.get("metadata_locked") == {"$ne": True}:
                matches = matches and self.doc.get("metadata_locked") is not True
            if query.get("metadata_source") == {"$ne": "manual"}:
                matches = matches and self.doc.get("metadata_source") != "manual"
            if matches:
                self.doc.update(update.get("$set") or {})
                self.update_applied = True

    workshop = _RacingWorkshopCollection()
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(workshop_mods=workshop))

    await server_routes._index_workshop_search_results([
        {"mod_id": "626A8C89099C8F12", "name": "New Live Name"}
    ])

    assert workshop.update_applied is False
    assert workshop.doc["name"] == "Curated Name"
    assert workshop.doc["metadata_locked"] is True


def test_workshop_thumbnail_backfill_bounds_tracking_and_task_fanout(monkeypatch):
    class _Task:
        def add_done_callback(self, callback):
            self.callback = callback

    created = []

    def fake_create_task(coro):
        coro.close()
        task = _Task()
        created.append(task)
        return task

    server_routes._workshop_backfill_attempts.clear()
    server_routes._workshop_backfill_active_ids.clear()
    server_routes._workshop_backfill_tasks.clear()
    attempted_at = server_routes.time.monotonic()
    server_routes._workshop_backfill_attempts.update({
        f"OLD-{index}": attempted_at
        for index in range(server_routes._WORKSHOP_BACKFILL_MAX_TRACKED + 20)
    })
    monkeypatch.setattr(server_routes.asyncio, "create_task", fake_create_task)

    server_routes._schedule_workshop_backfill({f"MOD-{index}" for index in range(50)})

    assert len(created) == server_routes._WORKSHOP_BACKFILL_MAX_IN_FLIGHT
    assert len(server_routes._workshop_backfill_active_ids) == server_routes._WORKSHOP_BACKFILL_MAX_IN_FLIGHT
    assert len(server_routes._workshop_backfill_attempts) <= server_routes._WORKSHOP_BACKFILL_MAX_TRACKED

    server_routes._workshop_backfill_attempts.clear()
    server_routes._workshop_backfill_active_ids.clear()
    server_routes._workshop_backfill_tasks.clear()


def test_workshop_thumbnail_backfill_allows_first_attempt_soon_after_process_start(monkeypatch):
    class _Task:
        def add_done_callback(self, callback):
            self.callback = callback

    created = []

    def fake_create_task(coro):
        coro.close()
        created.append(_Task())
        return created[-1]

    server_routes._workshop_backfill_attempts.clear()
    server_routes._workshop_backfill_active_ids.clear()
    server_routes._workshop_backfill_tasks.clear()
    monkeypatch.setattr(server_routes.time, "monotonic", lambda: 10.0)
    monkeypatch.setattr(server_routes.asyncio, "create_task", fake_create_task)

    server_routes._schedule_workshop_backfill({"FIRST-MOD"})

    assert len(created) == 1

    server_routes._workshop_backfill_attempts.clear()
    server_routes._workshop_backfill_active_ids.clear()
    server_routes._workshop_backfill_tasks.clear()
