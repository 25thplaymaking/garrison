"""File manager endpoints for the Server Management Portal.

Extracted from `routes.servers` as part of a token-light refactor pass.
Imports `_resolve_server_root` back from `routes.servers` to avoid moving the
helper chain (`_resolve_optional_server_root` -> `_iter_local_mod_roots` -> ...)
that other endpoints in `routes.servers` still depend on.
"""

import asyncio
import logging
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel

from middleware.rbac import require_permission, Permission
from middleware.ip_rate_limiter import rate_limit_ip


class _DbProxy:
    """Resolve attribute access against `routes.servers.db` on every call.

    Keeps `monkeypatch.setattr(routes.servers, "db", fake_db)` in existing
    tests effective without having to patch both modules.
    """

    def __getattr__(self, name):
        from routes import servers as _servers_module
        return getattr(_servers_module.db, name)


db = _DbProxy()
from services.audit_service import log_audit
from services.file_manager_tools import (
    FileManagerAIError,
    FileManagerAIUnavailable,
    validate_and_format_file_content,
)
from services.server_data_permissions import (
    repair_editable_permissions, remove_tree_with_permission_repair,
    unlink_with_permission_repair, write_text_with_permission_repair,
)
from routes.servers import (
    _derive_troubleshooting,
    _resolve_server_root,
)

logger = logging.getLogger(__name__)
router = APIRouter()
_require_servers = require_permission(Permission.MANAGE_SERVERS)
# Mirrors research.py's/diagnostics.py's paid-OpenAI-call rate limits — this
# endpoint forwards up to _FM_MAX_FILE_SIZE bytes of caller-supplied file
# content to OpenAI on every call and previously had no rate limit at all.
_ai_assist_rate_limit = rate_limit_ip("servers_file_ai_assist", 10, 3600)


# ── File Manager ─────────────────────────────────────────────────────────────

# Maximum file size that can be *edited/written* via the file manager (1 MB).
# Editing loads the whole file into a textarea, so this stays small.
_FM_MAX_FILE_SIZE = 1_048_576


# ── File-manager permission self-repair ──────────────────────────────────────
# Game-server containers run as root and create root-owned, non-group-writable
# files under the server-data tree (logs, profile data, mod configs). The
# backend runs as an unprivileged user and cannot overwrite them, which surfaces
# as "Permission denied" when saving in the file manager. On EACCES we invoke a
# tightly-scoped, root-owned helper — installed at PERM_REPAIR_HELPER and allowed
# for this user via a dedicated sudoers rule — that ONLY normalizes ownership and
# mode INSIDE the server-data base and refuses any path outside it, then retry
# the write once. See scripts/garrison-fix-perms.sh and
# scripts/install_file_manager_perms.sh.
def _repair_editable_permissions(path: Path) -> bool:
    """Compatibility wrapper for the shared server-data permission helper."""
    return repair_editable_permissions(path)

# Maximum file size that can be read *whole* for viewing (10 MB).
_FM_MAX_VIEW_SIZE = 10_485_760

# Read-only views read a bounded window from the end instead (`tail_bytes`), so a
# log of any size opens quickly; loading a whole 10 MB log into the page froze it.
_FM_MAX_TAIL_BYTES = 4 * 1_048_576

# Guards for folder (ZIP) downloads — refuse archives that would be huge so a
# workshop dir full of multi-GB .pbo mods can't blow up disk/memory.
_FM_MAX_ZIP_SIZE = 524_288_000  # 500 MB total uncompressed
_FM_MAX_ZIP_FILES = 5000

# Extensions we consider safe to view/edit in the panel.
_FM_EDITABLE_EXTENSIONS = {
    ".json", ".txt", ".cfg", ".ini", ".xml", ".log", ".conf", ".yaml", ".yml",
    ".toml", ".properties", ".md", ".csv", ".sh", ".bat", ".py", ".lua",
}

# Additional text-ish extensions that are safe to *view* read-only (never edited
# through the panel). Superset drives the read-only viewer; binaries / unknown
# types fall through to download-only.
_FM_VIEWABLE_EXTENSIONS = _FM_EDITABLE_EXTENSIONS | {
    ".rpt", ".html", ".htm", ".js", ".css", ".map", ".diff", ".patch",
}



