"""A crash loop stops being reported once it is over.

The monitor used to watch only "running" and "starting" servers, so a server it
marked ``crash_loop`` was never looked at again. Docker kept relaunching the
container, the game often came up on its own, and the card, the critical
notification, the issue count and the open incident all kept saying "crash
loop" until someone restarted the server by hand. These tests pin the release.
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

from services import server_health_monitor as mon  # noqa: E402

NOW = datetime(2026, 10, 16, 20, 0, tzinfo=timezone.utc)
LOOP_TEXT = (
    "Docker restarted the container 3 times in 15 min (lifetime restarts: 3). "
    "The game exits during boot. Cause: A mod can't be downloaded from the Workshop."
)


def _matches(doc, query):
    for key, cond in query.items():
        value = doc.get(key)
        if isinstance(cond, dict):
            for op, arg in cond.items():
                if op == "$in" and value not in arg:
                    return False
                if op == "$lt" and not (value is not None and value < arg):
                    return False
                if op == "$exists" and (value is not None) != arg:
                    return False
        elif key == "$or":
            if not any(_matches(doc, sub) for sub in cond):
                return False
        elif value != cond:
            return False
    return True


class _Collection:
    def __init__(self, docs=None):
        self.docs = [dict(d) for d in docs or []]

    async def update_one(self, query, update):
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)

    async def update_many(self, query, update):
        n = 0
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                n += 1
        return SimpleNamespace(modified_count=n)


def _server(**over):
    server = {
        "id": "s1",
        "name": "Ops",
        "container_name": "reforger-s1",
        "status": "crash_loop",
        "readiness_state": "failed",
        "summary_message": LOOP_TEXT,
        "last_docker_error": LOOP_TEXT,
    }
    server.update(over)
    return server


def _loop_incident():
    seen = (NOW - timedelta(minutes=30)).isoformat()
    return {
        "id": "inc_loop",
        "server_id": "s1",
        "incident_type": "crash_loop",
        "status": "open",
        "auto_detected": True,
        "detected_at": seen,
        "last_detected_at": seen,
    }


@pytest.fixture
def env(monkeypatch):
    db = SimpleNamespace(managed_servers=_Collection(), server_incidents=_Collection())
    notified = []

    async def fake_notify(server):
        notified.append(server)

    monkeypatch.setattr(mon, "db", db)
    monkeypatch.setattr(mon, "sync_server_notifications", fake_notify)
    mon._docker_restart_baseline.clear()
    mon._incidents_checked_for_run.clear()
    yield SimpleNamespace(db=db, notified=notified)
    mon._docker_restart_baseline.clear()
    mon._incidents_checked_for_run.clear()


def _container(up_for, restart_count=40):
    return {
        "running": True,
        "status": "running",
        "started_at": (NOW - up_for).isoformat().replace("+00:00", "Z"),
        "restart_count": restart_count,
    }


async def _evaluate(server, status_info, at=NOW):
    await mon._evaluate_server(
        server, server["id"], server["name"], server["container_name"], server["status"],
        status_info, now=at,
    )


def test_the_monitor_keeps_watching_crash_looped_servers(monkeypatch):
    queries = []

    class _Servers:
        def find(self, query, *_args, **_kwargs):
            queries.append(query)
            return SimpleNamespace(to_list=lambda _n: _done([]))

    async def _done(value):
        return value

    async def stop(_seconds):
        raise asyncio.CancelledError

    monkeypatch.setattr(mon, "db", SimpleNamespace(managed_servers=_Servers()))
    monkeypatch.setattr(mon.asyncio, "sleep", stop)
    asyncio.run(mon.server_health_loop(check_interval=1))

    assert "crash_loop" in queries[0]["status"]["$in"]


def test_a_loop_that_stopped_restarting_is_cleared(env):
    env.db.managed_servers.docs.append(_server())
    env.db.server_incidents.docs.append(_loop_incident())

    asyncio.run(_evaluate(_server(), _container(timedelta(minutes=6))))

    (record,) = env.db.managed_servers.docs
    assert record["status"] == "running"
    assert record["readiness_state"] == "ready"
    assert record["summary_message"] == ""
    assert record["last_docker_error"] == ""
    # The critical "Server Requires Intervention" notification clears from this.
    assert env.notified and env.notified[-1]["status"] == "running"
    assert env.db.server_incidents.docs[0]["status"] == "resolved"


def test_a_container_that_just_relaunched_is_still_looping(env):
    env.db.managed_servers.docs.append(_server())
    env.db.server_incidents.docs.append(_loop_incident())

    asyncio.run(_evaluate(_server(), _container(timedelta(minutes=2))))

    (record,) = env.db.managed_servers.docs
    assert record["status"] == "crash_loop"
    assert record["summary_message"] == LOOP_TEXT
    assert env.notified == []
    assert env.db.server_incidents.docs[0]["status"] == "open"


def test_an_operator_action_in_the_meantime_wins(env):
    """The record changed after the poll read it; the release must not undo that."""
    env.db.managed_servers.docs.append(_server(status="stopped"))

    asyncio.run(_evaluate(_server(), _container(timedelta(minutes=6))))

    assert env.db.managed_servers.docs[0]["status"] == "stopped"
    assert env.notified == []


def test_loop_text_left_on_a_restarted_server_clears_after_a_stable_run(env):
    """Someone restarted it by hand; the old loop summary must not outlive the loop."""
    server = _server(status="running", readiness_state="ready")
    env.db.managed_servers.docs.append(server)

    asyncio.run(_evaluate(server, _container(timedelta(minutes=6))))

    (record,) = env.db.managed_servers.docs
    assert record["summary_message"] == ""
    assert record["last_docker_error"] == ""


def test_a_stable_run_keeps_messages_the_monitor_did_not_write(env):
    followup = "Server is operational, but follow-up stages need attention: sat_discovery"
    server = _server(
        status="running", readiness_state="ready",
        summary_message=followup, last_docker_error="Restart failed: port in use",
    )
    env.db.managed_servers.docs.append(server)

    asyncio.run(_evaluate(server, _container(timedelta(minutes=6))))

    (record,) = env.db.managed_servers.docs
    assert record["summary_message"] == followup
    assert record["last_docker_error"] == "Restart failed: port in use"
