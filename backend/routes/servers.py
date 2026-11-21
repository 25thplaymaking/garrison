"""Server Management Portal API routes.

Provides endpoints for managing Docker-based game servers, workshop mods,
mod presets, incidents, mod issue tracking, backups, scheduled actions,
webhooks, and admin notes.  All endpoints require MANAGE_SERVERS permission
(S4 Logistics and S1/Admin).
"""

import json
import logging
import asyncio
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, List, Optional

from fastapi import APIRouter, HTTPException, Depends, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo.errors import DuplicateKeyError

from database import db
from middleware.rbac import require_permission, Permission
from services.audit_service import log_audit
from services import server_capacity
from config import (
    SERVER_PORT_BASE_GAME,
    SERVER_PORT_BASE_QUERY,
    SERVER_PORT_BASE_RCON,
    SERVER_PORT_BLOCK_SIZE,
)
from services.docker_agent import DockerAgent
from services.reforger_orchestrator import (
    NON_READINESS_STAGE_NAMES,
    ProvisioningError,
    apply_runtime_defaults,
    delete_server as orchestrator_delete_server,
    get_diagnostics as orchestrator_get_diagnostics,
    prepare_server_deployment as orchestrator_prepare_server,
    provision_server as orchestrator_provision_server,
    reconfigure_server as orchestrator_reconfigure_server,
    restart_server as orchestrator_restart_server,
    start_server as orchestrator_start_server,
    stop_server as orchestrator_stop_server,
    update_server_runtime as orchestrator_update_server_runtime,
)
from services.server_config_generator import (
    DEFAULT_MOD_NAME,
    SERVER_SAT_REQUIRED_MOD_ID,
    apply_backend_managed_config_fields,
    ensure_required_mods,
    generate_reforger_config,
    normalize_server_config,
    write_config_file,
)
from services.server_notifications import (
    list_server_notifications,
    sync_server_notifications,
)
from services.config_snapshots import (
    restore_file_snapshots,
    snapshot_server_config_file,
)
from services.server_logs import (
    build_log_entries,
    build_log_entry,
    get_recent_server_log_entries,
    parse_log_since,
    record_server_log_event,
    stable_hash,
    stream_server_log_entries,
)
from services.file_manager_tools import (
    FileManagerAIError,
    FileManagerAIUnavailable,
    assist_file_content,
    validate_and_format_file_content,
)
from services.log_streamer import log_streamer
from services.rcon_bridge import bercon_client
from services.server_runtime_host import get_server_runtime_host
from services.sat_config_service import SAT_CONFIG_FILENAME, discover_sat_config, load_sat_config, overlay_baseline_if_configured, save_sat_config
from services.server_watchers import ensure_default_watchers
from services.config_revisions import (
    current_version,
    get_config_revision,
    latest_revision_meta,
    list_config_revisions,
    record_config_revision,
    summarize_config_diff,
)
from models.server import (
    ManagedServer, ServerCreate, ServerUpdate,
    WorkshopMod, WorkshopModCreate,
    ModPreset, ModPresetCreate, ModPresetUpdate,
    ModLoadoutMirrorRequest,
    ServerIncident, IncidentCreate, IncidentResolve,
    ModIssue,
    ServerWatcher, ServerWatcherCreate, ServerWatcherUpdate,
    WatcherDetection,
    ServerBackup,
    ScheduledAction, ScheduledActionCreate, ScheduledActionUpdate,
    WebhookConfig, WebhookConfigCreate,
    ServerNote, ServerNoteCreate,
    SERVER_STATUSES,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# Docker agent instance for container orchestration
_docker = DockerAgent()

# Shorthand dependency for all server-management endpoints
_require_servers = require_permission(Permission.MANAGE_SERVERS)

# Sensitive keys that should be redacted in API responses
_SENSITIVE_ENV_KEYS = {"rcon_password", "password", "admin_password", "steam_password"}

# Config paths whose changes affect container environment variables and thus
# require a full container reconfigure (not just a restart) to take effect.
_ENV_AFFECTING_KEYS = frozenset({"max_fps", "startup_parameters", "script_limit_patch"})
_ENV_AFFECTING_CONFIG_PATHS = frozenset({
    "rcon.password", "rcon.port", "rcon.permission",
})
_RCON_RUNTIME_ENV_FIELDS = (
    ("RCON_PASSWORD", "password"),
    ("RCON_PORT", "port"),
    ("RCON_PERMISSION", "permission"),
)
_MOD_ID_MARKER_RE = re.compile(r"[A-Fa-f0-9]{16}")


def _needs_reconfigure(before_server: dict, updates: dict) -> bool:
    """Return True if any update touches a value that requires container recreation."""
    for key in _ENV_AFFECTING_KEYS:
        if key in updates and updates[key] != before_server.get(key):
            return True
    if "config" not in updates:
        return False
    old_config = before_server.get("config") or {}
    new_config = updates["config"]
    for path in _ENV_AFFECTING_CONFIG_PATHS:
        parts = path.split(".")
        old_val = old_config
        new_val = new_config
        for part in parts:
            old_val = old_val.get(part) if isinstance(old_val, dict) else None
            new_val = new_val.get(part) if isinstance(new_val, dict) else None
        if old_val != new_val:
            return True
    return False


def _expected_rcon_runtime_env(server: dict) -> dict[str, str]:
    config = (server.get("config") or {}).get("rcon") or {}
    ports = server.get("ports") or {}
    return {
        "RCON_PASSWORD": str(config.get("password") or ""),
        "RCON_PORT": str(config.get("port") or ports.get("rcon") or 19999),
        "RCON_PERMISSION": str(config.get("permission") or "admin"),
    }


def _detect_rcon_runtime_drift(server: dict, runtime_env: Optional[dict[str, str]]) -> Optional[dict]:
    if runtime_env is None:
        return None

    expected_env = _expected_rcon_runtime_env(server)
    changed_fields: list[str] = []
    runtime_keys: list[str] = []

    for runtime_key, field_name in _RCON_RUNTIME_ENV_FIELDS:
        expected_value = expected_env[runtime_key]
        runtime_value = runtime_env.get(runtime_key)
        if runtime_value is None:
            changed_fields.append(field_name)
            runtime_keys.append(runtime_key)
            continue
        if str(runtime_value) != expected_value:
            changed_fields.append(field_name)
            runtime_keys.append(runtime_key)

    if not changed_fields:
        return None

    return {
        "code": "runtime_drift",
        "needs_reconfigure": True,
        "changed_fields": sorted(set(changed_fields)),
        "runtime_env_keys": sorted(set(runtime_keys)),
        "detail": (
            "The running container is still using older RCON settings than the dashboard. "
            "Reconfigure the server to recreate the container and sync the active RCON environment."
        ),
    }


async def _get_rcon_runtime_drift(server: dict) -> Optional[dict]:
    container_name = str(server.get("container_name") or "").strip()
    if not container_name:
        return None
    runtime_env = await _docker.get_container_environment(container_name)
    return _detect_rcon_runtime_drift(server, runtime_env)


async def _get_runtime_drift(server: dict) -> Optional[dict]:
    """Detect container-level drift from dashboard settings (max FPS + RCON).

    ``max_fps`` and RCON are baked into container environment at creation, so a
    plain restart never applies them — only a reconfigure (recreate) does. This
    is the persistent counterpart to the save-time ``_needs_reconfigure`` flag:
    it lets the UI keep a lasting "reconfigure required" notice even after a
    page reload, instead of a transient post-save banner that disappears.
    """
    container_name = str(server.get("container_name") or "").strip()
    if not container_name:
        return None
    runtime_env = await _docker.get_container_environment(container_name)
    if runtime_env is None:
        return None

    changed_fields: list[str] = []
    expected_max_fps = str(server.get("max_fps") or 120)
    if str(runtime_env.get("ARMA_MAX_FPS") or "") != expected_max_fps:
        changed_fields.append("max_fps")

    expected_rcon = _expected_rcon_runtime_env(server)
    for runtime_key, field_name in _RCON_RUNTIME_ENV_FIELDS:
        runtime_value = runtime_env.get(runtime_key)
        if runtime_value is None or str(runtime_value) != expected_rcon[runtime_key]:
            changed_fields.append(field_name)

    if not changed_fields:
        return None
    return {
        "code": "runtime_drift",
        "needs_reconfigure": True,
        "changed_fields": sorted(set(changed_fields)),
        "detail": (
            "The running container still uses older runtime settings (max FPS or RCON) "
            "than the dashboard. Reconfigure the server to recreate the container and "
            "apply them."
        ),
    }


def _redact_env(env: dict) -> dict:
    """Return a copy of environment dict with sensitive values masked."""
    if not env:
        return env
    return {
        k: ("***" if k.lower() in _SENSITIVE_ENV_KEYS else v)
        for k, v in env.items()
    }


def _clean_string_list(values: list[str] | None) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        item = str(value or "").strip()
        if not item:
            continue
        marker = item.lower()
        if marker in seen:
            continue
        seen.add(marker)
        cleaned.append(item)
    return cleaned


def _trim_optional_string(value: Any) -> str:
    return str(value or "").strip()


def _normalize_server_contract(server: dict) -> dict:
    """Normalize legacy provisioning statuses into operational/readiness fields."""
    doc = dict(server or {})
    status = doc.get("status")
    deployment_state = doc.get("deployment_state")

    if status == "provisioning_partial":
        doc["status"] = "running"
        doc["deployment_state"] = deployment_state or "created"
        doc["provisioning_state"] = "warning"
        if not (doc.get("provisioning_warnings") or []):
            failed = [
                stage for stage in (doc.get("provisioning_stages") or {}).values()
                if stage.get("status") == "failed"
            ]
            if failed:
                doc["provisioning_warnings"] = [
                    {
                        "stage": stage.get("name", "unknown"),
                        "message": stage.get("error") or stage.get("message") or "Stage completed with warnings",
                    }
                    for stage in failed
                ]
        warning_stages = {
            str(item.get("stage") or "").strip()
            for item in (doc.get("provisioning_warnings") or [])
            if isinstance(item, dict)
        }
        supplemental_only = bool(warning_stages) and warning_stages <= NON_READINESS_STAGE_NAMES
        doc["readiness_state"] = doc.get("readiness_state") or ("ready" if supplemental_only else "degraded")

    if status == "provisioning_failed":
        doc["status"] = "error"
        doc["deployment_state"] = "failed"
        doc["provisioning_state"] = "failed"
        doc["readiness_state"] = "failed"

    if not doc.get("deployment_state"):
        doc["deployment_state"] = "created" if doc.get("status") not in {"error", "deletion_pending"} else "failed"

    if doc.get("status") == "running" and doc.get("provisioning_state") == "warning":
        warning_stages = {
            str(item.get("stage") or "").strip()
            for item in (doc.get("provisioning_warnings") or [])
            if isinstance(item, dict)
        }
        supplemental_only = bool(warning_stages) and warning_stages <= NON_READINESS_STAGE_NAMES
        doc["readiness_state"] = doc.get("readiness_state") or ("ready" if supplemental_only else "degraded")

    return doc


def _redact_config_secrets(config: dict) -> dict:
    """Return a copy of the server config with in-band plaintext secrets masked."""
    if not config:
        return config
    redacted = dict(config)
    rcon = redacted.get("rcon")
    if isinstance(rcon, dict) and rcon.get("password"):
        redacted["rcon"] = {**rcon, "password": "***"}
    game = redacted.get("game")
    if isinstance(game, dict):
        patched_game = dict(game)
        for key in ("password", "passwordAdmin"):
            if patched_game.get(key):
                patched_game[key] = "***"
        redacted["game"] = patched_game
    return redacted


# The mask `_redact_config_secrets` writes. Anything arriving from a client with
# this exact value is a redaction echo, not a real password.
REDACTED_SENTINEL = "***"


def _restore_redacted_config_secrets(incoming: dict, stored: dict) -> dict:
    """Put stored secrets back wherever the client echoed the redaction mask.

    Redacting a secret on read is only half the job. The config editor seeds
    itself from `GET /servers/{id}`, so it holds `"***"` where the passwords
    are; saving any unrelated field then PUTs that mask back and overwrites the
    real admin, join and RCON passwords with three asterisks.

    So a secret field whose incoming value is exactly the mask means "unchanged"
    and is replaced with what is stored. A genuinely new password passes through
    untouched — which does mean `***` cannot be chosen as a password, an
    acceptable trade for not destroying credentials on every save.
    """
    if not isinstance(incoming, dict):
        return incoming
    merged = dict(incoming)
    stored = stored or {}

    stored_rcon = stored.get("rcon") if isinstance(stored.get("rcon"), dict) else {}
    rcon = merged.get("rcon")
    if isinstance(rcon, dict) and rcon.get("password") == REDACTED_SENTINEL:
        merged["rcon"] = {**rcon, "password": stored_rcon.get("password", "")}

    stored_game = stored.get("game") if isinstance(stored.get("game"), dict) else {}
    game = merged.get("game")
    if isinstance(game, dict):
        patched = dict(game)
        for key in ("password", "passwordAdmin"):
            if patched.get(key) == REDACTED_SENTINEL:
                patched[key] = stored_game.get(key, "")
        merged["game"] = patched

    return merged


def _server_response(server: dict) -> dict:
    """Prepare a server document for API response (redact secrets)."""
    if not server:
        return server
    doc = _serialize_doc(_normalize_server_contract(dict(server)))
    doc.pop("_id", None)
    if "environment" in doc:
        doc["environment"] = _redact_env(doc["environment"])
    if "config" in doc:
        doc["config"] = _redact_config_secrets(doc["config"])
    doc.pop("admin_credentials", None)
    return doc


def _mod_id_markers(value: Any) -> set[str]:
    text = str(value or "").strip()
    if not text:
        return set()

    markers = {text.lower()}
    markers.update(match.group(0).lower() for match in _MOD_ID_MARKER_RE.finditer(text))
    return markers


def _resolve_optional_server_root(server: dict, root_key: str, *, details: dict | None = None) -> str:
    try:
        return _resolve_server_root(server, root_key, details=details)
    except HTTPException:
        return ""


def _iter_local_mod_roots(server: dict, *, details: dict | None = None) -> list[Path]:
    details = details or _derive_troubleshooting(server)
    roots: list[Path] = []
    seen: set[Path] = set()

    for root_key in ("workshop", "profile"):
        root_path = _resolve_optional_server_root(server, root_key, details=details)
        if not root_path:
            continue

        for candidate in (Path(root_path), Path(root_path) / "addons", Path(root_path) / "Addons"):
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            if not resolved.is_dir() or resolved in seen:
                continue
            seen.add(resolved)
            roots.append(resolved)

    return roots


def _scan_local_mod_markers(server: dict, *, details: dict | None = None) -> Optional[set[str]]:
    roots = _iter_local_mod_roots(server, details=details)
    if not roots:
        return None

    markers: set[str] = set()
    for root in roots:
        try:
            children = list(root.iterdir())
        except (OSError, PermissionError):
            continue

        for child in children:
            markers.update(_mod_id_markers(child.name))
            if child.is_file():
                markers.update(_mod_id_markers(child.stem))

    return markers


def _annotate_server_mod_install_state(server: dict) -> dict:
    doc = dict(server or {})
    mods = doc.get("mods")
    if not isinstance(mods, list) or not mods:
        return doc

    details = _derive_troubleshooting(doc)
    local_markers = _scan_local_mod_markers(doc, details=details)
    annotated_mods: list[Any] = []

    for mod in mods:
        if not isinstance(mod, dict):
            annotated_mods.append(mod)
            continue

        mod_doc = dict(mod)
        mod_id = _trim_optional_string(mod_doc.get("mod_id") or mod_doc.get("modId"))
        if not mod_id or local_markers is None:
            mod_doc["local_installed"] = None
        else:
            mod_doc["local_installed"] = bool(_mod_id_markers(mod_id) & local_markers)
        annotated_mods.append(mod_doc)

    doc["mods"] = annotated_mods
    return doc


# Loadout mods that still lack a thumbnail after a cache lookup are scraped
# lazily in the background so reads stay fast. Track recent attempts so a hot
# read path does not re-queue the same id (and re-hit the rate-limited scraper)
# on every request.
_WORKSHOP_BACKFILL_COOLDOWN = 300  # seconds
_WORKSHOP_BACKFILL_MAX_IN_FLIGHT = 8
_WORKSHOP_BACKFILL_MAX_TRACKED = 4096

# How long a workshop_mods record nothing has touched is kept around before the
# background sweep may delete it. Long enough that a mod someone browsed, or a
# dependency a loadout names, survives; short enough to bound growth.
_WORKSHOP_PURGE_MAX_AGE_DAYS = 14
_workshop_backfill_attempts: dict[str, float] = {}
_workshop_backfill_active_ids: set[str] = set()
_workshop_backfill_tasks: set[asyncio.Task] = set()


async def _backfill_workshop_thumbnail(mod_id: str, *, force: bool = False) -> None:
    """Background: scrape + cache a mod's metadata so the next read has its logo."""
    try:
        from services.workshop_ingest import fetch_and_store_mod
        await fetch_and_store_mod(mod_id, force_refresh=force)
    except Exception as exc:
        logger.debug("Workshop thumbnail backfill for %s failed: %s", mod_id, exc)


async def _run_workshop_backfill(mod_id: str, *, force: bool = False) -> None:
    try:
        await _backfill_workshop_thumbnail(mod_id, force=force)
    finally:
        _workshop_backfill_active_ids.discard(mod_id)


def _schedule_workshop_backfill(mod_ids: set[str], *, force: bool = False) -> None:
    """Fire-and-forget workshop scrape for mods missing a cached thumbnail.

    Deduped via a short cooldown so repeated reads of the same loadout do not
    queue the same scrape (and burn the rate-limited scrape budget) repeatedly.
    ``force=True`` bypasses the ingest cache — used when a read served a record
    that is stale rather than missing.
    """
    now = time.monotonic()
    expired = [
        mod_id
        for mod_id, attempted_at in _workshop_backfill_attempts.items()
        if now - attempted_at >= _WORKSHOP_BACKFILL_COOLDOWN
    ]
    for mod_id in expired:
        _workshop_backfill_attempts.pop(mod_id, None)
    if len(_workshop_backfill_attempts) > _WORKSHOP_BACKFILL_MAX_TRACKED:
        oldest = sorted(_workshop_backfill_attempts, key=_workshop_backfill_attempts.get)
        for mod_id in oldest[:len(_workshop_backfill_attempts) - _WORKSHOP_BACKFILL_MAX_TRACKED]:
            _workshop_backfill_attempts.pop(mod_id, None)

    capacity = max(0, _WORKSHOP_BACKFILL_MAX_IN_FLIGHT - len(_workshop_backfill_active_ids))
    for mod_id in sorted(mod_ids):
        if capacity <= 0:
            break
        if mod_id in _workshop_backfill_active_ids:
            continue
        attempted_at = _workshop_backfill_attempts.get(mod_id)
        if attempted_at is not None and now - attempted_at < _WORKSHOP_BACKFILL_COOLDOWN:
            continue
        _workshop_backfill_attempts[mod_id] = now
        _workshop_backfill_active_ids.add(mod_id)
        task = asyncio.create_task(_run_workshop_backfill(mod_id, force=force))
        _workshop_backfill_tasks.add(task)
        task.add_done_callback(_workshop_backfill_tasks.discard)
        capacity -= 1
    if len(_workshop_backfill_attempts) > _WORKSHOP_BACKFILL_MAX_TRACKED:
        oldest = sorted(_workshop_backfill_attempts, key=_workshop_backfill_attempts.get)
        for mod_id in oldest[:len(_workshop_backfill_attempts) - _WORKSHOP_BACKFILL_MAX_TRACKED]:
            _workshop_backfill_attempts.pop(mod_id, None)


async def _enrich_mods_with_workshop_metadata(server: dict) -> dict:
    """Backfill missing per-mod display metadata from the workshop_mods cache.

    Mods added to a loadout before icons existed were stored without a
    ``thumbnail_url``, so they render without a logo even though the canonical
    ``workshop_mods`` record (populated by _sync_workshop_mod_metadata) has one.
    Rather than a one-off migration, fill the gaps on read: it self-heals every
    pre-existing mod and stays correct as the cache refreshes. Only empty fields
    are filled, so explicit per-mod values (e.g. a pinned name) are preserved.

    Any loadout mod still without a logo after the cache lookup — regardless of
    how it was ingested (workshop add, mirror, manual add, import) — gets a lazy
    background scrape so the next read pulls its workshop thumbnail.
    """
    doc = dict(server or {})
    mods = doc.get("mods")
    if not isinstance(mods, list) or not mods:
        return doc

    # Availability is always copied so a removed Workshop entry is visible in
    # existing server loadouts. Display metadata remains fill-only.
    _ENRICH_FIELDS = ("thumbnail_url", "name", "author")
    _AVAILABILITY_FIELDS = (
        "availability_status",
        "removed_from_workshop",
        "removed_detected_at",
        "availability_checked_at",
        "availability_error",
    )
    wanted: set[str] = set()
    for mod in mods:
        if not isinstance(mod, dict):
            continue
        mod_id = _trim_optional_string(mod.get("mod_id") or mod.get("modId"))
        if re.fullmatch(r"[0-9A-Fa-f]{16}", mod_id):
            mod_id = mod_id.upper()
        if not mod_id:
            continue
        wanted.add(mod_id)
    if not wanted:
        return doc

    records = await db.workshop_mods.find(
        {"mod_id": {"$in": list(wanted)}},
        {
            "_id": 0,
            "mod_id": 1,
            "thumbnail_url": 1,
            "name": 1,
            "author": 1,
            **{field: 1 for field in _AVAILABILITY_FIELDS},
        },
    ).to_list(None)
    by_id = {r["mod_id"]: r for r in records if r.get("mod_id")}

    enriched: list[Any] = []
    needs_scrape: set[str] = set()
    for mod in mods:
        if not isinstance(mod, dict):
            enriched.append(mod)
            continue
        original_mod_id = _trim_optional_string(mod.get("mod_id") or mod.get("modId"))
        mod_id = original_mod_id.upper() if re.fullmatch(r"[0-9A-Fa-f]{16}", original_mod_id) else original_mod_id
        record = by_id.get(mod_id)
        mod = dict(mod)
        if mod_id and mod_id != original_mod_id:
            mod["mod_id"] = mod_id
            mod["modId"] = mod_id
        if record:
            for field in _ENRICH_FIELDS:
                current = _trim_optional_string(mod.get(field))
                is_id_placeholder = field == "name" and current.upper() == mod_id.upper()
                if (not current or is_id_placeholder) and _trim_optional_string(record.get(field)):
                    mod[field] = record[field]
            for field in _AVAILABILITY_FIELDS:
                if field in record:
                    mod[field] = record[field]
        # Still no logo (cache record missing, or stored without a thumbnail)?
        # Queue a scrape so mirror/manual/import mods self-heal on the next read.
        if mod_id and mod_id in wanted and not _trim_optional_string(mod.get("thumbnail_url")):
            needs_scrape.add(mod_id)
        enriched.append(mod)

    if needs_scrape:
        _schedule_workshop_backfill(needs_scrape)

    doc["mods"] = enriched
    return doc


def _validate_mission_header(config: dict) -> None:
    """Ensure missionHeader is a JSON-serializable object when provided.

    The Arma Reforger engine schema expects missionHeader inside
    game.gameProperties, but we also accept it at game level during input
    and migrate it automatically during config normalization.
    """
    game = config.get("game") if isinstance(config.get("game"), dict) else config
    mission_header = None
    if game:
        # Check canonical location first (game.gameProperties.missionHeader)
        gp = game.get("gameProperties")
        if isinstance(gp, dict) and "missionHeader" in gp:
            mission_header = gp["missionHeader"]
        # Fall back to legacy location (game.missionHeader) — will be migrated
        elif "missionHeader" in game:
            mission_header = game["missionHeader"]
    if mission_header is None:
        return
    if not isinstance(mission_header, dict):
        raise HTTPException(
            status_code=422,
            detail="missionHeader must be a JSON object (not an array, string, or primitive).",
        )
    try:
        json.dumps(mission_header, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"missionHeader contains values that cannot be serialized to JSON: {exc}",
        )


def _find_mount_source(mounts: list[dict], destinations: tuple[str, ...]) -> Optional[str]:
    for mount in mounts or []:
        destination = mount.get("destination")
        source = mount.get("source")
        if destination in destinations and source:
            return source
    return None


def _normalize_host_path(path: Optional[str]) -> str:
    return (path or "").replace("\\", "/").rstrip("/")


def _server_scoped_path(root: Optional[str], server_id: str) -> str:
    normalized = _normalize_host_path(root)
    if not normalized or not server_id:
        return normalized
    segments = [segment for segment in normalized.split("/") if segment]
    if server_id in segments:
        return normalized
    return f"{normalized}/{server_id}"


def _derive_troubleshooting(server: dict, runtime: Optional[dict] = None) -> dict:
    runtime = runtime or {}
    mounts = runtime.get("mounts") or []
    server_id = server.get("id", "")
    volumes = server.get("volumes") or {}

    config_destinations = ("/reforger/Configs", "/app/server-configs")
    profile_destinations = ("/home/profile", "/app/profiles", "/profile", "/app/profile")
    workshop_destinations = ("/reforger/workshop", "/app/workshop")

    config_path = _normalize_host_path(server.get("config_path"))
    config_directory = ""
    if config_path and Path(config_path).parent.is_dir():
        config_directory = _normalize_host_path(Path(config_path).parent.as_posix())
    if not config_directory:
        config_root = _find_mount_source(mounts, config_destinations) or next(
            (host for host, container in volumes.items() if container in config_destinations),
            None,
        )
        config_directory = _server_scoped_path(config_root, server_id)

    profile_directory = _normalize_host_path(server.get("profile_path"))
    if profile_directory and not Path(profile_directory).is_dir():
        profile_directory = ""
    if not profile_directory:
        profile_root = _find_mount_source(mounts, profile_destinations) or next(
            (host for host, container in volumes.items() if container in profile_destinations),
            None,
        )
        profile_directory = _server_scoped_path(profile_root, server_id)

    workshop_directory = _normalize_host_path(server.get("workshop_path"))
    if workshop_directory and not Path(workshop_directory).is_dir():
        workshop_directory = ""
    if not workshop_directory:
        workshop_root = _find_mount_source(mounts, workshop_destinations) or next(
            (host for host, container in volumes.items() if container in workshop_destinations),
            None,
        )
        workshop_directory = _server_scoped_path(workshop_root, server_id)

    config_file = config_path if config_path and Path(config_path).parent.is_dir() else (
        f"{config_directory}/server.json" if config_directory else ""
    )
    working_directory = _normalize_host_path(runtime.get("working_dir")) or profile_directory or config_directory

    return {
        "actual_container_name": runtime.get("actual_container_name") or server.get("container_name") or server.get("name", ""),
        "requested_container_name": server.get("container_name") or server.get("name", ""),
        "working_directory": working_directory,
        "config_directory": config_directory,
        "config_file": config_file,
        "profile_directory": profile_directory,
        "workshop_directory": workshop_directory,
        "cd_target": profile_directory or config_directory or working_directory,
        "mounts": mounts,
    }


def _merge_nested_dicts(base: dict, incoming: dict) -> dict:
    merged = dict(base or {})
    for key, value in (incoming or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_nested_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


def _parse_players_response(response: str) -> list[dict]:
    players: list[dict] = []
    for raw_line in (response or "").splitlines():
        line = raw_line.strip()
        if not line or line.lower().startswith(("players", "---", "name")):
            continue
        if "|" in line:
            parts = [part.strip() for part in line.split("|") if part.strip()]
            if len(parts) >= 2:
                name = parts[1] if parts[0].isdigit() else parts[0]
                players.append({
                    "name": name,
                    "raw": line,
                    "ping": next(
                        (int(token[:-2]) for token in parts if token.lower().endswith("ms") and token[:-2].isdigit()),
                        None,
                    ),
                })
                continue
        if line[0].isdigit():
            name = line.lstrip("0123456789.-: ").strip()
            if name:
                players.append({"name": name, "raw": line, "ping": None})
    return players


def _serialize_doc(value):
    if isinstance(value, datetime):
        # Mongo hands back UTC as naive datetimes; without an offset the
        # browser reads them as local time (schedule next/last run, backups).
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    if isinstance(value, list):
        return [_serialize_doc(item) for item in value]
    if isinstance(value, dict):
        return {key: _serialize_doc(item) for key, item in value.items()}
    return value


def _startup_grace_until(minutes: int = 6) -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


def _notification_actor(user: dict) -> str:
    return str(user.get("username") or user.get("name") or user.get("id") or "")


def _is_sat_warning_entry(warning: dict) -> bool:
    return str((warning or {}).get("stage") or "").strip().lower() == "sat_discovery"


def _readiness_relevant_failed_stages(server: dict) -> list[dict]:
    failed: list[dict] = []
    for stage in (server.get("provisioning_stages") or {}).values():
        if not isinstance(stage, dict) or stage.get("status") != "failed":
            continue
        stage_name = str(stage.get("name") or "").strip()
        if stage_name in NON_READINESS_STAGE_NAMES:
            continue
        failed.append(stage)
    return failed


def _derive_sat_reconciliation_updates(server: dict, sat_path: Optional[str], sat_status: str) -> dict:
    updates: dict = {}
    stored_sat_path = str(server.get("sat_config_path") or "")

    if sat_path:
        if stored_sat_path != sat_path:
            updates["sat_config_path"] = sat_path
    elif stored_sat_path:
        updates["sat_config_path"] = ""

    if server.get("sat_status") != sat_status:
        updates["sat_status"] = sat_status

    if not sat_path:
        return updates

    warnings = list(server.get("provisioning_warnings") or [])
    filtered_warnings = [warning for warning in warnings if not _is_sat_warning_entry(warning)]
    if filtered_warnings != warnings:
        updates["provisioning_warnings"] = filtered_warnings

    stages = server.get("provisioning_stages") or {}
    sat_stage = stages.get("sat_discovery")
    if isinstance(sat_stage, dict):
        normalized_stage = dict(sat_stage)
        changed = False
        success_message = f"{SAT_CONFIG_FILENAME} discovered in server profile"
        if normalized_stage.get("status") != "success":
            normalized_stage["status"] = "success"
            changed = True
        if normalized_stage.get("error"):
            normalized_stage["error"] = ""
            changed = True
        if normalized_stage.get("message") != success_message:
            normalized_stage["message"] = success_message
            changed = True
        if changed:
            updates["provisioning_stages"] = {**stages, "sat_discovery": normalized_stage}

    candidate = {**server, **updates}
    if (
        candidate.get("status") == "running"
        and not (candidate.get("provisioning_warnings") or [])
        and not _readiness_relevant_failed_stages(candidate)
    ):
        if candidate.get("provisioning_state") == "warning":
            updates["provisioning_state"] = "completed"
        if candidate.get("provisioning_step") in {"waiting_for_sat_config", "sat_discovery", "profile_generation"}:
            updates["provisioning_step"] = "ready"
        if candidate.get("readiness_state") in {"degraded", "pending", "initializing"}:
            updates["readiness_state"] = "ready"

        summary_message = str(candidate.get("summary_message") or "")
        if SAT_CONFIG_FILENAME.lower() in summary_message.lower():
            updates["summary_message"] = "Server is operational."

    return updates


async def _reconcile_server_sat_state(server: dict) -> dict:
    if not server or not server.get("id") or not server.get("sat_enabled", True):
        return server

    sat_path, sat_status = _resolve_sat_path(server)
    updates = _derive_sat_reconciliation_updates(server, sat_path, sat_status)
    if not updates:
        return server

    updates["updated_at"] = datetime.now(timezone.utc)
    await db.managed_servers.update_one({"id": server["id"]}, {"$set": updates})
    merged = {**server, **updates}
    await sync_server_notifications(merged)
    return merged


def _server_summary_response(server: dict) -> dict:
    doc = _server_response(server)
    return {
        "id": doc.get("id"),
        "name": doc.get("name"),
        "status": doc.get("status"),
        "deployment_state": doc.get("deployment_state", "created"),
        "provisioning_state": doc.get("provisioning_state"),
        "provisioning_step": doc.get("provisioning_step"),
        "readiness_state": doc.get("readiness_state"),
        "summary_message": doc.get("summary_message", ""),
        "needs_manual_intervention": doc.get("needs_manual_intervention", False),
        "provisioning_warnings": doc.get("provisioning_warnings", []),
        "container_name": doc.get("container_name", ""),
        "docker_image": doc.get("docker_image", ""),
    }


async def _run_follow_up_provisioning(server_id: str) -> None:
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        return

    now = datetime.now(timezone.utc)
    await db.managed_servers.update_one(
        {"id": server_id},
        {
            "$set": {
                "provisioning_state": "running",
                "provisioning_step": "running",
                "summary_message": "Server deployment succeeded. Follow-up provisioning is running.",
                "updated_at": now,
            }
        },
    )
    server["provisioning_state"] = "running"
    server["provisioning_step"] = "running"

    try:
        updates = await orchestrator_provision_server(server)
        updates["config"] = generate_reforger_config({**server, **updates})
        updates["updated_at"] = datetime.now(timezone.utc)
        await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
        await sync_server_notifications({**server, **updates})
    except ProvisioningError as exc:
        failure_updates = {
            "deployment_state": server.get("deployment_state", "created"),
            "status": "error",
            "provisioning_state": "failed",
            "provisioning_step": exc.step,
            "readiness_state": "failed",
            "last_docker_error": exc.message,
            "provisioning_stages": {
                **(server.get("provisioning_stages") or {}),
                **(exc.stages or {}),
            },
            "summary_message": f"Server deployment succeeded, but follow-up provisioning failed: {exc.message}",
            "startup_grace_until": None,
            "updated_at": datetime.now(timezone.utc),
        }
        await db.managed_servers.update_one({"id": server_id}, {"$set": failure_updates})
        await sync_server_notifications({**server, **failure_updates})
        logger.error("Follow-up provisioning failed for %s at %s: %s", server_id, exc.step, exc.message)
    except Exception as exc:
        failure_updates = {
            "deployment_state": server.get("deployment_state", "created"),
            "status": "error",
            "provisioning_state": "failed",
            "provisioning_step": "unexpected_error",
            "readiness_state": "failed",
            "last_docker_error": str(exc),
            "summary_message": f"Server deployment succeeded, but follow-up provisioning failed: {exc}",
            "updated_at": datetime.now(timezone.utc),
        }
        await db.managed_servers.update_one({"id": server_id}, {"$set": failure_updates})
        logger.error("Unexpected follow-up provisioning failure for %s: %s", server_id, exc)


# ── Server Lifecycle ─────────────────────────────────────────────────────────


async def _allocate_ports() -> dict:
    """Auto-allocate the next available port block for a new server.

    Uses configured base ports and increments by SERVER_PORT_BLOCK_SIZE for
    each existing server to avoid collisions.  Port values are validated
    against the valid 1-65535 range.
    """
    servers = await db.managed_servers.find({}, {"ports": 1, "_id": 0}).to_list(None)
    used_game = set()
    used_query = set()
    used_rcon = set()
    for s in servers:
        p = s.get("ports") or {}
        if "game" in p:
            used_game.add(int(p["game"]))
        if "query" in p:
            used_query.add(int(p["query"]))
        if "rcon" in p:
            used_rcon.add(int(p["rcon"]))
    # Ports other containers on this host hold count as taken too.
    on_host = await _docker.published_host_ports()
    used_game |= on_host
    used_query |= on_host
    used_rcon |= on_host

    step = SERVER_PORT_BLOCK_SIZE  # validated > 0 in config.py

    game = SERVER_PORT_BASE_GAME
    while game in used_game:
        game += step
        if game > 65535:
            raise HTTPException(status_code=409, detail="No available game ports remaining.")
    query = SERVER_PORT_BASE_QUERY
    while query in used_query:
        query += step
        if query > 65535:
            raise HTTPException(status_code=409, detail="No available query ports remaining.")
    rcon = SERVER_PORT_BASE_RCON
    while rcon in used_rcon:
        rcon += step
        if rcon > 65535:
            raise HTTPException(status_code=409, detail="No available RCON ports remaining.")

    return {"game": game, "query": query, "rcon": rcon}

@router.get("/servers")
async def list_servers(current_user: dict = Depends(_require_servers)):
    """List all managed game servers."""
    servers = await db.managed_servers.find({}, {"_id": 0}).to_list(200)
    return [_server_response(s) for s in servers]


@router.get("/servers/capacity")
async def server_capacity_status(current_user: dict = Depends(_require_servers)):
    """How many of the domain's server instances are in use (services/server_capacity.py)."""
    return {"in_use": await server_capacity.instances_in_use(), "max": server_capacity.MAX_SERVER_INSTANCES}


@router.post("/servers", status_code=201)
async def create_server(
    body: ServerCreate,
    current_user: dict = Depends(_require_servers),
):
    """Create and provision a Docker-backed Arma Reforger server."""
    # At most MAX_SERVER_INSTANCES on this host (services/server_capacity.py).
    try:
        await server_capacity.ensure_room()
    except server_capacity.ServerCapacityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    max_retries = 3
    doc = None

    for attempt in range(max_retries):
        ports = await _allocate_ports()
        server = ManagedServer(
            name=body.name,
            description=body.description,
            config=body.config,
            mods=ensure_required_mods(
                body.mods,
                sat_enabled=body.sat_enabled,
            ),
            ports=ports,
            port_allocations=ports,
            tags=body.tags,
            auto_restart=body.auto_restart,
            max_restart_attempts=body.max_restart_attempts,
            log_stats_enabled=body.log_stats_enabled,
            max_fps=body.max_fps,
            startup_parameters=body.startup_parameters,
            startup_grace_until=_startup_grace_until(),
            created_by=current_user["id"],
            deployment_state="creating",
            status="created",
            provisioning_state="queued",
            provisioning_step="queued",
            readiness_state="pending",
            summary_message="Reserving deployment resources.",
            sat_enabled=body.sat_enabled,
            sat_status="pending" if body.sat_enabled else "not_applicable",
        )
        doc = apply_runtime_defaults(server.model_dump())
        try:
            doc["config"] = generate_reforger_config(doc)
            await db.managed_servers.insert_one(doc)
            break
        except DuplicateKeyError:
            if attempt < max_retries - 1:
                logger.warning("Managed server create collided on attempt %d, retrying", attempt + 1)
                continue
            raise HTTPException(status_code=409, detail="Unable to reserve unique server resources")

    if doc is None:
        raise HTTPException(status_code=500, detail="Failed to create server definition")

    deployment_error = None

    try:
        updates = await orchestrator_prepare_server(doc)
        updates["config"] = generate_reforger_config({**doc, **updates})
        updates["updated_at"] = datetime.now(timezone.utc)
        await db.managed_servers.update_one({"id": doc["id"]}, {"$set": updates})
        await sync_server_notifications({**doc, **updates})
        asyncio.create_task(_run_follow_up_provisioning(doc["id"]))
    except ProvisioningError as exc:
        failure_updates = {
            "deployment_state": "failed",
            "status": "error",
            "provisioning_state": "failed",
            "provisioning_step": exc.step,
            "readiness_state": "failed",
            "last_docker_error": exc.message,
            "provisioning_stages": exc.stages,
            "summary_message": exc.message,
            "startup_grace_until": None,
            "updated_at": datetime.now(timezone.utc),
        }
        await db.managed_servers.update_one({"id": doc["id"]}, {"$set": failure_updates})
        await sync_server_notifications({**doc, **failure_updates})
        logger.error("Provisioning failed for %s at %s: %s", doc["id"], exc.step, exc.message)
        deployment_error = failure_updates["summary_message"]

    await log_audit(
        user_id=current_user["id"],
        action_type="server_create",
        resource_type="server",
        resource_id=doc["id"],
        after={"name": doc["name"], "docker_image": doc["docker_image"]},
    )
    created = await db.managed_servers.find_one({"id": doc["id"]}, {"_id": 0})
    if deployment_error or created.get("deployment_state") != "created":
        raise HTTPException(
            status_code=500,
            detail=deployment_error or created.get("summary_message") or "Server deployment failed before the container was created.",
        )
    return _server_response(created)


# ── Static /servers/* routes (must be registered BEFORE /servers/{server_id})─

@router.get("/servers/mod-download-history")
async def get_mod_download_history(
    mod_id: Optional[str] = Query(None),
    current_user: dict = Depends(_require_servers),
):
    """Get download history for mods — optionally filtered by mod_id."""
    query_filter = {}
    if mod_id:
        query_filter["mod_id"] = mod_id
    history = await db.mod_download_history.find(
        query_filter, {"_id": 0}
    ).sort("downloaded_at", -1).to_list(500)
    return history


@router.get("/servers/presets")
async def list_presets(current_user: dict = Depends(_require_servers)):
    """List all mod presets."""
    presets = await db.mod_presets.find({}, {"_id": 0}).to_list(200)
    return presets


@router.get("/servers/mod-issues")
async def list_mod_issues(
    response: Response,
    status: Optional[str] = Query(None),
    designated_area: Optional[str] = Query(None, alias="area"),
    troublesome: Optional[bool] = Query(None),
    current_user: dict = Depends(_require_servers),
):
    """List mod issues across all servers, sorted by confidence score."""
    query = {}
    if status:
        query["status"] = status
    if designated_area:
        query["designated_area"] = designated_area
    if troublesome is not None:
        query["troublesome"] = troublesome
    issues = await db.mod_issues.find(query, {"_id": 0}) \
        .sort("confidence_score", -1).to_list(200)
    # The list is capped; X-Total-Count lets the UI report the real backlog.
    total = len(issues)
    if total >= 200:
        total = await db.mod_issues.count_documents(query)
    response.headers["X-Total-Count"] = str(total)
    return issues


def _public_webhook(doc: dict) -> dict:
    """A webhook URL is a bearer credential (Discord embeds its token in the
    path); return only enough of it to recognise which endpoint it is."""
    out = dict(doc)
    url = str(out.get("url") or "")
    if url:
        from urllib.parse import urlparse

        parsed = urlparse(url)
        tail = url.rstrip("/")[-4:]
        out["url"] = f"{parsed.scheme}://{parsed.netloc}/…{tail}" if parsed.netloc else f"…{tail}"
    return out


@router.get("/servers/webhooks")
async def list_webhooks(current_user: dict = Depends(_require_servers)):
    """List configured notification webhooks (URLs masked)."""
    webhooks = await db.server_webhooks.find({}, {"_id": 0}).to_list(50)
    return [_public_webhook(webhook) for webhook in webhooks]


# ── Public Reforger server list (Compare / Mirror) ───────────────────────────
# ReforgerMods (reforgermods.net) indexes every server in Bohemia's public Arma
# Reforger list about once a minute, with the mods each server reports, and
# answers cached reads with no key (60 a minute, 5,000 a day per calling IP).
# It replaced BattleMetrics, whose API now needs a paid subscription for every
# caller (as of 2026-11). Independent service, not Bohemia; mod links in the
# UI point at the official Workshop as its terms ask.

_SERVER_LIST_API = "https://api.reforgermods.net/v2"
_SERVER_LIST_PAGE = "https://reforgermods.net/servers"
_SERVER_LIST_TIMEOUT = 15
# ReforgerMods asks callers to name their client: a generic name, nothing about the site.
_SERVER_LIST_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "reforger-server-compare/1.0",
    "X-API-Client": "reforger-server-compare",
}
_SERVER_LIST_SORTS = frozenset({"players", "name", "newest", "lastSeen"})
# Bohemia's ping sites, which ReforgerMods reports as a server's region.
_SERVER_LIST_REGIONS = frozenset({"frankfurt", "london", "new_york", "miami", "los_angeles", "singapore", "sydney"})
_SERVER_LIST_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_WORKSHOP_MOD_ID = re.compile(r"[0-9A-F]{16}", re.IGNORECASE)


def _server_list_error(exc: Exception) -> HTTPException:
    """The server list's refusal, in words staff can act on."""
    import httpx

    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        try:
            message = str(((exc.response.json() or {}).get("error") or {}).get("message") or "")
        except (ValueError, AttributeError):
            message = ""
        if status == 404:
            return HTTPException(status_code=404, detail="That server is not in the public server list any more.")
        if status == 429:
            return HTTPException(
                status_code=429,
                detail="The free server list allows 60 lookups a minute and 5,000 a day from this site. Try again in a minute.",
            )
        return HTTPException(
            status_code=502,
            detail=f"The server list refused the request ({status}){': ' + message[:200] if message else ''}.",
        )
    return HTTPException(status_code=502, detail="Could not reach the server list (reforgermods.net). Try again shortly.")


async def _server_list_get(path: str, params: Optional[dict] = None) -> dict:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=_SERVER_LIST_TIMEOUT, headers=_SERVER_LIST_HEADERS) as client:
            resp = await client.get(f"{_SERVER_LIST_API}{path}", params=params)
            if resp.status_code == 202:  # ReforgerMods queued a refresh; not a failure
                raise HTTPException(status_code=503, detail="The server list is refreshing that server. Try again in a few seconds.")
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        raise _server_list_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="The server list sent an answer this site could not read.") from exc
    return data if isinstance(data, dict) else {}


