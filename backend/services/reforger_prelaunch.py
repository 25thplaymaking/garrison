"""Pre-launch script check: will this mod list start, before anyone launches it?

The engine's script limits (the 131,072 call-target limit above all, see
``docs/reforger-script-limit-patch.md``) cannot be counted from the mods'
files. So this asks the engine itself: it starts the *stock* server program
with the list in a throwaway container that has no network, lets it compile
and initialise scripts (about 8 seconds), reads the result and removes the
container. Stock on purpose: players' games are stock, so a list that only the
patched server can load is a list nobody can join.

The game files come from a snapshot image of a server's own container
(``docker commit``, which copies the container's files but not its mounts, so
no workshop data and no configs). One snapshot per game build, keyed by the
server binary's hash; older snapshots are removed.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import shlex
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from services import addon_index, crash_analysis
from services.docker_agent import DockerAgent

logger = logging.getLogger(__name__)

docker_agent = DockerAgent()

SNAPSHOT_REPOSITORY = "garrison-prelaunch"
SERVER_BINARY_PATH = "/reforger/ArmaReforgerServer"
BINARY_MAX_BYTES = 200 * 1024 * 1024
# A world every install has; the verdict comes before the world loads.
CHECK_WORLD = "{77C41EA429B6AC35}worlds/GameMaster/GM_Arland.ent"
CHECK_TIMEOUT_SECONDS = 150
CHECK_MEMORY_LIMIT = "12g"
CHECK_NANO_CPUS = 4_000_000_000
_MOD_ID_RE = re.compile(r"^[0-9A-Fa-f]{16}$")

_MARK_CREATED = "Game successfully created"
_MARK_CRASHED = "Application crashed"
_MARK_COMPILE = "Can't compile"
_CALL_TARGET_RE = re.compile(r"NULL pointer to instance.{0,400}?Function:\s*'#InitGlobals'", re.S)
_MODULE_RE = re.compile(r"Module: Game; loaded (\d+)x files; (\d+)x classes")
_SCRIPT_ERROR_RE = re.compile(r"SCRIPT\s+\(E\):\s*(.+)")

def _shim_file_mounts() -> dict:
    """Launch shims, mounted from the host-visible copy (services/runtime_files.py)."""
    from services.runtime_files import host_visible

    return {
        host_visible("reforger_launch.py"): {"bind": "/app/garrison_launch.py", "mode": "ro"},
        host_visible("reforger_script_limit_patch.py"): {"bind": "/app/reforger_script_limit_patch.py", "mode": "ro"},
    }

# One check at a time per backend process: each one runs a full script compile.
_check_lock = asyncio.Lock()


def build_check_script(mod_ids: List[str]) -> str:
    """Shell script run inside the throwaway container.

    Starts the engine, waits for the first decisive line in its console log,
    stops it, and prints the relevant part of the log for the backend to read.
    """
    addons = ",".join(mod_ids)
    engine = (
        f"./ArmaReforgerServer -server {shlex.quote(CHECK_WORLD)} -profile /prof "
        f"-addonsDir /reforger/workshop/addons -addons {shlex.quote(addons)} -maxFPS 30"
    )
    return (
        f"{engine} > /prof/out.txt 2>&1 & p=$!\n"
        "for i in $(seq 1 60); do\n"
        "  sleep 2\n"
        "  c=$(ls /prof/logs/*/console.log 2>/dev/null | head -1)\n"
        f"  [ -n \"$c\" ] && grep -q -e '{_MARK_CRASHED}' -e \"{_MARK_COMPILE}\" -e '{_MARK_CREATED}' \"$c\" && break\n"
        "  kill -0 $p 2>/dev/null || break\n"
        "done\n"
        "sleep 2; kill -9 $p 2>/dev/null\n"
        "c=$(ls /prof/logs/*/console.log 2>/dev/null | head -1)\n"
        "[ -n \"$c\" ] || { echo GARRISON-NO-LOG; tail -5 /prof/out.txt; exit 0; }\n"
        f"grep -e 'Module: Game;' -e '(E)' -e 'Virtual Machine Exception' -e 'Reason:' -e \"Function: '\" "
        f"-e '{_MARK_CRASHED}' -e \"{_MARK_COMPILE}\" -e '{_MARK_CREATED}' -e \"can't be added\" \"$c\" | tail -300\n"
    )


def read_verdict(output: str) -> Dict[str, Any]:
    """Turn the container's output into a verdict the page can show."""
    module = _MODULE_RE.search(output)
    result: Dict[str, Any] = {
        "script_files": int(module.group(1)) if module else None,
        "classes": int(module.group(2)) if module else None,
        "errors": [],
    }
    if _CALL_TARGET_RE.search(output):
        result["verdict"] = "over_call_target_limit"
        return result
    if _MARK_COMPILE in output:
        seen: List[str] = []
        for match in _SCRIPT_ERROR_RE.finditer(output):
            line = match.group(1).strip()
            if line not in seen and "Wrong GUID" not in line:
                seen.append(line)
        result["verdict"] = "compile_error"
        result["errors"] = seen[:8]
        return result
    if _MARK_CRASHED in output:
        result["verdict"] = "crashed"
        return result
    if _MARK_CREATED in output:
        result["verdict"] = "starts"
        return result
    result["verdict"] = "unknown"
    return result


