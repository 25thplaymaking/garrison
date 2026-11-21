"""Unit tests for the app-level realtime hub (topic pub/sub + authorization)."""
import os

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

import asyncio

import pytest

from services.realtime_hub import RealtimeHub, notify


class FakeWebSocket:
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def send_json(self, message):
        if self.fail:
            raise RuntimeError("socket dead")
        self.sent.append(message)


MEMBER = {"id": "u1", "role": "operator"}
STAFF = {"id": "u2", "role": "admin"}
ADMIN = {"id": "u3", "role": "admin"}
NOBODY = {"id": "u4", "role": "retired-role"}


class TestTopicAuthorization:
    def test_operator_can_subscribe_game(self):
        assert RealtimeHub.can_subscribe(MEMBER, "game")

    def test_unknown_role_cannot_subscribe_game(self):
        assert not RealtimeHub.can_subscribe(NOBODY, "game")

    def test_admin_can_subscribe_game(self):
        assert RealtimeHub.can_subscribe(ADMIN, "game")


    def test_unknown_topic_refused_for_everyone(self):
        assert not RealtimeHub.can_subscribe(ADMIN, "definitely-not-a-topic")

    def test_subscribe_partitions_ok_and_refused(self):
        hub = RealtimeHub()
        conn = hub.register(FakeWebSocket(), MEMBER)
        result = hub.subscribe(conn, ["game", "approvals", "nope"])
        assert result["ok"] == ["game"]
        assert sorted(result["refused"]) == ["approvals", "nope"]
        assert conn.topics == {"game"}


class TestPublish:
    @pytest.mark.asyncio
    async def test_publish_reaches_only_subscribers(self):
        hub = RealtimeHub()
        ws_sub, ws_other = FakeWebSocket(), FakeWebSocket()
        conn_sub = hub.register(ws_sub, STAFF)
        conn_other = hub.register(ws_other, STAFF)
        hub.subscribe(conn_sub, ["game"])
        hub.subscribe(conn_other, [])

        delivered = await hub.publish("game", "request_created", {"request_id": "r1"})

        assert delivered == 1
        assert ws_other.sent == []
        (message,) = ws_sub.sent
        assert message["topic"] == "game"
        assert message["event"] == "request_created"
        assert message["data"] == {"request_id": "r1"}
        assert "ts" in message

    @pytest.mark.asyncio
    async def test_dead_socket_is_dropped_and_others_still_delivered(self):
        hub = RealtimeHub()
        ws_dead, ws_live = FakeWebSocket(fail=True), FakeWebSocket()
        conn_dead = hub.register(ws_dead, MEMBER)
        conn_live = hub.register(ws_live, MEMBER)
        hub.subscribe(conn_dead, ["game"])
        hub.subscribe(conn_live, ["game"])

        delivered = await hub.publish("game", "rsvp_updated")

        assert delivered == 1
        assert len(ws_live.sent) == 1
        assert conn_dead not in hub._connections

    @pytest.mark.asyncio
    async def test_unregister_stops_delivery(self):
        hub = RealtimeHub()
        ws = FakeWebSocket()
        conn = hub.register(ws, MEMBER)
        hub.subscribe(conn, ["game"])
        hub.unregister(conn)
        assert await hub.publish("game", "changed") == 0

    def test_stats_counts_subscriptions(self):
        hub = RealtimeHub()
        conn = hub.register(FakeWebSocket(), STAFF)
        hub.subscribe(conn, ["approvals", "game"])
        stats = hub.stats()
        assert stats["connections"] == 1
        assert stats["subscriptions"] == {"game": 1}


class TestNotify:
    def test_notify_outside_event_loop_is_a_noop(self):
        # Mutation call sites must never crash in sync contexts (tests, scripts).
        notify("game", "changed", {"x": 1})

    @pytest.mark.asyncio
    async def test_notify_schedules_publish(self):
        from services import realtime_hub as module
        ws = FakeWebSocket()
        conn = module.hub.register(ws, MEMBER)
        module.hub.subscribe(conn, ["game"])
        try:
            notify("game", "rsvp_updated", {"operation_id": "op1"})
            await asyncio.sleep(0)  # let the scheduled task run
            assert len(ws.sent) == 1
            assert ws.sent[0]["event"] == "rsvp_updated"
        finally:
            module.hub.unregister(conn)