def _server_list_row(row: dict) -> dict:
    """One public server in the fields Compare shows (search rows and detail)."""
    server_id = str(row.get("id") or "")
    return {
        "id": server_id,
        "name": row.get("name") or "",
        "players": row.get("players") or 0,
        "max_players": row.get("maxPlayers") or 0,
        "status": "online" if row.get("online") else "offline",
        "region": row.get("region") or "",
        "scenario": row.get("scenarioName") or "",
        "version": row.get("gameVersion") or "",
        "password": bool(row.get("passwordProtected")),
        "official": bool(row.get("official")),
        "battleye": bool(row.get("battlEye")),
        "mod_count": row.get("modCount") or 0,
        "page_url": f"{_SERVER_LIST_PAGE}/{server_id}" if server_id else "",
    }


def _server_list_detail(server: dict) -> dict:
    """A server with its address and the mods it reports (Workshop ids only)."""
    mods = [
        {"mod_id": str(m.get("id")).upper(), "name": m.get("name") or "", "version": m.get("version") or ""}
        for m in server.get("mods") or []
        if isinstance(m, dict) and _WORKSHOP_MOD_ID.fullmatch(str(m.get("id") or ""))
    ]
    return {
        **_server_list_row(server),
        "host": server.get("host") or "",
        "port": server.get("port"),
        "direct_join_code": server.get("directJoinCode") or "",
        "mod_count": len(mods),
        "mods": mods,
    }


@router.get("/servers/server-list/search")
async def server_list_search(
    q: str = Query("", max_length=200, description="Server or scenario name, or a ReforgerMods server link or id"),
    page: int = Query(1, ge=1, le=1000),
    per_page: int = Query(10, ge=1, le=50),
    sort: str = Query("players", description="players, name, newest or lastSeen"),
    region: str = Query("", description="Ping site, e.g. new_york or frankfurt"),
    include_offline: bool = Query(False),
    modded_only: bool = Query(False),
    current_user: dict = Depends(_require_servers),
):
    """Search the public Arma Reforger server list. A pasted server link or id opens that server."""
    query = (q or "").strip()
    pasted = _SERVER_LIST_ID.search(query)
    if pasted:
        data = await _server_list_get(f"/servers/{pasted.group(0).lower()}")
        server = data.get("server")
        rows = [_server_list_row(server)] if isinstance(server, dict) else []
        return {"servers": rows, "page": 1, "total_pages": 1, "total": len(rows), "has_next": False, "has_prev": False}

    params: dict = {"page": page, "perPage": per_page, "sort": sort if sort in _SERVER_LIST_SORTS else "players"}
    if query:
        params["search"] = query
    if region in _SERVER_LIST_REGIONS:
        params["region"] = region
    if include_offline:
        params["includeOffline"] = "true"
    if modded_only:
        params["hasMods"] = "true"
    data = await _server_list_get("/servers", params)
    meta = data.get("meta") or {}
    total_pages = int(meta.get("totalPages") or 0)
    return {
        "servers": [_server_list_row(row) for row in data.get("data") or [] if isinstance(row, dict)],
        "page": page,
        "total_pages": total_pages,
        "total": int(meta.get("totalServers") or 0),
        "has_next": page < total_pages,
        "has_prev": page > 1,
        "list_age_seconds": (data.get("dataset") or {}).get("snapshotAgeSeconds"),
    }


@router.get("/servers/server-list/{list_id}")
async def server_list_detail(list_id: str, current_user: dict = Depends(_require_servers)):
    """One public server with the mods it reports, for Compare / Mirror."""
    if not _SERVER_LIST_ID.fullmatch(list_id):
        raise HTTPException(status_code=400, detail="Invalid server id")
    data = await _server_list_get(f"/servers/{list_id.lower()}")
    server = data.get("server")
    if not isinstance(server, dict):
        raise HTTPException(status_code=502, detail="The server list sent an empty answer.")
    return _server_list_detail(server)


# ── Parameterized /servers/{server_id} routes ────────────────────────────────