def _safe_resolve(base: str, relative: str, *, allow_root: bool = False) -> Path:
    """Resolve *relative* under *base*, preventing path-traversal attacks.

    Returns the resolved absolute path. Raises HTTPException(400) if the
    input is invalid or the result escapes *base*.

    The relative_to() check rejects
    symlinks that resolve outside the base, but we ALSO walk each
    intermediate component and reject if any of them is a symlink at all.
    Rationale: a symlink under server-data/<id>/ that points to another
    spot inside the same tree passes relative_to() but is still a vector
    for an attacker who can place files (e.g. via a mod zip upload) to
    pivot to paths the file manager wasn't meant to reach. Defense-in-depth.
    """
    if relative is None:
        raise HTTPException(status_code=400, detail="Path is required")

    # Normalize whitespace and separators early
    rel_str = str(relative).strip()
    if not rel_str:
        if allow_root:
            return Path(base).resolve()
        raise HTTPException(status_code=400, detail="Path is required")

    # Normalize backslashes to forward slashes for consistent checks
    rel_norm = rel_str.replace("\\", "/")

    # Disallow absolute or root-relative paths
    if rel_norm.startswith("/"):
        raise HTTPException(status_code=400, detail="Absolute paths are not allowed")
    if Path(rel_str).is_absolute():
        raise HTTPException(status_code=400, detail="Absolute paths are not allowed")

    # Reject path components that are clearly malicious (.. traversal)
    if ".." in rel_norm.split("/"):
        raise HTTPException(status_code=400, detail="Path traversal is not allowed")

    base_path = Path(base).resolve()
    target = (base_path / rel_str).resolve()

    # Use relative_to() — raises ValueError if target is outside base_path
    try:
        target.relative_to(base_path)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path traversal is not allowed")

    # F-17 defense-in-depth: reject if any intermediate component (or the
    # target itself) is a symlink. We walk from base_path → target so we
    # catch a symlinked directory anywhere along the chain. Uses the
    # non-resolved (literal) path because Path.resolve() collapses symlinks.
    literal_target = base_path / rel_str
    walker = base_path
    for part in literal_target.relative_to(base_path).parts:
        walker = walker / part
        try:
            if walker.is_symlink():
                raise HTTPException(
                    status_code=400,
                    detail="Symlinked paths are not allowed",
                )
        except (OSError, PermissionError):
            # If we can't even stat the component, treat that as the same
            # outcome as a missing intermediate (which the caller may handle).
            break

    return target


def _format_file_manager_target(root_key: str, relative: str = "") -> str:
    rel = str(relative or "").replace("\\", "/").strip().lstrip("/")
    return f"{root_key}:/{rel}" if rel else f"{root_key}:/"


def _resolve_editable_file_target(base: str, root_key: str, relative: str) -> tuple[Path, str]:
    target = _safe_resolve(base, relative)
    target_label = _format_file_manager_target(root_key, relative)
    if target.exists() and target.is_dir():
        raise HTTPException(status_code=400, detail=f"Path {target_label} is a directory")
    if target.suffix.lower() not in _FM_EDITABLE_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type for {target_label} is not editable")
    return target, target_label


class FileWriteBody(BaseModel):
    content: str


class FileDeleteBody(BaseModel):
    root: str
    paths: list[str]


