"""Crash analysis and one-click remediation for managed Reforger servers.

``GET /servers/{id}/crash-analysis`` names the real cause of a failed boot
(see ``services.crash_analysis``) instead of the last error line, which is
almost always shutdown noise. ``POST /servers/{id}/crash-analysis/rectify``
applies one of the proposed fixes by delegating to the existing routes (the
mod-list save, revision revert, file delete and lifecycle endpoints) so
backups, mod revisions and audit records behave
exactly as they do when an operator makes the same change by hand.
"""

import asyncio
import logging
import re
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

from middleware.rbac import require_permission, Permission
from services import addon_index, crash_analysis
from services import reforger_script_limit_patch as script_limit_patch
from services import reforger_prelaunch
from services.audit_service import log_audit


class _DbProxy:
    """Resolve ``db`` through ``routes.servers`` so its test patches apply here."""

    def __getattr__(self, name):
        from routes import servers as _servers_module
        return getattr(_servers_module.db, name)


db = _DbProxy()
logger = logging.getLogger(__name__)
router = APIRouter()
_require_servers = require_permission(Permission.MANAGE_SERVERS)

_MOD_ID_RE = re.compile(r"^[0-9A-Fa-f]{16}$")
_RUNNING_STATUSES = {"running", "starting", "initializing", "crash_loop", "degraded"}
_RECENT_REVISIONS = 10
RECTIFY_ACTIONS = {
    "remove_mods", "add_mods", "pin_version", "delete_addon",
    "revert_revision", "restart", "stop",
}


def _mod_id(mod: dict) -> str:
    return str(mod.get("modId") or mod.get("mod_id") or mod.get("id") or "").upper()


async def _workshop_names(mod_ids: List[str]) -> dict:
    if not mod_ids:
        return {}
    try:
        rows = await db.workshop_mods.find(
            {"mod_id": {"$in": mod_ids}}, {"_id": 0, "mod_id": 1, "name": 1},
        ).to_list(len(mod_ids))
    except Exception:
        return {}
    return {str(r.get("mod_id", "")).upper(): r.get("name") for r in rows if r.get("name")}


async def _scenario_providers(scenario_id: str) -> List[dict]:
    """Workshop mods whose published scenarios include ``scenario_id``."""
    match = re.match(r"\{([0-9A-Fa-f]{16})\}", scenario_id or "")
    if not match:
        return []
    try:
        rows = await db.workshop_mods.find(
            {"scenarios.scenario_id": {"$regex": f"^\\{{{match.group(1)}\\}}", "$options": "i"}},
            {"_id": 0, "mod_id": 1, "name": 1},
        ).to_list(5)
    except Exception:
        return []
    return [{"mod_id": str(r["mod_id"]).upper(), "name": r.get("name") or r["mod_id"]} for r in rows if r.get("mod_id")]


def _describe_revision_source(source: str) -> str:
    """Plain words for a revision's ``source`` field."""
    source = source or "change"
    if source.startswith("revert_to_v"):
        return f"revert to revision {source[len('revert_to_v'):]}"
    return {"deploy": "save", "mirror": "mirror"}.get(source, source.replace("_", " "))


async def _revision_that_removed(server_id: str, mod_ids: List[str]) -> Optional[dict]:
    """Newest recent mod revision that dropped any of ``mod_ids``.

    The result carries ``newer_count``: how many later revisions an undo
    would also discard.
    """
    wanted = {m.upper() for m in mod_ids}
    if not wanted:
        return None
    try:
        revisions = await db.server_mod_revisions.find(
            {"server_id": server_id},
            {"_id": 0, "version": 1, "source": 1, "changed_at": 1, "changed_by_name": 1, "diff.removed": 1},
        ).sort("version", -1).to_list(_RECENT_REVISIONS)
    except Exception:
        return None
    for index, revision in enumerate(revisions):
        removed = {str(m.get("mod_id", "")).upper() for m in (revision.get("diff") or {}).get("removed") or []}
        if removed & wanted and int(revision.get("version") or 0) > 1:
            return {**revision, "newer_count": index}
    return None


