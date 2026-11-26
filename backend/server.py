"""Garrison: a self-hosted web panel for Arma Reforger dedicated servers."""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from bson import ObjectId
from fastapi import APIRouter, FastAPI
from fastapi.responses import FileResponse, JSONResponse

from config import (
    ADMIN_PASSWORD,
    ADMIN_USERNAME,
    LOG_MONITOR_INTERVAL,
    SERVER_HEALTH_CHECK_INTERVAL,
    SERVER_LOG_ANALYSIS_INTERVAL,
    SERVER_METRICS_INTERVAL,
    SERVER_METRICS_RETENTION_DAYS,
    WORKSHOP_REFRESH_INTERVAL_HOURS,
)
from database import db
from middleware.security_headers import SecurityHeadersMiddleware
from routes.auth import create_user_record, router as auth_router
from routes.config_health import router as config_health_router
from routes.diagnostics import router as diagnostics_router
from routes.log_monitor import router as log_monitor_router
from routes.realtime import router as realtime_router
from routes.servers import router as servers_router
from routes.servers_diagnosis import router as servers_diagnosis_router
from routes.servers_files import router as servers_files_router
from routes.servers_ws import router as servers_ws_router

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("garrison")

VERSION = "1.0.0"
LOG_OCCURRENCE_RETENTION_DAYS = int(os.environ.get("LOG_OCCURRENCE_RETENTION_DAYS", 90))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parent.parent / "frontend" / "dist"))


async def _ensure_index(collection, keys, **kwargs) -> None:
    try:
        await collection.create_index(keys, **kwargs)
    except Exception as exc:  # an index failure must not stop the panel
        logger.warning("index %s %s failed: %s", collection.name, keys, exc)


async def ensure_indexes() -> None:
    i = _ensure_index
    await i(db.users, "id", unique=True)
    await i(db.users, "username_lower", unique=True)
    await i(db.audit_logs, [("timestamp", -1)])
    await i(db.audit_logs, [("resource_id", 1), ("timestamp", -1)])
    await i(db.managed_servers, "id", unique=True)
    await i(db.managed_servers, "status")
    await i(db.managed_servers, "container_name", sparse=True)
    await i(db.managed_servers, "data_root", sparse=True)
    await i(db.managed_servers, "ports.game", sparse=True)
    await i(db.managed_servers, "ports.query", sparse=True)
    await i(db.managed_servers, "ports.rcon", sparse=True)
    await i(db.server_mod_revisions, [("server_id", 1), ("version", -1)])
    await i(db.server_config_revisions, [("server_id", 1), ("version", -1)])
    await i(db.server_config_revisions, "id", unique=True)
    await i(db.server_incidents, "server_id")
    await i(db.server_incidents, "status")
    await i(db.mod_issues, "error_signature", unique=True)
    await i(db.mod_issues, "status")
    await i(db.mod_issues, [("troublesome", 1), ("mod_id", 1)])
    await i(db.server_backups, "server_id")
    await i(db.server_schedules, "server_id")
    await i(db.server_schedules, "id", unique=True)
    await i(db.server_schedules, "next_run")
    await i(db.server_webhooks, "id", unique=True)
    await i(db.server_notifications, "id", unique=True)
    await i(db.server_notifications, [("server_id", 1), ("status", 1)])
    await i(db.server_notifications, [("server_id", 1), ("dedupe_key", 1)], unique=True)
    await i(db.workshop_mods, "mod_id", unique=True)
    await i(db.workshop_cache, "key", unique=True)
    await i(db.workshop_proxy_cache, "key", unique=True)
    await i(db.workshop_proxy_cache, "expires_at", expireAfterSeconds=0)
    await i(db.mod_download_history, [("mod_id", 1), ("server_id", 1)], unique=True)
    await i(db.mod_download_history, "downloaded_at")
    await i(db.server_metrics, [("server_id", 1), ("timestamp", -1)])
    await i(db.server_metrics, "timestamp", expireAfterSeconds=SERVER_METRICS_RETENTION_DAYS * 86400)
    await i(db.realtime_events, "created_at", expireAfterSeconds=60)
    await i(db.server_log_events, [("server_id", 1), ("timestamp", -1)])
    await i(db.server_player_sessions, "id", unique=True)
    await i(db.server_player_sessions, [("server_id", 1), ("active", 1), ("updated_at", -1)])
    await i(db.server_player_sessions, [("server_id", 1), ("connected_at", -1)])
    await i(db.server_player_sessions, [("server_id", 1), ("session_identity_key", 1)])
    await i(db.server_player_events, "event_key", unique=True)
    await i(db.server_player_events, [("server_id", 1), ("timestamp", -1)])
    await i(db.server_watchers, [("server_id", 1), ("enabled", 1)])
    await i(db.server_watchers, "id", unique=True)
    await i(db.server_detections, [("server_id", 1), ("last_seen", -1)])
    await i(db.server_detections, [("server_id", 1), ("detection_key", 1)], unique=True)
    await i(db.log_error_types, "id", unique=True)
    await i(db.log_error_types, "fingerprint", unique=True)
    for field in ("category", "severity", "review_status", "attribution_type", "actionability", "linked_mod_guid"):
        await i(db.log_error_types, field)
    await i(db.log_error_types, [("troublesome", 1), ("linked_mod_guid", 1)])
    await i(db.log_mods, "guid", unique=True)
    await i(db.log_mods, "id", unique=True)
    await i(db.log_alerts, "id", unique=True)
    await i(db.log_alerts, [("server_id", 1), ("resolved", 1)])
    await i(db.log_alerts, [("error_type_id", 1), ("server_id", 1), ("resolved", 1)])
    await i(db.log_occurrences, "id", unique=True)
    await i(db.log_occurrences, [("server_id", 1), ("timestamp", -1)])
    await i(db.log_occurrences, [("error_type_id", 1), ("timestamp", -1)])
    await i(db.log_occurrences, [("mod_guid", 1), ("timestamp", -1)])
    await i(db.log_occurrences, "timestamp")


