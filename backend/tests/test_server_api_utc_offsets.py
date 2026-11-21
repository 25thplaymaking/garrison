"""Datetimes read back from Mongo are naive UTC; the API must say so.

Without an offset the browser parses "2026-10-10T21:12:27" as local time, so
a viewer west of UTC saw schedule runs hours late.
"""
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.encoders import jsonable_encoder  # noqa: E402

from routes import servers as servers_route  # noqa: E402

NAIVE = datetime(2026, 10, 10, 21, 12, 27)


def test_server_documents_carry_a_utc_offset():
    doc = servers_route._serialize_doc({"next_run": NAIVE, "nested": [{"at": NAIVE}]})
    assert doc["next_run"] == "2026-10-10T21:12:27+00:00"
    assert doc["nested"][0]["at"] == "2026-10-10T21:12:27+00:00"
    aware = datetime(2026, 10, 10, 17, 12, tzinfo=timezone.utc)
    assert servers_route._serialize_doc(aware) == aware.isoformat()
