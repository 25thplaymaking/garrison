"""Security regression tests for server log and RCON WebSockets."""

import asyncio
import contextlib
import json
from unittest.mock import AsyncMock

import jwt
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from config import JWT_ALGORITHM, JWT_SECRET
from middleware import ws_auth
from routes import servers as _servers  # Load compatibility re-exports before submodule import.
from routes import servers_ws


class _FakeCollection:
    def __init__(self, result=None):
        self.result = result

    async def find_one(self, query, projection=None):
        if self.result and query.get("id") == self.result.get("id"):
            return dict(self.result)
        return None


class _FakeDB:
    def __init__(self, user, server=None):
        self.users = _FakeCollection(user)
        self.managed_servers = _FakeCollection(server)


@pytest.mark.parametrize("path", ["logs", "rcon"])
@pytest.mark.parametrize("credential", ["purpose", "inactive"])
def test_server_websockets_reject_non_session_or_inactive_users_before_rcon(
    monkeypatch, path, credential
):
    user = {
        "id": "admin-1",
        "role": "admin",
        "is_active": credential != "inactive",
    }
    fake_db = _FakeDB(user)
    monkeypatch.setattr(ws_auth, "db", fake_db)
    monkeypatch.setattr(servers_ws, "db", fake_db)
    execute = AsyncMock(return_value=(True, "ok"))
    monkeypatch.setattr(servers_ws.bercon_client, "execute", execute)

    claims = {"sub": user["id"]}
    if credential == "purpose":
        claims["purpose"] = "verify_email"
    token = jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALGORITHM)

    app = FastAPI()
    app.include_router(servers_ws.router, prefix="/api")
    client = TestClient(app)

    with client.websocket_connect(f"/api/ws/servers/srv-1/{path}?token={token}") as websocket:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            websocket.receive_json()

    assert excinfo.value.code == 4001
    execute.assert_not_awaited()


@pytest.mark.parametrize("path", ["logs", "rcon"])
def test_server_websockets_still_require_manage_servers_permission(monkeypatch, path):
    user = {"id": "member-1", "role": "member", "is_active": True}
    fake_db = _FakeDB(user)
    monkeypatch.setattr(ws_auth, "db", fake_db)
    monkeypatch.setattr(servers_ws, "db", fake_db)
    execute = AsyncMock(return_value=(True, "ok"))
    monkeypatch.setattr(servers_ws.bercon_client, "execute", execute)
    token = jwt.encode({"sub": user["id"]}, JWT_SECRET, algorithm=JWT_ALGORITHM)

    app = FastAPI()
    app.include_router(servers_ws.router, prefix="/api")
    client = TestClient(app)

    with client.websocket_connect(f"/api/ws/servers/srv-1/{path}?token={token}") as websocket:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            websocket.receive_json()

    assert excinfo.value.code == 4003
    execute.assert_not_awaited()


