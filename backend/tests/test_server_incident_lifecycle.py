"""Auto-detected server incidents: one open record per kind, closed on recovery.

A crash loop used to file a new critical incident every few minutes and none
were ever closed, so the server overview showed weeks-old failures as open.
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

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)


def _match_value(value, cond):
    if isinstance(cond, dict):
        for op, arg in cond.items():
            if op == "$in" and value not in arg:
                return False
            if op == "$lt" and not (value is not None and value < arg):
                return False
            if op == "$exists" and (value is not None) != arg:
                return False
        return True
    return value == cond


def _matches(doc, query):
    for key, cond in query.items():
        if key == "$or":
            if not any(_matches(doc, sub) for sub in cond):
                return False
        elif not _match_value(doc.get(key), cond):
            return False
    return True


class _Incidents:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    async def find_one(self, query, projection=None, sort=None):
        found = [d for d in self.docs if _matches(d, query)]
        if sort:
            key, direction = sort[0]
            found.sort(key=lambda d: str(d.get(key)), reverse=direction < 0)
        return dict(found[0]) if found else None

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def update_one(self, query, update):
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                for key, inc in update.get("$inc", {}).items():
                    doc[key] = doc.get(key, 0) + inc
                return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)

    async def update_many(self, query, update):
        n = 0
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                n += 1
        return SimpleNamespace(modified_count=n)


@pytest.fixture
def incidents(monkeypatch):
    store = _Incidents()
    monkeypatch.setattr(mon, "db", SimpleNamespace(server_incidents=store))
    return store


def _incident(kind="crash_loop", severity="critical", at=NOW, server_id="s1"):
    return {
        "id": f"inc_{kind}_{at.timestamp()}",
        "server_id": server_id,
        "incident_type": kind,
        "severity": severity,
        "title": f"{kind} on {server_id}",
        "description": f"seen at {at.isoformat()}",
        "status": "open",
        "detected_at": at.isoformat(),
        "auto_detected": True,
    }


def test_repeat_detections_fold_into_the_open_incident(incidents):
    first = asyncio.run(mon.record_auto_incident(_incident(at=NOW)))
    again = asyncio.run(mon.record_auto_incident(_incident(at=NOW + timedelta(minutes=10))))

    assert again == first
    (doc,) = incidents.docs
    assert doc["occurrences"] == 2
    assert doc["last_detected_at"] == (NOW + timedelta(minutes=10)).isoformat()
    assert doc["description"].endswith((NOW + timedelta(minutes=10)).isoformat())


def test_other_kinds_servers_and_closed_incidents_get_their_own_record(incidents):
    asyncio.run(mon.record_auto_incident(_incident(kind="crash_loop")))
    asyncio.run(mon.record_auto_incident(_incident(kind="startup_failure", severity="high")))
    asyncio.run(mon.record_auto_incident(_incident(server_id="s2")))
    incidents.docs[0]["status"] = "resolved"
    asyncio.run(mon.record_auto_incident(_incident(at=NOW + timedelta(hours=1))))

    assert len(incidents.docs) == 4


def test_recurrence_raises_but_never_lowers_severity(incidents):
    asyncio.run(mon.record_auto_incident(_incident(kind="crash", severity="high")))
    asyncio.run(mon.record_auto_incident(_incident(kind="crash", severity="critical", at=NOW + timedelta(minutes=1))))
    asyncio.run(mon.record_auto_incident(_incident(kind="crash", severity="medium", at=NOW + timedelta(minutes=2))))

    (doc,) = incidents.docs
    assert doc["severity"] == "critical"


def test_stable_run_resolves_only_incidents_from_before_this_start(incidents):
    started = NOW - timedelta(minutes=6)
    asyncio.run(mon.record_auto_incident(_incident(kind="crash_loop", at=NOW - timedelta(days=2))))
    asyncio.run(mon.record_auto_incident(_incident(kind="startup_failure", severity="high", at=NOW - timedelta(minutes=2))))
    manual = {**_incident(kind="performance", at=NOW - timedelta(days=1)), "auto_detected": False}
    incidents.docs.append(manual)

    resolved = asyncio.run(mon.resolve_recovered_incidents(
        "s1", {"running": True, "started_at": started.isoformat().replace("+00:00", "Z")}, NOW,
    ))

    assert resolved == 1
    by_kind = {d["incident_type"]: d for d in incidents.docs}
    assert by_kind["crash_loop"]["status"] == "resolved"
    assert by_kind["crash_loop"]["resolved_by"] == "system"
    assert by_kind["startup_failure"]["status"] == "open"
    assert by_kind["performance"]["status"] == "open"


def test_a_fresh_start_does_not_resolve_anything_yet(incidents):
    asyncio.run(mon.record_auto_incident(_incident(at=NOW - timedelta(days=2))))
    resolved = asyncio.run(mon.resolve_recovered_incidents(
        "s1", {"running": True, "started_at": (NOW - timedelta(minutes=1)).isoformat()}, NOW,
    ))
    assert resolved == 0
    assert incidents.docs[0]["status"] == "open"


def test_health_loop_skips_a_pass_while_docker_is_unreachable(monkeypatch):
    evaluated = []

    class _Servers:
        def find(self, *_args, **_kwargs):
            return SimpleNamespace(to_list=lambda _n: _async([{"id": "s1", "name": "Ops", "status": "running"}]))

    async def _async(value):
        return value

    async def ping():
        return False, "Docker client is not available"

    async def evaluate(*args, **kwargs):
        evaluated.append(args)

    async def stop_after_first_sleep(_seconds):
        raise asyncio.CancelledError

    monkeypatch.setattr(mon, "db", SimpleNamespace(managed_servers=_Servers()))
    monkeypatch.setattr(mon.docker_agent, "ping", ping)
    monkeypatch.setattr(mon, "_evaluate_server", evaluate)
    monkeypatch.setattr(mon.asyncio, "sleep", stop_after_first_sleep)

    asyncio.run(mon.server_health_loop(check_interval=1))

    assert evaluated == []