@router.get("/servers/{server_id}/files/roots")
async def list_file_roots(server_id: str, current_user: dict = Depends(_require_servers)):
    """Return the available filesystem roots for a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    # Compute troubleshooting details once and share across all three root lookups
    # to avoid redundant filesystem scans and mount/volume checks per request.
    details = _derive_troubleshooting(server)

    roots = []
    for key, label in [("config", "Configs"), ("profile", "Profile"), ("workshop", "Workshop")]:
        try:
            path = _resolve_server_root(server, key, details=details)
            exists = Path(path).is_dir()
        except HTTPException:
            exists = False
        roots.append({"key": key, "label": label, "exists": exists})
    return roots


@router.get("/servers/{server_id}/files/browse")
async def browse_server_files(
    server_id: str,
    root: str = Query("config", description="Root: config, profile, or workshop"),
    path: str = Query("", description="Relative path within the root"),
    current_user: dict = Depends(_require_servers),
):
    """Browse files and directories under a server root."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = _resolve_server_root(server, root)
    target = _safe_resolve(base, path, allow_root=True)
    target_label = _format_file_manager_target(root, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Cannot find path {target_label}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Path {target_label} is not a directory")

    entries = []
    try:
        for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            relative = str(child.relative_to(Path(base).resolve()))
            entry = {
                "name": child.name,
                "path": relative,
                "is_dir": child.is_dir(),
            }
            if not child.is_dir():
                try:
                    stat = child.stat()
                    entry["size"] = stat.st_size
                    entry["modified"] = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
                except OSError:
                    entry["size"] = 0
                    entry["modified"] = None
                suffix = child.suffix.lower()
                size = entry.get("size", 0)
                # editable: text type small enough to load into the editor + save.
                entry["editable"] = suffix in _FM_EDITABLE_EXTENSIONS and size <= _FM_MAX_FILE_SIZE
                # viewable: a text type; large files are viewed through bounded tail reads.
                entry["viewable"] = suffix in _FM_VIEWABLE_EXTENSIONS
                # every file can be downloaded (read-only, non-destructive).
                entry["downloadable"] = True
            entries.append(entry)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied reading directory")

    return {
        "root": root,
        "path": path or "",
        "entries": entries,
    }


@router.get("/servers/{server_id}/files/read")
async def read_server_file(
    server_id: str,
    root: str = Query(..., description="Root: config, profile, or workshop"),
    path: str = Query(..., description="Relative path to file"),
    current_user: dict = Depends(_require_servers),
    tail_bytes: Annotated[Optional[int], Query(ge=1, description="Read only this many bytes before `end`")] = None,
    end: Annotated[Optional[int], Query(ge=0, description="Byte offset the tail window ends at (default: end of file)")] = None,
):
    """Read the content of a text file under a server root.

    With ``tail_bytes`` it returns a window of whole lines that ends at ``end``, for
    paging backwards through a large log; ``offset`` is where the window starts.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = _resolve_server_root(server, root)
    target = _safe_resolve(base, path)
    target_label = _format_file_manager_target(root, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Cannot find file {target_label}")
    if not target.is_file():
        raise HTTPException(status_code=400, detail=f"Path {target_label} is not a file")
    suffix = target.suffix.lower()
    if suffix not in _FM_VIEWABLE_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"File type for {target_label} cannot be viewed as text — download it instead",
        )

    try:
        size = target.stat().st_size
    except OSError:
        size = 0

    if tail_bytes is not None:
        return _read_tail_window(target, root, path, size, tail_bytes, end)

    if size > _FM_MAX_VIEW_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File is too large to view ({size} bytes, max {_FM_MAX_VIEW_SIZE}) — download it instead",
        )

    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File contains invalid UTF-8 and cannot be displayed as text")
    except (PermissionError, OSError) as exc:
        raise HTTPException(status_code=403, detail=f"Cannot read file: {exc}")

    # editable means the caller may save it back: small enough + an editable type.
    editable = suffix in _FM_EDITABLE_EXTENSIONS and size <= _FM_MAX_FILE_SIZE

    return {
        "root": root,
        "path": path,
        "name": target.name,
        "content": content,
        "size": size,
        "editable": editable,
        "modified": datetime.fromtimestamp(target.stat().st_mtime, tz=timezone.utc).isoformat(),
    }


def _read_tail_window(target: Path, root: str, path: str, size: int, tail_bytes: int, end: Optional[int]) -> dict:
    window_end = size if end is None else min(end, size)
    start = max(0, window_end - min(tail_bytes, _FM_MAX_TAIL_BYTES))
    try:
        with target.open("rb") as handle:
            handle.seek(start)
            chunk = handle.read(window_end - start)
            modified = os.fstat(handle.fileno()).st_mtime
    except (PermissionError, OSError) as exc:
        raise HTTPException(status_code=403, detail=f"Cannot read file: {exc}")
    if start > 0:
        # Drop the partial first line so the window starts on a line boundary, unless
        # that would empty it (a line longer than the window) and stop paging.
        newline = chunk.find(b"\n")
        if newline != -1 and newline + 1 < len(chunk):
            chunk = chunk[newline + 1:]
            start += newline + 1
    return {
        "root": root,
        "path": path,
        "name": target.name,
        # Logs can hold stray non-UTF-8 bytes; a viewer should still show the rest.
        "content": chunk.decode("utf-8", errors="replace"),
        "size": size,
        "offset": start,
        "end": window_end,
        "truncated": start > 0,
        "editable": False,
        "modified": datetime.fromtimestamp(modified, tz=timezone.utc).isoformat(),
    }


@router.get("/servers/{server_id}/files/download")
async def download_server_file(
    server_id: str,
    root: str = Query(..., description="Root: config, profile, or workshop"),
    path: str = Query(..., description="Relative path to file"),
    current_user: dict = Depends(_require_servers),
):
    """Stream any single file under a server root for download.

    Read-only and non-destructive. Unlike read, this is NOT restricted to text types or a size cap —
    operators need to retrieve every artifact the container generates, including
    large logs, crash dumps, and binaries (.pbo/.paa/.bin). Path-traversal and
    symlink escapes are still rejected by `_safe_resolve`.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = _resolve_server_root(server, root)
    target = _safe_resolve(base, path)
    target_label = _format_file_manager_target(root, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Cannot find file {target_label}")
    if not target.is_file():
        raise HTTPException(status_code=400, detail=f"Path {target_label} is not a file")

    await log_audit(
        user_id=current_user["id"],
        action_type="file_download",
        resource_type="server",
        resource_id=server_id,
        metadata={"root": root, "path": path},
    )

    return FileResponse(
        path=str(target),
        media_type="application/octet-stream",
        filename=target.name,
    )


def _zip_folder_to_temp(source: Path) -> tuple[str, int]:
    """Zip *source* recursively into a temp file, returning (temp_path, file_count).

    Symlinks are never followed (no escape out of the root, no loops). Enforces
    the file-count and total-uncompressed-size guards, raising HTTPException(400)
    if exceeded. Cleans up the partial temp file on any failure.
    """
    tmp = tempfile.NamedTemporaryFile(prefix="fm-zip-", suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()

    total_bytes = 0
    file_count = 0
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for dirpath, dirnames, filenames in os.walk(source, followlinks=False):
                # Drop symlinked subdirectories so the walk can't leave the tree.
                dirnames[:] = [d for d in dirnames if not Path(dirpath, d).is_symlink()]
                for filename in filenames:
                    file_path = Path(dirpath, filename)
                    if file_path.is_symlink() or not file_path.is_file():
                        continue
                    try:
                        size = file_path.stat().st_size
                    except OSError:
                        continue
                    file_count += 1
                    total_bytes += size
                    if file_count > _FM_MAX_ZIP_FILES:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Folder has too many files to zip (> {_FM_MAX_ZIP_FILES}). "
                                "Download individual files instead."
                            ),
                        )
                    if total_bytes > _FM_MAX_ZIP_SIZE:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Folder is too large to zip (> {_FM_MAX_ZIP_SIZE} bytes). "
                                "Download individual files instead."
                            ),
                        )
                    archive.write(file_path, arcname=str(file_path.relative_to(source)))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    return tmp_path, file_count