async def _enrich(server: dict, diagnosis: dict) -> dict:
    """Database-backed context the file-only analyzer cannot know."""
    listed = {_mod_id(m) for m in server.get("mods") or []}
    culprits = diagnosis.get("culprits") or []
    actions = diagnosis.get("actions") or []
    primary = diagnosis.get("primary") or {}

    unnamed = [c["mod_id"] for c in culprits if c.get("name") in (None, "", c["mod_id"])]
    names = await _workshop_names(unnamed)
    for culprit in culprits:
        if culprit["mod_id"] in names:
            culprit["name"] = names[culprit["mod_id"]]

    missing_ids: List[str] = [c["mod_id"] for c in culprits if not c.get("in_mod_list")]
    if primary.get("kind") == "scenario_unavailable":
        has_owner = any(c.get("role") == "scenario" for c in culprits)
        providers = [] if has_owner else await _scenario_providers(primary.get("scenario_id") or "")
        for provider in providers:
            if provider["mod_id"] in listed:
                continue
            missing_ids.append(provider["mod_id"])
            actions.insert(0, {
                "type": "add_mods",
                "mod_ids": [provider["mod_id"]],
                "label": f"Add {provider['name']} to the mod list",
                "detail": "The Workshop lists this mod as the publisher of the configured scenario.",
                "restart": True,
            })

    if primary.get("kind") in {"scenario_unavailable", "script_compile_error", "missing_class"}:
        revision = await _revision_that_removed(server["id"], missing_ids)
        if revision:
            version = int(revision["version"])
            source = _describe_revision_source(revision.get("source"))
            newer = int(revision.get("newer_count") or 0)
            action = {
                "type": "revert_revision",
                "revision": version - 1,
                "label": f"Undo the {source} that removed it (restore revision {version - 1})",
                "detail": (
                    f"Revision {version} ({source}"
                    + (f" by {revision['changed_by_name']}" if revision.get("changed_by_name") else "")
                    + (f", {str(revision['changed_at'])[:16].replace('T', ' ')} UTC" if revision.get("changed_at") else "")
                    + ") removed a mod this failure needs."
                    + (f" This also discards the {newer} later mod change(s)." if newer else "")
                ),
                "restart": True,
            }
            if newer and any(a["type"] == "add_mods" for a in actions):
                # Restoring an old snapshot would throw away later work; the
                # targeted add stays the recommendation.
                last_add = max(i for i, a in enumerate(actions) if a["type"] == "add_mods")
                actions.insert(last_add + 1, action)
            else:
                actions.insert(0, action)

    if diagnosis.get("stale"):
        # The server has come online since; these fixes describe a past state.
        diagnosis["suggested_actions_hidden"] = [a for a in actions if a["type"] != "stop"]
        actions = []
    diagnosis["actions"] = actions
    return diagnosis