@router.get("/servers/{server_id}")
async def get_server(server_id: str, current_user: dict = Depends(_require_servers)):
    """Get full details for a single managed server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    server = await _reconcile_server_sat_state(server)
    server = await _enrich_mods_with_workshop_metadata(server)
    server = _annotate_server_mod_install_state(server)
    response = _server_response(server)
    # The workspace Overview's host-path panel and its Server Admin Tools config
    # target read this; without it both always rendered empty.
    details = _derive_troubleshooting(server)
    response["troubleshooting"] = {
        key: details.get(key) or ""
        for key in ("actual_container_name", "working_directory", "config_directory", "profile_directory", "cd_target")
    }
    # created_by is a user id; the Overview shows who that is.
    creator_id = server.get("created_by")
    if creator_id:
        creator = await db.users.find_one({"id": creator_id}, {"_id": 0, "username": 1})
        if creator and creator.get("username"):
            response["created_by_name"] = creator["username"]
    return response


@router.get("/servers/{server_id}/summary")
async def get_server_summary(server_id: str, current_user: dict = Depends(_require_servers)):
    """Get the lightweight server summary used by workspace header polling."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    server = await _reconcile_server_sat_state(server)
    return _server_summary_response(server)


@router.put("/servers/{server_id}")
async def update_server(
    server_id: str,
    body: ServerUpdate,
    current_user: dict = Depends(_require_servers),
):
    """Update server metadata and configuration."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    # Control field, never persisted — pop before `updates` reaches the $set.
    base_revision = updates.pop("base_revision", None)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Optimistic concurrency. Two operators editing the same server used to end
    # in a silent overwrite; now the loser is told who beat them and can reload
    # rather than having their work vanish.
    if base_revision is not None and "config" in updates:
        live_revision = await current_version(server_id)
        if live_revision != base_revision:
            latest = await latest_revision_meta(server_id) or {}
            changed_at = latest.get("changed_at")
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "This config changed since you opened it.",
                    "base_revision": base_revision,
                    "current_revision": live_revision,
                    "changed_by": latest.get("changed_by_name") or "another operator",
                    "changed_at": (
                        changed_at.isoformat()
                        if isinstance(changed_at, datetime)
                        else changed_at
                    ),
                },
            )

    # The client only ever saw redacted secrets, so an echoed mask means
    # "unchanged" — never "set the password to three asterisks".
    if "config" in updates:
        updates["config"] = _restore_redacted_config_secrets(
            updates["config"], server.get("config")
        )

    if "startup_parameters" in updates:
        updates["startup_parameters"] = [
            str(param).strip()
            for param in (updates.get("startup_parameters") or [])
            if str(param).strip()
        ]
    if "max_fps" in updates:
        try:
            updates["max_fps"] = max(30, int(updates["max_fps"]))
        except (TypeError, ValueError):
            updates["max_fps"] = max(30, int(server.get("max_fps") or 120))
    if "log_stats_enabled" in updates:
        updates["log_stats_enabled"] = bool(updates["log_stats_enabled"])
    if "script_limit_patch" in updates:
        updates["script_limit_patch"] = bool(updates["script_limit_patch"])

    if "sat_enabled" in updates:
        updates["sat_enabled"] = bool(updates["sat_enabled"])
        if not updates["sat_enabled"]:
            updates["sat_status"] = "not_applicable"

    if "config" in updates:
        if not isinstance(updates["config"], dict):
            raise HTTPException(status_code=400, detail="config must be a JSON object")
        _validate_mission_header(updates["config"])
        updates["config"] = apply_backend_managed_config_fields(updates["config"], server)
        raw_game = updates["config"].get("game") or {}
        # Only a config that carries game.mods replaces the mod list. A config
        # saved without the key (settings forms, partial raw JSON) must not
        # wipe the server's mods; an explicit "mods": [] still clears them.
        if isinstance(raw_game, dict) and "mods" in raw_game:
            raw_mods = raw_game.get("mods")
            if raw_mods is None:
                raw_mods = []
            if not isinstance(raw_mods, list):
                raise HTTPException(status_code=400, detail="game.mods must be an array when present")
            updates["mods"] = raw_mods

    before = {k: server.get(k) for k in updates}
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()

    next_mods = updates.get("mods", server.get("mods", []))
    sat_on = updates.get("sat_enabled", server.get("sat_enabled", True))
    if "mods" in updates or "sat_enabled" in updates:
        updates["mods"] = ensure_required_mods(
            next_mods,
            sat_enabled=sat_on,
        )
        next_mods = updates["mods"]

    if "config" in updates:
        # Treat the incoming config as a full replacement — do NOT merge with
        # the old config.  The frontend always sends a complete config object
        # (either from the form state or the Raw JSON editor), so merging with
        # the previous config would re-introduce values the user deliberately
        # removed or changed, causing "reverts to old/template values" bugs.
        #
        # Let generate_reforger_config handle all normalization in a single
        # pass (it calls normalize_server_config internally).
        updates["config"] = generate_reforger_config(
            {**server, **updates, "mods": next_mods},
        )

    config_file_snapshots = ()
    if "config" in updates or "mods" in updates:
        merged = {**server, **updates}
        config_file_snapshots = snapshot_server_config_file(merged)
        try:
            ok, result = await write_config_file(merged, config=updates.get("config") if "config" in updates else None)
            if ok:
                updates["config_path"] = result
                sat_path, sat_status = discover_sat_config(merged.get("profile_path", ""))
                updates["sat_config_path"] = sat_path or server.get("sat_config_path", "")
                updates["sat_status"] = sat_status
            else:
                raise HTTPException(status_code=400, detail=result)
        except Exception:
            restore_file_snapshots(config_file_snapshots)
            raise

    db_update: dict = {"$set": updates}

    try:
        await db.managed_servers.update_one({"id": server_id}, db_update)
    except Exception:
        restore_file_snapshots(config_file_snapshots)
        raise

    # Config history lives in its own collection rather than an array on this
    # document — the array was unbounded and rode along on every unprojected
    # server read. Recorded after the write succeeds: history is a side effect,
    # and a failure to record it must never fail the update.
    if "config" in updates:
        await record_config_revision(
            server_id=server_id,
            before_config=server.get("config") or {},
            after_config=updates["config"],
            changed_by=current_user["id"],
            changed_by_name=(
                current_user.get("username") or current_user.get("display_name") or ""
            ),
            source="update",
        )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_update",
        resource_type="server",
        resource_id=server_id,
        before=before,
        after=updates,
    )
    updated = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    await sync_server_notifications(updated or {})

    response = _server_response(updated)
    # Signal the frontend when the saved changes will only take effect
    # after a full container reconfigure (not just a file-level restart).
    if _needs_reconfigure(server, updates):
        response["needs_reconfigure"] = True
    return response


@router.delete("/servers/{server_id}")
async def delete_server(server_id: str, current_user: dict = Depends(_require_servers)):
    """Remove a managed server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {"status": "deletion_pending", "provisioning_state": "deleting", "updated_at": datetime.now(timezone.utc)}},
    )
    try:
        await orchestrator_delete_server(server)
    except ProvisioningError as exc:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {
                "status": "deletion_pending",
                "provisioning_state": "deleting",
                "last_docker_error": exc.message,
                "updated_at": datetime.now(timezone.utc),
            }},
        )
        await log_audit(
            user_id=current_user["id"],
            action_type="server_delete_failed",
            resource_type="server",
            resource_id=server_id,
            before={"name": server.get("name")},
            after={"step": exc.step, "error": exc.message},
        )
        raise HTTPException(status_code=502, detail=exc.message) from exc

    await db.managed_servers.delete_one({"id": server_id})
    # Clean up related data
    await db.server_incidents.delete_many({"server_id": server_id})
    await db.server_backups.delete_many({"server_id": server_id})
    await db.server_schedules.delete_many({"server_id": server_id})
    await db.server_metrics.delete_many({"server_id": server_id})
    await db.server_notifications.delete_many({"server_id": server_id})
    await db.mod_download_history.delete_many({"server_id": server_id})

    await log_audit(
        user_id=current_user["id"],
        action_type="server_delete",
        resource_type="server",
        resource_id=server_id,
        before={"name": server.get("name")},
    )
    return {"message": "Server deleted", "id": server_id}


# ── Server Actions ───────────────────────────────────────────────────────────

class ServerActionResponse(BaseModel):
    server_id: str
    action: str
    status: str
    message: str


@router.post("/servers/{server_id}/start")
async def start_server(server_id: str, current_user: dict = Depends(_require_servers)):
    """Start or resume a managed server container."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    now = datetime.now(timezone.utc)
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {
            "status": "starting",
            "provisioning_step": "starting_container",
            "readiness_state": "initializing",
            "startup_grace_until": _startup_grace_until(),
            "updated_at": now,
        }},
    )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_start",
        resource_type="server",
        resource_id=server_id,
    )

    try:
        updates = await orchestrator_start_server(server)
        updates["last_started"] = now
        updates["status"] = "starting"
        updates["provisioning_state"] = "starting_container"
        updates["provisioning_step"] = "starting_container"
        updates["readiness_state"] = "initializing"
        updates["startup_grace_until"] = _startup_grace_until()
        updates["updated_at"] = datetime.now(timezone.utc)
        await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
        await sync_server_notifications({**server, **updates})
        return ServerActionResponse(
            server_id=server_id,
            action="start",
            status=str(updates.get("status") or "starting"),
            message="Server start requested. Runtime readiness checks are still in progress.",
        )
    except ProvisioningError as exc:
        error = exc.message
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {
                "status": "error",
                "provisioning_state": "failed",
                "provisioning_step": exc.step,
                "readiness_state": "failed",
                "last_docker_error": exc.message,
                "startup_grace_until": None,
                "updated_at": datetime.now(timezone.utc),
            }},
        )
        await sync_server_notifications({**server, "status": "error", "readiness_state": "failed", "last_docker_error": exc.message, "startup_grace_until": None})
        # Auto-create an incident for the failure
        from services.server_health_monitor import record_auto_incident

        incident = {
            "id": f"inc_{__import__('uuid').uuid4().hex[:12]}",
            "server_id": server_id,
            "incident_type": "startup_failure",
            "severity": "high",
            "title": f"Failed to start — {server.get('name', server_id)}",
            "description": f"Docker start failed: {error}",
            "status": "open",
            "detected_at": datetime.now(timezone.utc).isoformat(),
            "auto_detected": True,
        }
        await record_auto_incident(incident, database=db)
        raise HTTPException(status_code=500, detail=f"Server start failed: {error}")


@router.post("/servers/{server_id}/stop")
async def stop_server(server_id: str, current_user: dict = Depends(_require_servers)):
    """Stop a managed server container."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    now = datetime.now(timezone.utc)
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {"status": "stopping", "startup_grace_until": None, "updated_at": now}},
    )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_stop",
        resource_type="server",
        resource_id=server_id,
    )

    try:
        updates = await orchestrator_stop_server(server)
        updates["last_stopped"] = datetime.now(timezone.utc)
        updates["updated_at"] = datetime.now(timezone.utc)
        await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
        await sync_server_notifications({**server, **updates})
        return ServerActionResponse(server_id=server_id, action="stop", status="stopped", message="Server stopped successfully.")
    except ProvisioningError as exc:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"status": "error", "last_docker_error": exc.message, "updated_at": datetime.now(timezone.utc)}},
        )
        await sync_server_notifications({**server, "status": "error", "last_docker_error": exc.message})
        raise HTTPException(status_code=500, detail=exc.message)


@router.post("/servers/{server_id}/restart")
async def restart_server(server_id: str, current_user: dict = Depends(_require_servers)):
    """Restart a managed server container."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    now = datetime.now(timezone.utc)
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {
            "status": "starting",
            "readiness_state": "initializing",
            "startup_grace_until": _startup_grace_until(),
            "last_started": now,
            "updated_at": now,
        }},
    )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_restart",
        resource_type="server",
        resource_id=server_id,
    )

    try:
        updates = await orchestrator_restart_server(server)
        updates["last_started"] = now
        updates["status"] = "starting"
        updates["provisioning_state"] = "starting_container"
        updates["provisioning_step"] = "starting_container"
        updates["readiness_state"] = "initializing"
        updates["startup_grace_until"] = _startup_grace_until()
        updates["updated_at"] = datetime.now(timezone.utc)
        await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
        await sync_server_notifications({**server, **updates})
        return ServerActionResponse(
            server_id=server_id,
            action="restart",
            status=str(updates.get("status") or "starting"),
            message="Server restart requested. Runtime readiness checks are still in progress.",
        )
    except ProvisioningError as exc:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"status": "error", "last_docker_error": exc.message, "startup_grace_until": None, "updated_at": datetime.now(timezone.utc)}},
        )
        await sync_server_notifications({**server, "status": "error", "last_docker_error": exc.message, "startup_grace_until": None})
        raise HTTPException(status_code=500, detail=exc.message)


@router.post("/servers/{server_id}/reconfigure")
async def reconfigure_server(server_id: str, current_user: dict = Depends(_require_servers)):
    """Recreate the container with fresh environment and restart.

    Use this after config changes that affect container-level environment
    variables (RCON password/port, max_fps, startup parameters) which a
    simple ``restart`` would not pick up.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    now = datetime.now(timezone.utc)
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {
            "status": "starting",
            "readiness_state": "initializing",
            "startup_grace_until": _startup_grace_until(),
            "last_started": now,
            "updated_at": now,
        }},
    )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_reconfigure",
        resource_type="server",
        resource_id=server_id,
    )

    try:
        updates = await orchestrator_reconfigure_server(server)
        updates["last_started"] = now
        updates["status"] = "starting"
        updates["provisioning_state"] = "starting_container"
        updates["provisioning_step"] = "starting_container"
        updates["readiness_state"] = "initializing"
        updates["startup_grace_until"] = _startup_grace_until()
        updates["updated_at"] = datetime.now(timezone.utc)
        await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
        await sync_server_notifications({**server, **updates})
        return ServerActionResponse(
            server_id=server_id,
            action="reconfigure",
            status=str(updates.get("status") or "starting"),
            message="Server reconfigured and restarting. Container recreated with updated environment.",
        )
    except ProvisioningError as exc:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"status": "error", "last_docker_error": exc.message, "startup_grace_until": None, "updated_at": datetime.now(timezone.utc)}},
        )
        await sync_server_notifications({**server, "status": "error", "last_docker_error": exc.message, "startup_grace_until": None})
        raise HTTPException(status_code=500, detail=exc.message)


@router.post("/servers/{server_id}/update-runtime")
async def update_server_runtime(server_id: str, current_user: dict = Depends(_require_servers)):
    """Pull and replace only the server's disposable Docker runtime layer."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    await log_audit(
        user_id=current_user["id"],
        action_type="server_runtime_update",
        resource_type="server",
        resource_id=server_id,
        metadata={"docker_image": server.get("docker_image", ""), "preserve_server_data": True},
    )

    try:
        result = await orchestrator_update_server_runtime(server)
        control_keys = {"server_id", "action", "was_running", "image_pulled", "applies_on_create"}
        updates = {key: value for key, value in result.items() if key not in control_keys}
        was_running = bool(result.get("was_running"))
        if result.get("action") == "recreated":
            updates.update({
                "status": "starting" if was_running else "stopped",
                "last_known_container_status": "running" if was_running else "created",
                "readiness_state": "initializing" if was_running else "pending",
                "startup_grace_until": _startup_grace_until() if was_running else None,
                "updated_at": datetime.now(timezone.utc),
            })
            await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
            await sync_server_notifications({**server, **updates})

        state = "restarting" if was_running else "stopped"
        message = (
            f"Runtime updated; server is {state}. Persistent config, profile, workshop/mod files, "
            "and saved server settings were preserved."
            if result.get("action") == "recreated"
            else "Configured image updated. No existing container was present; persistent server data was unchanged."
        )
        return {
            "server_id": server_id,
            "action": result.get("action"),
            "status": "starting" if was_running else server.get("status", "created"),
            "preserved": ["config", "profile", "workshop_mods", "database_settings"],
            "message": message,
        }
    except ProvisioningError as exc:
        failure_updates = {
            "last_docker_error": exc.message,
            "updated_at": datetime.now(timezone.utc),
        }
        # Preflight failures leave the old container and its state intact. Later
        # failures occur after replacement has begun and need intervention.
        if exc.step not in {"pulling_image", "verifying_persistent_mounts"}:
            failure_updates.update({"status": "error", "startup_grace_until": None})
        await db.managed_servers.update_one({"id": server_id}, {"$set": failure_updates})
        raise HTTPException(status_code=500, detail=exc.message)


@router.get("/servers/{server_id}/status")
async def get_server_status(server_id: str, current_user: dict = Depends(_require_servers)):
    """Get current status and health info for a server."""
    server = await db.managed_servers.find_one(
        {"id": server_id},
        {"_id": 0, "id": 1, "name": 1, "status": 1, "last_started": 1,
         "last_stopped": 1, "auto_restart": 1, "provisioning_state": 1,
         "provisioning_step": 1, "readiness_state": 1, "last_docker_error": 1,
         "provisioning_stages": 1, "provisioning_warnings": 1},
    )
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    return _serialize_doc(_normalize_server_contract(server))


@router.get("/servers/{server_id}/diagnostics")
async def get_server_diagnostics(server_id: str, current_user: dict = Depends(_require_servers)):
    """Return container-aware diagnostics for a managed server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    diagnostics = await orchestrator_get_diagnostics(server)
    return _serialize_doc(diagnostics)


# ── Server Config ────────────────────────────────────────────────────────────

@router.get("/servers/{server_id}/config")
async def get_server_config(server_id: str, current_user: dict = Depends(_require_servers)):
    """Get the current server configuration."""
    server = await db.managed_servers.find_one(
        {"id": server_id}, {"_id": 0, "config": 1}
    )
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    return {
        "config": server.get("config", {}),
        "history_count": await db.server_config_revisions.count_documents(
            {"server_id": server_id}
        ),
        # The concurrency token the client sends back as `base_revision` on
        # save. Distinct from history_count: pruning history changes the count
        # but must never rewind the version.
        "revision": await current_version(server_id),
    }


@router.get("/servers/{server_id}/config/history")
async def get_config_history(
    server_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(_require_servers),
):
    """Get configuration change history, newest first, with per-version diffs.

    Each entry carries a dotted-path diff of what that change did. The old
    shape returned raw pre-change snapshots with no diff, which is why nothing
    in the UI ever rendered it.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0, "id": 1})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    return _serialize_doc(await list_config_revisions(server_id, limit=limit, offset=offset))


@router.get("/servers/{server_id}/config/history/{version}")
async def get_config_history_entry(
    server_id: str,
    version: int,
    current_user: dict = Depends(_require_servers),
):
    """One config revision including the full before/after snapshots."""
    revision = await get_config_revision(server_id, version)
    if not revision:
        raise HTTPException(status_code=404, detail="Config revision not found")
    return _serialize_doc(revision)


@router.post("/servers/{server_id}/config/history/{version}/revert")
async def revert_config_revision(
    server_id: str,
    version: int,
    current_user: dict = Depends(_require_servers),
):
    """Restore the server config to the state a revision produced.

    Gated under the same ``server_config_update`` policy as a normal config
    edit, and records a new revision so the timeline stays complete.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    revision = await get_config_revision(server_id, version)
    if not revision:
        raise HTTPException(status_code=404, detail="Config revision not found")

    target_config = revision.get("after_config") or {}
    before_config = server.get("config") or {}
    if target_config == before_config:
        return {"message": "Config already matches that revision", "version": version}


    config_file_snapshots = snapshot_server_config_file(server)
    ok, result = await write_config_file({**server, "config": target_config})
    if not ok:
        raise HTTPException(status_code=400, detail=result)
    try:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {
                "config": target_config,
                "config_path": result,
                "updated_at": datetime.now(timezone.utc),
            }},
        )
    except Exception:
        restore_file_snapshots(config_file_snapshots)
        raise

    await record_config_revision(
        server_id=server_id,
        before_config=before_config,
        after_config=target_config,
        changed_by=current_user["id"],
        changed_by_name=(
            current_user.get("username") or current_user.get("display_name") or ""
        ),
        source=f"revert_to_v{version}",
    )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_config_revert",
        resource_type="server",
        resource_id=server_id,
        before={"config": before_config},
        after={"config": target_config},
    )
    return {"message": f"Config reverted to revision {version}", "version": version}


@router.get("/servers/{server_id}/notifications")
async def get_server_notifications(
    server_id: str,
    include_cleared: bool = Query(False),
    current_user: dict = Depends(_require_servers),
):
    """List operational notifications for a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0, "id": 1})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    notifications = await list_server_notifications(server_id, include_cleared=include_cleared)
    return {
        "server_id": server_id,
        "notifications": notifications,
        "count": len(notifications),
    }


@router.post("/servers/{server_id}/notifications/{notification_id}/acknowledge")
async def acknowledge_server_notification(
    server_id: str,
    notification_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Acknowledge a server notification without clearing it."""
    notification = await db.server_notifications.find_one(
        {"server_id": server_id, "id": notification_id},
        {"_id": 0},
    )
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")

    now = datetime.now(timezone.utc)
    await db.server_notifications.update_one(
        {"server_id": server_id, "id": notification_id},
        {"$set": {
            "acknowledged": True,
            "acknowledged_at": now,
            "acknowledged_by": _notification_actor(current_user),
            "updated_at": now,
        }},
    )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_notification_acknowledge",
        resource_type="server",
        resource_id=server_id,
        metadata={"notification_id": notification_id, "notification_type": notification.get("notification_type")},
    )

    updated = await db.server_notifications.find_one(
        {"server_id": server_id, "id": notification_id},
        {"_id": 0},
    )
    return {
        "server_id": server_id,
        "notification": _serialize_doc(updated),
    }


@router.post("/servers/{server_id}/notifications/{notification_id}/clear")
async def clear_server_notification(
    server_id: str,
    notification_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Clear an operational notification and resolve follow-up warnings when possible."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    notification = await db.server_notifications.find_one(
        {"server_id": server_id, "id": notification_id},
        {"_id": 0},
    )
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")

    now = datetime.now(timezone.utc)
    actor = _notification_actor(current_user)

    await db.server_notifications.update_one(
        {"server_id": server_id, "id": notification_id},
        {"$set": {
            "status": "cleared",
            "cleared_at": now,
            "cleared_by": actor,
            "updated_at": now,
        }},
    )
    await log_audit(
        user_id=current_user["id"],
        action_type="server_notification_clear",
        resource_type="server",
        resource_id=server_id,
        metadata={"notification_id": notification_id, "notification_type": notification.get("notification_type")},
    )

    server_updates = {}
    if notification.get("notification_type") == "provisioning.followup":
        server_updates = {
            "provisioning_warnings": [],
            "updated_at": now,
        }
        if server.get("status") == "running":
            server_updates["readiness_state"] = "ready"
            server_updates["provisioning_state"] = "ready"
            server_updates["summary_message"] = (
                "Server is operational. Provisioning follow-up items were acknowledged and cleared."
            )
        await db.managed_servers.update_one({"id": server_id}, {"$set": server_updates})
        server = {**server, **server_updates}
        await sync_server_notifications(server)

    updated = await db.server_notifications.find_one(
        {"server_id": server_id, "id": notification_id},
        {"_id": 0},
    )
    return {
        "server_id": server_id,
        "notification": _serialize_doc(updated),
        "server": _server_response(server),
    }


@router.get("/servers/{server_id}/sat-config")
async def get_sat_config(server_id: str, current_user: dict = Depends(_require_servers)):
    """Return the discovered Server Admin Tools config for a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    server = await _reconcile_server_sat_state(server)
    sat_path, sat_status = _resolve_sat_path(server)
    if not sat_path:
        return {"available": False, "status": sat_status, "config": None}

    try:
        config = load_sat_config(sat_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read SAT config: {exc}")

    return {"available": True, "status": sat_status, "config_path": sat_path, "config": config}


class SatConfigUpdate(BaseModel):
    config: dict


@router.put("/servers/{server_id}/sat-config")
async def update_sat_config(
    server_id: str,
    body: SatConfigUpdate,
    current_user: dict = Depends(_require_servers),
):
    """Persist a structured Server Admin Tools configuration update."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    server = await _reconcile_server_sat_state(server)
    sat_path, sat_status = _resolve_sat_path(server)
    if not sat_path:
        raise HTTPException(status_code=409, detail=f"Server Admin Tools config is not available yet ({sat_status})")
    try:
        save_sat_config(sat_path, body.config)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {"sat_config_path": sat_path, "sat_status": sat_status if sat_status == "configured" else "discovered", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"message": "SAT config updated", "config_path": sat_path}


def _resolve_sat_path(server: dict) -> tuple[Optional[str], str]:
    sat_path = server.get("sat_config_path")
    sat_status = server.get("sat_status", "pending")
    if sat_path and Path(sat_path).is_file():
        return sat_path, sat_status
    return discover_sat_config(server.get("profile_path", ""))


