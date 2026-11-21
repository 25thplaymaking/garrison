"""Snapshot and restore a server's config file around a multi-step change.

A server save writes the config file on disk and then the database. If the
database write fails, the file is put back so the two never disagree.
"""

from __future__ import annotations

import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable

from services.server_data_permissions import repair_editable_permissions
from utils.atomic_write import atomic_write_text


@dataclass(frozen=True)
class FileSnapshot:
    path: Path
    existed: bool
    content: str = ""
    mode: int = 0o600


def _snapshot(path: Path) -> FileSnapshot:
    if path.exists():
        return FileSnapshot(
            path=path,
            existed=True,
            content=path.read_text(encoding="utf-8"),
            mode=stat.S_IMODE(path.stat().st_mode),
        )
    return FileSnapshot(path=path, existed=False)


def snapshot_server_config_file(server: Dict[str, Any]) -> tuple[FileSnapshot, ...]:
    """Capture the managed Reforger config before a cross-store mutation."""
    config_value = str(server.get("config_path") or "").strip()
    if config_value:
        path = Path(config_value)
    else:
        data_root = str(server.get("data_root") or "").strip()
        if not data_root:
            return ()
        from config import SERVER_CONFIG_FILENAME

        path = Path(data_root) / "Configs" / SERVER_CONFIG_FILENAME
    return (_snapshot(path),)


def _write_repairing(path: Path, content: str, *, mode: int) -> None:
    """Write a file, repairing a container-owned folder once if needed."""
    try:
        atomic_write_text(path, content, mode=mode)
    except PermissionError:
        if not repair_editable_permissions(path.parent):
            raise
        atomic_write_text(path, content, mode=mode)


def restore_file_snapshots(snapshots: Iterable[FileSnapshot]) -> None:
    """Put files back the way they were before a failed change."""
    for snapshot in snapshots:
        if snapshot.existed:
            _write_repairing(snapshot.path, snapshot.content, mode=snapshot.mode or 0o600)
            continue
        try:
            snapshot.path.unlink()
        except FileNotFoundError:
            pass
