"""Tests for the Mod Presets routes/models (routes/servers.py, models/server.py).

Covers: a preset with a well-formed mod list can be created, a malformed mod
entry (missing the required ``mod_id`` field) is rejected with a pydantic
validation error (surfaces as HTTP 422 via FastAPI's request-body handling),
and the MANAGE_SERVERS RBAC gate still applies to preset routes.
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")
os.environ.setdefault("JWT_ALGORITHM", "HS256")
os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes import servers as server_routes  # noqa: E402
from models.server import ModPresetCreate, ModPresetModEntry, ModPresetUpdate  # noqa: E402
from middleware.rbac import Permission, require_permission  # noqa: E402

ADMIN = {"id": "admin-1", "username": "Admin", "role": "admin"}
MEMBER = {"id": "member-1", "username": "Rank and File", "role": "member"}


def _fake_db():
    db = MagicMock()
    db.mod_presets.insert_one = AsyncMock()
    db.mod_presets.find_one = AsyncMock(return_value=None)
    db.mod_presets.update_one = AsyncMock()
    db.mod_presets.delete_one = AsyncMock(return_value=SimpleNamespace(deleted_count=1))
    return db


@pytest.mark.asyncio
async def test_create_preset_with_valid_mods_succeeds():
    db = _fake_db()
    body = ModPresetCreate(
        name="Vanilla+",
        mods=[{"mod_id": "ABC123", "name": "Test Mod", "version": "1.0.0"}],
    )

    with patch.object(server_routes, "db", db):
        result = await server_routes.create_preset(body, ADMIN)

    assert result["name"] == "Vanilla+"
    assert result["created_by"] == ADMIN["id"]
    assert len(result["mods"]) == 1
    assert result["mods"][0]["mod_id"] == "ABC123"
    assert result["mods"][0]["name"] == "Test Mod"
    assert result["mods"][0]["version"] == "1.0.0"
    assert result["mods"][0]["enabled"] is True
    db.mod_presets.insert_one.assert_awaited_once()
    # The stored document must be plain dicts (JSON/BSON-serializable), not
    # nested pydantic model instances.
    stored_doc = db.mod_presets.insert_one.await_args.args[0]
    assert isinstance(stored_doc["mods"][0], dict)


def test_malformed_mod_entry_missing_mod_id_is_rejected():
    with pytest.raises(ValidationError):
        ModPresetCreate(name="Broken", mods=[{"name": "No id here"}])


def test_mod_entry_with_blank_mod_id_is_rejected():
    with pytest.raises(ValidationError):
        ModPresetModEntry(mod_id="")


def test_update_preset_also_validates_mod_entries():
    with pytest.raises(ValidationError):
        ModPresetUpdate(mods=[{"name": "Still no id"}])


@pytest.mark.asyncio
async def test_non_manager_is_rejected_by_permission_gate():
    checker = require_permission(Permission.MANAGE_SERVERS)
    with pytest.raises(HTTPException) as exc_info:
        await checker(current_user=MEMBER)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_delete_preset_requires_existing_preset():
    db = _fake_db()
    db.mod_presets.find_one = AsyncMock(return_value=None)

    with patch.object(server_routes, "db", db):
        with pytest.raises(HTTPException) as exc_info:
            await server_routes.delete_preset("missing-id", ADMIN)

    assert exc_info.value.status_code == 404
    db.mod_presets.delete_one.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_preset_removes_existing_preset():
    db = _fake_db()
    db.mod_presets.find_one = AsyncMock(return_value={"id": "preset-1", "name": "Vanilla+"})

    with patch.object(server_routes, "db", db):
        result = await server_routes.delete_preset("preset-1", ADMIN)

    assert result["id"] == "preset-1"
    db.mod_presets.delete_one.assert_awaited_once_with({"id": "preset-1"})