async def _load_sat_state(server: dict) -> tuple[str, dict]:
    server = await _reconcile_server_sat_state(server)
    sat_path, sat_status = _resolve_sat_path(server)
    if not sat_path:
        raise HTTPException(status_code=409, detail=f"Server Admin Tools config is not available yet ({sat_status})")
    try:
        return sat_path, load_sat_config(sat_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read SAT config: {exc}") from exc


def _get_sat_bans(config: dict) -> list[dict]:
    bans = config.get("bans")
    if isinstance(bans, list):
        normalized = []
        for index, entry in enumerate(bans):
            if isinstance(entry, dict):
                player_id = entry.get("playerId") or entry.get("id") or entry.get("guid") or ""
                reason = entry.get("reason") or ""
            else:
                player_id = str(entry or "")
                reason = ""
            if player_id:
                normalized.append({"id": player_id, "reason": reason, "index": index})
        return normalized
    if isinstance(bans, dict):
        return [
            {"id": str(player_id), "reason": str(reason or ""), "index": index}
            for index, (player_id, reason) in enumerate(bans.items())
        ]
    return []


async def _sync_workshop_mod_metadata(server_id: str, mods: list[dict], current_user: dict) -> None:
    now = datetime.now(timezone.utc).isoformat()
    needs_backfill: set[str] = set()

    for mod in mods:
        mod_id = (mod.get("mod_id") or mod.get("modId") or "").strip()
        if not mod_id:
            continue
        if re.fullmatch(r"[0-9A-Fa-f]{16}", mod_id):
            mod_id = mod_id.upper()
        # Prior canonical record — used as a fallback so a deploy whose live
        # scrape has not completed can't clobber previously-fetched metadata.
        # Saving a loadout must never wait for the external Workshop: a large
        # loadout can contain 100+ mods and the shared API client times out at
        # 30 seconds. Missing metadata is queued below for bounded background
        # hydration instead.
        existing = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0}) or {}
        stored = existing

        # Preserve real dependency data: a fresh verified scrape wins, else keep
        # whatever we already had, else empty. ``dependencies_verified`` tracks
        # whether the list we kept actually came from a full detail fetch, so
        # resolution won't trust an unproven empty list (the "all dependencies
        # fulfilled" false positive).
        dependencies = (
            mod.get("dependencies")
            or (stored or {}).get("dependencies")
            or existing.get("dependencies")
            or []
        )
        dependencies_verified = bool(
            (stored or {}).get("dependencies_verified")
            or existing.get("dependencies_verified")
        )

        assigned_name = _trim_optional_string(mod.get("name"))
        if assigned_name.upper() == mod_id.upper():
            assigned_name = ""
        canonical = {
            "mod_id": mod_id,
            "name": assigned_name or (stored or {}).get("name") or existing.get("name") or mod_id,
            "author": mod.get("author") or stored.get("author") or "",
            "version": mod.get("version") or stored.get("version") or "",
            "summary": mod.get("summary") or stored.get("summary") or "",
            "description": mod.get("description") or stored.get("description") or "",
            "license": mod.get("license") or stored.get("license") or "",
            "tags": mod.get("tags") or stored.get("tags") or [],
            "dependencies": dependencies,
            "dependencies_verified": dependencies_verified,
            "scenario_ids": mod.get("scenario_ids") or stored.get("scenario_ids") or [],
            "scenarios": mod.get("scenarios") or stored.get("scenarios") or [],
            "versions": mod.get("versions") or stored.get("versions") or [],
            "changelog": mod.get("changelog") or stored.get("changelog") or "",
            "thumbnail_url": mod.get("thumbnail_url") or stored.get("thumbnail_url") or "",
            "workshop_url": mod.get("workshop_url") or stored.get("workshop_url") or f"https://reforger.armaplatform.com/workshop/{mod_id}",
            "game_version": mod.get("game_version") or stored.get("game_version") or "",
            "current_version_size": mod.get("current_version_size") or stored.get("current_version_size") or 0,
            "rating": mod.get("rating") or stored.get("rating") or 0,
            "rating_count": mod.get("rating_count") or stored.get("rating_count") or 0,
            "subscribers": mod.get("subscribers") or stored.get("subscribers") or 0,
            "downloads": mod.get("downloads") or stored.get("downloads") or 0,
            "created_at": mod.get("created_at") or stored.get("created_at") or "",
            "updated_at": mod.get("updated_at") or stored.get("updated_at") or "",
            "metadata_source": mod.get("metadata_source") or stored.get("metadata_source") or "server_assignment",
            "last_fetched": stored.get("last_fetched") or now,
            "availability_status": stored.get("availability_status") or "unknown",
            "removed_from_workshop": stored.get("removed_from_workshop") is True,
            "removed_detected_at": stored.get("removed_detected_at"),
            "availability_checked_at": stored.get("availability_checked_at"),
            "availability_error": stored.get("availability_error") or "",
            "last_used_by_server_id": server_id,
            "last_used_by_user_id": current_user["id"],
            "last_used_at": now,
        }
        await db.workshop_mods.update_one({"mod_id": mod_id}, {"$set": canonical}, upsert=True)
        await db.mod_download_history.update_one(
            {"mod_id": mod_id, "server_id": server_id},
            {"$set": {
                "mod_id": mod_id,
                "mod_name": canonical["name"],
                "server_id": server_id,
                "downloaded_by": current_user.get("username") or current_user.get("id", ""),
                "downloaded_by_id": current_user["id"],
                "downloaded_at": now,
            }},
            upsert=True,
        )

        if not canonical["thumbnail_url"]:
            needs_backfill.add(mod_id)

    if needs_backfill:
        _schedule_workshop_backfill(needs_backfill)

    # Purge workshop_mods entries that are no longer active on any server.
    # This is deferred to a background task so it does not block the HTTP
    # response — the scan touches all servers and can be slow at scale.
    asyncio.create_task(_purge_stale_workshop_mods())


async def _purge_stale_workshop_mods() -> None:
    """Background task: drop ``workshop_mods`` entries nothing references any more.

    This exists to bound the collection's growth, so it only removes records
    that nothing has needed for ``_WORKSHOP_PURGE_MAX_AGE_DAYS``. The previous
    sweep deleted every record not present in a server's mod list, on *every*
    loadout save — which is every mod a user is browsing in the Workshop tab,
    plus every dependency (a dependency is by definition not in the loadout).
    The tab's own index was wiped dozens of times a week: its cached search had
    nothing left to match, ``/refresh`` 404'd on mods the operator had just
    added, and every dependency scan fell back to slow live fetching.
    """
    try:
        active_server_mods = await db.managed_servers.find({}, {"mods": 1, "_id": 0}).to_list(None)
        protected_ids: set[str] = set()
        for active_server in active_server_mods:
            for mod in active_server.get("mods", []):
                mod_id = (mod.get("mod_id") or mod.get("modId") or "").strip()
                if mod_id:
                    protected_ids.add(mod_id)

        # Dependencies named by a loadout mod are part of a real configuration
        # even though they never appear in it. Resolve them before deleting
        # anything: purging without this protection is what kept breaking the
        # dependency cache. If this lookup fails, skip the purge entirely —
        # deleting with an incomplete protected set is the bug we are fixing.
        if protected_ids:
            cursor = db.workshop_mods.find(
                {"mod_id": {"$in": list(protected_ids)}},
                {"dependencies": 1, "_id": 0},
            )
            async for record in cursor:
                for dep in (record.get("dependencies") or []):
                    if not isinstance(dep, dict):
                        continue
                    dep_id = (dep.get("mod_id") or dep.get("modId") or "").strip()
                    if dep_id:
                        protected_ids.add(dep_id)

        cutoff = (
            datetime.now(timezone.utc) - timedelta(days=_WORKSHOP_PURGE_MAX_AGE_DAYS)
        ).isoformat()
        result = await db.workshop_mods.delete_many({
            "mod_id": {"$nin": list(protected_ids)},
            "manually_entered": {"$ne": True},
            "metadata_locked": {"$ne": True},
            "$or": [
                {"last_fetched": {"$lt": cutoff}},
                {"last_fetched": {"$exists": False}, "indexed_at": {"$lt": cutoff}},
                {"last_fetched": {"$exists": False}, "indexed_at": {"$exists": False}},
            ],
        })
        if result.deleted_count:
            logger.info(
                "Purged %d workshop_mods entries unused for %d+ days",
                result.deleted_count,
                _WORKSHOP_PURGE_MAX_AGE_DAYS,
            )
    except Exception as exc:
        logger.warning("_purge_stale_workshop_mods failed: %s", exc)


# Arma Reforger / BattlEye player IDs are alphanumeric identifiers (Steam IDs,
# UIDs, etc.).  They must never contain whitespace or ASCII control characters
# that could break or hijack the RCON command protocol.
_PLAYER_ID_RE = re.compile(r'^\S{1,128}$')
_SAT_BAN_REASON_MAX = 100


def _sat_ban_create_command(player_id: str, reason: str) -> str:
    """A permanent engine ban; Reforger answers a bare "#ban <id>" with its help text."""
    printable = "".join(ch if 0x20 <= ord(ch) <= 0x7E else " " for ch in reason or "")
    reason_text = " ".join(printable.split())[:_SAT_BAN_REASON_MAX].strip()
    command = f"#ban create {player_id} 0"
    return f"{command} {reason_text}" if reason_text else command


def _validate_player_id(player_id: str) -> str:
    """Raise ValueError if player_id contains disallowed characters."""
    if not _PLAYER_ID_RE.match(player_id):
        raise ValueError(
            "player_id must be 1 to 128 non-whitespace characters"
        )
    # Reject any ASCII control characters (0x00-0x1F, 0x7F)
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in player_id):
        raise ValueError("player_id must not contain control characters (0x00-0x1F, 0x7F)")
    return player_id


class SatBanCreate(BaseModel):
    player_id: str
    reason: str = ""

    @field_validator("player_id")
    @classmethod
    def player_id_must_be_safe(cls, value: str) -> str:
        return _validate_player_id(value)


