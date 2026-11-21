"""Atomic file-write helpers.

Direct ``open(path, 'w')`` or ``Path.write_text`` leaves a window where two
concurrent writers can interleave and produce a partially-written file.
``os.replace`` is atomic on both POSIX and Windows (NTFS), so writing to a
sibling temp file and renaming gives all-or-nothing semantics.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Union

PathLike = Union[str, os.PathLike[str]]


def atomic_write_text(
    path: PathLike,
    content: str,
    *,
    encoding: str = "utf-8",
    mode: int = 0o600,
) -> Path:
    """Write ``content`` to ``path`` atomically.

    Writes to a temp file in the same directory, fsyncs, then ``os.replace``
    onto the target. Returns the resolved target Path.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(
        prefix=target.name + ".",
        suffix=".tmp",
        dir=str(target.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding=encoding) as handle:
            handle.write(content)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                # fsync is best-effort; not all filesystems support it.
                pass
        try:
            os.chmod(tmp_name, mode)
        except OSError:
            # chmod is best-effort on Windows; ignore permission failures.
            pass
        os.replace(tmp_name, target)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return target
