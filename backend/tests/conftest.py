import asyncio
import atexit
import os
import shutil
import sys
import tempfile
import warnings
from pathlib import Path

import pytest

# Set before any test imports config, which refuses a short JWT_SECRET.
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32-byte-minimum")
os.environ.setdefault("JWT_ALGORITHM", "HS256")
# Deliberately unreachable: no unit test needs a live database.
os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=500")
os.environ.setdefault("DB_NAME", "test_db")

# Tests never reach a Docker daemon and never write server folders into the
# checkout. Forced, not defaulted, so an inherited environment cannot point the
# suite at real paths. Tests that need Docker behaviour fake docker_agent.
os.environ["DOCKER_SOCKET_PATH"] = "unix:///nonexistent/garrison-tests/docker.sock"
_TEST_SERVER_DATA = tempfile.mkdtemp(prefix="garrison-test-server-data-")
os.environ["SERVER_DATA_ROOT"] = _TEST_SERVER_DATA
atexit.register(shutil.rmtree, _TEST_SERVER_DATA, True)

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

_FIXTURE_LOOP: asyncio.AbstractEventLoop | None = None


@pytest.fixture(autouse=True)
def ensure_current_event_loop():
    """Give every test an open event loop as the thread's current loop.

    Several sync tests drive coroutines with
    ``asyncio.get_event_loop().run_until_complete(...)`` and ``asyncio.run``
    clears the current loop when it returns.
    """
    global _FIXTURE_LOOP
    if _FIXTURE_LOOP is None or _FIXTURE_LOOP.is_closed():
        _FIXTURE_LOOP = asyncio.new_event_loop()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        asyncio.set_event_loop(_FIXTURE_LOOP)
    yield


@pytest.fixture(autouse=True)
def _fresh_rate_limiter():
    """The in-process rate limiter is module-global; reset it between tests."""
    from middleware.ip_rate_limiter import reset_all
    reset_all()