@router.get("/servers/{server_id}/sat/status")
async def get_sat_status(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    server = await _reconcile_server_sat_state(server)
    sat_path, sat_status = _resolve_sat_path(server)
    latest_metrics = await db.server_metrics.find_one({"server_id": server_id}, {"_id": 0}, sort=[("timestamp", -1)])
    sat_config = None
    if sat_path:
        try:
            sat_config = load_sat_config(sat_path)
        except Exception:
            sat_config = None

    return _serialize_doc({
        "server_id": server_id,
        "status": server.get("status"),
        "readiness_state": server.get("readiness_state"),
        "sat_status": sat_status,
        "sat_config_path": sat_path,
        "uptime_seconds": (latest_metrics or {}).get("uptime_seconds"),
        "player_count": (latest_metrics or {}).get("player_count"),
        "server_fps": (latest_metrics or {}).get("server_fps"),
        "avg_player_ping_ms": (latest_metrics or {}).get("avg_player_ping_ms"),
        "ban_count": len(_get_sat_bans(sat_config or {})),
        "repeated_message_count": len((sat_config or {}).get("repeatedChatMessages") or []),
        "scheduled_message_count": len((sat_config or {}).get("scheduledChatMessages") or []),
    })


@router.get("/servers/{server_id}/sat/bans")
async def get_sat_bans(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    _, config = await _load_sat_state(server)
    return {"server_id": server_id, "bans": _get_sat_bans(config)}


@router.post("/servers/{server_id}/sat/bans")
async def add_sat_ban(
    server_id: str,
    body: SatBanCreate,
    current_user: dict = Depends(_require_servers),
):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    sat_path, config = await _load_sat_state(server)

    bans = _get_sat_bans(config)
    if not any(entry["id"] == body.player_id for entry in bans):
        bans.append({"id": body.player_id, "reason": body.reason})
    config["bans"] = {entry["id"]: entry.get("reason", "") for entry in bans}
    save_sat_config(sat_path, config)

    live_sync = {"executed": False, "response": "Server is offline"}
    if server.get("status") == "running":
        live_sync["executed"], live_sync["response"] = await bercon_client.execute(
            host=get_server_runtime_host(),
            port=int((server.get("ports") or {}).get("rcon", 19999)),
            password=str(((server.get("config") or {}).get("rcon") or {}).get("password") or ""),
            command=_sat_ban_create_command(body.player_id, body.reason),
        )

    return {"message": "Ban added", "bans": _get_sat_bans(config), "live_sync": live_sync}


@router.delete("/servers/{server_id}/sat/bans/{player_id}")
async def remove_sat_ban(server_id: str, player_id: str, current_user: dict = Depends(_require_servers)):
    try:
        _validate_player_id(player_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    sat_path, config = await _load_sat_state(server)

    bans = [entry for entry in _get_sat_bans(config) if entry["id"] != player_id]
    config["bans"] = {entry["id"]: entry.get("reason", "") for entry in bans}
    save_sat_config(sat_path, config)

    # Adding a ban also creates an engine ban, so removing it must lift that one too.
    live_sync = {"executed": False, "response": "Server is offline"}
    if server.get("status") == "running":
        live_sync["executed"], live_sync["response"] = await bercon_client.execute(
            host=get_server_runtime_host(),
            port=int((server.get("ports") or {}).get("rcon", 19999)),
            password=str(((server.get("config") or {}).get("rcon") or {}).get("password") or ""),
            command=f"#ban remove {player_id}",
        )
    return {"message": "Ban removed", "bans": _get_sat_bans(config), "live_sync": live_sync}


@router.post("/servers/{server_id}/sat/bans/sync")
async def sync_sat_bans(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    _, config = await _load_sat_state(server)
    bans = _get_sat_bans(config)
    if server.get("status") != "running":
        return {"executed": False, "detail": "Server is offline", "bans": bans}

    responses = []
    for entry in bans:
        player_id = entry["id"]
        try:
            _validate_player_id(player_id)
        except ValueError as exc:
            responses.append({"player_id": player_id, "executed": False, "response": f"Skipped: {exc}"})
            continue
        success, response = await bercon_client.execute(
            host=get_server_runtime_host(),
            port=int((server.get("ports") or {}).get("rcon", 19999)),
            password=str(((server.get("config") or {}).get("rcon") or {}).get("password") or ""),
            command=_sat_ban_create_command(player_id, entry.get("reason") or ""),
        )
        responses.append({"player_id": player_id, "executed": success, "response": response})
    return {"executed": True, "count": len(responses), "responses": responses}


@router.post("/servers/{server_id}/sat/tools/restore-defaults")
async def restore_sat_defaults(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    sat_path, _ = _resolve_sat_path(server)
    if not sat_path:
        raise HTTPException(status_code=409, detail="Server Admin Tools config is not available yet")
    if not overlay_baseline_if_configured(sat_path):
        raise HTTPException(status_code=409, detail="SAT baseline is not configured on this host")
    config = load_sat_config(sat_path)
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {"sat_config_path": sat_path, "sat_status": "configured", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"message": "SAT defaults restored", "config": config}


@router.post("/servers/{server_id}/sat/tools/copy-from-server")
async def copy_sat_from_server(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    sat_path, config = await _load_sat_state(server)
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {"sat_config_path": sat_path, "sat_status": "discovered", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"message": "SAT config copied from server", "config": config}


# ── Mods Management ─────────────────────────────────────────────────────────

@router.get("/servers/{server_id}/mods")
async def get_server_mods(server_id: str, current_user: dict = Depends(_require_servers)):
    """Get the enabled mods list for a server."""
    server = await db.managed_servers.find_one(
        {"id": server_id}, {"_id": 0, "mods": 1}
    )
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    enriched = await _enrich_mods_with_workshop_metadata(server)
    return enriched.get("mods", [])


def _normalize_mod_loadout(
    mods: list[dict],
    *,
    include_disabled: bool = True,
    include_pinned_versions: bool = True,
) -> list[dict]:
    normalized: list[dict] = []
    seen_mod_ids: set[str] = set()

    for mod in mods or []:
        if not isinstance(mod, dict):
            continue
        if not include_disabled and mod.get("enabled") is False:
            continue

        mod_id = _trim_optional_string(mod.get("mod_id") or mod.get("modId"))
        if re.fullmatch(r"[0-9A-Fa-f]{16}", mod_id):
            mod_id = mod_id.upper()
        if not mod_id or mod_id in seen_mod_ids:
            continue
        seen_mod_ids.add(mod_id)

        entry = {
            "mod_id": mod_id,
            "modId": mod_id,
            "name": _trim_optional_string(mod.get("name")) or mod_id,
            "enabled": mod.get("enabled") is not False,
        }
        if include_pinned_versions and mod.get("version"):
            entry["version"] = _trim_optional_string(mod.get("version"))

        for key in (
            "author",
            "description",
            "tags",
            "dependencies",
            "scenario_ids",
            "thumbnail_url",
            "metadata_source",
            "system_managed",
            "dependency_of",
        ):
            if key in mod:
                entry[key] = mod[key]
        if "thumbnail_url" not in entry and mod.get("thumbnailUrl"):
            entry["thumbnail_url"] = mod["thumbnailUrl"]
        if mod.get("system_managed") is True:
            entry["system_managed"] = True
        normalized.append(entry)

    return normalized


def _ensure_required_mods_for_storage(
    mods: list[dict],
    *,
    existing_mods: list[dict],
    sat_enabled: bool = True,
) -> list[dict]:
    del existing_mods  # kept for callers; nothing is carried over now.
    normalized = _normalize_mod_loadout(mods, include_disabled=True, include_pinned_versions=True)
    seen = {mod.get("mod_id") or mod.get("modId") for mod in normalized}
    if sat_enabled and SERVER_SAT_REQUIRED_MOD_ID not in seen:
        normalized.append({
            "mod_id": SERVER_SAT_REQUIRED_MOD_ID,
            "modId": SERVER_SAT_REQUIRED_MOD_ID,
            "name": DEFAULT_MOD_NAME,
            "enabled": True,
            "system_managed": True,
        })
    return normalized


async def _create_server_backup_snapshot(server: dict, *, current_user: dict, backup_type: str = "manual") -> str:
    backup = ServerBackup(
        server_id=server["id"],
        backup_type=backup_type,
        config_snapshot=server.get("config", {}),
        mods_snapshot=server.get("mods", []),
        created_by=current_user["id"],
    )
    doc = backup.model_dump()
    for key in ("created_at",):
        val = doc.get(key)
        if isinstance(val, datetime):
            doc[key] = val.isoformat()
    await db.server_backups.insert_one(doc)
    return backup.id


class ModListUpdate(BaseModel):
    mods: list


def _mod_list_index(mods) -> dict:
    """Map mod_id -> {name, version, enabled} for diffing two mod lists."""
    out: dict = {}
    for mod in mods or []:
        mid = (mod.get("mod_id") or mod.get("modId") or "").strip()
        if not mid:
            continue
        out[mid] = {
            "name": mod.get("name") or mid,
            "version": (mod.get("version") or "").strip(),
            "enabled": mod.get("enabled", True) is not False,
        }
    return out


def _summarize_mod_diff(before, after) -> dict:
    """Produce a human-readable diff between two mod lists for the changelog."""
    b = _mod_list_index(before)
    a = _mod_list_index(after)
    added = [{"mod_id": mid, "name": a[mid]["name"]} for mid in a if mid not in b]
    removed = [{"mod_id": mid, "name": b[mid]["name"]} for mid in b if mid not in a]
    version_changed = []
    enabled_changed = []
    for mid in a:
        if mid in b:
            if a[mid]["version"] != b[mid]["version"]:
                version_changed.append({
                    "mod_id": mid, "name": a[mid]["name"],
                    "from": b[mid]["version"], "to": a[mid]["version"],
                })
            if a[mid]["enabled"] != b[mid]["enabled"]:
                enabled_changed.append({
                    "mod_id": mid, "name": a[mid]["name"], "enabled": a[mid]["enabled"],
                })

    def _ids(mods):
        return [
            (m.get("mod_id") or m.get("modId") or "").strip() for m in mods or []
        ]

    def _order(mods):
        return [mid for mid in _ids(mods) if mid in a and mid in b]

    before_common = _order(before)
    after_common = _order(after)
    reordered = before_common != after_common
    moved = _detect_moves(before_common, after_common, _ids(before), _ids(after), a)

    return {
        "added": added,
        "removed": removed,
        "version_changed": version_changed,
        "enabled_changed": enabled_changed,
        "reordered": reordered,
        "moved": moved,
        "added_count": len(added),
        "removed_count": len(removed),
        "version_changed_count": len(version_changed),
        "enabled_changed_count": len(enabled_changed),
        "moved_count": len(moved),
    }


def _detect_moves(before_common, after_common, before_ids, after_ids, index) -> list:
    """Name the mods that actually changed load-order position.

    Reporting every mod whose index shifted is useless: moving one mod to the
    front renumbers everything behind it. So the mods that "moved" are the ones
    outside the longest common subsequence of the two orderings — the minimal
    set you would have to drag to turn `before` into `after`.

    Positions are reported as 1-based indexes into the FULL lists, because that
    is what the Load Order tab numbers, not the common-only subsequence.
    """
    if before_common == after_common:
        return []

    n, m = len(before_common), len(after_common)
    # Classic LCS table. n is the mod count (~130 in production), so the
    # O(n*m) table is a few thousand cells — cheap, and only on a real change.
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if before_common[i] == after_common[j]:
                table[i][j] = table[i + 1][j + 1] + 1
            else:
                table[i][j] = max(table[i + 1][j], table[i][j + 1])

    kept = set()
    i = j = 0
    while i < n and j < m:
        if before_common[i] == after_common[j]:
            kept.add(before_common[i])
            i += 1
            j += 1
        elif table[i + 1][j] >= table[i][j + 1]:
            i += 1
        else:
            j += 1

    before_pos = {mid: idx for idx, mid in enumerate(before_ids)}
    after_pos = {mid: idx for idx, mid in enumerate(after_ids)}
    moved = []
    for mid in after_common:
        if mid in kept:
            continue
        moved.append({
            "mod_id": mid,
            "name": index.get(mid, {}).get("name", mid),
            "from": before_pos.get(mid, -1) + 1,
            "to": after_pos.get(mid, -1) + 1,
        })
    return moved


async def _record_mod_revision(server_id, before_mods, after_mods, current_user, source) -> None:
    """Append a mod-list revision to the changelog/revert history.

    No-op writes (identical content and ordering) are skipped so the timeline
    only captures meaningful changes. Full before/after snapshots are stored so
    any revision can be restored later.
    """
    diff = _summarize_mod_diff(before_mods, after_mods)
    if not (diff["added"] or diff["removed"] or diff["version_changed"]
            or diff["enabled_changed"] or diff["reordered"]):
        return
    # Recording history is a non-critical side effect: the mod list + config
    # were already written successfully by the caller. Never let a history
    # write failure surface as a failed deploy/import/mirror/revert.
    try:
        count = await db.server_mod_revisions.count_documents({"server_id": server_id})
        now = datetime.now(timezone.utc)
        await db.server_mod_revisions.insert_one({
            "id": str(uuid.uuid4()),
            "server_id": server_id,
            "version": count + 1,
            "source": source,
            "diff": diff,
            "before_mods": before_mods,
            "after_mods": after_mods,
            "changed_by": current_user.get("id", ""),
            "changed_by_name": (
                current_user.get("username")
                or current_user.get("display_name")
                or current_user.get("id", "")
            ),
            "changed_at": now.isoformat(),
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to record mod revision for server %s: %s", server_id, exc)


@router.put("/servers/{server_id}/mods")
async def update_server_mods(
    server_id: str,
    body: ModListUpdate,
    current_user: dict = Depends(_require_servers),
):
    """Update the enabled mod list for a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    before_mods = server.get("mods", [])
    now = datetime.now(timezone.utc)
    normalized_mods = ensure_required_mods(
        body.mods,
        sat_enabled=server.get("sat_enabled", True),
    )
    next_config = generate_reforger_config({**server, "mods": normalized_mods})
    config_file_snapshots = snapshot_server_config_file(server)
    ok, result = await write_config_file({**server, "mods": normalized_mods, "config": next_config})
    if not ok:
        raise HTTPException(status_code=400, detail=result)
    try:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"mods": normalized_mods, "config": next_config, "config_path": result, "updated_at": now}},
        )
    except Exception:
        restore_file_snapshots(config_file_snapshots)
        raise
    await _sync_workshop_mod_metadata(server_id, normalized_mods, current_user)
    await _record_mod_revision(server_id, before_mods, normalized_mods, current_user, "deploy")
    await log_audit(
        user_id=current_user["id"],
        action_type="server_mods_update",
        resource_type="server",
        resource_id=server_id,
        before={"mods": before_mods},
        after={"mods": normalized_mods},
    )
    return {"message": "Mods updated", "count": len(normalized_mods)}


@router.get("/servers/{server_id}/mods/revisions")
async def list_mod_revisions(
    server_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(_require_servers),
):
    """Return a page of the mod-list change history (newest first).

    Full before/after snapshots are omitted here to keep the payload light —
    the per-revision ``diff`` carries everything the timeline renders, and
    ``mod_count`` is derived so a row can show the loadout size without them.
    The detail and revert endpoints load a snapshot by version when needed.

    Paged because this used to return a flat `.to_list(200)`: the busiest
    server already had 225 revisions, so its 25 oldest were unreachable and
    could not be reverted to.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0, "id": 1})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    total = await db.server_mod_revisions.count_documents({"server_id": server_id})
    cursor = db.server_mod_revisions.aggregate([
        {"$match": {"server_id": server_id}},
        {"$sort": {"version": -1}},
        {"$skip": offset},
        {"$limit": limit},
        {"$addFields": {"mod_count": {"$size": {"$ifNull": ["$after_mods", []]}}}},
        {"$project": {"_id": 0, "before_mods": 0, "after_mods": 0}},
    ])
    items = await cursor.to_list(limit)
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total,
    }


@router.get("/servers/{server_id}/mods/revisions/{version}")
async def get_mod_revision(
    server_id: str,
    version: int,
    current_user: dict = Depends(_require_servers),
):
    """Return one revision including the full loadout snapshot it produced.

    Backs "view the loadout as it was at this revision" — the list endpoint
    strips snapshots, so they are fetched one revision at a time.
    """
    revision = await db.server_mod_revisions.find_one(
        {"server_id": server_id, "version": version}, {"_id": 0}
    )
    if not revision:
        raise HTTPException(status_code=404, detail="Revision not found")
    return revision


@router.get("/servers/{server_id}/mods/revisions/{version}/compare/{other}")
async def compare_mod_revisions(
    server_id: str,
    version: int,
    other: int,
    current_user: dict = Depends(_require_servers),
):
    """Diff the loadouts produced by two revisions, oldest treated as the base.

    Answers "what changed between Tuesday and now" without stepping through
    every intermediate revision.
    """
    low, high = sorted((version, other))
    if low == high:
        raise HTTPException(status_code=400, detail="Pick two different revisions")

    revisions = await db.server_mod_revisions.find(
        {"server_id": server_id, "version": {"$in": [low, high]}},
        {"_id": 0, "version": 1, "after_mods": 1, "changed_at": 1, "changed_by_name": 1, "source": 1},
    ).to_list(2)
    by_version = {r["version"]: r for r in revisions}
    missing = [v for v in (low, high) if v not in by_version]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Revision {missing[0]} not found",
        )

    base, target = by_version[low], by_version[high]
    return {
        "base": {k: base.get(k) for k in ("version", "changed_at", "changed_by_name", "source")},
        "target": {k: target.get(k) for k in ("version", "changed_at", "changed_by_name", "source")},
        "diff": _summarize_mod_diff(base.get("after_mods") or [], target.get("after_mods") or []),
    }


@router.post("/servers/{server_id}/mods/revisions/{version}/revert")
async def revert_mod_revision(
    server_id: str,
    version: int,
    current_user: dict = Depends(_require_servers),
):
    """Restore the saved loadout to the snapshot captured by a revision.

    Gated under the same ``server_mod_update`` policy as a normal deploy. The
    revert itself records a new revision so the timeline stays complete.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    revision = await db.server_mod_revisions.find_one(
        {"server_id": server_id, "version": version}, {"_id": 0}
    )
    if not revision:
        raise HTTPException(status_code=404, detail="Revision not found")

    target_mods = revision.get("after_mods") or []
    before_mods = server.get("mods", [])


    now = datetime.now(timezone.utc)
    normalized_mods = ensure_required_mods(
        target_mods,
        sat_enabled=server.get("sat_enabled", True),
    )
    next_config = generate_reforger_config({**server, "mods": normalized_mods})
    config_file_snapshots = snapshot_server_config_file(server)
    ok, result = await write_config_file({**server, "mods": normalized_mods, "config": next_config})
    if not ok:
        raise HTTPException(status_code=400, detail=result)
    try:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"mods": normalized_mods, "config": next_config, "config_path": result, "updated_at": now}},
        )
    except Exception:
        restore_file_snapshots(config_file_snapshots)
        raise
    await _sync_workshop_mod_metadata(server_id, normalized_mods, current_user)
    await _record_mod_revision(server_id, before_mods, normalized_mods, current_user, f"revert_to_v{version}")
    await log_audit(
        user_id=current_user["id"],
        action_type="server_mods_revert",
        resource_type="server",
        resource_id=server_id,
        before={"mods": before_mods},
        after={"mods": normalized_mods, "reverted_to_version": version},
    )
    return {"message": f"Reverted to revision {version}", "count": len(normalized_mods)}


@router.post("/servers/{source_server_id}/mods/mirror")
async def mirror_server_mods(
    source_server_id: str,
    body: ModLoadoutMirrorRequest,
    current_user: dict = Depends(_require_servers),
):
    """Mirror one managed server's mod load order to other managed servers."""
    target_ids = []
    seen_target_ids: set[str] = set()
    for raw_id in body.target_server_ids or []:
        target_id = _trim_optional_string(raw_id)
        if not target_id or target_id in seen_target_ids:
            continue
        seen_target_ids.add(target_id)
        target_ids.append(target_id)

    if not target_ids:
        raise HTTPException(status_code=400, detail="Select at least one target server.")

    source_server = await db.managed_servers.find_one({"id": source_server_id}, {"_id": 0})
    if not source_server:
        raise HTTPException(status_code=404, detail="Source server not found")

    source_mods = _mirror_source_mods(source_server, body)

    results: list[dict] = []
    for target_id in target_ids:
        if target_id == source_server_id:
            results.append({
                "target_server_id": target_id,
                "ok": False,
                "error": "Cannot mirror a server loadout to itself.",
            })
            continue

        target_server = await db.managed_servers.find_one({"id": target_id}, {"_id": 0})
        if not target_server:
            results.append({
                "target_server_id": target_id,
                "ok": False,
                "error": "Target server not found.",
            })
            continue

        before_mods = target_server.get("mods", [])
        normalized_mods = _mirror_target_mods(source_mods, target_server, body)
        scenario_warning = await _mirror_scenario_warning(target_server, normalized_mods)
        now = datetime.now(timezone.utc)

        backup_id = None
        try:
            if body.create_backups:
                backup_id = await _create_server_backup_snapshot(
                    target_server,
                    current_user=current_user,
                    backup_type="mirror",
                )

            next_config = generate_reforger_config({**target_server, "mods": normalized_mods})
            config_file_snapshots = snapshot_server_config_file(target_server)
            ok, config_path = await write_config_file({**target_server, "mods": normalized_mods, "config": next_config})
            if not ok:
                raise HTTPException(status_code=400, detail=config_path)

            try:
                await db.managed_servers.update_one(
                    {"id": target_id},
                    {"$set": {
                        "mods": normalized_mods,
                        "config": next_config,
                        "config_path": config_path,
                        "updated_at": now,
                    }},
                )
            except Exception:
                restore_file_snapshots(config_file_snapshots)
                raise
            await _sync_workshop_mod_metadata(target_id, normalized_mods, current_user)
            await _record_mod_revision(target_id, before_mods, normalized_mods, current_user, "mirror")
            updated_target = {**target_server, "mods": normalized_mods, "config": next_config, "config_path": config_path, "updated_at": now}
            await sync_server_notifications(updated_target)
            await log_audit(
                user_id=current_user["id"],
                action_type="server_mods_mirror",
                resource_type="server",
                resource_id=target_id,
                before={"mods": before_mods},
                after={
                    "mods": normalized_mods,
                    "source_server_id": source_server_id,
                    "backup_id": backup_id,
                    "preserve_system_managed": body.preserve_system_managed,
                },
            )

            post_action = None
            post_action_error = None
            if body.reconfigure_targets:
                try:
                    await reconfigure_server(target_id, current_user=current_user)
                    post_action = "reconfigure_requested"
                except Exception as exc:
                    post_action = "reconfigure_failed"
                    post_action_error = str(getattr(exc, "detail", exc)) or "Reconfigure failed."
            elif body.restart_targets:
                try:
                    await restart_server(target_id, current_user=current_user)
                    post_action = "restart_requested"
                except Exception as exc:
                    post_action = "restart_failed"
                    post_action_error = str(getattr(exc, "detail", exc)) or "Restart failed."

            results.append({
                "target_server_id": target_id,
                "target_name": target_server.get("name", ""),
                "ok": True,
                "mod_count": len(normalized_mods),
                "editable_mod_count": len([mod for mod in normalized_mods if not mod.get("system_managed")]),
                "system_managed_count": len([mod for mod in normalized_mods if mod.get("system_managed")]),
                "backup_id": backup_id,
                "post_action": post_action,
                "post_action_error": post_action_error,
                "scenario_warning": scenario_warning,
            })
        except HTTPException as exc:
            results.append({
                "target_server_id": target_id,
                "target_name": target_server.get("name", ""),
                "ok": False,
                "backup_id": backup_id,
                "error": str(exc.detail),
            })
        except Exception as exc:
            logger.exception("Failed to mirror mods from %s to %s", source_server_id, target_id)
            results.append({
                "target_server_id": target_id,
                "target_name": target_server.get("name", ""),
                "ok": False,
                "backup_id": backup_id,
                "error": str(exc) or "Mirror failed.",
            })

    succeeded = len([result for result in results if result.get("ok")])
    failed = len(results) - succeeded
    post_action_failures = len([
        result for result in results if result.get("post_action_error")
    ])
    response = {
        "source_server_id": source_server_id,
        "source_name": source_server.get("name", ""),
        "requested": len(target_ids),
        "succeeded": succeeded,
        "failed": failed,
        "post_action_failures": post_action_failures,
        "results": results,
    }
    return response


def _mirror_source_mods(source_server: dict, options) -> list[dict]:
    return [
        mod for mod in _normalize_mod_loadout(
            source_server.get("mods", []),
            include_disabled=options.include_disabled,
            include_pinned_versions=options.include_pinned_versions,
        )
        if not mod.get("system_managed")
    ]


def _mirror_target_mods(source_mods: list[dict], target_server: dict, options) -> list[dict]:
    """The loadout a target ends up with: the source's mods plus its own system mods."""
    before_mods = target_server.get("mods", [])
    target_system_mods = []
    if options.preserve_system_managed:
        target_system_mods = [
            mod for mod in _normalize_mod_loadout(
                before_mods,
                include_disabled=True,
                include_pinned_versions=options.include_pinned_versions,
            )
            if mod.get("system_managed")
        ]

    target_system_by_id = {
        mod.get("mod_id") or mod.get("modId"): mod
        for mod in target_system_mods
    }
    source_with_preserved_system_metadata = [
        {
            **mod,
            **target_system_by_id.get(mod.get("mod_id") or mod.get("modId"), {}),
        }
        for mod in source_mods
    ]
    merged_mods = _normalize_mod_loadout(
        [*source_with_preserved_system_metadata, *target_system_mods],
        include_disabled=True,
        include_pinned_versions=options.include_pinned_versions,
    )
    return _ensure_required_mods_for_storage(
        merged_mods,
        existing_mods=before_mods,
        sat_enabled=target_server.get("sat_enabled", True),
    )


def _server_scenario_id(server: dict) -> str:
    config = server.get("config") or {}
    return str((config.get("game") or {}).get("scenarioId") or config.get("scenarioId") or "").strip()


async def _mirror_scenario_warning(target_server: dict, after_mods: list[dict]) -> Optional[dict]:
    """Warn when a mirror drops the mod that ships the target's scenario.

    A mirror replaces the whole loadout but keeps the target's scenario, so a
    scenario that came from a mod only the target had stops loading and the
    server crash-loops ("Unable to read the mission header").
    """
    scenario_id = _server_scenario_id(target_server)
    match = re.match(r"\{([0-9A-Fa-f]{16})\}", scenario_id)
    if not match or any(s["id"] == scenario_id for s in VANILLA_SCENARIOS):
        return None
    try:
        providers = await db.workshop_mods.find(
            {"scenarios.scenario_id": {"$regex": f"^\\{{{match.group(1)}\\}}", "$options": "i"}},
            {"_id": 0, "mod_id": 1, "name": 1},
        ).to_list(10)
    except Exception:
        return None
    provider_ids = {str(p.get("mod_id", "")).upper() for p in providers if p.get("mod_id")}
    if not provider_ids:
        return None
    present = {(m.get("mod_id") or m.get("modId") or "").upper() for m in after_mods}
    frontier = set(present)
    for _ in range(3):  # a scenario mod can arrive as a dependency
        if provider_ids & present or not frontier:
            break
        docs = await db.workshop_mods.find(
            {"mod_id": {"$in": sorted(frontier)}}, {"_id": 0, "dependencies": 1},
        ).to_list(500)
        frontier = {
            (d.get("mod_id") or d.get("modId") or "").upper()
            for doc in docs for d in doc.get("dependencies") or []
        } - present
        present |= frontier
    if provider_ids & present:
        return None
    names = [p.get("name") or p["mod_id"] for p in providers]
    return {
        "scenario_id": scenario_id,
        "providers": [{"mod_id": str(p["mod_id"]).upper(), "name": p.get("name") or p["mod_id"]} for p in providers],
        "message": (
            f"{target_server.get('name', 'The target')} runs scenario {scenario_id}, which comes from "
            f"{', '.join(names)}. That mod is not in the mirrored loadout, so the server will fail to "
            "start until you keep it or choose another scenario."
        ),
    }


class ModLoadoutPullRequest(BaseModel):
    source_server_id: str
    preserve_system_managed: bool = True
    include_disabled: bool = True
    include_pinned_versions: bool = True
    create_backups: bool = True
    restart_target: bool = False
    reconfigure_target: bool = False


@router.get("/servers/{server_id}/mods/mirror-preview")
async def preview_mod_mirror(
    server_id: str,
    source_server_id: str = Query(..., min_length=1),
    preserve_system_managed: bool = True,
    include_disabled: bool = True,
    include_pinned_versions: bool = True,
    current_user: dict = Depends(_require_servers),
):
    """What pulling ``source_server_id``'s loadout onto this server would change."""
    if source_server_id == server_id:
        raise HTTPException(status_code=400, detail="Pick a different server to pull from.")
    target_server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not target_server:
        raise HTTPException(status_code=404, detail="Server not found")
    source_server = await db.managed_servers.find_one({"id": source_server_id}, {"_id": 0})
    if not source_server:
        raise HTTPException(status_code=404, detail="Source server not found")
    options = ModLoadoutPullRequest(
        source_server_id=source_server_id,
        preserve_system_managed=preserve_system_managed,
        include_disabled=include_disabled,
        include_pinned_versions=include_pinned_versions,
    )
    after_mods = _mirror_target_mods(_mirror_source_mods(source_server, options), target_server, options)
    return {
        "source": {"id": source_server_id, "name": source_server.get("name", ""), "status": source_server.get("status")},
        "target": {"id": server_id, "name": target_server.get("name", ""), "status": target_server.get("status")},
        "mod_count_before": len(target_server.get("mods") or []),
        "mod_count_after": len(after_mods),
        "diff": _summarize_mod_diff(target_server.get("mods") or [], after_mods),
        "scenario_warning": await _mirror_scenario_warning(target_server, after_mods),
    }


@router.post("/servers/{server_id}/mods/mirror-from")
async def pull_server_mods(
    server_id: str,
    body: ModLoadoutPullRequest,
    current_user: dict = Depends(_require_servers),
):
    """Pull another server's mod loadout onto this one.

    The reverse of ``/mods/mirror``, for working from the server being changed;
    it runs the same mirror path, so backup, revision and audit behaviour are
    identical.
    """
    source_id = _trim_optional_string(body.source_server_id)
    if not source_id:
        raise HTTPException(status_code=400, detail="Select a server to pull from.")
    if source_id == server_id:
        raise HTTPException(status_code=400, detail="Cannot mirror a server loadout to itself.")
    return await mirror_server_mods(
        source_id,
        ModLoadoutMirrorRequest(
            target_server_ids=[server_id],
            preserve_system_managed=body.preserve_system_managed,
            include_disabled=body.include_disabled,
            include_pinned_versions=body.include_pinned_versions,
            create_backups=body.create_backups,
            restart_targets=body.restart_target,
            reconfigure_targets=body.reconfigure_target,
        ),
        current_user=current_user,
    )


class ModRef(BaseModel):
    mod_id: Optional[str] = None
    modId: Optional[str] = None
    name: Optional[str] = None
    version: Optional[str] = None


class ModValidateRequest(BaseModel):
    mods: list[ModRef]


@router.post("/servers/{server_id}/mods/validate")
async def validate_server_mods(
    server_id: str,
    body: ModValidateRequest,
    current_user: dict = Depends(_require_servers),
):
    """Validate a mod list for conflicts, missing deps, and known issues."""
    # Verify server exists
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    issues = []

    # Check for duplicates
    seen_ids = set()
    for mod in body.mods:
        mid = mod.mod_id or mod.modId or ""
        if mid in seen_ids:
            issues.append({
                "type": "duplicate",
                "severity": "warning",
                "mod_id": mid,
                "message": f"Duplicate mod: {mod.name or mid}"
            })
        seen_ids.add(mid)

    # Check for known problematic mods
    active_issues = await db.mod_issues.find(
        {"status": "active", "confidence_score": {"$gte": 0.6}}
    ).to_list(200)
    bad_mod_ids = {i["mod_id"] for i in active_issues if "mod_id" in i}
    for mod in body.mods:
        mid = mod.mod_id or mod.modId or ""
        if mid in bad_mod_ids:
            matching_issues = [i for i in active_issues if i.get("mod_id") == mid]
            issues.append({
                "type": "known_issue",
                "severity": "high",
                "mod_id": mid,
                "message": f"Mod '{mod.name or mid}' has {len(matching_issues)} active issue(s) with high confidence"
            })

    # Check for missing dependencies (batch query to avoid N+1)
    all_mod_ids = [m.mod_id or m.modId for m in body.mods if m.mod_id or m.modId]
    projection = {
        "_id": 0,
        "mod_id": 1,
        "name": 1,
        "version": 1,
        "dependencies": 1,
        "removed_from_workshop": 1,
        "removed_detected_at": 1,
        "downloadable": 1,
        "workshop_flags": 1,
    }
    workshop_docs = await db.workshop_mods.find(
        {"mod_id": {"$in": all_mod_ids}}, projection,
    ).to_list(500)
    ws_lookup = {d["mod_id"]: d for d in workshop_docs}
    issues.extend(await _dependency_availability_issues(body.mods, ws_lookup, projection))
    issues.extend(_version_pin_issues(body.mods, ws_lookup))

    for mod in body.mods:
        mid = mod.mod_id or mod.modId or ""
        if not mid:
            continue
        workshop_mod = ws_lookup.get(mid)
        if workshop_mod and workshop_mod.get("removed_from_workshop"):
            issues.append({
                "type": "removed_from_workshop",
                "severity": "high",
                "mod_id": mid,
                "message": (
                    f"Mod '{mod.name or workshop_mod.get('name') or mid}' has been "
                    "removed from the Workshop. It remains in this loadout for "
                    "operator review and will not be deleted automatically."
                ),
            })
        if workshop_mod and workshop_mod.get("dependencies"):
            for dep in workshop_mod["dependencies"]:
                dep_id = dep.get("mod_id") or dep.get("modId", "")
                if dep_id and dep_id not in seen_ids:
                    issues.append({
                        "type": "missing_dependency",
                        "severity": "warning",
                        "mod_id": mid,
                        "dependency_id": dep_id,
                        "message": f"Mod '{mod.name or mid}' depends on {dep_id} which is not in the mod list"
                    })

    blocking = [i for i in issues if i.get("severity") in {"high", "critical"}]
    return {
        "issues": issues,
        "mod_count": len(body.mods),
        "valid": len(issues) == 0,
        "blocking_count": len(blocking),
    }


def _version_tuple(value: str) -> tuple:
    parts = []
    for piece in re.split(r"[.\-+]", str(value or "").strip()):
        parts.append((0, int(piece)) if piece.isdigit() else (1, piece))
    return tuple(parts)


def _version_below(pinned: str, required: str) -> bool:
    if not pinned or not required:
        return False
    try:
        return _version_tuple(pinned) < _version_tuple(required)
    except TypeError:
        return False


def _version_pin_issues(mods: list, ws_lookup: dict) -> list[dict]:
    """Pins below what another listed mod requires, and pins behind latest.

    Reforger resolves a listed mod's dependencies at the version the parent
    declares; a loadout that pins the dependency lower cannot be satisfied and
    the server refuses to download (``assetDependenciesUnresolvable``).
    """
    issues: list[dict] = []
    pins = {}
    names = {}
    for mod in mods:
        mid = (mod.mod_id or mod.modId or "").upper()
        if not mid:
            continue
        names[mid] = mod.name or mid
        if mod.version and mod.version.lower() != "latest":
            pins[mid] = mod.version
    required: dict[str, tuple[str, str]] = {}
    for mod in mods:
        parent = (mod.mod_id or mod.modId or "").upper()
        for dep in (ws_lookup.get(parent) or ws_lookup.get(mod.mod_id or mod.modId or "") or {}).get("dependencies") or []:
            did = (dep.get("mod_id") or dep.get("modId") or "").upper()
            need = (dep.get("version") or "").strip()
            if did and need and (did not in required or _version_below(required[did][0], need)):
                required[did] = (need, parent)
    for mid, pinned in pins.items():
        need = required.get(mid)
        if need and _version_below(pinned, need[0]):
            issues.append({
                "type": "version_conflict",
                "severity": "high",
                "mod_id": mid,
                "pinned_version": pinned,
                "required_version": need[0],
                "required_by": need[1],
                "message": (
                    f"'{names.get(mid, mid)}' is pinned to {pinned}, but "
                    f"'{names.get(need[1], need[1])}' requires {need[0]} or newer. "
                    "Unpin it or pin a newer version."
                ),
            })
            continue
        latest = (ws_lookup.get(mid) or {}).get("version") or ""
        if latest and _version_below(pinned, latest):
            issues.append({
                "type": "pinned_outdated",
                "severity": "info",
                "mod_id": mid,
                "pinned_version": pinned,
                "latest_version": latest,
                "message": f"'{names.get(mid, mid)}' is pinned to {pinned}; the Workshop has {latest}.",
            })
    return issues


async def _dependency_availability_issues(mods: list, ws_lookup: dict, projection: dict) -> list[dict]:
    """Listed mods, and dependencies down the tree, the Workshop will not serve."""
    issues: list[dict] = []
    names = {(m.mod_id or m.modId or "").upper(): m.name for m in mods}
    for mod in mods:
        mid = mod.mod_id or mod.modId or ""
        record = ws_lookup.get(mid) or {}
        if record.get("downloadable") is False and not record.get("removed_from_workshop"):
            flags = [k for k, v in (record.get("workshop_flags") or {}).items() if v and k in {"blocked", "private"}]
            issues.append({
                "type": "not_downloadable",
                "severity": "high",
                "mod_id": mid,
                "message": (
                    f"Mod '{mod.name or record.get('name') or mid}' is "
                    f"{' and '.join(flags) or 'unavailable'} on the Workshop; the server cannot download it."
                ),
            })

    # Walk the dependency tree through stored records (a few levels deep is
    # plenty in practice), then flag every edge to a dependency the Workshop
    # marks unavailable or has removed.
    lookup = dict(ws_lookup)
    frontier = list(lookup.values())
    edges: list[tuple[dict, dict]] = []
    for _ in range(4):
        missing: set[str] = set()
        for record in frontier:
            for dep in record.get("dependencies") or []:
                did = dep.get("mod_id") or dep.get("modId") or ""
                if not did:
                    continue
                edges.append((record, dep))
                if did not in lookup:
                    missing.add(did)
        if not missing:
            break
        found = await db.workshop_mods.find({"mod_id": {"$in": sorted(missing)}}, projection).to_list(500)
        for doc in found:
            lookup[doc["mod_id"]] = doc
        frontier = found

    seen: set[tuple[str, str]] = set()
    for record, dep in edges:
        parent = record.get("mod_id", "")
        did = dep.get("mod_id") or dep.get("modId") or ""
        dep_record = lookup.get(did) or {}
        if dep.get("unavailable"):
            reason = "/".join(dep["unavailable"]) + " on the Workshop"
        elif dep_record.get("removed_from_workshop"):
            reason = "removed from the Workshop"
        elif dep_record.get("downloadable") is False:
            reason = "not downloadable from the Workshop"
        else:
            continue
        if (parent, did) in seen:
            continue
        seen.add((parent, did))
        issues.append({
            "type": "dependency_unavailable",
            "severity": "high",
            "mod_id": parent,
            "dependency_id": did,
            "message": (
                f"'{names.get(parent.upper()) or record.get('name') or parent}' depends on "
                f"'{dep.get('name') or dep_record.get('name') or did}', which is {reason}."
            ),
        })
    return issues


# ── Mod JSON Import / Export ─────────────────────────────────────────────────

class ModJsonImportRequest(BaseModel):
    mods: Optional[list[dict]] = None
    game: Optional[dict] = None  # Support full Reforger config.json format


@router.post("/servers/{server_id}/mods/import-json")
async def import_mods_json(
    server_id: str,
    body: ModJsonImportRequest,
    current_user: dict = Depends(_require_servers),
):
    """Import a JSON mod list into a server, replacing its current mod list.
    
    Accepts either:
    - {"mods": [...]} with mod objects
    - A full Reforger server config.json with mods at game.mods
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    # Extract mods from either format
    raw_mods = body.mods
    if raw_mods is None and body.game and isinstance(body.game.get("mods"), list):
        # Full Reforger config.json format: game.mods uses modId key
        raw_mods = []
        for m in body.game["mods"]:
            raw_mods.append({
                "mod_id": m.get("modId") or m.get("mod_id") or "",
                "name": m.get("name") or m.get("modId") or m.get("mod_id") or "",
                "version": m.get("version") or "",
                "enabled": True,
            })
    if not raw_mods:
        raise HTTPException(status_code=400, detail="No mods found. Provide a 'mods' array or a full Reforger config.json with game.mods.")

    before_mods = server.get("mods", [])
    normalized: list[dict] = []
    seen_mod_ids: set = set()
    for m in raw_mods:
        mod_id = m.get("mod_id") or m.get("modId") or ""
        name = m.get("name") or ""
        version = m.get("version") or ""
        if not mod_id or mod_id in seen_mod_ids:
            continue
        seen_mod_ids.add(mod_id)
        entry = {
            "mod_id": mod_id,
            "name": name,
            "version": version,
            "enabled": m.get("enabled", True),
        }
        # Preserve optional fields
        for key in (
            "author", "tags", "dependencies", "dependency_of", "scenario_ids",
            "description", "thumbnail_url", "metadata_source",
        ):
            if key in m:
                entry[key] = m[key]
        normalized.append(entry)

    normalized = _ensure_required_mods_for_storage(
        normalized,
        existing_mods=before_mods,
        sat_enabled=server.get("sat_enabled", True),
    )
    now = datetime.now(timezone.utc)
    next_config = generate_reforger_config({**server, "mods": normalized})
    config_file_snapshots = snapshot_server_config_file(server)
    ok, config_path = await write_config_file({**server, "mods": normalized, "config": next_config})
    if not ok:
        raise HTTPException(status_code=400, detail=config_path)
    try:
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"mods": normalized, "config": next_config, "config_path": config_path, "updated_at": now}},
        )
    except Exception:
        restore_file_snapshots(config_file_snapshots)
        raise
    await _sync_workshop_mod_metadata(server_id, normalized, current_user)
    await _record_mod_revision(server_id, before_mods, normalized, current_user, "import")
    await log_audit(
        user_id=current_user["id"],
        action_type="server_mods_import",
        resource_type="server",
        resource_id=server_id,
        before={"mods": before_mods},
        after={"mods": normalized},
    )

    # Record download history for each imported mod
    return {"message": "Mods imported", "count": len(normalized)}


@router.get("/servers/{server_id}/mods/export-json")
async def export_mods_json(
    server_id: str,
    format: Optional[str] = Query(None),
    current_user: dict = Depends(_require_servers),
):
    """Export the current mod list of a server as JSON.
    
    Use ?format=config to export the full raw Reforger server config.json.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    if format == "config":
        # Return the full generated Reforger config.json
        config = server.get("config")
        if not config:
            config = generate_reforger_config(server)
        return config

    mods = server.get("mods", [])
    return {"server_id": server_id, "server_name": server.get("name", ""), "mods": mods}


# ── Mod Download History ─────────────────────────────────────────────────────

class RecordDownloadHistoryRequest(BaseModel):
    server_id: str
    mod_id: str
    mod_name: str = ""


@router.post("/servers/mod-download-history")
async def record_download_history(
    body: RecordDownloadHistoryRequest,
    current_user: dict = Depends(_require_servers),
):
    """Record that a mod was added to a server (upsert latest download)."""
    now = datetime.now(timezone.utc).isoformat()
    await db.mod_download_history.update_one(
        {"mod_id": body.mod_id, "server_id": body.server_id},
        {"$set": {
            "mod_id": body.mod_id,
            "mod_name": body.mod_name,
            "server_id": body.server_id,
            "downloaded_by": current_user.get("username") or current_user.get("id", ""),
            "downloaded_by_id": current_user["id"],
            "downloaded_at": now,
        }},
        upsert=True,
    )
    return {"message": "Download history recorded"}


# ── Workshop Live Proxy (browse/search the real Workshop) ────────────────────

@router.get("/workshop/browse")
async def browse_workshop_live(
    category: str = Query("popular", description="Category: popular, newest, subscribers, versionSize"),
    page: int = Query(1, ge=1),
    tags: Optional[str] = Query(None, description="Comma-separated tags"),
    current_user: dict = Depends(_require_servers),
):
    """Browse the live Arma Reforger Workshop by category with pagination."""
    from services.workshop_proxy import browse_workshop

    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
    result = await browse_workshop(category=category, page=page, tags=tag_list)
    return result


async def _index_workshop_search_results(mods: list[dict]) -> None:
    """Persist lightweight live-search rows so later searches can render immediately."""
    for mod in mods or []:
        mod_id = _trim_optional_string(mod.get("mod_id") or mod.get("modId")).upper()
        if not re.fullmatch(r"[0-9A-F]{16}", mod_id):
            continue
        try:
            existing = await db.workshop_mods.find_one(
                {"mod_id": mod_id},
                {
                    "_id": 0,
                    "metadata_locked": 1,
                    "metadata_source": 1,
                    "manual_overrides": 1,
                },
            )
            if existing and (
                existing.get("metadata_locked")
                or existing.get("metadata_source") == "manual"
            ):
                continue
            indexed = {
                key: value
                for key, value in {**mod, "mod_id": mod_id}.items()
                if key != "_id" and value is not None
            }
            indexed["last_indexed_at"] = datetime.now(timezone.utc).isoformat()
            indexed["availability_status"] = "available"
            indexed["removed_from_workshop"] = False
            indexed["removed_detected_at"] = None
            indexed["availability_checked_at"] = indexed["last_indexed_at"]
            indexed["availability_error"] = ""
            if existing and existing.get("manual_overrides"):
                indexed["manual_overrides"] = existing["manual_overrides"]
                for field, value in existing["manual_overrides"].items():
                    if value is not None:
                        indexed[field] = value
                indexed["metadata_source"] = "hybrid"
            update_filter: dict[str, Any] = {
                "mod_id": mod_id,
                "metadata_locked": {"$ne": True},
                "metadata_source": {"$ne": "manual"},
            }
            if existing is not None:
                update_filter["manual_overrides"] = (
                    existing["manual_overrides"]
                    if "manual_overrides" in existing
                    else {"$exists": False}
                )
            await db.workshop_mods.update_one(
                update_filter,
                {
                    "$set": indexed,
                    "$setOnInsert": {"indexed_at": datetime.now(timezone.utc).isoformat()},
                },
                # Existing rows use an optimistic conditional update. New rows
                # may upsert; a concurrent manual insert wins via the unique
                # mod_id constraint instead of being overwritten.
                upsert=existing is None,
            )
        except Exception as exc:
            logger.warning("Failed to index Workshop search result %s: %s", mod_id, exc)


@router.get("/workshop/search")
async def search_workshop_live(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1),
    sort: str = Query("popularity", description="Sort: popularity, newest, subscribers, versionSize"),
    tags: Optional[str] = Query(None, description="Comma-separated tags to filter by"),
    current_user: dict = Depends(_require_servers),
):
    """Search the live Arma Reforger Workshop with pagination."""
    from services.workshop_proxy import search_workshop
    from services.workshop_ingest import fetch_mod_metadata

    query = q.strip()
    if not query:
        return {"mods": [], "total": 0, "page": page, "per_page": 16, "total_pages": 0}
    if re.fullmatch(r"[0-9A-Fa-f]{16}", query):
        mod_id = query.upper()
        mod = await fetch_mod_metadata(mod_id)
        if mod:
            return {
                "mods": [mod], "total": 1, "page": 1, "per_page": 16,
                "total_pages": 1, "query": query, "source": "direct",
            }
        return {
            "mods": [], "total": 0, "page": 1, "per_page": 16,
            "total_pages": 0, "query": query, "source": "error",
            "error": "Mod ID was not found in the Workshop",
        }
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
    result = await search_workshop(query=query, page=page, sort=sort, tags=tag_list)
    if result.get("mods"):
        asyncio.create_task(_index_workshop_search_results(result["mods"]))
    return result


# ── Workshop Browser (local cache) ──────────────────────────────────────────

@router.get("/servers/workshop/search")
async def search_workshop(
    q: str = Query("", description="Search query"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(_require_servers),
):
    """Search cached workshop mod metadata."""
    query_filter = {}
    if q:
        # Escape the user query before using it as a Mongo $regex so a
        # catastrophic-backtracking pattern (e.g. "(a+)+$") can't stall the
        # worker. Matches the safe pattern used by the other search endpoints
        # (routes/search.py:16, recruitment, intel, etc.).
        safe = re.escape(q)
        query_filter["$or"] = [
            {"name": {"$regex": safe, "$options": "i"}},
            {"mod_id": {"$regex": safe, "$options": "i"}},
            {"author": {"$regex": safe, "$options": "i"}},
        ]
    total = await db.workshop_mods.count_documents(query_filter)
    mods = await db.workshop_mods.find(query_filter, {"_id": 0}) \
        .skip((page - 1) * per_page) \
        .limit(per_page) \
        .to_list(per_page)
    return {"mods": mods, "total": total, "page": page, "per_page": per_page}


@router.get("/servers/workshop/mod/{mod_id}")
async def get_workshop_mod(mod_id: str, current_user: dict = Depends(_require_servers)):
    """Get cached metadata for a specific workshop mod."""
    mod = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})
    if not mod:
        raise HTTPException(status_code=404, detail="Mod not found in cache")
    return mod


@router.get("/servers/workshop/mod/{mod_id}/details")
async def get_workshop_mod_details(
    mod_id: str,
    refresh: bool = False,
    current_user: dict = Depends(_require_servers),
):
    """Get enriched metadata for a mod including versions, scenarios, deps, changelog.

    Always fetches fresh data from the workshop detail page and merges it
    with any existing DB record.  The result is both stored to the DB and
    returned directly, bypassing the ingest cache entirely.

    Pass ``?refresh=true`` to force a refetch even if enriched data exists.
    """
    from services.workshop_ingest import fetch_and_store_mod

    from services.workshop_ingest import TOMBSTONE_RECHECK

    mod = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})

    # Determine if we need a refresh
    needs_refresh = refresh or not mod
    if mod and not refresh:
        has_enriched = bool(mod.get("versions")) or bool(mod.get("subscribers"))
        if mod.get("removed_from_workshop"):
            # A tombstone has no versions by definition; refetching it every
            # time its panel opened just re-confirmed the 404.
            checked = mod.get("availability_checked_at") or mod.get("last_fetched") or ""
            recheck_after = (datetime.now(timezone.utc) - TOMBSTONE_RECHECK).isoformat()
            needs_refresh = checked < recheck_after
        elif not has_enriched:
            needs_refresh = True

    if needs_refresh:
        refreshed = await fetch_and_store_mod(mod_id, force_refresh=True)
        if refreshed:
            return refreshed
        if not mod:
            raise HTTPException(status_code=404, detail="Mod not found and workshop fetch failed")

    return mod


