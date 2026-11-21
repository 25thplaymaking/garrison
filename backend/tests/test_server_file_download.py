"""Tests for the file-manager read-only access expansion.

Covers the new download (single file + folder ZIP) endpoints, the larger
read-only view cap with the `editable` flag, and the security-sensitive
behaviour these endpoints must preserve: path-traversal rejection, the folder
ZIP size guard, and that symlinks are never archived out of the server root.
"""
import io
import os
import sys
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.responses import FileResponse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("JWT_ALGORITHM", "HS256")

import routes.servers as server_routes  # noqa: E402
import routes.servers_files as fm  # noqa: E402
from routes.servers_files import (  # noqa: E402
    browse_server_files,
    download_server_file,
    download_server_folder,
    read_server_file,
)

_ADMIN = {"id": "admin-1", "username": "Admin"}


def _patches(root: Path):
    fake_db = type("D", (), {})()
    fake_db.managed_servers = type("C", (), {})()
    fake_db.managed_servers.find_one = AsyncMock(return_value={"id": "s1", "name": "Alpha"})
    return (
        patch.object(server_routes, "db", fake_db),
        patch.object(fm, "_resolve_server_root", return_value=str(root)),
        patch.object(fm, "log_audit", AsyncMock()),
    )


@pytest.mark.asyncio
async def test_download_single_file_returns_fileresponse(tmp_path):
    (tmp_path / "console.log").write_text("hello log", encoding="utf-8")
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        resp = await download_server_file("s1", root="profile", path="console.log", current_user=_ADMIN)

    assert isinstance(resp, FileResponse)
    assert resp.path == str(tmp_path / "console.log")
    assert resp.filename == "console.log"


@pytest.mark.asyncio
async def test_download_allows_binary_and_oversize(tmp_path):
    """Download is not restricted to text types or the view/edit caps — any
    container artifact (binaries, huge logs) must be retrievable."""
    big = tmp_path / "addon.pbo"
    big.write_bytes(b"\x00\x01" * 2_000_000)  # ~4 MB binary, non-text extension
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        resp = await download_server_file("s1", root="workshop", path="addon.pbo", current_user=_ADMIN)
    assert isinstance(resp, FileResponse)
    assert resp.filename == "addon.pbo"


@pytest.mark.asyncio
async def test_download_rejects_traversal(tmp_path):
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        with pytest.raises(HTTPException) as exc:
            await download_server_file("s1", root="config", path="../escape.txt", current_user=_ADMIN)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_read_large_text_is_viewable_but_not_editable(tmp_path):
    """A 2 MB log is over the 1 MB edit cap but under the 10 MB view cap: it
    must be viewable read-only with editable=False."""
    log = tmp_path / "error.log"
    log.write_text("x" * (2 * 1024 * 1024), encoding="utf-8")
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        data = await read_server_file("s1", root="profile", path="error.log", current_user=_ADMIN)
    assert data["editable"] is False
    assert data["size"] == 2 * 1024 * 1024


@pytest.mark.asyncio
async def test_read_small_text_is_editable(tmp_path):
    (tmp_path / "settings.json").write_text("{}", encoding="utf-8")
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        data = await read_server_file("s1", root="config", path="settings.json", current_user=_ADMIN)
    assert data["editable"] is True


@pytest.mark.asyncio
async def test_read_rejects_beyond_view_cap(tmp_path):
    log = tmp_path / "console.log"
    log.write_text("y" * (fm._FM_MAX_VIEW_SIZE + 10), encoding="utf-8")
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        with pytest.raises(HTTPException) as exc:
            await read_server_file("s1", root="profile", path="console.log", current_user=_ADMIN)
    assert exc.value.status_code == 400
    assert "download" in exc.value.detail.lower()


@pytest.mark.asyncio
async def test_browse_flags_view_edit_download(tmp_path):
    (tmp_path / "small.json").write_text("{}", encoding="utf-8")
    big = tmp_path / "big.log"
    big.write_text("z" * (2 * 1024 * 1024), encoding="utf-8")
    (tmp_path / "mod.pbo").write_bytes(b"\x00" * 100)
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        result = await browse_server_files("s1", root="profile", path="", current_user=_ADMIN)

    by_name = {e["name"]: e for e in result["entries"]}
    assert by_name["small.json"]["editable"] is True
    assert by_name["small.json"]["viewable"] is True
    assert by_name["big.log"]["editable"] is False      # over edit cap
    assert by_name["big.log"]["viewable"] is True        # under view cap
    assert by_name["mod.pbo"]["viewable"] is False       # binary type
    assert all(e["downloadable"] for e in by_name.values())


@pytest.mark.asyncio
async def test_download_folder_zips_contents(tmp_path):
    logs = tmp_path / "logs"
    (logs / "sub").mkdir(parents=True)
    (logs / "a.log").write_text("aaa", encoding="utf-8")
    (logs / "sub" / "b.log").write_text("bbb", encoding="utf-8")
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        resp = await download_server_folder("s1", root="profile", path="logs", current_user=_ADMIN)

    assert isinstance(resp, FileResponse)
    try:
        with zipfile.ZipFile(resp.path) as archive:
            names = {n.replace("\\", "/") for n in archive.namelist()}
        assert "a.log" in names
        assert "sub/b.log" in names
    finally:
        if resp.background:
            resp.background.func()
    assert not os.path.exists(resp.path)  # background cleanup removed the temp