@router.get("/servers/{server_id}/files/download-folder")
async def download_server_folder(
    server_id: str,
    root: str = Query(..., description="Root: config, profile, or workshop"),
    path: str = Query("", description="Relative path to folder (empty = root)"),
    current_user: dict = Depends(_require_servers),
):
    """Stream a whole folder as a ZIP archive.

    Read-only and non-destructive. Guards against oversized
    archives. Symlinks inside the tree are skipped so the archive can never
    contain content from outside the server root.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = _resolve_server_root(server, root)
    target = _safe_resolve(base, path, allow_root=True)
    target_label = _format_file_manager_target(root, path)

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Cannot find path {target_label}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Path {target_label} is not a directory")

    tmp_path, file_count = await asyncio.to_thread(_zip_folder_to_temp, target)

    await log_audit(
        user_id=current_user["id"],
        action_type="folder_download",
        resource_type="server",
        resource_id=server_id,
        metadata={"root": root, "path": path, "file_count": file_count},
    )

    download_name = f"{target.name or root}.zip"
    return FileResponse(
        path=tmp_path,
        media_type="application/zip",
        filename=download_name,
        background=BackgroundTask(lambda: os.path.exists(tmp_path) and os.unlink(tmp_path)),
    )


@router.put("/servers/{server_id}/files/write")
async def write_server_file(
    server_id: str,
    body: FileWriteBody,
    root: str = Query(..., description="Root: config, profile, or workshop"),
    path: str = Query(..., description="Relative path to file"),
    current_user: dict = Depends(_require_servers),
):
    """Write content to a text file under a server root."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = _resolve_server_root(server, root)
    target, target_label = _resolve_editable_file_target(base, root, path)
    if len(body.content.encode("utf-8")) > _FM_MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"Content exceeds maximum size ({_FM_MAX_FILE_SIZE} bytes)")

    try:
        write_text_with_permission_repair(target, body.content)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied writing file")

    await log_audit(
        user_id=current_user["id"],
        action_type="file_edit",
        resource_type="server",
        resource_id=server_id,
        metadata={"root": root, "path": path, "size": len(body.content)},
    )

    return {
        "message": "File saved successfully",
        "root": root,
        "path": path,
        "size": len(body.content),
    }