def _mod_id(mod: Dict[str, Any]) -> str:
    return str(mod.get("modId") or mod.get("mod_id") or "").strip().upper()


# Snapshots being built right now, by image name. A snapshot copies about 20 GB
# and takes a couple of minutes, far longer than a request should hang, so it
# is built in the background and the caller is told to come back.
_snapshots_in_progress: Dict[str, "asyncio.Task[None]"] = {}


async def _build_snapshot(container_name: str, tag: str, image: str) -> None:
    try:
        ok, error = await docker_agent.commit_container(container_name, SNAPSHOT_REPOSITORY, tag)
        if not ok:
            logger.warning("Pre-launch snapshot of %s failed: %s", container_name, error)
            return
        for other in await docker_agent.list_image_tags(SNAPSHOT_REPOSITORY):
            if other != image:
                await docker_agent.remove_image(other)
    finally:
        _snapshots_in_progress.pop(image, None)


async def _snapshot_for(container_name: str) -> tuple[Optional[str], bool]:
    """``(image, preparing)`` for the game files of ``container_name``.

    One snapshot per game build. When this build has none yet, building starts
    in the background and ``preparing`` is true.
    """
    binary = await docker_agent.read_container_file(container_name, SERVER_BINARY_PATH, BINARY_MAX_BYTES)
    if not binary:
        return None, False
    tag = hashlib.sha256(binary).hexdigest()[:16]
    image = f"{SNAPSHOT_REPOSITORY}:{tag}"
    if await docker_agent.image_exists(image):
        return image, False
    if image not in _snapshots_in_progress:
        _snapshots_in_progress[image] = asyncio.create_task(_build_snapshot(container_name, tag, image))
    return None, True


async def _any_snapshot() -> Optional[str]:
    tags = await docker_agent.list_image_tags(SNAPSHOT_REPOSITORY)
    return tags[0] if tags else None


async def check_server(server: Dict[str, Any]) -> Dict[str, Any]:
    """Dry-run ``server``'s saved mod list on the stock engine and report."""
    mods = [m for m in (server.get("mods") or []) if m.get("enabled", True) is not False]
    mod_ids = [_mod_id(m) for m in mods if _MOD_ID_RE.match(_mod_id(m))]
    names = {_mod_id(m): m.get("name") or _mod_id(m) for m in mods}
    _, addons_dir = crash_analysis.resolve_server_dirs(server)
    workshop = str(server.get("workshop_path") or "").replace("\\", "/").rstrip("/")
    if addons_dir is None or not workshop:
        return {"verdict": "unavailable", "reason": "This server has no workshop folder yet."}

    addons = await asyncio.to_thread(addon_index.list_addons, addons_dir)
    missing = [names[m] for m in mod_ids if m not in addons]
    if missing:
        return {
            "verdict": "unavailable",
            "reason": "Some mods are not downloaded yet, so the list cannot be loaded for a check. "
                      "Start the server once (or download the mods) and check again.",
            "missing": missing[:20],
            "missing_count": len(missing),
        }

    image, preparing = await _snapshot_for(str(server.get("container_name") or ""))
    if preparing:
        return {
            "verdict": "preparing",
            "reason": "Making a copy of the game install to check with. This takes about two minutes and "
                      "happens once per game update. Check again shortly.",
        }
    image = image or await _any_snapshot()
    if image is None:
        return {
            "verdict": "unavailable",
            "reason": "No installed copy of the game to check with yet. Start any server once; "
                      "its game install is then reused for checks.",
        }

    started = time.monotonic()
    async with _check_lock:
        exit_code, output, error = await docker_agent.run_once(
            image=image,
            name=f"garrison-prelaunch-{str(server.get('id') or 'x')[:8]}",
            command=["/bin/bash", "-c", build_check_script(mod_ids)],
            volumes={
                workshop: {"bind": "/reforger/workshop", "mode": "ro"},
                # The snapshot remembers the server container's single-file mounts as
                # volumes; Docker refuses to start unless a file is mounted there.
                **_shim_file_mounts(),
            },
            tmpfs={"/prof": "rw,size=512m"},
            timeout=CHECK_TIMEOUT_SECONDS,
            mem_limit=CHECK_MEMORY_LIMIT,
            nano_cpus=CHECK_NANO_CPUS,
        )
    result = read_verdict(output)
    result["seconds"] = round(time.monotonic() - started, 1)
    result["checked_mods"] = len(mod_ids)
    if result["verdict"] == "unknown":
        result["reason"] = error or "The engine gave no clear result."
        logger.warning("Pre-launch check for %s was inconclusive (exit %s): %s", server.get("id"), exit_code, output[-400:])
    return result
