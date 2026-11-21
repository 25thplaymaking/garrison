"""A downtime window's restore must run even if the schedule changed mid-window."""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services import schedule_executor  # noqa: E402

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)


class _Cursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, _n):
        return self.docs


def test_disabled_schedule_still_restores_its_stopped_server(monkeypatch):
    schedule = {
        "id": "sched-1", "server_id": "srv-1", "enabled": False, "action_type": "restart",
        "downtime_restore_at": NOW - timedelta(minutes=1),
    }
    queries = []

    def find(query, projection=None):
        queries.append(query)
        due = query.get("downtime_restore_at", {}).get("$lte")
        matches = due is not None and schedule["downtime_restore_at"] <= due and all(
            schedule.get(key) == value for key, value in query.items() if key != "downtime_restore_at"
        )
        return _Cursor([dict(schedule)] if matches else [])

    fake_db = SimpleNamespace(
        server_schedules=SimpleNamespace(find=find, update_one=AsyncMock()),
        managed_servers=SimpleNamespace(find_one=AsyncMock(return_value={"id": "srv-1", "name": "Ops"})),
    )
    start = AsyncMock(return_value={"status": "running"})
    monkeypatch.setattr(schedule_executor, "db", fake_db)
    monkeypatch.setattr(schedule_executor, "orchestrator_start_server", start)
    monkeypatch.setattr(schedule_executor, "_apply_server_update", AsyncMock())

    asyncio.run(schedule_executor._run_due_restores(NOW))

    start.assert_awaited_once()
    assert fake_db.server_schedules.update_one.await_count == 1