@router.post("/servers/workshop/mod", status_code=201)
async def add_workshop_mod(
    body: WorkshopModCreate,
    current_user: dict = Depends(_require_servers),
):
    """Manually add or update a workshop mod entry."""
    existing = await db.workshop_mods.find_one({"mod_id": body.mod_id})
    mod = WorkshopMod(
        mod_id=body.mod_id,
        name=body.name,
        author=body.author,
        version=body.version,
        description=body.description,
        license=body.license,
        dependencies=body.dependencies,
        scenario_ids=body.scenario_ids,
        manually_entered=True,
        metadata_source="manual",
        workshop_url=f"https://reforger.armaplatform.com/workshop/{body.mod_id}",
    )
    doc = mod.model_dump()
    for key in ("last_fetched",):
        val = doc.get(key)
        if isinstance(val, datetime):
            doc[key] = val.isoformat()

    if existing:
        await db.workshop_mods.update_one({"mod_id": body.mod_id}, {"$set": doc})
        return {**doc, "action": "updated"}
    else:
        await db.workshop_mods.insert_one(doc)
        doc.pop("_id", None)
        return {**doc, "action": "created"}


class AutoFetchModRequest(BaseModel):
    mod_id: str


@router.post("/servers/workshop/mod/fetch", status_code=201)
async def auto_fetch_workshop_mod(
    body: AutoFetchModRequest,
    current_user: dict = Depends(_require_servers),
):
    """Auto-fetch workshop mod metadata by mod_id from the Arma Reforger Workshop."""
    from services.workshop_ingest import fetch_and_store_mod

    result = await fetch_and_store_mod(body.mod_id, force_refresh=True)
    if result:
        result.pop("_id", None)
        return {**result, "action": "fetched"}
    else:
        raise HTTPException(status_code=502, detail="Failed to fetch mod metadata from workshop")


@router.post("/servers/workshop/mod/{mod_id}/refresh")
async def refresh_workshop_mod(
    mod_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Ensure a mod's metadata is current, creating the record when missing.

    This is the enrichment call the mods workspace fires after adding a mod from
    the Workshop tab — and a mod found by browsing has no cached record yet, so
    the old "record must already exist or 404" precondition rejected exactly the
    case it exists for. The caller swallowed the 404, so newly added mods never
    got a dependency list. A missing record is now the normal path; we only
    report unavailable when the Workshop itself says the mod is gone (which
    ``fetch_mod_metadata`` records as a ``removed_from_workshop`` tombstone).
    """
    from services.workshop_ingest import fetch_mod_metadata

    result = await fetch_mod_metadata(mod_id, force_refresh=True)
    if result:
        return {
            "mod_id": mod_id,
            "refreshed": True,
            "availability_status": result.get("availability_status", "unknown"),
            "removed_from_workshop": result.get("removed_from_workshop") is True,
            "metadata_completeness": result.get("metadata_completeness", ""),
            "dependencies": result.get("dependencies") or [],
            "metadata": result,
        }
    return {"mod_id": mod_id, "refreshed": False, "message": "Could not refresh metadata"}


# ── Vanilla Scenarios ────────────────────────────────────────────────────────

VANILLA_SCENARIOS = [
    {"id": "{ECC61978EDCC2B5A}Missions/23_Campaign.conf", "name": "Everon – Conflict", "map": "Everon"},
    {"id": "{59AD59368755F41A}Missions/21_GM_Eden.conf", "name": "Game Master – Eden", "map": "Eden"},
    {"id": "{DAA03C6E6099D50F}Missions/22_GM_Arland.conf", "name": "Game Master – Arland", "map": "Arland"},
    {"id": "{2BBBE828037C6F4B}Missions/24_GM_Montignac.conf", "name": "Game Master – Montignac", "map": "Montignac"},
    {"id": "{C700DB41A0C5CB58}Missions/25_Tutorial.conf", "name": "Tutorial", "map": "Everon"},
    {"id": "{90F086789073C963}Missions/26_CombatOps_Everon.conf", "name": "Combat Ops – Everon", "map": "Everon"},
    {"id": "{28802845ADA2796A}Missions/27_CombatOps_Arland.conf", "name": "Combat Ops – Arland", "map": "Arland"},
    {"id": "{F1A1BEA67132113E}Missions/28_Conflict_Everon.conf", "name": "Conflict – Everon", "map": "Everon"},
    {"id": "{589945FB9FA7B97D}Missions/29_Conflict_Arland.conf", "name": "Conflict – Arland", "map": "Arland"},
    {"id": "{E3FF37E9B1743B8F}Missions/30_Conflict_Eden.conf", "name": "Conflict – Eden", "map": "Eden"},
]


# ── Scenario Aggregation ────────────────────────────────────────────────────


class SharedScenarioCreate(BaseModel):
    scenario_id: str
    name: str = ""
    mod_id: str = ""
    mod_name: str = ""
    description: str = ""
    game_mode: str = ""
    player_count: int = 0
    thumbnail_url: str = ""

    @field_validator("scenario_id")
    @classmethod
    def _validate_scenario_id(cls, value: str) -> str:
        trimmed = _trim_optional_string(value)
        if not trimmed:
            raise ValueError("scenario_id is required")
        return trimmed


class CustomScenariosUpdate(BaseModel):
    custom_scenarios: list[str] = []


class ScenarioActivationRequest(BaseModel):
    scenario_id: str

    @field_validator("scenario_id")
    @classmethod
    def _validate_scenario_id(cls, value: str) -> str:
        trimmed = _trim_optional_string(value)
        if not trimmed:
            raise ValueError("scenario_id is required")
        return trimmed


def _serialize_shared_scenario(doc: dict, enabled_mod_ids: set[str] | None = None) -> dict:
    scenario_id = _trim_optional_string(doc.get("scenario_id") or doc.get("id"))
    mod_id = _trim_optional_string(doc.get("mod_id"))
    available_on_server = not mod_id or enabled_mod_ids is None or mod_id in enabled_mod_ids
    return {
        "id": scenario_id,
        "name": _trim_optional_string(doc.get("name")) or scenario_id,
        "source": "shared",
        "mod_id": mod_id,
        "mod_name": _trim_optional_string(doc.get("mod_name")),
        "game_mode": _trim_optional_string(doc.get("game_mode")),
        "player_count": max(0, int(doc.get("player_count") or 0)),
        "description": _trim_optional_string(doc.get("description")),
        "thumbnail_url": _trim_optional_string(doc.get("thumbnail_url")),
        "available_on_server": available_on_server,
    }


@router.post("/servers/scenarios/library")
async def add_shared_scenario(
    body: SharedScenarioCreate,
    current_user: dict = Depends(_require_servers),
):
    """Save a scenario to the shared library available to every server."""
    scenario_id = body.scenario_id
    existing = await db.shared_server_scenarios.find_one({"_id": scenario_id}, {"_id": 1})
    now = datetime.now(timezone.utc).isoformat()

    payload = {
        "scenario_id": scenario_id,
        "name": _trim_optional_string(body.name) or scenario_id,
        "mod_id": _trim_optional_string(body.mod_id),
        "mod_name": _trim_optional_string(body.mod_name),
        "description": _trim_optional_string(body.description),
        "game_mode": _trim_optional_string(body.game_mode),
        "player_count": max(0, int(body.player_count or 0)),
        "thumbnail_url": _trim_optional_string(body.thumbnail_url),
        "updated_at": now,
        "updated_by": current_user["id"],
    }

    await db.shared_server_scenarios.update_one(
        {"_id": scenario_id},
        {
            "$set": payload,
            "$setOnInsert": {
                "created_at": now,
                "created_by": current_user["id"],
            },
        },
        upsert=True,
    )

    await log_audit(
        user_id=current_user["id"],
        action_type="shared_scenario_upsert",
        resource_type="scenario",
        resource_id=scenario_id,
        before={"exists": bool(existing)},
        after=payload,
    )

    return {
        "created": existing is None,
        "scenario": _serialize_shared_scenario(payload),
    }


@router.get("/servers/{server_id}/scenarios")
async def get_server_scenarios(
    server_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Aggregate available scenarios: vanilla + shared + mod-provided + server-only entries."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    enabled_mod_ids = {
        _trim_optional_string(mod.get("mod_id") or mod.get("modId"))
        for mod in server.get("mods", [])
        if _trim_optional_string(mod.get("mod_id") or mod.get("modId"))
    }

    # 1. Vanilla scenarios
    vanilla = [{"source": "vanilla", **s} for s in VANILLA_SCENARIOS]

    # 2. Shared scenarios available to all servers
    shared_docs = await db.shared_server_scenarios.find({}, {"_id": 0}).to_list(500)
    shared = [
        _serialize_shared_scenario(doc, enabled_mod_ids)
        for doc in shared_docs
        if _trim_optional_string(doc.get("scenario_id") or doc.get("id"))
    ]
    shared.sort(key=lambda item: (item["name"].lower(), item["id"].lower()))

    # 3. Scenarios from enabled mods
    mod_scenarios: list[dict] = []
    mod_ids = list(enabled_mod_ids)

    if mod_ids:
        ws_mods = await db.workshop_mods.find(
            {"mod_id": {"$in": mod_ids}},
            {"_id": 0, "mod_id": 1, "name": 1, "scenario_ids": 1, "scenarios": 1},
        ).to_list(500)

        for ws_mod in ws_mods:
            rich_scenarios = ws_mod.get("scenarios") or []
            flat_ids = ws_mod.get("scenario_ids") or []

            if rich_scenarios:
                for sc in rich_scenarios:
                    sid = _trim_optional_string(sc.get("scenario_id") or sc.get("gameId"))
                    if not sid:
                        continue
                    mod_scenarios.append({
                        "id": sid,
                        "name": _trim_optional_string(sc.get("name")) or sid,
                        "source": "mod",
                        "mod_id": _trim_optional_string(ws_mod.get("mod_id")),
                        "mod_name": _trim_optional_string(ws_mod.get("name")),
                        "game_mode": _trim_optional_string(sc.get("game_mode")),
                        "player_count": sc.get("player_count") or 0,
                        "description": _trim_optional_string(sc.get("description")),
                    })
            elif flat_ids:
                for sid in flat_ids:
                    trimmed_sid = _trim_optional_string(sid)
                    if not trimmed_sid:
                        continue
                    mod_scenarios.append({
                        "id": trimmed_sid,
                        "name": trimmed_sid,
                        "source": "mod",
                        "mod_id": _trim_optional_string(ws_mod.get("mod_id")),
                        "mod_name": _trim_optional_string(ws_mod.get("name")),
                    })

    # 4. Server-only user-added scenarios
    custom_scenarios = server.get("custom_scenarios", [])
    custom = [{"id": s, "name": s, "source": "custom"} for s in custom_scenarios]

    return {
        "vanilla": vanilla,
        "shared": shared,
        "mod": mod_scenarios,
        "custom": custom,
    }


@router.put("/servers/{server_id}/scenarios")
async def update_custom_scenarios(
    server_id: str,
    body: CustomScenariosUpdate,
    current_user: dict = Depends(_require_servers),
):
    """Save server-only custom scenarios for a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    deduped = _clean_string_list(body.custom_scenarios)

    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": {"custom_scenarios": deduped, "updated_at": datetime.now(timezone.utc)}},
    )
    return {"custom_scenarios": deduped}