def test_rcon_websocket_disconnect_cancels_inflight_command(monkeypatch):
    async def scenario():
        from middleware.rate_limiter import rcon_rate_limiter
        from services import audit_service

        user = {"id": "disconnect-admin", "role": "admin", "is_active": True}
        server = {
            "id": "srv-1",
            "name": "Server One",
            "status": "running",
            "ports": {"rcon": 19999},
            "config": {"rcon": {"password": "pw"}},
        }
        fake_db = _FakeDB(user, server)
        monkeypatch.setattr(servers_ws, "db", fake_db)
        monkeypatch.setattr(servers_ws, "_authenticate_ws", AsyncMock(return_value=user))
        monkeypatch.setattr(servers_ws, "_refresh_ws_user", AsyncMock(return_value=user))
        monkeypatch.setattr(audit_service, "log_audit", AsyncMock(return_value=None))

        execute_started = asyncio.Event()
        execute_cancelled = asyncio.Event()
        client_disconnected = asyncio.Event()

        async def blocking_execute(**kwargs):
            execute_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                execute_cancelled.set()
                raise

        monkeypatch.setattr(servers_ws.bercon_client, "execute", blocking_execute)

        class FakeWebSocket:
            query_params = {}
            cookies = {}

            def __init__(self):
                self.receive_count = 0
                self.sent = []

            async def accept(self):
                pass

            async def close(self, code=1000, reason=""):
                client_disconnected.set()

            async def send_json(self, message):
                self.sent.append(message)

            async def receive_text(self):
                self.receive_count += 1
                if self.receive_count == 1:
                    return json.dumps({"command": "#status"})
                await client_disconnected.wait()
                raise WebSocketDisconnect(code=1000)

        websocket = FakeWebSocket()
        rcon_rate_limiter.reset(user["id"], server["id"])
        route_task = asyncio.create_task(servers_ws.ws_server_rcon(websocket, server["id"]))
        try:
            await execute_started.wait()
            client_disconnected.set()
            await asyncio.wait_for(execute_cancelled.wait(), timeout=0.1)
            await asyncio.wait_for(route_task, timeout=0.1)
        finally:
            if not route_task.done():
                route_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await route_task
            rcon_rate_limiter.reset(user["id"], server["id"])

    asyncio.run(scenario())


@pytest.mark.parametrize("current", [
    None,  # deactivated / deleted since the handshake
    {"id": "demoted-admin", "role": "member", "is_active": True},  # role removed / override revoked
])
def test_rcon_websocket_refuses_commands_after_access_is_lost(monkeypatch, current):
    """The handshake resolves the caller once; every command re-reads them, so
    a demotion, deactivation or revoked override ends RCON on an open socket."""
    async def scenario():
        from services import audit_service

        user = {"id": "demoted-admin", "role": "admin", "is_active": True}
        server = {
            "id": "srv-1",
            "name": "Server One",
            "status": "running",
            "ports": {"rcon": 19999},
            "config": {"rcon": {"password": "pw"}},
        }
        monkeypatch.setattr(servers_ws, "db", _FakeDB(user, server))
        monkeypatch.setattr(servers_ws, "_authenticate_ws", AsyncMock(return_value=user))
        refresh = AsyncMock(return_value=current)
        monkeypatch.setattr(servers_ws, "_refresh_ws_user", refresh)
        monkeypatch.setattr(audit_service, "log_audit", AsyncMock(return_value=None))
        execute = AsyncMock(return_value=(True, "ok"))
        monkeypatch.setattr(servers_ws.bercon_client, "execute", execute)

        class FakeWebSocket:
            query_params = {}
            cookies = {}

            def __init__(self):
                self.receive_count = 0
                self.sent = []
                self.closed_with = None
                self.closed = asyncio.Event()

            async def accept(self):
                pass

            async def close(self, code=1000, reason=""):
                self.closed_with = code
                self.closed.set()

            async def send_json(self, message):
                self.sent.append(message)

            async def receive_text(self):
                self.receive_count += 1
                if self.receive_count == 1:
                    return json.dumps({"command": "#status"})
                await self.closed.wait()
                raise WebSocketDisconnect(code=1000)

        websocket = FakeWebSocket()
        await asyncio.wait_for(servers_ws.ws_server_rcon(websocket, server["id"]), timeout=2)

        refresh.assert_awaited_with("demoted-admin")
        execute.assert_not_awaited()
        assert websocket.closed_with == 4003
        assert any(m.get("code") == "auth_failed" for m in websocket.sent)

    asyncio.run(scenario())


@pytest.mark.parametrize("current,allowed", [
    ({"id": "u", "role": "operator", "is_active": True}, True),
    ({"id": "u", "role": "admin", "is_active": True}, True),
    ({"id": "u", "role": "retired-role", "is_active": True}, False),
    (None, False),
])
def test_current_server_operator_requires_manage_servers(monkeypatch, current, allowed):
    monkeypatch.setattr(servers_ws, "_refresh_ws_user", AsyncMock(return_value=current))
    result = asyncio.run(servers_ws._current_server_operator("u"))
    assert (result is not None) is allowed