def _rmtree_collect(target: Path, sink: list) -> None:
    """Use the shared host repair and retain per-entry failure reporting."""
    try:
        remove_tree_with_permission_repair(target)
    except OSError as exc:
        sink.append(str(exc))


def _unlink_with_retry(target: Path) -> None:
    unlink_with_permission_repair(target)


def _remove_fs_entry(target: Path) -> Optional[str]:
    """Delete a file/dir/symlink, returning an error string or None on success.

    Directories are removed recursively. Per-file rmtree failures are collected
    rather than aborting on the first one, so the real OS reason (EACCES when
    the running container recreated files as root, EBUSY on a live mount) is
    surfaced instead of a bare exception.
    """
    try:
        if not target.exists():
            if target.is_symlink():
                _unlink_with_retry(target)
                return None
            return "Not found"
        if target.is_dir() and not target.is_symlink():
            rmtree_errors: list[str] = []
            _rmtree_collect(target, rmtree_errors)
            if rmtree_errors:
                return "; ".join(rmtree_errors[:3])
            return None
        _unlink_with_retry(target)
        return None
    except (PermissionError, OSError) as exc:
        return str(exc)


def _mod_purge_target_dirs(server: dict) -> list[Path]:
    """Resolve every directory whose immediate children are downloaded mods.

    Reforger writes mod GUID folders directly under ARMA_WORKSHOP_DIR, but
    depending on engine version / image they can also land in an ``addons``
    (or ``Addons``) subfolder of the workshop or profile root. The original
    purge only cleared the top level of ``workshop``, so when a mod lived under
    one of those subfolders the purge found nothing, deleted nothing, and
    reported success — exactly the "goes through but files remain" symptom.

    The profile *root* is intentionally never returned: it holds configs, logs
    and SAT data that must survive a mod purge. Only its ``addons`` subfolders
    are eligible. Directories nested inside another returned directory are
    dropped, since clearing the parent already removes them.
    """
    candidates: list[Path] = []

    # Workshop root: the primary, canonical mod store.
    try:
        candidates.append(Path(_resolve_server_root(server, "workshop")))
    except HTTPException:
        pass

    # addons/Addons subfolders under either root (never the profile root itself).
    for root_key in ("workshop", "profile"):
        try:
            base = Path(_resolve_server_root(server, root_key))
        except HTTPException:
            continue
        for sub in ("addons", "Addons"):
            candidates.append(base / sub)

    resolved: list[Path] = []
    seen: set[Path] = set()
    for cand in candidates:
        try:
            rp = cand.resolve()
        except OSError:
            continue
        if rp.is_dir() and rp not in seen:
            seen.add(rp)
            resolved.append(rp)

    # Drop any directory whose contents a broader target already clears.
    return [d for d in resolved if not any(other != d and other in d.parents for other in resolved)]


