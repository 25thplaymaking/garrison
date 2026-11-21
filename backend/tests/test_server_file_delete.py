"""Tests for the file-manager delete endpoint (servers_files.delete_server_files).

Deletion is destructive and not extension-restricted, so these tests pin the
security-sensitive behaviour: real files/folders are removed, the server root
can never be the target, and path traversal is rejected.
"""
import os
from contextlib import nullcontext
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("JWT_ALGORITHM", "HS256")

import routes.servers as server_routes  # noqa: E402
import routes.servers_files as fm  # noqa: E402
from routes.servers_files import delete_server_files, purge_server_mod_files, FileDeleteBody  # noqa: E402
import services.reforger_orchestrator as orch  # noqa: E402


_ADMIN = {"id": "admin-1", "username": "Admin"}


def _seed_tree(root: Path):
    (root / "keep.txt").write_text("keep", encoding="utf-8")
    (root / "doomed.cfg").write_text("bye", encoding="utf-8")
    sub = root / "modfolder"
    sub.mkdir()
    (sub / "nested.bin").write_text("binary-ish", encoding="utf-8")
    (sub / "inner").mkdir()
    (sub / "inner" / "deep.paa").write_text("deep", encoding="utf-8")


def _patches(root: Path, gate_return):
    fake_db = type("D", (), {})()
    fake_db.managed_servers = type("C", (), {})()
    fake_db.managed_servers.find_one = AsyncMock(return_value={"id": "s1", "name": "Alpha"})
    return (
        patch.object(server_routes, "db", fake_db),
        patch.object(fm, "_resolve_server_root", return_value=str(root)),
        nullcontext(),
        patch.object(fm, "log_audit", AsyncMock()),
    )


def test_mod_purge_target_dirs_covers_workshop_and_profile_addons(tmp_path):
    """Purge must target the workshop root AND profile/addons (where some engine
    versions land mods), but never the profile root itself, and must drop
    addons subdirs already covered by clearing the workshop root."""
    workshop = tmp_path / "workshop"
    (workshop / "addons").mkdir(parents=True)
    profile = tmp_path / "profile"
    (profile / "addons").mkdir(parents=True)
    (profile / "server.json").write_text("{}", encoding="utf-8")

    def fake_resolve(server, key, **kwargs):
        if key == "workshop":
            return str(workshop)
        if key == "profile":
            return str(profile)
        raise HTTPException(status_code=400, detail="no such root")

    with patch.object(fm, "_resolve_server_root", side_effect=fake_resolve):
        targets = fm._mod_purge_target_dirs({"id": "s1"})

    resolved = {p.resolve() for p in targets}
    assert workshop.resolve() in resolved          # primary mod store
    assert (profile / "addons").resolve() in resolved  # alt mod location
    assert (workshop / "addons").resolve() not in resolved  # nested under workshop → dropped
    assert profile.resolve() not in resolved       # profile root is protected


def _purge_patches(server_doc, *, workshop, profile, gate_return=None, running=False):
    fake_db = type("D", (), {})()
    fake_db.managed_servers = type("C", (), {})()
    fake_db.managed_servers.find_one = AsyncMock(return_value=server_doc)

    def fake_resolve(server, key, **kwargs):
        if key == "workshop":
            return str(workshop)
        if key == "profile":
            return str(profile)
        raise HTTPException(status_code=400, detail="no such root")

    return (
        patch.object(server_routes, "db", fake_db),
        patch.object(fm, "_resolve_server_root", side_effect=fake_resolve),
        nullcontext(),
        patch.object(fm, "log_audit", AsyncMock()),
        patch.object(orch.docker_agent, "get_container_status",
                     AsyncMock(return_value={"running": running, "status": "running" if running else "exited"})),
    )


@pytest.mark.asyncio
async def test_purge_removes_mods_under_workshop_addons(tmp_path):
    """The user's real layout: mods live in workshop/addons/<mod>. Purging the
    workshop root must clear them while leaving the workshop root in place."""
    workshop = tmp_path / "workshop"
    (workshop / "addons" / "mod-aaa").mkdir(parents=True)
    (workshop / "addons" / "mod-aaa" / "addon.pbo").write_text("x", encoding="utf-8")
    profile = tmp_path / "profile"
    profile.mkdir()

    server = {"id": "s1", "name": "Alpha", "container_name": "srv-alpha"}
    p_db, p_root, p_gate, p_audit, p_docker = _purge_patches(
        server, workshop=workshop, profile=profile, running=False)
    with p_db, p_root, p_gate, p_audit, p_docker:
        result = await purge_server_mod_files("s1", current_user=_ADMIN)

    assert result["count"] == 1
    assert result["errors"] == []
    assert not (workshop / "addons").exists()  # the mod store was cleared
    assert workshop.is_dir()                    # root preserved
    assert str(workshop) in result["scanned_paths"]