@router.put("/servers/{server_id}/scenario")
async def activate_server_scenario(
    server_id: str,
    body: ScenarioActivationRequest,
    current_user: dict = Depends(_require_servers),
):
    """Safely set the active scenario in config.game.scenarioId and persist the config."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    next_config = normalize_server_config(server.get("config") or {}, server)
    next_config.setdefault("game", {})
    next_config["game"]["scenarioId"] = body.scenario_id

    return await update_server(
        server_id,
        ServerUpdate(config=next_config),
        current_user,
    )


# ── Mod Dependency Resolution ────────────────────────────────────────────────


# How long a complete workshop_mods record is trusted during on-demand
# dependency resolution before we refetch the live page for the latest version.
_RESOLVE_FRESH_TTL_SECONDS = 6 * 3600


def _record_needs_refresh(rec: Optional[dict]) -> bool:
    """True when a ``workshop_mods`` record should be refetched from the live
    workshop page during on-demand dependency resolution.

    Refetches when the record is missing, partial (no name/version, or flagged
    incomplete/minimal), or older than ``_RESOLVE_FRESH_TTL_SECONDS``. Manually
    curated (``metadata_locked``) records are never auto-refreshed.
    """
    from services.workshop_ingest import _coerce_utc

    if not rec:
        return True
    if rec.get("metadata_locked"):
        return False
    if rec.get("removed_from_workshop"):
        checked = _coerce_utc(rec.get("availability_checked_at"))
        return (
            not checked
            or (datetime.now(timezone.utc) - checked).total_seconds()
            > _RESOLVE_FRESH_TTL_SECONDS
        )
    if rec.get("metadata_incomplete") or rec.get("metadata_completeness") == "minimal":
        return True
    if not rec.get("name") or not rec.get("version"):
        return True
    # A record can look fresh (name/version/recent) yet carry an empty
    # dependency list that was never actually fetched — e.g. persisted by
    # _sync_workshop_mod_metadata on a deploy where the live scrape failed.
    # Trusting it makes dependency resolution report "all dependencies
    # fulfilled" when deps are in fact missing. Only trust an empty list once a
    # full detail scrape has verified it (``dependencies_verified``); otherwise
    # refetch. Records that genuinely have no deps get verified once and then
    # stop refetching.
    if not rec.get("dependencies") and not rec.get("dependencies_verified"):
        return True
    last = _coerce_utc(rec.get("last_fetched"))
    if not last:
        return True
    return (datetime.now(timezone.utc) - last).total_seconds() > _RESOLVE_FRESH_TTL_SECONDS


async def _fetch_fresh_mod_record(mod_id: str) -> Optional[dict]:
    """Refetch a mod's live workshop page, persist it, and return the record.

    Mirrors the ``?refresh=true`` path in ``get_workshop_mod_details``: it goes
    straight to ``fetch_mod_details`` so it bypasses the 24h ingest cache and
    surfaces the latest available version instead of a stale stored one.
    Preserves any ``manual_overrides``. Returns ``None`` when the live fetch
    yields nothing usable (caller should keep whatever it already had).
    """
    from services.workshop_ingest import fetch_and_store_mod

    try:
        return await fetch_and_store_mod(mod_id, force_refresh=True)
    except Exception as exc:
        logger.debug("Resolve refresh fetch failed for %s: %s", mod_id, exc)
        return None


async def _resolve_mod_record(mod_id: str) -> Optional[dict]:
    """Return the best available metadata record for a mod during resolution.

    Reads the stored ``workshop_mods`` record and, when it is missing/partial/
    stale, refetches the live page. Falls back to the stored record (or a
    fresh ingest) if the live refetch fails, so a transient scrape error never
    erases data we already had.
    """
    from services.workshop_ingest import fetch_and_store_mod

    stored = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})
    if not _record_needs_refresh(stored):
        return stored

    fresh = await _fetch_fresh_mod_record(mod_id)
    if fresh:
        return fresh
    if stored:
        return stored
    # No stored record and live refetch failed — last resort, go through the
    # normal ingest path (which may yield a partial record we can name).
    try:
        return await fetch_and_store_mod(mod_id)
    except Exception:
        return None


# A dependency walk has to answer inside the browser's patience. Serving stored
# records directly (below) removes the common cost, but a cold cache can still
# need a live fetch per unknown mod and each one waits on the workshop rate
# limiter (~1.7s measured). Past this budget the walk stops blocking, returns
# what it has, and the response says it is incomplete.
_RESOLVE_SCAN_BUDGET_SECONDS = 20.0


def _record_is_usable(rec: Optional[dict]) -> bool:
    """True when a stored record can be trusted for a dependency walk.

    "Merely old" counts as usable: a stale record still carries the dependency
    list the walk needs, and the background backfill refreshes it afterwards.
    Only records that would make the walk *lie* are rejected — missing, partial,
    or an empty dependency list that a full detail fetch never verified.
    """
    if not rec:
        return False
    if rec.get("metadata_locked"):
        return True
    if rec.get("metadata_incomplete") or rec.get("metadata_completeness") == "minimal":
        return False
    if not rec.get("name") or not rec.get("version"):
        return False
    return bool(rec.get("dependencies") or rec.get("dependencies_verified"))


async def _scan_mod_record(
    mod_id: str,
    *,
    deadline: Optional[float] = None,
    stale_ids: Optional[set[str]] = None,
) -> Optional[dict]:
    """Resolve one mod's metadata for a dependency walk, bounded by *deadline*.

    Stale-while-revalidate: a stored record is returned immediately and queued
    for a background refresh instead of being refetched inline. The old
    behaviour refetched every record older than six hours one at a time through
    the rate limiter, so a ~100-mod loadout took minutes — longer than the
    browser waits, which is why the scan reported failure and nginx logged 499s.

    Records that cannot be used at all (missing/partial/never-verified) still
    take the blocking path, but only while the scan has budget left; the caller
    flags the response incomplete when it runs out.
    """
    from services.workshop_ingest import fetch_and_store_mod

    stored = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})
    if _record_is_usable(stored):
        if _record_needs_refresh(stored) and stale_ids is not None:
            stale_ids.add(mod_id)
        return stored
    if deadline is not None and time.monotonic() >= deadline:
        return stored

    fresh = await _fetch_fresh_mod_record(mod_id)
    if fresh:
        return fresh
    if stored:
        return stored
    try:
        return await fetch_and_store_mod(mod_id)
    except Exception:
        return None


class ResolveDependenciesRequest(BaseModel):
    mod_id: str
    existing_mod_ids: list[str] = []


@router.post("/servers/{server_id}/mods/resolve-dependencies")
async def resolve_mod_dependencies(
    server_id: str,
    body: ResolveDependenciesRequest,
    current_user: dict = Depends(_require_servers),
):
    """Recursively resolve all dependencies for a mod.

    Returns an ordered list: dependencies first, then the mod itself.
    Dependencies already in ``existing_mod_ids`` are flagged as ``already_present``.

    Uses the bounded scan path: stored records are served as-is and refreshed in
    the background, so the walk cannot outlive the request (see
    ``_scan_mod_record``). ``partial`` marks a response that ran out of budget
    before every entry it could not resolve.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    existing_set = set(body.existing_mod_ids)
    deadline = time.monotonic() + _RESOLVE_SCAN_BUDGET_SECONDS
    stale_ids: set[str] = set()

    server_names: dict[str, str] = {}
    for sm in server.get("mods", []):
        sm_id = (sm.get("mod_id") or sm.get("modId") or "").strip()
        if sm_id and sm.get("name") and sm["name"] != sm_id:
            server_names[sm_id] = sm["name"]

    # Parent-declared hints, harvested as we walk each mod's dependency list.
    # A parent's detail page names every dependency and pins the version it was
    # built against, so we can name/version a dep even if its own page fails.
    dep_hint_name: dict[str, str] = {}
    dep_required_version: dict[str, str] = {}

    # Breadth-first dependency resolution with cycle protection
    resolved: list[dict] = []
    visited: set[str] = set()
    queue: list[str] = [body.mod_id]

    while queue:
        current_id = queue.pop(0)
        if current_id in visited:
            continue
        visited.add(current_id)

        # Fetch mod metadata (stored record first, background refresh for stale)
        mod_data = await _scan_mod_record(current_id, deadline=deadline, stale_ids=stale_ids)

        def _pick_name(own: str) -> str:
            for candidate in (own, dep_hint_name.get(current_id, ""),
                              server_names.get(current_id, "")):
                if candidate and candidate != current_id:
                    return candidate
            return current_id

        if not mod_data:
            resolved.append({
                "mod_id": current_id,
                "name": _pick_name(""),
                "required_version": dep_required_version.get(current_id, ""),
                "already_present": current_id in existing_set,
                "metadata_available": False,
                "metadata_stale": False,
            })
            continue

        deps = mod_data.get("dependencies", [])
        for dep in deps:
            dep_id = (dep.get("mod_id") or dep.get("modId") or "").strip()
            if not dep_id:
                continue
            dep_name = (dep.get("name") or "").strip()
            if dep_name and dep_id not in dep_hint_name:
                dep_hint_name[dep_id] = dep_name
            dep_ver = (dep.get("version") or "").strip()
            if dep_ver and dep_id not in dep_required_version:
                dep_required_version[dep_id] = dep_ver
            if dep_id not in visited:
                queue.append(dep_id)

        resolved.append({
            "mod_id": current_id,
            "name": _pick_name(mod_data.get("name") or ""),
            "author": mod_data.get("author", ""),
            # ``version`` is the dep's own latest; the parent-declared baseline
            # is surfaced separately as ``required_version``.
            "version": mod_data.get("version", ""),
            "required_version": dep_required_version.get(current_id, ""),
            "thumbnail_url": mod_data.get("thumbnail_url", ""),
            "dependencies": deps,
            "scenario_ids": mod_data.get("scenario_ids", []),
            "availability_status": mod_data.get("availability_status", "unknown"),
            "removed_from_workshop": mod_data.get("removed_from_workshop") is True,
            "downloadable": mod_data.get("downloadable") is not False,
            "already_present": current_id in existing_set,
            "metadata_available": True,
            "metadata_stale": current_id in stale_ids,
        })

    # Dependencies first, the requested mod last. BFS order put a mod before
    # its own dependencies (root -> A -> B came out [A, B, root]); a post-order
    # walk places every mod after everything it depends on.
    resolved = _dependency_first(resolved, body.mod_id)

    new_deps = [r for r in resolved if not r["already_present"] and r["mod_id"] != body.mod_id]

    if stale_ids:
        _schedule_workshop_backfill(stale_ids, force=True)

    unresolved = [r for r in resolved if not r["metadata_available"]]
    return {
        "mod_id": body.mod_id,
        "resolved": resolved,
        "new_dependencies": new_deps,
        "total": len(resolved),
        "new_count": len(new_deps),
        # True when the scan budget ran out with entries still unresolved: the
        # client should say so and offer a retry rather than pretend the walk
        # completed (the background refresh fills these in shortly).
        "partial": bool(unresolved) and time.monotonic() >= deadline,
        "unresolved_count": len(unresolved),
        "stale_count": len(stale_ids),
    }


def _dependency_first(entries: list[dict], root_id: str) -> list[dict]:
    """Order resolver entries so each mod follows all of its dependencies."""
    by_id = {entry["mod_id"]: entry for entry in entries}
    ordered: list[dict] = []
    done: set[str] = set()

    def visit(mod_id: str, path: set[str]) -> None:
        if mod_id in done or mod_id in path or mod_id not in by_id:
            return
        path.add(mod_id)
        for dep in by_id[mod_id].get("dependencies") or []:
            visit((dep.get("mod_id") or dep.get("modId") or "").strip(), path)
        path.discard(mod_id)
        done.add(mod_id)
        ordered.append(by_id[mod_id])

    for entry in entries:
        if entry["mod_id"] != root_id:
            visit(entry["mod_id"], set())
    visit(root_id, set())
    return ordered


class ResolveAllDependenciesRequest(BaseModel):
    mod_ids: list[str] = []


@router.post("/servers/{server_id}/mods/resolve-all-dependencies")
async def resolve_all_mod_dependencies(
    server_id: str,
    body: ResolveAllDependenciesRequest,
    current_user: dict = Depends(_require_servers),
):
    """Resolve the full dependency closure for an entire loadout.

    For every mod in ``mod_ids`` we walk its dependency tree and report:
      - ``additions``: dependencies NOT already in the loadout, each tagged with
        the mods that directly require it (provenance) so the UI can render a
        "Dependency of: X" tag. These are the mods Reforger pulls in at runtime
        but that never make it into the saved config — adding them here makes
        them explicit, version-pinnable, and trackable.
      - ``tree``: a per-provider nested view of which mods pull in which deps.

    Bounded by ``_RESOLVE_SCAN_BUDGET_SECONDS``: stored records are served as-is
    and refreshed in the background, so a 100-mod loadout no longer refetches
    every stale record inline (which took minutes and timed the browser out).
    ``partial`` is true when the budget ran out with entries still unresolved.
    """
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    loadout_ids = [m.strip() for m in body.mod_ids if m and m.strip()]
    loadout_set = set(loadout_ids)
    deadline = time.monotonic() + _RESOLVE_SCAN_BUDGET_SECONDS
    stale_ids: set[str] = set()

    server_names: dict[str, str] = {}
    for sm in server.get("mods", []):
        sm_id = (sm.get("mod_id") or sm.get("modId") or "").strip()
        if sm_id and sm.get("name") and sm["name"] != sm_id:
            server_names[sm_id] = sm["name"]

    # Parent-declared hints harvested while walking dependency lists: a parent's
    # detail page names each dep and pins the required (baseline) version.
    dep_hint_name: dict[str, str] = {}
    dep_required_version: dict[str, str] = {}

    meta_cache: dict[str, Optional[dict]] = {}

    async def get_meta(mod_id: str) -> Optional[dict]:
        if mod_id in meta_cache:
            return meta_cache[mod_id]
        data = await _scan_mod_record(mod_id, deadline=deadline, stale_ids=stale_ids)
        meta_cache[mod_id] = data
        return data

    def display_name(mod_id: str, data: Optional[dict]) -> str:
        own = (data or {}).get("name", "")
        for candidate in (own, dep_hint_name.get(mod_id, ""), server_names.get(mod_id, "")):
            if candidate and candidate != mod_id:
                return candidate
        return mod_id

    def dep_ids_of(data: Optional[dict]) -> list[str]:
        ids = []
        for dep in (data or {}).get("dependencies", []) or []:
            did = (dep.get("mod_id") or dep.get("modId") or "").strip()
            if not did:
                continue
            dep_name = (dep.get("name") or "").strip()
            if dep_name and did not in dep_hint_name:
                dep_hint_name[did] = dep_name
            dep_ver = (dep.get("version") or "").strip()
            if dep_ver and did not in dep_required_version:
                dep_required_version[did] = dep_ver
            ids.append(did)
        return ids

    provenance: dict[str, set[str]] = {}
    expanded: set[str] = set()

    async def build_node(mod_id: str, ancestors: frozenset) -> dict:
        data = await get_meta(mod_id)
        node = {
            "mod_id": mod_id,
            "name": display_name(mod_id, data),
            "thumbnail_url": (data or {}).get("thumbnail_url", ""),
            "already_present": mod_id in loadout_set,
            "metadata_available": data is not None,
            "metadata_stale": mod_id in stale_ids,
            "availability_status": (data or {}).get("availability_status", "unknown"),
            "removed_from_workshop": (data or {}).get("removed_from_workshop") is True,
            "children": [],
        }
        if mod_id in ancestors:  # cycle guard
            node["cycle"] = True
            return node
        if mod_id in expanded:
            # A dependency shared by many mods was re-expanded under every
            # parent, multiplying the response; show its subtree once.
            node["shared"] = True
            return node
        expanded.add(mod_id)
        next_ancestors = ancestors | {mod_id}
        for did in dep_ids_of(data):
            if did not in loadout_set:
                provenance.setdefault(did, set()).add(mod_id)
            node["children"].append(await build_node(did, next_ancestors))
        return node

    tree = []
    for mod_id in loadout_ids:
        data = await get_meta(mod_id)
        if dep_ids_of(data):
            tree.append(await build_node(mod_id, frozenset()))

    additions = []
    for dep_id, parents in provenance.items():
        data = await get_meta(dep_id)
        ordered_parents = sorted(parents)
        additions.append({
            "mod_id": dep_id,
            "name": display_name(dep_id, data),
            "author": (data or {}).get("author", ""),
            # ``version`` is the dep's own latest available release; the
            # parent-declared baseline is exposed as ``required_version``.
            "version": (data or {}).get("version", ""),
            "required_version": dep_required_version.get(dep_id, ""),
            "thumbnail_url": (data or {}).get("thumbnail_url", ""),
            "dependencies": (data or {}).get("dependencies", []),
            "scenario_ids": (data or {}).get("scenario_ids", []),
            "metadata_available": data is not None,
            "metadata_stale": dep_id in stale_ids,
            "availability_status": (data or {}).get("availability_status", "unknown"),
            "removed_from_workshop": (data or {}).get("removed_from_workshop") is True,
            "downloadable": (data or {}).get("downloadable") is not False,
            "dependency_of": ordered_parents,
            "dependency_of_names": [display_name(p, meta_cache.get(p)) for p in ordered_parents],
        })
    additions.sort(key=lambda a: a["name"].lower())

    if stale_ids:
        _schedule_workshop_backfill(stale_ids, force=True)

    unresolved = [
        node for node in tree if not node.get("metadata_available")
    ] + [a for a in additions if not a.get("metadata_available")]
    return {
        "additions": additions,
        "tree": tree,
        "addition_count": len(additions),
        "provider_count": len(tree),
        # True when the scan budget ran out with entries still unresolved: the
        # UI should offer a retry instead of reporting a clean scan.
        "partial": bool(unresolved) and time.monotonic() >= deadline,
        "unresolved_count": len(unresolved),
        "stale_count": len(stale_ids),
    }


# ── Mod Presets ──────────────────────────────────────────────────────────────

@router.post("/servers/presets", status_code=201)
async def create_preset(
    body: ModPresetCreate,
    current_user: dict = Depends(_require_servers),
):
    """Create a new mod preset."""
    preset = ModPreset(
        name=body.name,
        description=body.description,
        mods=body.mods,
        scenario_id=body.scenario_id,
        created_by=current_user["id"],
    )
    doc = preset.model_dump()
    for key in ("created_at", "updated_at"):
        val = doc.get(key)
        if isinstance(val, datetime):
            doc[key] = val.isoformat()
    await db.mod_presets.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/servers/presets/{preset_id}")
async def get_preset(preset_id: str, current_user: dict = Depends(_require_servers)):
    """Get a specific mod preset."""
    preset = await db.mod_presets.find_one({"id": preset_id}, {"_id": 0})
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


@router.put("/servers/presets/{preset_id}")
async def update_preset(
    preset_id: str,
    body: ModPresetUpdate,
    current_user: dict = Depends(_require_servers),
):
    """Update a mod preset."""
    preset = await db.mod_presets.find_one({"id": preset_id})
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.mod_presets.update_one({"id": preset_id}, {"$set": updates})
    updated = await db.mod_presets.find_one({"id": preset_id}, {"_id": 0})
    return updated


@router.delete("/servers/presets/{preset_id}")
async def delete_preset(preset_id: str, current_user: dict = Depends(_require_servers)):
    """Delete a mod preset."""
    preset = await db.mod_presets.find_one({"id": preset_id})
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    await db.mod_presets.delete_one({"id": preset_id})
    return {"message": "Preset deleted", "id": preset_id}


# ── Incidents ────────────────────────────────────────────────────────────────

@router.get("/servers/{server_id}/incidents")
async def list_incidents(
    server_id: str,
    status: Optional[str] = Query(None),
    current_user: dict = Depends(_require_servers),
):
    """List incidents for a server."""
    query = {"server_id": server_id}
    if status:
        query["status"] = status
    incidents = await db.server_incidents.find(query, {"_id": 0}) \
        .sort("detected_at", -1).to_list(200)
    return incidents


@router.post("/servers/{server_id}/incidents", status_code=201)
async def create_incident(
    server_id: str,
    body: IncidentCreate,
    current_user: dict = Depends(_require_servers),
):
    """Manually log an incident for a server."""
    server = await db.managed_servers.find_one({"id": server_id})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    incident = ServerIncident(
        server_id=server_id,
        incident_type=body.incident_type,
        severity=body.severity,
        title=body.title,
        description=body.description,
    )
    doc = incident.model_dump()
    for key in ("detected_at", "resolved_at"):
        val = doc.get(key)
        if isinstance(val, datetime):
            doc[key] = val.isoformat()
        elif val is None:
            doc[key] = None

    await db.server_incidents.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.post("/servers/{server_id}/incidents/{incident_id}/resolve")
async def resolve_incident(
    server_id: str,
    incident_id: str,
    body: IncidentResolve,
    current_user: dict = Depends(_require_servers),
):
    """Resolve an incident so it no longer appears in open triage views."""
    incident = await db.server_incidents.find_one({"server_id": server_id, "id": incident_id}, {"_id": 0})
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    now = datetime.now(timezone.utc).isoformat()
    updates = {
        "status": "resolved",
        "resolved_at": now,
        "resolved_by": current_user["id"],
        "resolution_notes": (body.resolution_notes or "").strip(),
    }
    await db.server_incidents.update_one({"server_id": server_id, "id": incident_id}, {"$set": updates})
    await log_audit(
        user_id=current_user["id"],
        action_type="incident_resolve",
        resource_type="server",
        resource_id=server_id,
        metadata={"incident_id": incident_id},
    )
    updated = await db.server_incidents.find_one({"server_id": server_id, "id": incident_id}, {"_id": 0})
    return updated