@router.post("/servers/{server_id}/mods/files/purge")
async def purge_server_mod_files(
    server_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Delete every downloaded mod from the server's workshop/addon folders.

    Destructive: removes all immediate entries under each resolved mod root so
    the server re-downloads its mods on next start. The roots themselves are
    preserved.
    Files locked by a running container may fail to delete — those are reported
    per-entry rather than aborting the whole purge.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    # Guard against a still-running container regardless of the stored status.
    # If the container is actually up, it holds/recreates the mod files, so a
    # purge would either fail on locks or have its files re-downloaded moments
    # later — the "I stopped it but nothing deletes" symptom. Check the live
    # Docker state, not the DB status field (which can be stale / "stuck").
    container_name = server.get("container_name")
    if container_name:
        try:
            from services.reforger_orchestrator import docker_agent
            status = await docker_agent.get_container_status(container_name)
        except Exception:
            status = None
        if status and status.get("running"):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Server container '{container_name}' is still running. Stop the "
                    "server fully before removing mods — otherwise the files are locked "
                    "or get re-downloaded immediately."
                ),
            )

    purge_dirs = _mod_purge_target_dirs(server)
    if not purge_dirs:
        raise HTTPException(
            status_code=400,
            detail="Server has no workshop/addon folder configured or it is not accessible.",
        )

    children: list[Path] = []
    for directory in purge_dirs:
        try:
            children.extend(sorted(directory.iterdir()))
        except (OSError, PermissionError) as exc:
            raise HTTPException(status_code=400, detail=f"Cannot read {directory}: {exc}")

    scanned = [str(d) for d in purge_dirs]


    deleted: list[str] = []
    errors: list[dict] = []
    for target in children:
        err = _remove_fs_entry(target)
        if err:
            errors.append({"path": target.name, "error": err})
        else:
            deleted.append(target.name)

    if errors:
        logger.warning(
            "Mod purge on server %s (scanned %s): %d removed, %d failed: %s",
            server_id, scanned, len(deleted), len(errors),
            "; ".join(f"{e['path']} ({e['error']})" for e in errors[:5]),
        )
    else:
        logger.info(
            "Mod purge on server %s (scanned %s): %d mod(s) removed",
            server_id, scanned, len(deleted),
        )

    await log_audit(
        user_id=current_user["id"],
        action_type="mod_files_purge",
        resource_type="server",
        resource_id=server_id,
        metadata={"deleted": deleted, "errors": errors, "scanned_paths": scanned},
    )

    return {
        "message": f"Removed {len(deleted)} mod(s)",
        "deleted": deleted,
        "errors": errors,
        "count": len(deleted),
        "scanned_paths": scanned,
    }


