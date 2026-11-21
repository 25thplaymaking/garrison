import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "x" * 48)
os.environ.setdefault("JWT_ALGORITHM", "HS256")

import routes.servers as server_routes  # noqa: E402
import services.reforger_orchestrator as orchestrator  # noqa: E402
import services.server_metrics_collector as metrics_service  # noqa: E402
from routes.servers import ModListUpdate  # noqa: E402
from services.reforger_orchestrator import ProvisioningError  # noqa: E402


class _ManagedServers:
    def __init__(self, server, *, fail_update=False):
        self.server = server
        self.fail_update = fail_update
        self.updates = []
        self.deleted = False

    async def find_one(self, query, projection=None):
        return self.server if query.get("id") == self.server["id"] else None

    async def update_one(self, query, update):
        self.updates.append(update)
        if self.fail_update:
            raise RuntimeError("database unavailable")
        return SimpleNamespace(modified_count=1)

    async def delete_one(self, query):
        self.deleted = True
        return SimpleNamespace(deleted_count=1)


class _NoopCollection:
    async def delete_many(self, query):
        return SimpleNamespace(deleted_count=0)


@pytest.mark.asyncio
async def test_delete_failure_keeps_retriable_server_record(monkeypatch):
    server = {"id": "srv-1", "name": "Server", "container_name": "arma-srv-1"}
    managed = _ManagedServers(server)
    fake_db = SimpleNamespace(
        managed_servers=managed,
        server_incidents=_NoopCollection(),
        server_backups=_NoopCollection(),
        server_schedules=_NoopCollection(),
        server_metrics=_NoopCollection(),
        server_notifications=_NoopCollection(),
        mod_download_history=_NoopCollection(),
    )
    monkeypatch.setattr(server_routes, "db", fake_db)
    monkeypatch.setattr(
        server_routes,
        "orchestrator_delete_server",
        AsyncMock(side_effect=ProvisioningError("deleting_container", "docker refused removal")),
    )
    monkeypatch.setattr(server_routes, "log_audit", AsyncMock())

    with pytest.raises(HTTPException) as exc_info:
        await server_routes.delete_server("srv-1", {"id": "operator"})

    assert exc_info.value.status_code == 502
    assert managed.deleted is False
    assert managed.updates[-1]["$set"]["status"] == "deletion_pending"
    assert managed.updates[-1]["$set"]["last_docker_error"] == "docker refused removal"


@pytest.mark.asyncio
async def test_orchestrator_delete_surfaces_container_failure(monkeypatch):
    monkeypatch.setattr(
        orchestrator.docker_agent,
        "remove_container",
        AsyncMock(return_value=(False, "daemon error")),
    )

    with pytest.raises(ProvisioningError, match="daemon error"):
        await orchestrator.delete_server({"container_name": "arma-srv-1"})


class _MetricsCursor:
    def __init__(self, rows):
        self.rows = rows
        self.direction = 1

    def sort(self, field, direction):
        self.direction = direction
        return self

    async def to_list(self, limit):
        rows = sorted(self.rows, key=lambda item: item["timestamp"], reverse=self.direction < 0)
        return rows[:limit]


class _MetricsCollection:
    def __init__(self, rows):
        self.rows = rows

    def find(self, query, projection=None):
        return _MetricsCursor(self.rows)


@pytest.mark.asyncio
async def test_raw_metrics_cap_returns_newest_samples_in_chronological_order(monkeypatch):
    start = datetime.now(timezone.utc) - timedelta(days=1)
    rows = [
        {"server_id": "srv-1", "timestamp": start + timedelta(seconds=index)}
        for index in range(10_005)
    ]
    monkeypatch.setattr(
        metrics_service,
        "db",
        SimpleNamespace(server_metrics=_MetricsCollection(rows)),
    )

    result = await metrics_service.get_metrics_range("srv-1", period="7d", resolution="raw")

    assert len(result) == 10_000
    assert result[0]["timestamp"] == rows[5]["timestamp"]
    assert result[-1]["timestamp"] == rows[-1]["timestamp"]
    assert result == sorted(result, key=lambda item: item["timestamp"])


def test_supplemental_warning_without_saved_readiness_stays_ready():
    normalized = server_routes._normalize_server_contract({
        "status": "provisioning_partial",
        "provisioning_warnings": [
            {"stage": "sat_discovery", "message": "SAT config not found"},
            {"stage": "profile_generation", "message": "Profile not found"},
        ],
    })

    assert normalized["status"] == "running"
    assert normalized["readiness_state"] == "ready"