@pytest.mark.asyncio
async def test_purge_blocked_when_container_still_running(tmp_path):
    """If the container is actually up (stuck/never stopped), the purge refuses
    with 409 instead of silently deleting nothing or fighting file locks."""
    workshop = tmp_path / "workshop"
    (workshop / "addons" / "mod-aaa").mkdir(parents=True)
    profile = tmp_path / "profile"
    profile.mkdir()

    server = {"id": "s1", "name": "Alpha", "container_name": "srv-alpha"}
    p_db, p_root, p_gate, p_audit, p_docker = _purge_patches(
        server, workshop=workshop, profile=profile, running=True)
    with p_db, p_root, p_gate, p_audit, p_docker:
        with pytest.raises(HTTPException) as exc:
            await purge_server_mod_files("s1", current_user=_ADMIN)

    assert exc.value.status_code == 409
    assert "still running" in exc.value.detail
    assert (workshop / "addons" / "mod-aaa").exists()  # nothing deleted


@pytest.mark.asyncio
async def test_delete_removes_file_and_folder_recursively(tmp_path):
    _seed_tree(tmp_path)
    p_db, p_root, p_gate, p_audit = _patches(tmp_path, None)
    with p_db, p_root, p_gate, p_audit:
        body = FileDeleteBody(root="config", paths=["doomed.cfg", "modfolder"])
        result = await delete_server_files("s1", body, current_user=_ADMIN)

    assert result["count"] == 2
    assert result["errors"] == []
    assert not (tmp_path / "doomed.cfg").exists()
    assert not (tmp_path / "modfolder").exists()  # recursive
    assert (tmp_path / "keep.txt").exists()  # untouched


@pytest.mark.asyncio
async def test_delete_reports_missing_path_without_aborting(tmp_path):
    _seed_tree(tmp_path)
    p_db, p_root, p_gate, p_audit = _patches(tmp_path, None)
    with p_db, p_root, p_gate, p_audit:
        body = FileDeleteBody(root="config", paths=["doomed.cfg", "ghost.txt"])
        result = await delete_server_files("s1", body, current_user=_ADMIN)

    assert result["count"] == 1
    assert [e["path"] for e in result["errors"]] == ["ghost.txt"]
    assert not (tmp_path / "doomed.cfg").exists()


@pytest.mark.asyncio
async def test_delete_reports_rmtree_partial_failure(tmp_path):
    """If rmtree can't remove part of a folder (e.g. EBUSY when the running
    container still holds it as a mount, or EACCES on root-owned files), the
    failure is captured per-folder and surfaced instead of silently aborting."""
    _seed_tree(tmp_path)
    p_db, p_root, p_gate, p_audit = _patches(tmp_path, None)

    def fake_rmtree(path, onexc=None, onerror=None):
        # Mirror real shutil.rmtree across versions: it invokes `onexc` with the
        # exception instance on 3.12+ and the legacy `onerror` with a
        # sys.exc_info() tuple on older interpreters. The production helper
        # (_rmtree_collect) selects the right kwarg per interpreter, so accept
        # both here rather than pinning the test to one Python version.
        exc = OSError(16, "Device or resource busy")
        nested = str(Path(path) / "nested.bin")
        if onexc:
            onexc(os.unlink, nested, exc)
        elif onerror:
            onerror(os.unlink, nested, (type(exc), exc, None))

    with p_db, p_root, p_gate, p_audit, patch.object(fm.shutil, "rmtree", side_effect=fake_rmtree):
        body = FileDeleteBody(root="config", paths=["modfolder"])
        result = await delete_server_files("s1", body, current_user=_ADMIN)

    assert result["count"] == 0
    assert len(result["errors"]) == 1
    assert result["errors"][0]["path"] == "modfolder"
    assert "busy" in result["errors"][0]["error"].lower()


@pytest.mark.asyncio
async def test_delete_refuses_server_root(tmp_path):
    _seed_tree(tmp_path)
    p_db, p_root, p_gate, p_audit = _patches(tmp_path, None)
    with p_db, p_root, p_gate, p_audit:
        body = FileDeleteBody(root="config", paths=["."])
        with pytest.raises(HTTPException) as exc:
            await delete_server_files("s1", body, current_user=_ADMIN)
    assert exc.value.status_code == 400
    assert (tmp_path / "keep.txt").exists()


@pytest.mark.asyncio
async def test_delete_rejects_path_traversal(tmp_path):
    _seed_tree(tmp_path)
    p_db, p_root, p_gate, p_audit = _patches(tmp_path, None)
    with p_db, p_root, p_gate, p_audit:
        body = FileDeleteBody(root="config", paths=["../escape"])
        with pytest.raises(HTTPException) as exc:
            await delete_server_files("s1", body, current_user=_ADMIN)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_rejects_empty_path_list(tmp_path):
    p_db, p_root, p_gate, p_audit = _patches(tmp_path, None)
    with p_db, p_root, p_gate, p_audit:
        body = FileDeleteBody(root="config", paths=[])
        with pytest.raises(HTTPException) as exc:
            await delete_server_files("s1", body, current_user=_ADMIN)
    assert exc.value.status_code == 400