@router.delete("/servers/{server_id}/incidents/{incident_id}")
async def delete_incident(
    server_id: str,
    incident_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Delete an incident record from the server timeline."""
    incident = await db.server_incidents.find_one({"server_id": server_id, "id": incident_id}, {"_id": 0})
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    await db.server_incidents.delete_one({"server_id": server_id, "id": incident_id})
    await log_audit(
        user_id=current_user["id"],
        action_type="incident_delete",
        resource_type="server",
        resource_id=server_id,
        metadata={"incident_id": incident_id, "title": incident.get("title") or ""},
    )
    return {"message": "Incident deleted", "id": incident_id}


# ── Mod Issues ───────────────────────────────────────────────────────────────

@router.get("/servers/mod-issues/{issue_id}")
async def get_mod_issue(issue_id: str, current_user: dict = Depends(_require_servers)):
    """Get a detailed mod issue with evidence."""
    issue = await db.mod_issues.find_one({"id": issue_id}, {"_id": 0})
    if not issue:
        raise HTTPException(status_code=404, detail="Mod issue not found")
    return issue


class ModIssueResolve(BaseModel):
    status: str = "resolved"
    resolution_notes: str = ""
    designated_area: Optional[str] = None
    attribution_type: Optional[str] = None
    troublesome: Optional[bool] = None
    troublesome_reason: Optional[str] = ""


@router.post("/servers/mod-issues/{issue_id}/resolve")
async def resolve_mod_issue(
    issue_id: str,
    body: ModIssueResolve,
    current_user: dict = Depends(_require_servers),
):
    """Update the operator verdict for a mod issue."""
    issue = await db.mod_issues.find_one({"id": issue_id})
    if not issue:
        raise HTTPException(status_code=404, detail="Mod issue not found")

    status = body.status or "resolved"
    if status not in {"active", "monitoring", "resolved", "false_positive"}:
        raise HTTPException(status_code=400, detail="Unsupported issue status")
    if body.designated_area is not None and body.designated_area not in {"live-errors", "error-patterns", "mod-analysis", "alerts", "troublesome-mods"}:
        raise HTTPException(status_code=400, detail="Unsupported designated area")
    if body.attribution_type is not None and body.attribution_type not in {"unknown", "mod", "backend", "base_game", "engine", "rcon", "battleye", "config", "network", "performance"}:
        raise HTTPException(status_code=400, detail="Unsupported attribution type")

    now = datetime.now(timezone.utc).isoformat()
    update_fields = {
        "status": status,
        "resolved_by": current_user["id"],
        "resolved_at": now,
        "resolution_notes": body.resolution_notes,
    }
    if body.designated_area is not None:
        update_fields["designated_area"] = body.designated_area
    if body.attribution_type is not None:
        update_fields["attribution_type"] = body.attribution_type
    if body.troublesome is not None:
        update_fields["troublesome"] = body.troublesome
        if body.troublesome and "designated_area" not in update_fields:
            update_fields["designated_area"] = "troublesome-mods"
    if body.troublesome_reason is not None:
        update_fields["troublesome_reason"] = body.troublesome_reason

    await db.mod_issues.update_one(
        {"id": issue_id},
        {"$set": update_fields},
    )
    return {"message": "Issue updated", "id": issue_id, "status": status}


# Watchers

@router.get("/servers/{server_id}/watchers")
async def list_watchers(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0, "id": 1})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    watchers = await db.server_watchers.find({"server_id": server_id}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return _serialize_doc(watchers)


@router.post("/servers/{server_id}/watchers/seed-defaults", status_code=201)
async def seed_default_watchers(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0, "id": 1})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    created = await ensure_default_watchers(server_id, created_by=current_user["id"])
    watchers = await db.server_watchers.find({"server_id": server_id}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return _serialize_doc({
        "created": created,
        "created_count": len(created),
        "watchers": watchers,
    })


@router.post("/servers/{server_id}/watchers", status_code=201)
async def create_watcher(
    server_id: str,
    body: ServerWatcherCreate,
    current_user: dict = Depends(_require_servers),
):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    watcher = ServerWatcher(
        server_id=server_id,
        name=body.name,
        type=body.type,
        enabled=body.enabled,
        notify=body.notify,
        pattern=body.pattern,
        metric=body.metric,
        comparison=body.comparison,
        threshold=body.threshold,
        severity=body.severity,
        source_category=body.source_category,
        description=body.description,
        template_key=body.template_key,
        # Only seed-defaults creates system-managed watchers. Taking the flag
        # from the client let anyone make a watcher undeletable.
        system_managed=False,
        recommended_actions=_clean_string_list(body.recommended_actions),
        created_by=current_user["id"],
    )
    doc = _serialize_doc(watcher.model_dump())
    await db.server_watchers.insert_one(doc)
    return doc


@router.put("/servers/{server_id}/watchers/{watcher_id}")
async def update_watcher(
    server_id: str,
    watcher_id: str,
    body: ServerWatcherUpdate,
    current_user: dict = Depends(_require_servers),
):
    # system_managed is server-owned: clearing it on an essential watcher was a
    # way around the delete guard, and setting it pinned arbitrary watchers.
    updates = {
        k: v for k, v in body.model_dump(exclude_unset=True).items()
        if v is not None and k != "system_managed"
    }
    if not updates:
        raise HTTPException(status_code=400, detail="No watcher changes provided")
    if "recommended_actions" in updates:
        updates["recommended_actions"] = _clean_string_list(updates.get("recommended_actions"))
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    watcher = await db.server_watchers.find_one({"id": watcher_id, "server_id": server_id}, {"_id": 0})
    if not watcher:
        raise HTTPException(status_code=404, detail="Watcher not found")


    updates["updated_at"] = datetime.now(timezone.utc)
    result = await db.server_watchers.update_one({"id": watcher_id, "server_id": server_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Watcher not found")
    watcher = await db.server_watchers.find_one({"id": watcher_id, "server_id": server_id}, {"_id": 0})
    return _serialize_doc(watcher)


@router.delete("/servers/{server_id}/watchers/{watcher_id}")
async def delete_watcher(server_id: str, watcher_id: str, current_user: dict = Depends(_require_servers)):
    watcher = await db.server_watchers.find_one({"id": watcher_id, "server_id": server_id}, {"_id": 0})
    if not watcher:
        raise HTTPException(status_code=404, detail="Watcher not found")
    if watcher.get("system_managed"):
        raise HTTPException(
            status_code=409,
            detail="System-managed watchers can only be changed by an authorized system lifecycle.",
        )
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    result = await db.server_watchers.delete_one({"id": watcher_id, "server_id": server_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Watcher not found")
    await log_audit(
        user_id=current_user["id"],
        action_type="watcher_delete",
        resource_type="server",
        resource_id=server_id,
        metadata={"watcher_id": watcher_id, "name": watcher.get("name") or ""},
    )
    return {"message": "Watcher deleted", "id": watcher_id}


@router.get("/servers/{server_id}/detections")
async def list_server_detections(
    server_id: str,
    status: Optional[str] = Query(None),
    source_type: Optional[str] = Query(None),
    include_ignored: bool = Query(False),
    current_user: dict = Depends(_require_servers),
):
    query: dict = {"server_id": server_id}
    if status:
        query["status"] = status
    elif not include_ignored:
        query["status"] = {"$nin": ["ignored", "false_positive"]}
    if source_type:
        query["source_type"] = source_type
    detections = await db.server_detections.find(query, {"_id": 0}).sort("last_seen", -1).to_list(200)
    return _serialize_doc(detections)


class DetectionVerdictUpdate(BaseModel):
    status: str
    verdict_notes: str = ""


@router.post("/servers/{server_id}/detections/{detection_id}/verdict")
async def update_detection_verdict(
    server_id: str,
    detection_id: str,
    body: DetectionVerdictUpdate,
    current_user: dict = Depends(_require_servers),
):
    if body.status not in {"active", "monitoring", "resolved", "false_positive", "ignored"}:
        raise HTTPException(status_code=400, detail="Unsupported detection status")
    updates: dict = {
        "status": body.status,
        "verdict_notes": body.verdict_notes,
        "updated_at": datetime.now(timezone.utc),
        # Lets the watcher loop tell new evidence from lines it already saw.
        "verdict_at": datetime.now(timezone.utc),
    }
    if body.status in {"ignored", "false_positive"}:
        updates["ignored_at"] = datetime.now(timezone.utc)
        updates["ignored_by"] = current_user.get("username") or current_user.get("id") or ""
    else:
        updates["ignored_at"] = None
        updates["ignored_by"] = ""
    result = await db.server_detections.update_one(
        {"id": detection_id, "server_id": server_id},
        {"$set": updates},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Detection not found")
    detection = await db.server_detections.find_one({"id": detection_id, "server_id": server_id}, {"_id": 0})
    return _serialize_doc(detection)


@router.get("/servers/{server_id}/reports/summary")
async def get_server_report_summary(server_id: str, current_user: dict = Depends(_require_servers)):
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    detections = await db.server_detections.find({"server_id": server_id}, {"_id": 0}).sort("last_seen", -1).to_list(100)
    incidents = await db.server_incidents.find({"server_id": server_id}, {"_id": 0}).sort("detected_at", -1).to_list(100)
    backups = await db.server_backups.find({"server_id": server_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    watchers = await db.server_watchers.find({"server_id": server_id}, {"_id": 0}).sort("created_at", -1).to_list(200)
    relevant_mod_issues = await db.mod_issues.find({"affected_servers.server_id": server_id}, {"_id": 0}).sort("last_seen", -1).to_list(100)
    notes = sorted(
        list(server.get("notes") or []),
        key=lambda note: str(note.get("created_at") or ""),
        reverse=True,
    )

    detection_summary = {
        "total": len(detections),
        "active": len([d for d in detections if d.get("status") == "active"]),
        "monitoring": len([d for d in detections if d.get("status") == "monitoring"]),
        "resolved": len([d for d in detections if d.get("status") == "resolved"]),
        "false_positive": len([d for d in detections if d.get("status") == "false_positive"]),
    }
    categories: dict[str, int] = {}
    detection_categories: dict[str, int] = {}
    detection_severity: dict[str, int] = {}
    for issue in relevant_mod_issues:
        categories[issue.get("source_category", "unknown")] = categories.get(issue.get("source_category", "unknown"), 0) + 1
    for detection in detections:
        category = str(detection.get("source_category") or "unknown")
        severity = str(detection.get("severity") or "medium")
        detection_categories[category] = detection_categories.get(category, 0) + 1
        detection_severity[severity] = detection_severity.get(severity, 0) + 1

    note_categories: dict[str, int] = {}
    for note in notes:
        category = str(note.get("category") or "general")
        note_categories[category] = note_categories.get(category, 0) + 1

    watcher_summary = {
        "total": len(watchers),
        "enabled": len([watcher for watcher in watchers if watcher.get("enabled") is not False]),
        "system_managed": len([watcher for watcher in watchers if watcher.get("system_managed")]),
    }

    return _serialize_doc({
        "server_id": server_id,
        "server": _server_summary_response(server),
        "detections": detections[:25],
        "mod_issues": relevant_mod_issues[:25],
        "incidents": incidents[:25],
        "backups": backups[:25],
        "watchers": watchers[:25],
        "notes": notes[:25],
        "summary": {
            "detections": detection_summary,
            "detection_categories": detection_categories,
            "detection_severity": detection_severity,
            "incidents": {
                "total": len(incidents),
                # "investigating" is still unresolved (the health monitor folds
                # repeats into either); counting only "open" understated it.
                "open": len([i for i in incidents if i.get("status") in {"open", "investigating"}]),
            },
            "mod_issue_categories": categories,
            "backups": len(backups),
            "watchers": watcher_summary,
            "notes": {
                "total": len(notes),
                "open": len([note for note in notes if note.get("status") not in {"resolved", "archived"}]),
                "follow_up_required": len([note for note in notes if note.get("follow_up_required")]),
                "by_category": note_categories,
            },
        },
    })


# ── Backups ──────────────────────────────────────────────────────────────────

@router.get("/servers/{server_id}/backups")
async def list_backups(server_id: str, current_user: dict = Depends(_require_servers)):
    """List backups for a server."""
    backups = await db.server_backups.find(
        {"server_id": server_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(100)
    return backups


@router.post("/servers/{server_id}/backups", status_code=201)
async def create_backup(server_id: str, current_user: dict = Depends(_require_servers)):
    """Create a backup snapshot for a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    backup = ServerBackup(
        server_id=server_id,
        backup_type="manual",
        config_snapshot=server.get("config", {}),
        mods_snapshot=server.get("mods", []),
        created_by=current_user["id"],
    )
    doc = backup.model_dump()
    for key in ("created_at",):
        val = doc.get(key)
        if isinstance(val, datetime):
            doc[key] = val.isoformat()

    await db.server_backups.insert_one(doc)
    doc.pop("_id", None)
    await log_audit(
        user_id=current_user["id"],
        action_type="backup_create",
        resource_type="server",
        resource_id=server_id,
        metadata={"backup_id": backup.id},
    )
    return doc


# ── Server Notes ─────────────────────────────────────────────────────────────

@router.get("/servers/{server_id}/notes")
async def get_server_notes(server_id: str, current_user: dict = Depends(_require_servers)):
    """Get admin notes for a server."""
    server = await db.managed_servers.find_one(
        {"id": server_id}, {"_id": 0, "notes": 1}
    )
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    notes = sorted(
        list(server.get("notes") or []),
        key=lambda note: str(note.get("created_at") or ""),
        reverse=True,
    )
    return notes


@router.post("/servers/{server_id}/notes", status_code=201)
async def add_server_note(
    server_id: str,
    body: ServerNoteCreate,
    current_user: dict = Depends(_require_servers),
):
    """Add an admin note to a server."""
    server = await db.managed_servers.find_one({"id": server_id})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    note = ServerNote(
        author_id=current_user["id"],
        author_name=current_user.get("username", ""),
        title=str(body.title or "").strip(),
        category=body.category,
        status=body.status,
        priority=body.priority,
        tags=_clean_string_list(body.tags),
        related_mods=_clean_string_list(body.related_mods),
        requested_actions=_clean_string_list(body.requested_actions),
        follow_up_required=bool(body.follow_up_required),
        event_at=body.event_at,
        content=body.content,
    )
    note_doc = note.model_dump()
    for key in ("created_at", "updated_at", "event_at"):
        val = note_doc.get(key)
        if isinstance(val, datetime):
            note_doc[key] = val.isoformat()

    await db.managed_servers.update_one(
        {"id": server_id},
        {"$push": {"notes": note_doc}},
    )
    return note_doc


# ── RCON Console ─────────────────────────────────────────────────────────────

class RconCommand(BaseModel):
    command: str

    @field_validator("command")
    @classmethod
    def _validate_command(cls, v: str) -> str:
        from services.rcon_bridge import validate_rcon_command
        return validate_rcon_command(v)


@router.get("/servers/{server_id}/rcon/status")
async def get_rcon_status(server_id: str, current_user: dict = Depends(_require_servers)):
    """Probe BattlEye RCON availability for a running server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    if server.get("status") != "running":
        return {"state": "offline", "detail": "Server is not running"}

    rcon = (server.get("config") or {}).get("rcon") or {}
    status = await bercon_client.probe(
        host=get_server_runtime_host(),
        port=int((server.get("ports") or {}).get("rcon", 19999)),
        password=str(rcon.get("password") or ""),
    )
    if status.get("state") == "auth_failed":
        runtime_drift = await _get_rcon_runtime_drift(server)
        if runtime_drift:
            return runtime_drift
    return status


@router.post("/servers/{server_id}/rcon")
async def execute_rcon(
    server_id: str,
    body: RconCommand,
    current_user: dict = Depends(_require_servers),
):
    """Execute an RCON command on a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    if server.get("status") != "running":
        raise HTTPException(status_code=400, detail="Server is not running")


    # Rate-limit check
    from middleware.rate_limiter import rcon_rate_limiter
    allowed, _remaining = rcon_rate_limiter.reserve(current_user["id"], server_id)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="RCON rate limit exceeded — please wait before sending more commands",
        )

    await log_audit(
        user_id=current_user["id"],
        action_type="rcon_command",
        resource_type="server",
        resource_id=server_id,
        metadata={"command": body.command[:500]},
    )

    ports = server.get("ports", {})
    rcon_port = int(ports.get("rcon", 19999))
    rcon_password = str(((server.get("config") or {}).get("rcon") or {}).get("password") or "")

    success, response = False, "RCON execution failed unexpectedly"
    try:
        success, response = await asyncio.wait_for(
            bercon_client.execute(
                host=get_server_runtime_host(),
                port=rcon_port,
                password=rcon_password,
                command=body.command,
            ),
            timeout=15,
        )
    except asyncio.TimeoutError:
        success, response = False, "RCON command timed out after 15 seconds"
    except Exception:
        logger.exception("RCON execution error for server %s", server_id)
        success, response = False, "RCON execution failed"
    if not success:
        resp_lower = (response or "").lower()
        if "auth" in resp_lower or "password" in resp_lower or "login" in resp_lower:
            runtime_drift = await _get_rcon_runtime_drift(server)
            if runtime_drift:
                response = runtime_drift["detail"]

    await record_server_log_event(
        server_id,
        source="rcon:command",
        line=f"> {body.command}",
        metadata={"success": success},
    )
    if response:
        await record_server_log_event(
            server_id,
            source="rcon:response",
            line=response[:4000],
            raw=response[:4000],
            metadata={"success": success, "command": body.command[:500]},
        )

    return {
        "server_id": server_id,
        "command": body.command,
        "response": response,
        "executed": success,
    }


# ── Scheduled Actions ────────────────────────────────────────────────────────

@router.get("/servers/{server_id}/schedules")
async def list_schedules(server_id: str, current_user: dict = Depends(_require_servers)):
    """List scheduled actions for a server."""
    schedules = await db.server_schedules.find(
        {"server_id": server_id}, {"_id": 0}
    ).to_list(100)
    return _serialize_doc(schedules)


@router.post("/servers/{server_id}/schedules", status_code=201)
async def create_schedule(
    server_id: str,
    body: ScheduledActionCreate,
    current_user: dict = Depends(_require_servers),
):
    """Create a scheduled action for a server."""
    server = await db.managed_servers.find_one({"id": server_id})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    if body.action_type not in {"restart", "start", "stop", "downtime_window"}:
        raise HTTPException(status_code=400, detail="Unsupported action type")
    if body.action_type == "downtime_window" and not body.downtime_minutes:
        raise HTTPException(status_code=400, detail="Downtime schedules require downtime_minutes")
    if body.action_type == "downtime_window" and body.downtime_minutes < 1:
        raise HTTPException(status_code=400, detail="Downtime minutes must be at least 1")
    from services.schedule_executor import schedule_problem
    problem = schedule_problem(body.schedule, body.timezone)
    if problem:
        raise HTTPException(status_code=400, detail=problem)


    action = ScheduledAction(
        server_id=server_id,
        action_type=body.action_type,
        schedule=body.schedule,
        timezone=body.timezone,
        enabled=body.enabled,
        downtime_minutes=body.downtime_minutes,
        created_by=current_user["id"],
    )
    doc = action.model_dump()

    from services.schedule_executor import parse_next_run
    doc["next_run"] = parse_next_run(body.schedule, body.timezone)

    await db.server_schedules.insert_one(doc)
    doc.pop("_id", None)
    return _serialize_doc(doc)


@router.put("/servers/{server_id}/schedules/{schedule_id}")
async def update_schedule(
    server_id: str,
    schedule_id: str,
    body: ScheduledActionUpdate,
    current_user: dict = Depends(_require_servers),
):
    schedule = await db.server_schedules.find_one({"id": schedule_id, "server_id": server_id}, {"_id": 0})
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")

    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No schedule changes provided")
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    if "schedule" in updates or "timezone" in updates:
        from services.schedule_executor import schedule_problem
        problem = schedule_problem(
            updates.get("schedule", schedule.get("schedule")),
            updates.get("timezone", schedule.get("timezone", "UTC")),
        )
        if problem:
            raise HTTPException(status_code=400, detail=problem)


    from services.schedule_executor import parse_next_run
    action_type = updates.get("action_type", schedule.get("action_type"))
    if action_type not in {"restart", "start", "stop", "downtime_window"}:
        raise HTTPException(status_code=400, detail="Unsupported action type")
    if action_type == "downtime_window" and not updates.get("downtime_minutes", schedule.get("downtime_minutes")):
        raise HTTPException(status_code=400, detail="Downtime schedules require downtime_minutes")
    if action_type == "downtime_window" and int(updates.get("downtime_minutes", schedule.get("downtime_minutes")) or 0) < 1:
        raise HTTPException(status_code=400, detail="Downtime minutes must be at least 1")

    schedule_expr = updates.get("schedule", schedule.get("schedule"))
    timezone_name = updates.get("timezone", schedule.get("timezone", "UTC"))
    updates["next_run"] = parse_next_run(schedule_expr, timezone_name)
    updates["updated_at"] = datetime.now(timezone.utc)
    await db.server_schedules.update_one({"id": schedule_id, "server_id": server_id}, {"$set": updates})
    updated = await db.server_schedules.find_one({"id": schedule_id, "server_id": server_id}, {"_id": 0})
    return _serialize_doc(updated)


@router.delete("/servers/{server_id}/schedules/{schedule_id}")
async def delete_schedule(
    server_id: str,
    schedule_id: str,
    current_user: dict = Depends(_require_servers),
):
    schedule = await db.server_schedules.find_one({"id": schedule_id, "server_id": server_id}, {"_id": 0})
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")


    result = await db.server_schedules.delete_one({"id": schedule_id, "server_id": server_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Schedule not found")
    await log_audit(
        user_id=current_user["id"],
        action_type="schedule_delete",
        resource_type="server",
        resource_id=server_id,
        metadata={"schedule_id": schedule_id, "action_type": schedule.get("action_type") or ""},
    )
    return {"message": "Schedule deleted", "id": schedule_id}


# ── Webhooks ─────────────────────────────────────────────────────────────────

async def _assert_safe_webhook_url(url: str) -> None:
    """Reject webhook URLs that could be used for SSRF.

    Requires https and verifies every DNS-resolved address is publicly
    routable (no loopback, private, link-local, reserved, or multicast IPs).
    Guards against probing cloud metadata (169.254.169.254) and internal hosts.
    """
    import ipaddress
    import socket
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook URL")

    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail="Webhook URL must use https")
    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="Webhook URL has no host")

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Webhook host could not be resolved")

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise HTTPException(
                status_code=400,
                detail="Webhook URL resolves to a non-public address",
            )


@router.post("/servers/webhooks", status_code=201)
async def create_webhook(
    body: WebhookConfigCreate,
    current_user: dict = Depends(_require_servers),
):
    """Create a notification webhook."""
    await _assert_safe_webhook_url(body.url)
    webhook = WebhookConfig(
        name=body.name,
        url=body.url,
        events=body.events,
        enabled=body.enabled,
        created_by=current_user["id"],
    )
    doc = webhook.model_dump()
    for key in ("created_at",):
        val = doc.get(key)
        if isinstance(val, datetime):
            doc[key] = val.isoformat()
    await db.server_webhooks.insert_one(doc)
    doc.pop("_id", None)
    return _public_webhook(doc)


@router.delete("/servers/webhooks/{webhook_id}")
async def delete_webhook(webhook_id: str, current_user: dict = Depends(_require_servers)):
    """Delete a notification webhook."""
    webhook = await db.server_webhooks.find_one({"id": webhook_id})
    if not webhook:
        raise HTTPException(status_code=404, detail="Webhook not found")
    await db.server_webhooks.delete_one({"id": webhook_id})
    return {"message": "Webhook deleted", "id": webhook_id}


@router.post("/servers/webhooks/{webhook_id}/test")
async def test_webhook(webhook_id: str, current_user: dict = Depends(_require_servers)):
    """Send a test payload to a webhook URL (server-side to avoid CORS)."""
    webhook = await db.server_webhooks.find_one({"id": webhook_id}, {"_id": 0})
    if not webhook:
        raise HTTPException(status_code=404, detail="Webhook not found")
    await _assert_safe_webhook_url(webhook["url"])
    import httpx
    payload = {
        "event": "test",
        "content": "Test notification from Garrison. Server-down alerts will arrive here.",
        "message": "Test notification from Garrison",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(webhook["url"], json=payload)
            return {"message": "Test sent", "status_code": resp.status_code}
    except Exception:
        return {"message": "Test failed: could not reach webhook URL", "status_code": None}


# ── Metrics ───────────────────────────────────────────────────────────────────

@router.get("/servers/{server_id}/metrics")
async def get_server_metrics(
    server_id: str,
    period: str = Query("1h", pattern="^(1h|6h|24h|7d|30d)$"),
    resolution: str = Query("raw", pattern="^(raw|1m|5m|1h)$"),
    current_user: dict = Depends(_require_servers),
):
    """Get performance metrics for a server with time range and resolution."""
    from services.server_metrics_collector import get_metrics_range

    server = await db.managed_servers.find_one({"id": server_id})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    metrics = await get_metrics_range(server_id, period=period, resolution=resolution)
    # A chart bucket is not a current sample: it averages values and omits
    # runtime metadata. Keep indicators independent of the selected resolution.
    latest = await db.server_metrics.find_one(
        {"server_id": server_id}, {"_id": 0}, sort=[("timestamp", -1)]
    )
    # PyMongo returns naive UTC datetimes by default; browsers otherwise read
    # the timestamp in the viewer's local timezone and mislabel freshness.
    for sample in [*metrics, latest]:
        if sample and isinstance(sample.get("timestamp"), datetime):
            stamp = sample["timestamp"]
            if stamp.tzinfo is None:
                sample["timestamp"] = stamp.replace(tzinfo=timezone.utc)

    return {
        "server_id": server_id,
        "period": period,
        "resolution": resolution,
        "metrics": metrics,
        "latest": latest,
        "count": len(metrics),
        "server_status": server.get("status"),
    }


@router.get("/servers/{server_id}/metrics/summary")
async def get_server_metrics_summary(
    server_id: str,
    current_user: dict = Depends(_require_servers),
):
    """Get latest metrics plus 24h trend summary for a server."""
    from services.server_metrics_collector import get_metrics_summary

    server = await db.managed_servers.find_one({"id": server_id})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    summary = await get_metrics_summary(server_id)
    return {"server_id": server_id, **summary}


@router.get("/servers/{server_id}/players")
async def get_server_players(
    server_id: str,
    limit: int = Query(100, ge=10, le=300),
    current_user: dict = Depends(_require_servers),
):
    """Get active players and recent player sessions for a server."""
    from services.server_player_sessions import get_server_player_overview

    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0, "id": 1, "status": 1})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    overview = await get_server_player_overview(server_id, session_limit=limit)
    return {
        **_serialize_doc(overview),
        "server_status": server.get("status"),
    }


@router.get("/servers/{server_id}/logs/recent")
async def get_server_logs(
    server_id: str,
    tail: int = Query(200, ge=1, le=5000),
    since: Optional[str] = Query(None),
    current_user: dict = Depends(_require_servers),
):
    """Get recent merged logs for a server."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    entries = await get_recent_server_log_entries(server, tail=tail, since=_parse_log_since(since))
    logs = "\n".join(entry.get("raw") or entry.get("line") or "" for entry in entries)
    return {
        "server_id": server_id,
        "logs": logs,
        "entries": entries,
        "lines": len(entries),
    }



# ── WebSocket: Live Log Streaming ────────────────────────────────────────────


# ── NEW: Health/Diagnostics Endpoints ────────────────────────────────────────

@router.get("/servers/{server_id}/console/health")
async def get_console_health(server_id: str, current_user: dict = Depends(_require_servers)):
    """Return health/diagnostics for the console log stream."""
    from services.log_streamer import log_streamer
    return log_streamer.diagnostics(server_id)


@router.get("/servers/{server_id}/rcon/health")
async def get_rcon_health(server_id: str, current_user: dict = Depends(_require_servers)):
    """Return health/diagnostics for the RCON bridge."""
    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    ports = server.get("ports", {})
    rcon_port = int(ports.get("rcon", 19999))
    rcon_password = str(((server.get("config") or {}).get("rcon") or {}).get("password") or "")
    runtime_drift = await _get_runtime_drift(server)

    return {
        "server_id": server_id,
        "server_status": server.get("status", "unknown"),
        "rcon_port": rcon_port,
        "rcon_configured": bool(rcon_password),
        "runtime_host": get_server_runtime_host(),
        "needs_reconfigure": bool(runtime_drift),
        "runtime_drift": runtime_drift,
    }


def _resolve_server_root(server: dict, root_key: str, *, details: dict | None = None) -> str:
    """Return the validated host-side directory for a root_key.

    Supported root_key values:
      - config  → parent of config_path (the Configs directory)
      - profile → profile_path
      - workshop → workshop_path

    Raises HTTPException(400) when the root_key is unknown, the path is not
    configured, or neither the stored nor the derived path is an existing
    directory.

    Parameters
    ----------
    details:
        Pre-computed troubleshooting details from ``_derive_troubleshooting(server)``.
        Pass this when calling ``_resolve_server_root`` multiple times for the same
        server to avoid redundant filesystem scans.  When *None* it is computed
        internally.
    """
    if details is None:
        details = _derive_troubleshooting(server)

    if root_key == "config":
        stored = _normalize_host_path(Path(server["config_path"]).parent.as_posix()) if server.get("config_path") else ""
        derived = _normalize_host_path(details.get("config_directory"))
    elif root_key == "profile":
        stored = _normalize_host_path(server.get("profile_path"))
        derived = _normalize_host_path(details.get("profile_directory"))
    elif root_key == "workshop":
        stored = _normalize_host_path(server.get("workshop_path"))
        derived = _normalize_host_path(details.get("workshop_directory"))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown root: {root_key}")

    for candidate in (stored, derived):
        if candidate and Path(candidate).is_dir():
            return candidate

    raise HTTPException(status_code=400, detail=f"Server has no {root_key} path configured")



# ── Backward-compat re-exports ──────────────────────────────────────────────
# Helpers moved to servers_ws.py / servers_files.py are re-exported here so
# that `from routes.servers import _stable_hash` (used by existing tests) keeps
# working without churn.
from routes.servers_ws import (  # noqa: E402,F401
    _build_log_entries,
    _parse_log_line,
    _parse_log_since,
    _reject_ws,
    _stable_hash,
)
from routes.servers_files import (  # noqa: E402,F401
    FileWriteBody,
    _mod_purge_target_dirs,
    _remove_fs_entry,
    _safe_resolve,
    ai_assist_server_file,
    browse_server_files,
    list_file_roots,
    read_server_file,
    validate_server_file,
    write_server_file,
)