@pytest.mark.asyncio
@pytest.mark.parametrize("resolution", ["raw", "1m", "5m", "1h"])
async def test_metrics_latest_is_raw_sample_not_chart_bucket(monkeypatch, resolution):
    stamp = datetime(2026, 9, 7, 5, 0)  # Mongo's naive UTC representation
    latest = {"server_id": "srv-1", "timestamp": stamp, "uptime_seconds": 1179,
              "player_count": 0, "server_fps": 59, "ai_count": 24}
    bucket = {"timestamp": stamp - timedelta(minutes=3), "avg_server_fps": 42}
    collection = SimpleNamespace(find_one=AsyncMock(return_value=latest))
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(
        managed_servers=_ManagedServers({"id": "srv-1", "status": "running"}),
        server_metrics=collection,
    ))
    monkeypatch.setattr(metrics_service, "get_metrics_range", AsyncMock(return_value=[bucket]))
    result = await server_routes.get_server_metrics("srv-1", "24h", resolution, {"role": "admin"})
    assert result["latest"]["uptime_seconds"] == 1179
    assert result["latest"]["server_fps"] == 59
    assert result["latest"]["player_count"] == 0
    assert result["latest"]["timestamp"].tzinfo == timezone.utc
    assert result["metrics"][0]["avg_server_fps"] == 42
    assert result["metrics"][0]["timestamp"].tzinfo == timezone.utc
    collection.find_one.assert_awaited_once_with({"server_id": "srv-1"}, {"_id": 0}, sort=[("timestamp", -1)])


@pytest.mark.asyncio
async def test_metrics_keeps_last_sample_when_selected_range_empty(monkeypatch):
    latest = {"uptime_seconds": 0}
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(
        managed_servers=_ManagedServers({"id": "srv-1", "status": "stopped"}),
        server_metrics=SimpleNamespace(find_one=AsyncMock(return_value=latest)),
    ))
    monkeypatch.setattr(metrics_service, "get_metrics_range", AsyncMock(return_value=[]))
    result = await server_routes.get_server_metrics("srv-1", "1h", "1m", {})
    assert result["metrics"] == []
    assert result["latest"] == latest
    assert result["server_status"] == "stopped"


def test_core_warning_without_saved_readiness_is_degraded():
    normalized = server_routes._normalize_server_contract({
        "status": "provisioning_partial",
        "provisioning_warnings": [
            {"stage": "readiness_check", "message": "Server never became ready"},
        ],
    })

    assert normalized["readiness_state"] == "degraded"


@pytest.mark.asyncio
async def test_mod_db_failure_restores_previous_runtime_config(monkeypatch, tmp_path):
    config_path = tmp_path / "server-config.json"
    config_path.write_text('{"old": true}', encoding="utf-8")
    server = {
        "id": "srv-1",
        "name": "Server",
        "config_path": str(config_path),
        "mods": [],
        "sat_enabled": False,

        "config": {"old": True},
    }
    managed = _ManagedServers(server, fail_update=True)
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=managed))
    monkeypatch.setattr(server_routes, "generate_reforger_config", lambda candidate: {"new": True})

    async def _write_new_config(candidate, config=None):
        config_path.write_text('{"new": true}', encoding="utf-8")
        return True, str(config_path)

    monkeypatch.setattr(server_routes, "write_config_file", _write_new_config)

    with pytest.raises(RuntimeError, match="database unavailable"):
        await server_routes.update_server_mods(
            "srv-1",
            ModListUpdate(mods=[]),
            {"id": "operator"},
        )

    assert config_path.read_text(encoding="utf-8") == '{"old": true}'


@pytest.mark.asyncio
async def test_get_server_reports_host_paths_for_the_overview(monkeypatch, tmp_path):
    profile = tmp_path / "srv-9" / "profile"
    profile.mkdir(parents=True)
    server = {
        "id": "srv-9", "name": "Server", "container_name": "reforger-srv-9",
        "profile_path": profile.as_posix(), "created_by": "user-1",
    }
    users = SimpleNamespace(find_one=AsyncMock(return_value={"username": "kestrel"}))
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=_ManagedServers(server), users=users))
    monkeypatch.setattr(server_routes, "_reconcile_server_sat_state", AsyncMock(side_effect=lambda doc: doc))
    monkeypatch.setattr(server_routes, "_enrich_mods_with_workshop_metadata", AsyncMock(side_effect=lambda doc: doc))

    response = await server_routes.get_server("srv-9", current_user={"role": "admin"})

    paths = response["troubleshooting"]
    assert paths["actual_container_name"] == "reforger-srv-9"
    assert paths["profile_directory"].endswith("srv-9/profile")
    assert paths["cd_target"] == paths["profile_directory"]
    assert "mounts" not in paths
    assert response["created_by_name"] == "kestrel"
    users.find_one.assert_awaited_once_with({"id": "user-1"}, {"_id": 0, "username": 1})