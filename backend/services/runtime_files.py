"""Make the launch shim files visible to the Docker daemon.

Game containers bind-mount `reforger_launch.py` (and, when enabled, the
script-limit patch). Docker resolves a bind source on the HOST, so the panel's
own file path only works when the panel runs directly on the host. When the
panel runs in a container, its code lives at a path the host does not have.

The server data root is the one folder that has the same path on the host and
inside the panel container, so the shims are copied there (only when they
changed) and mounted from that copy. Works the same on a bare-metal install.
"""

from __future__ import annotations

import os
from pathlib import Path

from config import SERVER_DATA_ROOT

RUNTIME_DIR_NAME = ".garrison-runtime"


def host_visible(name: str) -> str:
    """Copy services/<name> into the data root and return the copy's path."""
    source = Path(__file__).with_name(name)
    content = source.read_bytes()
    target_dir = Path(SERVER_DATA_ROOT) / RUNTIME_DIR_NAME
    target = target_dir / name
    if not target.exists() or target.read_bytes() != content:
        target_dir.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{name}.tmp")
        tmp.write_bytes(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    return str(target)
