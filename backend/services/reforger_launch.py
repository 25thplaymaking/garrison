"""Run the upstream Reforger image launcher with diagnostic throws enabled.

The acemod image hard-codes ``-nothrow`` in its launcher and does not expose an
environment switch for it.  Keep using the image's install, configuration,
signal, and health-check behavior; only filter that one engine argument at the
final subprocess boundary.  Both published launcher layouts are supported so
an existing cached image can still be started safely.
"""

from __future__ import annotations

import importlib.util
import os
import runpy
import subprocess
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Optional

UPSTREAM_LAUNCH_PATHS = ("/app/launch.py", "/launch.py")

# Set by the orchestrator when the server has "raise the call-target limit" on.
SCRIPT_LIMIT_PATCH_ENV = "GARRISON_SCRIPT_LIMIT_PATCH"
# The patch module sits next to this file, in the repo and in the container.
SCRIPT_LIMIT_PATCH_PATH = Path(__file__).with_name("reforger_script_limit_patch.py")
SERVER_BINARY_PREFIX = "ArmaReforgerServer"
PATCHED_BINARY_SUFFIX = ".calltargets18"

# The upstream launcher downloads/validates the whole game (about 12 GB checked)
# on every container start, so a crash loop re-validates it every half minute.
# Once a start has validated the install, later starts of the same container
# skip it for this long. A game update is picked up after the window, or at
# once by replacing the container (Reconfigure / Update runtime).
INSTALL_SKIP_ENV = "SKIP_INSTALL"
INSTALL_MARKER_NAME = ".garrison-validated"
INSTALL_MAX_AGE_SECONDS = 12 * 3600


def without_nothrow(arguments: Any) -> Any:
    """Return an argv sequence without the exact ``-nothrow`` switch."""

    if not isinstance(arguments, (list, tuple)):
        return arguments
    filtered = [argument for argument in arguments if str(argument).lower() != "-nothrow"]
    return tuple(filtered) if isinstance(arguments, tuple) else filtered


def with_script_limit_patch(arguments: Any, cwd: Any = None) -> Any:
    """Swap the server binary for its call-target-limit patched copy.

    Only the engine's own argv is touched (the upstream launcher also runs
    steamcmd through ``subprocess``). If the patch does not fit this game
    build the stock binary runs and the reason is printed to the container log.
    """

    if not isinstance(arguments, (list, tuple)) or not arguments:
        return arguments
    binary = Path(str(arguments[0]))
    if not binary.name.startswith(SERVER_BINARY_PREFIX):
        return arguments
    if binary.name.endswith(PATCHED_BINARY_SUFFIX):
        return arguments
    resolved = binary if binary.is_absolute() else Path(str(cwd)) / binary if cwd else binary
    try:
        patch_module = _load_script_limit_patch()
        patched = patch_module.ensure_patched_binary(resolved)
    except Exception as exc:  # never block a start over the optional patch
        print(f"[garrison] script limit patch not applied, running the stock binary: {exc}", flush=True)
        return arguments
    print(f"[garrison] script limit patch active: {patched.name} (262,144 call targets)", flush=True)
    replacement = str(patched) if binary.is_absolute() else str(binary.with_name(patched.name))
    if not binary.is_absolute() and str(arguments[0]).startswith("./"):
        replacement = "./" + replacement
    swapped = [replacement, *arguments[1:]]
    return tuple(swapped) if isinstance(arguments, tuple) else swapped


def _load_script_limit_patch():
    spec = importlib.util.spec_from_file_location("reforger_script_limit_patch", SCRIPT_LIMIT_PATCH_PATH)
    if spec is None or spec.loader is None:
        raise FileNotFoundError(f"{SCRIPT_LIMIT_PATCH_PATH} is not mounted")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install_recently_validated(
    install_dir: Path,
    binary_name: str,
    now: Optional[float] = None,
    max_age: float = INSTALL_MAX_AGE_SECONDS,
) -> bool:
    """Whether this container's game install was validated recently enough to reuse."""

    marker = install_dir / INSTALL_MARKER_NAME
    try:
        validated_at = marker.stat().st_mtime
    except OSError:
        return False
    if not (install_dir / binary_name).is_file():
        return False
    age = (time.time() if now is None else now) - validated_at
    return 0 <= age < max_age


def mark_install_validated(install_dir: Path) -> None:
    try:
        (install_dir / INSTALL_MARKER_NAME).write_text(str(int(time.time())), encoding="utf-8")
    except OSError as exc:
        print(f"[garrison] could not record the validated install: {exc}", flush=True)


def is_server_binary(arguments: Any) -> bool:
    if not isinstance(arguments, (list, tuple)) or not arguments:
        return False
    return Path(str(arguments[0])).name.startswith(SERVER_BINARY_PREFIX)


def resolve_upstream_launch_path(
    candidates: Optional[Sequence[str]] = None,
) -> str:
    """Return the first launcher present in the running upstream image."""

    if candidates is None:
        candidates = UPSTREAM_LAUNCH_PATHS
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    checked = ", ".join(candidates)
    raise FileNotFoundError(f"Upstream Reforger launcher not found; checked: {checked}")


def main(launch_path: Optional[str] = None) -> None:
    if launch_path is None:
        launch_path = resolve_upstream_launch_path()

    real_popen = subprocess.Popen

    patch_script_limit = os.environ.get(SCRIPT_LIMIT_PATCH_ENV) == "1"

    install_dir = Path.cwd()
    binary_name = Path(os.environ.get("ARMA_BINARY") or SERVER_BINARY_PREFIX).name
    install_runs = os.environ.get(INSTALL_SKIP_ENV, "") in ("", "false")
    if install_runs and install_recently_validated(install_dir, binary_name):
        os.environ[INSTALL_SKIP_ENV] = "true"
        install_runs = False
        print("[garrison] game install validated recently; skipping the Steam check for this start", flush=True)

    def diagnostic_popen(arguments: Sequence[str], *args: Any, **kwargs: Any):
        # Reaching the engine means the upstream install step finished.
        if install_runs and is_server_binary(arguments):
            mark_install_validated(install_dir)
        arguments = without_nothrow(arguments)
        if patch_script_limit:
            arguments = with_script_limit_patch(arguments, kwargs.get("cwd"))
        return real_popen(arguments, *args, **kwargs)

    subprocess.Popen = diagnostic_popen
    try:
        runpy.run_path(launch_path, run_name="__main__")
    finally:
        subprocess.Popen = real_popen


if __name__ == "__main__":
    main()
