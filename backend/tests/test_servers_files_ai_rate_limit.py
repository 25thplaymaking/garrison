"""The file manager's AI assist sends file content to a paid model API, so
it carries a per-IP rate limit like the other AI routes."""
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")
os.environ.setdefault("JWT_ALGORITHM", "HS256")
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from middleware import auth as auth_module
from middleware.ip_rate_limiter import rate_limit_ip, reset_all
import routes.servers  # noqa: F401 — must load first: servers_files<->servers circular import
from routes import servers_files

ADMIN = {"id": "admin-1", "role": "admin"}


@pytest.fixture(autouse=True)
def _reset_store():
    reset_all()
    yield
    reset_all()


# ── servers_files.ai_assist_server_file ─────────────────────────────────────

@pytest.fixture
def ai_assist_client():
    app = FastAPI()
    app.include_router(servers_files.router)
    app.dependency_overrides[auth_module.get_current_user] = lambda: ADMIN
    # Override the route's real dependency (bound by identity at import time)
    # with a tight one so the test doesn't need 10 real calls.
    app.dependency_overrides[servers_files._ai_assist_rate_limit] = rate_limit_ip(
        "servers_file_ai_assist_test", 2, 3600
    )
    fake_db = MagicMock()
    fake_db.managed_servers.find_one = AsyncMock(return_value=None)
    servers_files.db = fake_db
    with TestClient(app) as c:
        yield c


def test_ai_assist_rejects_beyond_threshold_with_429(ai_assist_client):
    def _call():
        return ai_assist_client.post(
            "/servers/srv-1/files/ai-assist",
            params={"root": "config", "path": "draft.json"},
            json={"content": "{}"},
        )

    for _ in range(2):
        res = _call()
        assert res.status_code == 404  # server not found — proves auth/rate-limit passed
    res = _call()
    assert res.status_code == 429
    assert "Retry-After" in res.headers