@pytest.mark.asyncio
async def test_download_folder_rejects_too_many_files(tmp_path):
    folder = tmp_path / "many"
    folder.mkdir()
    (folder / "f.txt").write_text("x", encoding="utf-8")
    p_db, p_root, p_audit = _patches(tmp_path)
    with patch.object(fm, "_FM_MAX_ZIP_FILES", 0):
        with p_db, p_root, p_audit:
            with pytest.raises(HTTPException) as exc:
                await download_server_folder("s1", root="profile", path="many", current_user=_ADMIN)
    assert exc.value.status_code == 400


@pytest.mark.skipif(os.name != "posix", reason="symlink creation needs privileges on Windows")
def test_zip_folder_skips_symlinks(tmp_path):
    """The ZIP walk must never follow symlinks out of the source tree."""
    outside = tmp_path / "secret.txt"
    outside.write_text("top secret", encoding="utf-8")
    folder = tmp_path / "logs"
    folder.mkdir()
    (folder / "a.log").write_text("aaa", encoding="utf-8")
    (folder / "link").symlink_to(outside)

    zip_path, count = fm._zip_folder_to_temp(folder)
    try:
        with zipfile.ZipFile(zip_path) as archive:
            names = set(archive.namelist())
        assert "a.log" in names
        assert "link" not in names  # symlink skipped → no escape
        assert count == 1
    finally:
        os.unlink(zip_path)


# ── Bounded tail reads for the read-only log view ─────────────────────────────

def _numbered_log(path: Path, lines: int) -> bytes:
    data = "".join(f"{i:06d} SCRIPT : line {i}\n" for i in range(lines)).encode("utf-8")
    path.write_bytes(data)
    return data


@pytest.mark.asyncio
async def test_tail_read_returns_whole_lines_from_the_end(tmp_path):
    data = _numbered_log(tmp_path / "console.log", 2000)
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        res = await read_server_file("s1", root="profile", path="console.log", current_user=_ADMIN, tail_bytes=1000)

    assert res["editable"] is False
    assert res["truncated"] is True
    assert res["size"] == len(data)
    assert res["end"] == len(data)
    assert res["content"].endswith("001999 SCRIPT : line 1999\n")
    # The cut lands on a line boundary, never mid-line.
    assert data[res["offset"] - 1:res["offset"]] == b"\n"
    assert res["content"].encode("utf-8") == data[res["offset"]:]
    assert len(res["content"]) <= 1000


@pytest.mark.asyncio
async def test_tail_read_pages_backwards_to_the_start(tmp_path):
    data = _numbered_log(tmp_path / "console.log", 500)
    p_db, p_root, p_audit = _patches(tmp_path)
    chunks = []
    end = None
    with p_db, p_root, p_audit:
        while True:
            res = await read_server_file(
                "s1", root="profile", path="console.log", current_user=_ADMIN, tail_bytes=4096, end=end,
            )
            chunks.insert(0, res["content"])
            if res["offset"] == 0:
                assert res["truncated"] is False
                break
            end = res["offset"]

    assert "".join(chunks).encode("utf-8") == data


@pytest.mark.asyncio
async def test_tail_read_views_logs_beyond_the_full_view_cap(tmp_path):
    log = tmp_path / "console.log"
    log.write_bytes(b"x" * (fm._FM_MAX_VIEW_SIZE + 10) + b"\nlast line\n")
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        res = await read_server_file("s1", root="profile", path="console.log", current_user=_ADMIN, tail_bytes=64)
        browse = await browse_server_files("s1", root="profile", path="", current_user=_ADMIN)

    assert res["content"] == "last line\n"
    assert browse["entries"][0]["viewable"] is True


@pytest.mark.asyncio
async def test_tail_read_is_capped(tmp_path):
    _numbered_log(tmp_path / "console.log", 10)
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        res = await read_server_file(
            "s1", root="profile", path="console.log", current_user=_ADMIN, tail_bytes=10**12,
        )
    assert res["offset"] == 0 and res["truncated"] is False


@pytest.mark.asyncio
async def test_tail_read_always_moves_back_past_a_line_longer_than_the_window(tmp_path):
    log = tmp_path / "console.log"
    log.write_bytes(b"short\n" + b"L" * 300 + b"\nend\n")
    p_db, p_root, p_audit = _patches(tmp_path)
    with p_db, p_root, p_audit:
        first = await read_server_file("s1", root="profile", path="console.log", current_user=_ADMIN, tail_bytes=4)
        earlier = await read_server_file(
            "s1", root="profile", path="console.log", current_user=_ADMIN, tail_bytes=100, end=first["offset"],
        )
    assert first["content"] == "end\n"
    assert earlier["content"]
    assert earlier["offset"] < first["offset"]
