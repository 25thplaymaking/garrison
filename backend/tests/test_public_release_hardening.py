"""Hardening added before the public release: placeholder passwords from
.env.example are refused, and WebSocket handshakes from other sites are
rejected before the session cookie is read."""

import asyncio
import types

import pytest

import server
from middleware import ws_auth


class FakeSocket:
    def __init__(self, headers, cookies=None):
        self.headers = headers
        self.cookies = cookies or {}
        self.query_params = {}


@pytest.mark.parametrize(
    "headers, allowed",
    [
        ({"host": "panel.example.com"}, True),  # not a browser
        ({"host": "panel.example.com", "origin": "https://panel.example.com"}, True),
        ({"host": "127.0.0.1:8000", "origin": "http://127.0.0.1:8000"}, True),
        ({"host": "panel.example.com", "origin": "https://evil.example"}, False),
        ({"host": "panel.example.com", "origin": "https://panel.example.com.evil.example"}, False),
        ({"host": "panel.example.com", "origin": "null"}, False),
        ({"host": "", "origin": "https://panel.example.com"}, False),
    ],
)
def test_websocket_origin_must_be_the_panel(headers, allowed):
    assert ws_auth.origin_allowed(FakeSocket(headers)) is allowed


def test_site_url_host_is_allowed_behind_a_proxy(monkeypatch):
    monkeypatch.setattr(ws_auth, "SITE_URL", "https://panel.example.com")
    sock = FakeSocket({"host": "127.0.0.1:8000", "origin": "https://panel.example.com"})
    assert ws_auth.origin_allowed(sock) is True


def test_cross_site_handshake_is_rejected_even_with_a_valid_cookie(monkeypatch):
    called = []
    monkeypatch.setattr(ws_auth, "decode_session_token", lambda token: called.append(token) or {"sub": "u1"})
    sock = FakeSocket({"host": "panel.example.com", "origin": "https://evil.example"}, {ws_auth.COOKIE_NAME: "signed"})
    assert asyncio.run(ws_auth.authenticate_websocket(sock)) is None
    assert called == [], "the cookie must not even be decoded"


def test_placeholder_admin_password_does_not_create_an_account(monkeypatch):
    created = []

    async def count_documents(_query):
        return 0

    async def create_user_record(*args):
        created.append(args)

    monkeypatch.setattr(server, "db", types.SimpleNamespace(users=types.SimpleNamespace(count_documents=count_documents)))
    monkeypatch.setattr(server, "create_user_record", create_user_record)
    monkeypatch.setattr(server, "ADMIN_PASSWORD", "CHANGE_ME_at_least_10_chars")
    asyncio.run(server.ensure_first_admin())
    assert created == []

    monkeypatch.setattr(server, "ADMIN_PASSWORD", "a-real-long-password")
    asyncio.run(server.ensure_first_admin())
    assert len(created) == 1