@router.get("/servers/{server_id}/crash-analysis")
async def get_crash_analysis(
    server_id: str,
    session: Optional[str] = Query(None, max_length=64),
    current_user: dict = Depends(_require_servers),
):
    """Recent boot outcomes plus the root cause of the latest failure."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    if session and not crash_analysis._SESSION_DIR_RE.match(session):
        raise HTTPException(status_code=400, detail="Invalid session name")
    running = server.get("status") in _RUNNING_STATUSES
    try:
        result = await asyncio.to_thread(
            crash_analysis.diagnose_server, server, session=session, running=running,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    if result.get("diagnosis"):
        result["diagnosis"] = await _enrich(server, result["diagnosis"])
    result["server_status"] = server.get("status")
    result.pop("logs_root", None)
    return result


class RectifyRequest(BaseModel):
    type: str
    mod_ids: List[str] = []
    mod_id: Optional[str] = None
    version: Optional[str] = None
    folder: Optional[str] = None
    revision: Optional[int] = None
    restart: bool = False
    session: Optional[str] = None

    @field_validator("type")
    @classmethod
    def _known_type(cls, value: str) -> str:
        if value not in RECTIFY_ACTIONS:
            raise ValueError(f"Unknown action: {value}")
        return value

    @field_validator("mod_ids")
    @classmethod
    def _valid_ids(cls, value: List[str]) -> List[str]:
        cleaned = []
        for item in value:
            if not _MOD_ID_RE.match(item or ""):
                raise ValueError(f"Invalid mod id: {item}")
            if item.upper() not in cleaned:
                cleaned.append(item.upper())
        return cleaned


def _gated(response) -> bool:
    return isinstance(response, JSONResponse) and response.status_code == 202


async def _apply_mod_list(server_id: str, mods: list, current_user: dict):
    from routes import servers as server_routes
    return await server_routes.update_server_mods(
        server_id, server_routes.ModListUpdate(mods=mods), current_user=current_user,
    )


@router.post("/servers/{server_id}/crash-analysis/rectify")
async def rectify_crash(
    server_id: str,
    body: RectifyRequest,
    current_user: dict = Depends(_require_servers),
):
    """Apply one proposed fix, then optionally restart the server.

    Every action re-validates against the live record (a mod being removed
    must still be listed, a folder being deleted must still be an orphan)
    rather than trusting the analysis the browser saw.
    """
    from routes import servers as server_routes
    from routes import servers_files

    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    mods = list(server.get("mods") or [])
    listed = {_mod_id(m): m for m in mods}
    detail: dict = {"type": body.type}
    result = None

    if body.type == "remove_mods":
        if not body.mod_ids:
            raise HTTPException(status_code=400, detail="No mods selected")
        absent = [m for m in body.mod_ids if m not in listed]
        if absent:
            raise HTTPException(status_code=409, detail=f"Not in the mod list: {', '.join(absent)}")
        blocked = [m for m in body.mod_ids if listed[m].get("system_managed")]
        if blocked:
            raise HTTPException(status_code=400, detail="System-managed mods cannot be removed here")
        next_mods = [m for m in mods if _mod_id(m) not in set(body.mod_ids)]
        detail["removed"] = [{"mod_id": m, "name": listed[m].get("name")} for m in body.mod_ids]
        result = await _apply_mod_list(server_id, next_mods, current_user)

    elif body.type == "add_mods":
        if not body.mod_ids:
            raise HTTPException(status_code=400, detail="No mods selected")
        additions = [m for m in body.mod_ids if m not in listed]
        if not additions:
            raise HTTPException(status_code=409, detail="Those mods are already in the mod list")
        names = await _workshop_names(additions)
        new_entries = [{"modId": m, "name": names.get(m) or m} for m in additions]
        detail["added"] = new_entries
        result = await _apply_mod_list(server_id, mods + new_entries, current_user)

    elif body.type == "pin_version":
        mod_id = (body.mod_id or "").upper()
        if mod_id not in listed:
            raise HTTPException(status_code=409, detail="That mod is no longer in the mod list")
        if not body.version or not re.match(r"^[0-9][\w.\-]{0,31}$", body.version):
            raise HTTPException(status_code=400, detail="Invalid version")
        next_mods = [{**m, "version": body.version} if _mod_id(m) == mod_id else m for m in mods]
        detail.update({"mod_id": mod_id, "version": body.version, "previous": listed[mod_id].get("version")})
        result = await _apply_mod_list(server_id, next_mods, current_user)

    elif body.type == "delete_addon":
        mod_id = (body.mod_id or "").upper()
        folder = body.folder or ""
        if not _MOD_ID_RE.match(mod_id) or addon_index.guid_from_folder(folder) != mod_id or "/" in folder or "\\" in folder:
            raise HTTPException(status_code=400, detail="Invalid addon folder")
        if mod_id in listed:
            raise HTTPException(status_code=409, detail="That mod is in the mod list; remove it instead")
        _, addons_dir = crash_analysis.resolve_server_dirs(server)
        if addons_dir is None or not (addons_dir / folder).is_dir():
            raise HTTPException(status_code=404, detail="Addon folder not found")
        addons = await asyncio.to_thread(addon_index.list_addons, addons_dir)
        if crash_analysis.listed_dependents(mod_id, list(listed), addons):
            raise HTTPException(status_code=409, detail="A listed mod depends on it; it is not a leftover")
        workshop_root = Path(str(server.get("workshop_path") or "").replace("\\", "/").rstrip("/"))
        relative = (addons_dir / folder).relative_to(workshop_root).as_posix()
        detail.update({"mod_id": mod_id, "folder": folder})
        result = await servers_files.delete_server_files(
            server_id, servers_files.FileDeleteBody(root="workshop", paths=[relative]), current_user=current_user,
        )

    elif body.type == "revert_revision":
        if not body.revision or body.revision < 1:
            raise HTTPException(status_code=400, detail="Invalid revision")
        detail["revision"] = body.revision
        result = await server_routes.revert_mod_revision(server_id, body.revision, current_user=current_user)

    elif body.type == "restart":
        result = await server_routes.restart_server(server_id, current_user=current_user)
    elif body.type == "stop":
        result = await server_routes.stop_server(server_id, current_user=current_user)

    if _gated(result):
        return result

    restart_result = None
    if body.restart and body.type not in {"restart", "stop"}:
        try:
            restart_result = await server_routes.restart_server(server_id, current_user=current_user)
        except HTTPException as exc:
            restart_result = {"error": exc.detail}
        except Exception as exc:  # the fix itself already landed
            logger.warning("Rectify restart failed for %s: %s", server_id, exc)
            restart_result = {"error": str(exc)}

    await log_audit(
        user_id=current_user["id"],
        action_type="server_crash_rectify",
        resource_type="server",
        resource_id=server_id,
        after={**detail, "session": body.session, "restart": body.restart},
    )
    restart_payload = restart_result
    if isinstance(restart_result, JSONResponse):
        restart_payload = {"status_code": restart_result.status_code}
    return {
        "ok": True,
        "action": detail,
        "result": result if isinstance(result, dict) else None,
        "restart": restart_payload,
    }


@router.get("/servers/{server_id}/script-budget")
async def get_script_budget(
    server_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Script files each mod on the server loads, ranked like a host panel."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    mods = server.get("mods") or []
    names = {_mod_id(m): m.get("name") for m in mods if _mod_id(m) and m.get("name")}
    _, addons_dir = crash_analysis.resolve_server_dirs(server)
    result = await asyncio.to_thread(
        addon_index.script_budget, addons_dir, [_mod_id(m) for m in mods], names,
    )
    result["server_status"] = server.get("status")
    logs_root, _ = crash_analysis.resolve_server_dirs(server)
    hit_session = await asyncio.to_thread(_call_target_limit_session, logs_root)
    patch_on = bool(server.get("script_limit_patch"))
    result["call_target_limit"] = {
        "patch_enabled": patch_on,
        "limit": script_limit_patch.PATCHED_LIMIT if patch_on else script_limit_patch.STOCK_LIMIT,
        "stock_limit": script_limit_patch.STOCK_LIMIT,
        "patched_limit": script_limit_patch.PATCHED_LIMIT,
        # The newest start died at the limit. With the patch already on, the list
        # is past the raised limit too (or the patch did not fit this game build).
        "hit": hit_session is not None,
        "hit_session": hit_session,
    }
    return result


# The engine's own report when a call-target index overflows into its flag bit.
_CALL_TARGET_CRASH_RE = re.compile(
    r"NULL pointer to instance.{0,400}?Function:\s*'#InitGlobals'", re.S,
)
_CRASH_LOG_READ_BYTES = 256 * 1024


def _call_target_limit_session(logs_root: Optional[Path]) -> Optional[str]:
    """Name of the newest log session if that start died at the call-target limit."""
    if logs_root is None:
        return None
    sessions = crash_analysis.list_session_dirs(logs_root)
    if not sessions:
        return None
    newest = sessions[0]
    for name in ("crash.log", "console.log"):
        path = newest / name
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - _CRASH_LOG_READ_BYTES))
                text = handle.read().decode("utf-8", errors="replace")
        except OSError:
            continue
        if _CALL_TARGET_CRASH_RE.search(text):
            return newest.name
    return None


@router.post("/servers/{server_id}/script-budget/check")
async def check_script_budget(
    server_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Dry-run the saved mod list on the stock engine: will it start, can players join?

    Read-only for the server: it runs in its own throwaway container with no
    network and never touches the server's container, config or profile.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    result = await reforger_prelaunch.check_server(server)
    await log_audit(
        user_id=current_user["id"],
        action_type="server_prelaunch_check",
        resource_type="server",
        resource_id=server_id,
        after={"verdict": result.get("verdict"), "checked_mods": result.get("checked_mods")},
    )
    return result


class ScriptLimitRequest(BaseModel):
    enabled: bool
    restart: bool = True


@router.post("/servers/{server_id}/script-limit")
async def set_script_limit_patch(
    server_id: str,
    body: ScriptLimitRequest,
    current_user: dict = Depends(_require_servers),
):
    """Turn the call-target-limit patch on or off, then optionally restart.

    Delegates to the server update and restart routes, so audit behaves as it
    does for any other server setting. The restart replaces
    the container because the switch is part of its environment.
    """
    from routes import servers as server_routes

    result = await server_routes.update_server(
        server_id,
        server_routes.ServerUpdate(script_limit_patch=body.enabled),
        current_user=current_user,
    )
    if _gated(result):
        return result

    restart_payload = None
    if body.restart:
        try:
            restart_result = await server_routes.restart_server(server_id, current_user=current_user)
            restart_payload = (
                {"status_code": restart_result.status_code}
                if isinstance(restart_result, JSONResponse) else {"ok": True}
            )
        except HTTPException as exc:
            restart_payload = {"error": exc.detail}
        except Exception as exc:  # the setting itself already saved
            logger.warning("Script limit restart failed for %s: %s", server_id, exc)
            restart_payload = {"error": str(exc)}
    return {"ok": True, "script_limit_patch": body.enabled, "restart": restart_payload}