@router.post("/servers/{server_id}/files/delete")
async def delete_server_files(
    server_id: str,
    body: FileDeleteBody,
    current_user: dict = Depends(_require_servers),
):
    """Delete one or more files/directories under a server root.

    Directories are removed recursively so an operator can clear out a mod
    folder in one action. Unlike read/write, deletion is NOT restricted to
    editable extensions — mod folders hold binaries (.pbo, .bin, .paa) that
    legitimately need clearing when the game or a mod updates. Path-traversal
    and symlink escapes are still rejected by `_safe_resolve`, and the server
    root itself can never be the target.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    if not body.paths:
        raise HTTPException(status_code=400, detail="No paths provided")

    base = _resolve_server_root(server, body.root)
    base_resolved = Path(base).resolve()

    # Resolve + validate every target up front so a malformed/escaping path
    # fails the whole batch before anything is removed from disk.
    targets: list[tuple[str, Path]] = []
    for rel in body.paths:
        target = _safe_resolve(base, rel)
        if target == base_resolved:
            raise HTTPException(status_code=400, detail="Refusing to delete the server root")
        targets.append((rel, target))


    deleted: list[str] = []
    errors: list[dict] = []
    for rel, target in targets:
        error = _remove_fs_entry(target)
        if error:
            errors.append({"path": rel, "error": error})
        else:
            deleted.append(rel)

    if errors:
        logger.warning(
            "File delete on server %s root=%s: %d removed, %d failed: %s",
            server_id,
            body.root,
            len(deleted),
            len(errors),
            "; ".join(f"{e['path']} ({e['error']})" for e in errors[:5]),
        )
    else:
        logger.info(
            "File delete on server %s root=%s: %d item(s) removed",
            server_id,
            body.root,
            len(deleted),
        )

    await log_audit(
        user_id=current_user["id"],
        action_type="file_delete",
        resource_type="server",
        resource_id=server_id,
        metadata={"root": body.root, "deleted": deleted, "errors": errors},
    )

    return {
        "message": f"Deleted {len(deleted)} item(s)",
        "root": body.root,
        "deleted": deleted,
        "errors": errors,
        "count": len(deleted),
    }


@router.post("/servers/{server_id}/files/validate")
async def validate_server_file(
    server_id: str,
    body: FileWriteBody,
    root: str = Query(..., description="Root: config, profile, or workshop"),
    path: str = Query(..., description="Relative path to file"),
    current_user: dict = Depends(_require_servers),
):
    """Validate and format draft content for an editable server file."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = _resolve_server_root(server, root)
    target, _ = _resolve_editable_file_target(base, root, path)
    if len(body.content.encode("utf-8")) > _FM_MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"Content exceeds maximum size ({_FM_MAX_FILE_SIZE} bytes)")

    result = validate_and_format_file_content(path or target.name, body.content)
    return {
        **result,
        "root": root,
        "path": path,
        "name": target.name,
    }


