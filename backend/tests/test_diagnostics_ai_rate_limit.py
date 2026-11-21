"""POST /diagnostics/ai-analyze and /diagnostics/ai-triage call a paid model API
(ai-triage fans out to up to 100 calls), so both share a per-IP rate limit."""
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")
os.environ.setdefault("JWT_ALGORITHM", "HS256")
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from middleware import auth as auth_module
from middleware.ip_rate_limiter import reset_all
from routes import diagnostics

ADMIN = {"id": "admin-1", "role": "admin"}


@pytest.fixture(autouse=True)
def _reset_store():
    reset_all()
    yield
    reset_all()


@pytest.fixture
def client_low_limit():
    from middleware.ip_rate_limiter import rate_limit_ip
    app = FastAPI()
    app.include_router(diagnostics.router)
    app.dependency_overrides[auth_module.get_current_user] = lambda: ADMIN
    # Override the route's actual rate-limit dependency (captured by
    # identity when diagnostics.py's Depends(...) was first evaluated at
    # import time) with a tight one so the test doesn't need 10 real calls.
    app.dependency_overrides[diagnostics._diagnostics_ai_rate_limit] = rate_limit_ip("diagnostics_ai_test", 2, 3600)
    with TestClient(app) as c:
        yield c


def test_ai_analyze_requires_configured_key_before_rate_limit_matters(client_low_limit):
    with patch.object(diagnostics, "_OPENAI_API_KEY", ""):
        res = client_low_limit.post("/diagnostics/ai-analyze", json={"error_type_id": "et-1"})
    assert res.status_code == 503


def test_ai_analyze_rejects_beyond_threshold_with_429(client_low_limit):
    fake_db = MagicMock()
    fake_db.log_error_types.find_one = AsyncMock(return_value=None)
    with patch.object(diagnostics, "_OPENAI_API_KEY", "sk-test"), \
         patch.object(diagnostics, "db", fake_db):
        for _ in range(2):
            client_low_limit.post("/diagnostics/ai-analyze", json={"error_type_id": "et-1"})
        res = client_low_limit.post("/diagnostics/ai-analyze", json={"error_type_id": "et-1"})
    assert res.status_code == 429
    assert "Retry-After" in res.headers


def test_ai_triage_rejects_beyond_threshold_with_429(client_low_limit):
    fake_result = {"triaged": 0, "failed": 0}
    with patch("services.diagnostics_ai._OPENAI_API_KEY", "sk-test"), \
         patch("services.diagnostics_ai.auto_triage_uncurated", AsyncMock(return_value=fake_result)):
        for _ in range(2):
            client_low_limit.post("/diagnostics/ai-triage")
        res = client_low_limit.post("/diagnostics/ai-triage")
    assert res.status_code == 429


def test_ai_analyze_and_ai_triage_share_one_rate_limit_bucket(client_low_limit):
    """Both routes use the same _diagnostics_ai_rate_limit dependency, so
    calls to one count against the other's budget too."""
    fake_result = {"triaged": 0, "failed": 0}
    with patch.object(diagnostics, "_OPENAI_API_KEY", ""), \
         patch("services.diagnostics_ai._OPENAI_API_KEY", "sk-test"), \
         patch("services.diagnostics_ai.auto_triage_uncurated", AsyncMock(return_value=fake_result)):
        client_low_limit.post("/diagnostics/ai-analyze", json={"error_type_id": "et-1"})
        client_low_limit.post("/diagnostics/ai-triage")
        res = client_low_limit.post("/diagnostics/ai-triage")
    assert res.status_code == 429
