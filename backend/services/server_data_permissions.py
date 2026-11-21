"""Permission repair for container-created files under managed server data."""

from __future__ import annotations

import errno
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Bare-metal installs only (scripts/install-file-manager-perms.sh). In Docker
# the panel runs as root and needs no repair helper.
PERM_REPAIR_HELPER = os.environ.get("PERM_REPAIR_HELPER", "/usr/local/sbin/garrison-fix-perms")

# Never let PATH decide how the backend escalates. The service unit runs with a
# deliberately narrow PATH (its own venv, nothing else), so a bare "sudo" raised
# FileNotFoundError, every repair below silently returned False, and the operator
# was left staring at a raw "[Errno 13] Permission denied" toast for files the
# dashboard was supposed to be able to fix itself. Absolute candidates first;
# a PATH lookup is only a last resort on hosts that install sudo elsewhere.
SUDO_CANDIDATES = ("/usr/bin/sudo", "/bin/sudo", "/usr/local/bin/sudo")


def _running_as_root() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid) and geteuid() == 0


def resolve_sudo() -> Optional[str]:
    """Return an absolute path to an executable sudo, or None if there is none."""
    for candidate in SUDO_CANDIDATES:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("sudo")
    if found and os.path.isabs(found):
        return found
    return None


def repair_readiness() -> tuple[bool, str]:
    """Report whether automatic permission repair can run on this host.

    Used as a startup preflight: an unreachable repair path is invisible until a
    user hits a container-owned file, and then it looks like a backend bug.
    """
    if _running_as_root():
        return True, "running as root; container files are writable without repair"
    sudo = resolve_sudo()
    if sudo is None:
        return False, "no executable sudo at any absolute path"
    if not os.path.exists(PERM_REPAIR_HELPER):
        return False, f"host helper not installed at {PERM_REPAIR_HELPER}"
    return True, f"{sudo} {PERM_REPAIR_HELPER}"


def repair_editable_permissions(path: Path) -> bool:
    """Ask the hardened host helper to make one server-data path writable."""
    sudo = resolve_sudo()
    if sudo is None:
        logger.error(
            "cannot repair server-data permissions for %s: no executable sudo "
            "(tried %s); the backend cannot escalate to the host helper",
            path,
            ", ".join(SUDO_CANDIDATES),
        )
        return False
    if not os.path.exists(PERM_REPAIR_HELPER):
        logger.error(
            "cannot repair server-data permissions for %s: host helper not "
            "installed at %s",
            path,
            PERM_REPAIR_HELPER,
        )
        return False
    try:
        subprocess.run(
            [sudo, "-n", PERM_REPAIR_HELPER, str(path)],
            check=True,
            capture_output=True,
            timeout=15,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("server-data permission repair failed for %s: %s", path, exc)
        return False
    logger.info("repaired server-data permissions for %s", path)
    return True


class _RetryTreeRemoval(Exception):
    """Internal signal that permission repair succeeded and rmtree can retry."""


def _is_permission_error(exc: BaseException) -> bool:
    return isinstance(exc, PermissionError) or getattr(exc, "errno", None) == errno.EACCES


def write_text_with_permission_repair(path: Path, content: str) -> None:
    """Write an already-validated editable path, repairing one blocker once."""
    def write():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    try:
        write()
    except PermissionError:
        if not repair_editable_permissions(path):
            raise
        write()


def unlink_with_permission_repair(path: Path) -> None:
    """Repair the containing directory, never a symlink's destination."""
    try:
        path.unlink()
    except PermissionError:
        if not repair_editable_permissions(path.parent):
            raise
        path.unlink()


def remove_tree_with_permission_repair(path: Path) -> None:
    """Remove a tree, repairing each distinct permission blocker once.

    ``shutil.rmtree`` supplies the complete failing path to its error callback,
    which is essential because the underlying ``PermissionError.filename`` can
    be only a basename when dir-fd traversal is used. The helper remains the
    existing root-owned, strict-inside-server-data boundary; this function never
    widens what it may touch.
    """
    repaired_paths: set[str] = set()

    def _on_error(_func, failing_path, exc):
        if not _is_permission_error(exc):
            raise exc

        target = Path(failing_path)
        repair_key = os.path.normcase(os.path.abspath(str(target)))
        if repair_key in repaired_paths or not repair_editable_permissions(target):
            raise exc

        repaired_paths.add(repair_key)
        raise _RetryTreeRemoval

    while True:
        if not path.exists():
            return
        try:
            if sys.version_info >= (3, 12):
                shutil.rmtree(path, onexc=_on_error)
            else:
                shutil.rmtree(
                    path,
                    onerror=lambda func, failing_path, exc_info: _on_error(
                        func,
                        failing_path,
                        exc_info[1],
                    ),
                )
            return
        except FileNotFoundError:
            if not path.exists():
                return
            raise
        except _RetryTreeRemoval:
            continue
