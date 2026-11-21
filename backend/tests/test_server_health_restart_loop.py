"""Docker restart-loop detection in the server health monitor.

Docker's ``unless-stopped`` policy relaunches a dying Reforger container within
seconds, so the 15s poll sees it "running" and the exited-container crash path
never fires. A server once looped ~2,000 times over a week with the dashboard
reporting it healthy. These tests pin the RestartCount-based detector.
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

from services import server_health_monitor as mon  # noqa: E402

T0 = datetime(2026, 10, 4, 19, 0, tzinfo=timezone.utc)

LOG = "\n".join([
    "2026-10-04T19:31:06.1Z 19:31:06.100  RESOURCES (E): Wrong GUID/name for resource @\"{X}a.st\"",
    "2026-10-04T19:31:07.1Z 19:31:07.100  SCRIPT    (E): Multiple declaration of class 'ACE_AnimationTools'",
    "2026-10-04T19:31:07.2Z 19:31:07.200  SCRIPT    (E): Unknown type 'GTG_Walker_Extension'",
    "2026-10-04T19:32:07.1Z 19:32:07.100  SCRIPT    (E): Multiple declaration of class 'ACE_AnimationTools'",
    "2026-10-04T19:32:08.1Z 19:32:08.100 ENGINE       : Game destroyed.",
])


class _Coll:
    def __init__(self):
        self.updates, self.inserts = [], []

    async def update_one(self, query, update):
        self.updates.append((query, update))

    async def insert_one(self, doc):
        self.inserts.append(doc)

    async def find_one(self, query, projection=None, sort=None):
        return None


class _DB:
    def __init__(self):
        self.managed_servers = _Coll()
        self.server_incidents = _Coll()


@pytest.fixture
def env(monkeypatch):
    db = _DB()
    notified = []

    async def fake_logs(name, tail=200, since=None):
        return LOG

    async def fake_notify(server):
        notified.append(server)

    monkeypatch.setattr(mon, "db", db)
    monkeypatch.setattr(mon.docker_agent, "get_container_logs", fake_logs)
    monkeypatch.setattr(mon, "sync_server_notifications", fake_notify)
    mon._docker_restart_baseline.clear()
    yield db, notified
    mon._docker_restart_baseline.clear()


SERVER = {"id": "s1", "name": "Fun Ops", "status": "running"}


async def _tick(count, at):
    return await mon._check_docker_restart_loop(
        SERVER, "s1", "Fun Ops", "reforger-s1",
        {"running": True, "status": "running", "restart_count": count}, at,
    )


@pytest.mark.asyncio
async def test_rapid_docker_restarts_flag_crash_loop_with_engine_errors(env):
    db, notified = env
    assert await _tick(1950, T0) is False          # baseline, history ignored
    assert await _tick(1951, T0 + timedelta(minutes=1)) is False
    assert await _tick(1953, T0 + timedelta(minutes=3)) is True

    (_, update), = db.managed_servers.updates
    assert update["$set"]["status"] == "crash_loop"
    assert "ACE_AnimationTools" in update["$set"]["summary_message"]
    incident, = db.server_incidents.inserts
    assert incident["incident_type"] == "crash_loop"
    assert incident["severity"] == "critical"
    assert incident["evidence"][0].startswith("SCRIPT    (E): Multiple declaration")
    assert not any("Wrong GUID" in e for e in incident["evidence"])
    assert notified and notified[0]["status"] == "crash_loop"


@pytest.mark.asyncio
async def test_slow_restarts_outside_window_do_not_flag(env):
    db, _ = env
    assert await _tick(10, T0) is False
    assert await _tick(11, T0 + timedelta(minutes=10)) is False
    assert await _tick(12, T0 + timedelta(minutes=20)) is False  # window rebased
    assert await _tick(13, T0 + timedelta(minutes=25)) is False
    assert db.managed_servers.updates == []


@pytest.mark.asyncio
async def test_recreated_container_rebases_instead_of_flagging(env):
    db, _ = env
    assert await _tick(500, T0) is False
    assert await _tick(0, T0 + timedelta(minutes=1)) is False  # recreate resets count
    assert await _tick(1, T0 + timedelta(minutes=2)) is False
    assert db.managed_servers.updates == []


def test_summarize_engine_errors_dedupes_and_ranks():
    errors = mon.summarize_engine_errors(LOG)
    assert errors == [
        "SCRIPT    (E): Multiple declaration of class 'ACE_AnimationTools'",
        "SCRIPT    (E): Unknown type 'GTG_Walker_Extension'",
    ]


