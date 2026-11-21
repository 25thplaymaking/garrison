"""Cross-worker relay for the realtime hub.

Production runs uvicorn with two workers, and the hub's subscriptions are
process-local, so a hint published on worker A never used to reach a
WebSocket held by worker B — roughly half of all push hints were silently
lost. These tests cover the Mongo-backed relay that closes the gap: publish
inserts a TTL-bounded copy of the hint, and each worker's poller re-delivers
events that originated elsewhere.
"""

import asyncio
import copy
import os
from types import SimpleNamespace

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

import pytest

from services import realtime_hub as module
from services.realtime_hub import RealtimeHub


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


class ChainingRelayCollection:
    """Just enough Mongo for the relay: ordered _id inserts and $gt queries."""

    def __init__(self):
        self.documents = []
        self._next_id = 1

    async def insert_one(self, document):
        doc = copy.deepcopy(document)
        doc["_id"] = self._next_id
        self._next_id += 1
        self.documents.append(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    def find(self, query):
        after = query.get("_id", {}).get("$gt", 0)
        matched = [copy.deepcopy(d) for d in self.documents if d["_id"] > after]

        class _Cursor:
            def sort(self, *_args):
                return self

            async def to_list(self, _length):
                return matched

        return _Cursor()


class ChainingDB:
    def __init__(self):
        self.collections = {}

    def __getitem__(self, name):
        return self.collections.setdefault(name, ChainingRelayCollection())


MEMBER = {"id": "u1", "role": "operator"}


@pytest.fixture
def relay_db(monkeypatch):
    fake = ChainingDB()
    monkeypatch.setattr(module, "db", fake)
    monkeypatch.setattr(module, "_relay_enabled", True)
    yield fake
    # publish() schedules the insert as a background task; nothing else to undo


@pytest.mark.asyncio
async def test_publish_writes_hint_to_relay_when_enabled(relay_db):
    hub = RealtimeHub()
    delivered = await hub.publish("game", "rsvp_updated", {"operation_id": "op1"})
    await asyncio.sleep(0)  # let the fire-and-forget insert run

    assert delivered == 0  # no local subscribers
    docs = relay_db[module.RELAY_COLLECTION].documents
    assert len(docs) == 1
    assert docs[0]["topic"] == "game"
    assert docs[0]["event"] == "rsvp_updated"
    assert docs[0]["origin"] == module.WORKER_ID
    assert "created_at" in docs[0]


@pytest.mark.asyncio
async def test_publish_skips_relay_when_disabled(relay_db, monkeypatch):
    monkeypatch.setattr(module, "_relay_enabled", False)
    hub = RealtimeHub()
    await hub.publish("game", "rsvp_updated")
    await asyncio.sleep(0)

    assert relay_db[module.RELAY_COLLECTION].documents == []


@pytest.mark.asyncio
async def test_drain_delivers_foreign_events_to_local_subscribers(relay_db):
    ws = FakeWebSocket()
    conn = module.hub.register(ws, MEMBER)
    module.hub.subscribe(conn, ["game"])
    try:
        coll = relay_db[module.RELAY_COLLECTION]
        await coll.insert_one({
            "topic": "game", "event": "changed", "data": {"n": 1},
            "ts": "2026-07-30T00:00:00+00:00", "origin": "another-worker",
        })

        new_cursor = await module._drain_relay_once(0)

        assert new_cursor == 1
        assert len(ws.sent) == 1
        assert ws.sent[0] == {
            "topic": "game", "event": "changed",
            "data": {"n": 1}, "ts": "2026-07-30T00:00:00+00:00",
        }
    finally:
        module.hub.unregister(conn)


@pytest.mark.asyncio
async def test_drain_skips_own_origin_but_advances_cursor(relay_db):
    ws = FakeWebSocket()
    conn = module.hub.register(ws, MEMBER)
    module.hub.subscribe(conn, ["game"])
    try:
        coll = relay_db[module.RELAY_COLLECTION]
        await coll.insert_one({
            "topic": "game", "event": "mine", "data": {},
            "ts": "t", "origin": module.WORKER_ID,
        })
        await coll.insert_one({
            "topic": "game", "event": "theirs", "data": {},
            "ts": "t", "origin": "another-worker",
        })

        new_cursor = await module._drain_relay_once(0)

        # own event skipped (it was already delivered locally at publish
        # time), foreign event delivered, cursor past both
        assert new_cursor == 2
        assert [m["event"] for m in ws.sent] == ["theirs"]

        # a second drain from the new cursor re-delivers nothing
        assert await module._drain_relay_once(new_cursor) == new_cursor
        assert len(ws.sent) == 1
    finally:
        module.hub.unregister(conn)


@pytest.mark.asyncio
async def test_local_delivery_still_works_alongside_relay(relay_db):
    ws = FakeWebSocket()
    conn = module.hub.register(ws, MEMBER)
    module.hub.subscribe(conn, ["game"])
    try:
        delivered = await module.hub.publish("game", "changed", {"x": 1})
        await asyncio.sleep(0)

        assert delivered == 1
        assert len(ws.sent) == 1
        assert len(relay_db[module.RELAY_COLLECTION].documents) == 1
    finally:
        module.hub.unregister(conn)


@pytest.mark.asyncio
async def test_start_and_stop_relay_manage_the_poller(relay_db):
    module._relay_enabled = False
    module.start_relay()
    try:
        assert module._relay_enabled is True
        assert module._relay_task is not None
        assert not module._relay_task.done()
    finally:
        await module.stop_relay()
    assert module._relay_enabled is False
    assert module._relay_task is None