async def ensure_first_admin() -> None:
    """Create the first admin from ADMIN_USERNAME / ADMIN_PASSWORD when the
    panel has no accounts yet. Later starts never touch existing accounts."""
    if await db.users.count_documents({}) > 0:
        return
    if len(ADMIN_PASSWORD) < 10:
        logger.error(
            "No accounts exist and ADMIN_PASSWORD is unset or under 10 characters. "
            "Set it in .env and restart to create the first admin."
        )
        return
    if "CHANGE_ME" in ADMIN_PASSWORD.upper():
        logger.error(
            "No accounts exist and ADMIN_PASSWORD is still the placeholder from .env.example. "
            "Set a real password in .env and restart to create the first admin."
        )
        return
    await create_user_record(ADMIN_USERNAME, ADMIN_PASSWORD, "admin")
    logger.info("Created first admin account '%s'", ADMIN_USERNAME)


async def log_retention_loop(interval_hours: float = 6) -> None:
    """Delete log-monitor occurrences older than LOG_OCCURRENCE_RETENTION_DAYS."""
    while True:
        try:
            await asyncio.sleep(300)
            cutoff = ObjectId.from_datetime(datetime.now(timezone.utc) - timedelta(days=LOG_OCCURRENCE_RETENTION_DAYS))
            result = await db.log_occurrences.delete_many({"_id": {"$lt": cutoff}})
            if result.deleted_count:
                logger.info("Pruned %d old log occurrences", result.deleted_count)
            await asyncio.sleep(interval_hours * 3600)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("log retention pass failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_indexes()
    await ensure_first_admin()

    from services.diagnostics_ai import diagnostics_triage_loop
    from services.log_monitor import log_monitor_loop
    from services.mod_issue_engine import mod_issue_analysis_loop
    from services.realtime_hub import start_relay, stop_relay
    from services.rcon_bridge import bercon_client
    from services.schedule_executor import schedule_execution_loop
    from services.server_data_permissions import repair_readiness
    from services.server_health_monitor import server_health_loop
    from services.server_metrics_collector import metrics_collection_loop
    from services.server_player_sessions import player_tracking_loop
    from services.server_watchers import watchers_loop
    from services.webhook_alerts import webhook_alert_loop
    from services.workshop_ingest import workshop_refresh_loop

    tasks = [
        asyncio.create_task(server_health_loop(check_interval=SERVER_HEALTH_CHECK_INTERVAL)),
        asyncio.create_task(metrics_collection_loop(interval=SERVER_METRICS_INTERVAL)),
        asyncio.create_task(mod_issue_analysis_loop(interval=SERVER_LOG_ANALYSIS_INTERVAL)),
        asyncio.create_task(schedule_execution_loop(check_interval=60)),
        asyncio.create_task(watchers_loop(interval=30)),
        asyncio.create_task(workshop_refresh_loop(interval_hours=WORKSHOP_REFRESH_INTERVAL_HOURS)),
        asyncio.create_task(log_monitor_loop(interval=LOG_MONITOR_INTERVAL)),
        # RCON-polls #players; 30 s keeps the number fresh without hammering BattlEye RCON.
        asyncio.create_task(player_tracking_loop(interval=30)),
        asyncio.create_task(diagnostics_triage_loop()),
        asyncio.create_task(log_retention_loop()),
        asyncio.create_task(webhook_alert_loop(interval=60)),
    ]
    start_relay()

    repair_ok, repair_detail = repair_readiness()
    if not repair_ok:
        logger.warning(
            "File permission repair helper unavailable (%s). The file manager may show "
            "'Permission denied' on files a game container created. See docs/permissions.md.",
            repair_detail,
        )
    logger.info("Garrison %s started", VERSION)
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        stop_relay()
        await bercon_client.aclose()


app = FastAPI(title="Garrison", version=VERSION, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")

api = APIRouter(prefix="/api")


@api.get("/health")
async def health():
    try:
        await db.command("ping")
        return {"status": "ok", "version": VERSION}
    except Exception:
        return JSONResponse(status_code=503, content={"status": "database unreachable", "version": VERSION})


for router in (
    auth_router,
    servers_router,
    servers_files_router,
    servers_ws_router,
    servers_diagnosis_router,
    config_health_router,
    log_monitor_router,
    diagnostics_router,
    realtime_router,
):
    api.include_router(router)
app.include_router(api)


app.add_middleware(SecurityHeadersMiddleware)


# The built frontend is served by the same process: one container, one port.
if STATIC_DIR.is_dir():
    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        candidate = (STATIC_DIR / path).resolve()
        if path and candidate.is_file() and STATIC_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
