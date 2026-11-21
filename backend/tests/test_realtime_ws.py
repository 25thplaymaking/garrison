"""Protocol tests for the /ws/realtime endpoint (auth, HELLO, SUBSCRIBE, PING)."""
import os

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault(
    "JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32-byte-minimum"
)

import jwt as pyjwt
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from middleware import ws_auth
from routes.realtime import router as realtime_router


class _FakeUsers:
    def __init__(self, user):
        self.user = user

    async def find_one(self, query, projection=None):
        if self.user and query.get("id") == self.user["id"]:
            return dict(self.user)
        return None


class _FakeDB:
    def __init__(self, user):
        self.users = _FakeUsers(user)


def _client_and_token(monkeypatch, user):
    monkeypatch.setattr(ws_auth, "db", _FakeDB(user))
    app = FastAPI()
    app.include_router(realtime_router, prefix="/api")
    token = pyjwt.encode(
        {"sub": user["id"], "tv": 0}, os.environ["JWT_SECRET"], algorithm="HS256"
    )
    return TestClient(app), token


MEMBER = {"id": "user-1", "role": "retired-role", "is_active": True}
STAFF = {"id": "user-2", "role": "operator", "is_active": True}


def test_unauthenticated_connection_is_rejected(monkeypatch):
    client, _ = _client_and_token(monkeypatch, MEMBER)
    # The handshake must complete so the browser receives close code 4001 (its
    # stop-reconnecting signal). A close before accept becomes an HTTP 403 at
    # the ASGI server and reaches the browser as 1006, which it retries forever.
    with client.websocket_connect("/api/ws/realtime") as ws:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            ws.receive_json()
    assert excinfo.value.code == 4001


def test_invalid_token_is_closed_with_4001_after_accept(monkeypatch):
    client, _ = _client_and_token(monkeypatch, MEMBER)
    with client.websocket_connect("/api/ws/realtime?token=not-a-jwt") as ws:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            ws.receive_json()
    assert excinfo.value.code == 4001


def test_hello_lists_only_authorized_topics(monkeypatch):
    client, token = _client_and_token(monkeypatch, MEMBER)
    with client.websocket_connect(f"/api/ws/realtime?token={token}") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "HELLO"
        assert hello["topics"] == []  # an unknown role may subscribe to nothing


def test_subscribe_partitions_and_ping_pong(monkeypatch):
    client, token = _client_and_token(monkeypatch, STAFF)
    with client.websocket_connect(f"/api/ws/realtime?token={token}") as ws:
        ws.receive_json()  # HELLO
        ws.send_json({"type": "SUBSCRIBE", "topics": ["game", "approvals"]})
        result = ws.receive_json()
        assert result["type"] == "SUBSCRIBED"
        assert result["ok"] == ["game"]
        assert result["refused"] == ["approvals"]

        ws.send_json({"type": "PING"})
        assert ws.receive_json() == {"type": "PONG"}


def test_staff_receives_published_event_after_subscribe(monkeypatch):
    from services.realtime_hub import hub

    client, token = _client_and_token(monkeypatch, STAFF)

    async def _publish():
        return await hub.publish("game", "request_created", {"request_id": "r1"})

    # Enter the client context so a portal to the app's event loop exists.
    with client, client.websocket_connect(f"/api/ws/realtime?token={token}") as ws:
        ws.receive_json()  # HELLO
        ws.send_json({"type": "SUBSCRIBE", "topics": ["game"]})
        assert ws.receive_json()["ok"] == ["game"]

        delivered = client.portal.call(_publish)
        assert delivered == 1

        message = ws.receive_json()
        assert message["topic"] == "game"
        assert message["event"] == "request_created"
        assert message["data"] == {"request_id": "r1"}