@router.post("/servers/{server_id}/files/ai-assist")
async def ai_assist_server_file(
    server_id: str,
    body: FileWriteBody,
    root: str = Query(..., description="Root: config, profile, or workshop"),
    path: str = Query(..., description="Relative path to file"),
    current_user: dict = Depends(_require_servers),
    _rate: None = Depends(_ai_assist_rate_limit),
):
    """Use OpenAI to review and repair draft file content without saving it."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = _resolve_server_root(server, root)
    target, _ = _resolve_editable_file_target(base, root, path)
    if len(body.content.encode("utf-8")) > _FM_MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"Content exceeds maximum size ({_FM_MAX_FILE_SIZE} bytes)")

    try:
        # Resolve via routes.servers so tests that monkeypatch the parent
        # module's binding continue to work without test-side churn.
        from routes import servers as _servers
        result = await _servers.assist_file_content(path or target.name, body.content)
    except FileManagerAIUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileManagerAIError as exc:
        logger.warning("File manager AI assist failed for %s: %s", target.name, exc)
        raise HTTPException(status_code=502, detail="AI assist failed. Please try again later.") from exc

    await log_audit(
        user_id=current_user["id"],
        action_type="file_ai_assist",
        resource_type="server",
        resource_id=server_id,
        metadata={
            "root": root,
            "path": path,
            "changed": result.get("changed", False),
        },
    )

    return {
        **result,
        "root": root,
        "path": path,
        "name": target.name,
    }


# ── Addon configs ────────────────────────────────────────────────────────────
# Reforger addons each keep their own JSON config under the server's profile
# tree, so changing one setting means hunting through the file manager for the
# right file. This surfaces them as one list.
#
# The hard part is signal-to-noise. On the busiest live server the profile tree
# holds 174 .json files, of which roughly 18 are actually settings — the rest
# are per-player kit loadouts (GRS_Locker/players/**), radio persistence, saved
# map drawings, and engine savepoint metadata. Listing them flat would bury the
# thing you came to edit, so entries are classified and the UI defaults to
# settings only.

# Directory names whose contents are per-player or engine state, never settings.
_ADDON_DATA_DIRS = {"players", "savingmarkers", "radiopersistence", ".save", "logs"}

# Filename stems that mark a file as a settings file rather than state.
_ADDON_SETTINGS_HINTS = ("config", "settings", "defaults", "_cfg")

# A folder with one of these names holds that addon's configuration, whatever
# the files inside are called (SHS_DriveBy/configs/shs_driveby.json).
_ADDON_CONFIG_DIRS = {"config", "configs", "settings"}

# Runtime state that sits beside the configs and would otherwise pass the
# depth rule — e.g. ServerAdminTools_Stats.json next to ServerAdminTools_Config.json.
_ADDON_STATE_HINTS = ("_stats", "_cache", "_persist", "ownertoken")

# Bound the walk so a runaway tree cannot stall the request.
_ADDON_SCAN_MAX_DEPTH = 6
_ADDON_SCAN_MAX_FILES = 2000


def _classify_addon_config(relative: str, name: str) -> str:
    """Classify a discovered .json file as settings, data, or backup.

    Order matters. An explicit settings name has to outrank the data-directory
    rule, because addons mix the two in one folder: SavingMarkers/ holds both
    SM_Config.json and a pile of SM_Drawings_*.json map dumps. A parent folder
    literally named `config`/`configs` counts as the same signal, which is how
    SHS_DriveBy/configs/shs_driveby.json is reached.
    """
    lowered = name.lower()
    # `RealisticStaminaSystem.bak.json`, `Something.json.bak-preFinalize`
    if ".bak" in lowered or lowered.endswith(".orig.json"):
        return "backup"

    parts = [p.lower() for p in relative.replace("\\", "/").split("/")[:-1]]
    stem = lowered[:-5] if lowered.endswith(".json") else lowered

    if any(hint in stem for hint in _ADDON_STATE_HINTS):
        return "data"
    if any(hint in stem for hint in _ADDON_SETTINGS_HINTS):
        return "settings"
    if any(part in _ADDON_CONFIG_DIRS for part in parts):
        return "settings"

    if any(part in _ADDON_DATA_DIRS or part.startswith(".") for part in parts):
        return "data"

    # A loose .json sitting directly in an addon's own folder (or at the root of
    # the profile) is that addon's config by convention — e.g. dpl.json,
    # GRS_ATAK/grs_atak.json.
    return "settings" if len(parts) <= 2 else "data"


def _addon_label(relative: str) -> str:
    """The addon a config belongs to — its top folder, or 'General' at root."""
    parts = relative.replace("\\", "/").split("/")
    return parts[0] if len(parts) > 1 else "General"


@router.get("/servers/{server_id}/addon-configs")
async def list_addon_configs(
    server_id: str,
    include: str = Query("settings", description="settings | all"),
    current_user: dict = Depends(_require_servers),
):
    """List addon JSON configs under the server's profile tree.

    Reads only metadata — contents are fetched per file through the existing
    `files/read`, and saved through `files/write`, so the root-owned-file
    permission repair and audit logging all apply unchanged.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    base = Path(_resolve_server_root(server, "profile")).resolve()
    if not base.is_dir():
        return {"root": "profile", "entries": [], "truncated": False, "counts": {}}

    entries = []
    truncated = False
    counts = {"settings": 0, "data": 0, "backup": 0}

    def _walk(directory: Path, depth: int) -> None:
        nonlocal truncated
        if depth > _ADDON_SCAN_MAX_DEPTH or truncated:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except (OSError, PermissionError):
            return
        for child in children:
            if len(entries) >= _ADDON_SCAN_MAX_FILES:
                truncated = True
                return
            try:
                if child.is_dir():
                    _walk(child, depth + 1)
                    continue
                if child.suffix.lower() != ".json":
                    continue
                relative = str(child.relative_to(base)).replace("\\", "/")
                kind = _classify_addon_config(relative, child.name)
                counts[kind] = counts.get(kind, 0) + 1
                if include != "all" and kind != "settings":
                    continue
                stat = child.stat()
                entries.append({
                    "addon": _addon_label(relative),
                    "name": child.name,
                    "path": relative,
                    "kind": kind,
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    # Mirrors the file manager's rule so the UI can disable
                    # editing for anything it could not save anyway.
                    "editable": stat.st_size <= _FM_MAX_FILE_SIZE,
                })
            except (OSError, PermissionError, ValueError):
                continue

    _walk(base, 0)
    entries.sort(key=lambda e: (e["addon"].lower(), e["name"].lower()))
    return {
        "root": "profile",
        "entries": entries,
        "truncated": truncated,
        "counts": counts,
    }
