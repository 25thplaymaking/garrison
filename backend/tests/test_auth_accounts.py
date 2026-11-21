"""Sign-in, sessions and account management."""

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

import middleware.auth as auth_mw
import routes.auth as auth_routes
import services.audit_service as audit_service
from config import COOKIE_NAME
from tests.memory_db import MemoryDb

PASSWORD = "correct-horse-battery"


@pytest.fixture
def env(monkeypatch):
    db = MemoryDb(users=[], audit_logs=[])
    for module in (auth_mw, auth_routes, audit_service):
        monkeypatch.setattr(module, "db", db)
    app = FastAPI()
    app.include_router(auth_routes.router, prefix="/api")
    return db, app


def _seed(db, username, role, password=PASSWORD, **extra):
    import asyncio
    doc = asyncio.get_event_loop().run_until_complete(auth_routes.create_user_record(username, password, role))
    if extra:
        asyncio.get_event_loop().run_until_complete(db.users.update_one({"id": doc["id"]}, {"$set": extra}))
    return doc


def _login(client, username, password=PASSWORD):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def test_login_sets_httponly_cookie_and_me_works(env):
    db, app = env
    _seed(db, "Admin", "admin")
    client = TestClient(app)
    r = _login(client, "admin")  # usernames are case-insensitive
    assert r.status_code == 200
    assert r.json()["role"] == "admin"
    assert "password_hash" not in r.json()
    assert "httponly" in r.headers["set-cookie"].lower()
    me = client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["username"] == "Admin"
    assert "manage_servers" in me.json()["permissions"]


def test_wrong_password_and_unknown_user_give_the_same_answer(env):
    db, app = env
    _seed(db, "admin", "admin")
    client = TestClient(app)
    bad_pw = _login(client, "admin", "nope-nope-nope")
    no_user = _login(client, "ghost", "nope-nope-nope")
    assert bad_pw.status_code == no_user.status_code == 401
    assert bad_pw.json() == no_user.json()


def test_disabled_account_cannot_sign_in(env):
    db, app = env
    _seed(db, "op", "operator", is_active=False)
    assert _login(TestClient(app), "op").status_code == 401


def test_password_change_ends_other_sessions(env):
    db, app = env
    _seed(db, "op", "operator")
    first, second = TestClient(app), TestClient(app)
    _login(first, "op")
    _login(second, "op")
    r = first.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "a-brand-new-secret"})
    assert r.status_code == 200
    assert first.get("/api/auth/me").status_code == 200  # got a fresh cookie
    assert second.get("/api/auth/me").status_code == 401  # old session is dead
    assert _login(TestClient(app), "op", "a-brand-new-secret").status_code == 200


def test_operator_cannot_manage_accounts(env):
    db, app = env
    _seed(db, "op", "operator")
    client = TestClient(app)
    _login(client, "op")
    assert client.get("/api/users").status_code == 403
    assert client.post("/api/users", json={"username": "x1x", "password": PASSWORD}).status_code == 403
    assert client.get("/api/audit-logs").status_code == 403


def test_admin_creates_updates_and_deletes_accounts(env):
    db, app = env
    _seed(db, "admin", "admin")
    client = TestClient(app)
    _login(client, "admin")
    created = client.post("/api/users", json={"username": "op1", "password": PASSWORD, "role": "operator"})
    assert created.status_code == 201
    uid = created.json()["id"]
    assert client.post("/api/users", json={"username": "OP1", "password": PASSWORD}).status_code == 409
    assert client.post("/api/users", json={"username": "op2", "password": "short"}).status_code == 400
    assert client.patch(f"/api/users/{uid}", json={"role": "admin"}).json()["role"] == "admin"
    assert client.delete(f"/api/users/{uid}").status_code == 200
    actions = [row["action_type"] for row in db.audit_logs.rows] if hasattr(db.audit_logs, "rows") else None
    if actions is not None:
        assert {"user_create", "user_update", "user_delete"} <= set(actions)


def test_last_admin_cannot_be_removed_or_demoted(env):
    db, app = env
    admin = _seed(db, "admin", "admin")
    other = _seed(db, "second", "admin")
    client = TestClient(app)
    _login(client, "admin")
    assert client.delete(f"/api/users/{admin['id']}").status_code == 400  # not yourself
    assert client.patch(f"/api/users/{other['id']}", json={"is_active": False}).status_code == 200
    # "admin" is now the only active admin.
    assert client.patch(f"/api/users/{admin['id']}", json={"role": "operator"}).status_code == 400


def test_token_signed_for_another_purpose_is_not_a_session(env):
    import jwt

    from config import JWT_SECRET
    db, app = env
    user = _seed(db, "admin", "admin")
    client = TestClient(app)
    token = jwt.encode({"sub": user["id"], "tv": 0, "purpose": "reset"}, JWT_SECRET, algorithm="HS256")
    client.cookies.set(COOKIE_NAME, token)
    assert client.get("/api/auth/me").status_code == 401


def test_audit_log_masks_secrets():
    from services.audit_service import redact_secrets
    out = redact_secrets({"config": {"game": {"password": "x", "name": "n"}, "rcon": {"password": ""}}})
    assert out["config"]["game"]["password"] == "[redacted]"
    assert out["config"]["game"]["name"] == "n"
    assert out["config"]["rcon"]["password"] == ""
