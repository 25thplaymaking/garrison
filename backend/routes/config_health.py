"""Config Health routes: fleet status, config detection and lint.

Read-only. Every route needs MANAGE_SERVERS, the same gate as the server panel.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import db
from middleware.rbac import Permission, require_permission
from services import config_health as health
from services.a2s_query import query_a2s_info
from services.docker_agent import DockerAgent
from services.server_config_generator import generate_reforger_config
from services.server_runtime_host import get_server_runtime_host

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config-health", tags=["config-health"])
_require_servers = require_permission(Permission.MANAGE_SERVERS)
docker_agent = DockerAgent()

_ACTIVE_INCIDENTS = ["open", "investigating"]
# Whole record minus the bulky history arrays: config generation reads several
# fields (rcon_password, SAT flag, mods) and a partial record would
# make the drift check compare against a config the backend never writes.
_SERVER_FIELDS = {"_id": 0, "auto_recovery_log": 0, "restart_cycles": 0, "provisioning_stages": 0}


class LintRequest(BaseModel):
    config: Dict[str, Any]


async def _container(server: dict) -> Optional[dict]:
    name = server.get("container_name")
    if not name:
        return None
    try:
        return await docker_agent.get_container_status(name)
    except Exception as exc:  # docker socket hiccup must not break the panel
        logger.warning("Config Health container probe failed for %s: %s", name, exc)
        return None


async def _query(server: dict, running: bool) -> tuple[Optional[dict], bool]:
    if not running or health.inspection_disabled():
        return None, False
    port = (server.get("ports") or {}).get("query")
    if not port:
        return None, False
    try:
        return await query_a2s_info(get_server_runtime_host(), int(port), timeout_seconds=2.0), True
    except Exception as exc:
        logger.debug("Config Health A2S probe failed for %s: %s", server.get("id"), exc)
        return None, True


async def _inspect(server: dict, fleet: List[dict], *, include_detail: bool) -> dict:
    container = await _container(server)
    a2s, a2s_checked = await _query(server, bool(container and container.get("running")))
    open_incidents = await db.server_incidents.count_documents(
        {"server_id": server["id"], "status": {"$in": _ACTIVE_INCIDENTS}}
    )
    detection = await asyncio.to_thread(health.detect_config, server)
    effective = generate_reforger_config(server)
    findings = health.lint_config(effective, fleet_ports=health.fleet_port_map(fleet, exclude_id=server["id"]))
    counts = health.summarize_findings(findings)
    status = health.build_status(server, container=container, a2s=a2s, a2s_checked=a2s_checked,
                              open_incidents=open_incidents, detection=detection, lint_counts=counts)
    game = effective.get("game") or {}
    result = {
        "id": server["id"],
        "name": server.get("name"),
        "description": server.get("description") or "",
        "panel_status": server.get("status"),
        "status": status,
        "ports": server.get("ports") or {},
        "players": (a2s or {}).get("player_count"),
        "max_players": game.get("maxPlayers"),
        "map": (a2s or {}).get("map"),
        "scenario": game.get("scenarioId"),
        "mod_count": len(game.get("mods") or []),
        "container": container,
        "config": {
            "state": detection["state"],
            "message": detection["message"],
            "path": detection["path"],
            "modified_at": detection["modified_at"],
            "drift_count": detection.get("drift_count", 0),
            "lint": counts,
        },
    }
    if include_detail:
        result["config"]["detection"] = detection
        result["config"]["findings"] = findings
    return result


@router.get("/fleet")
async def health_fleet(current_user: dict = Depends(_require_servers)):
    """Every managed server with its Config Health verdict, config state and lint counts."""
    servers = await db.managed_servers.find({}, _SERVER_FIELDS).sort("name", 1).to_list(100)
    results = await asyncio.gather(*(_inspect(s, servers, include_detail=False) for s in servers))
    totals = {"online": 0, "degraded": 0, "down": 0, "stopped": 0, "deleting": 0}
    players = 0
    for item in results:
        totals[item["status"]["overall"]] = totals.get(item["status"]["overall"], 0) + 1
        players += item["players"] or 0
    return {
        "protocol": "Config Health",
        "version": health.HEALTH_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "totals": totals,
        "players": players,
        "servers": results,
    }


@router.get("/servers/{server_id}")
async def health_server(server_id: str, current_user: dict = Depends(_require_servers)):
    """Full Config Health report for one server: checks, config detection with drift, lint findings."""
    servers = await db.managed_servers.find({}, _SERVER_FIELDS).to_list(100)
    server = next((s for s in servers if s.get("id") == server_id), None)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    return await _inspect(server, servers, include_detail=True)


@router.post("/servers/{server_id}/lint")
async def health_lint(server_id: str, body: LintRequest, current_user: dict = Depends(_require_servers)):
    """Lint a config the operator has not saved yet, exactly as it would be written."""
    from routes.servers import _restore_redacted_config_secrets  # lazy: servers.py is heavy

    servers = await db.managed_servers.find({}, _SERVER_FIELDS).to_list(100)
    server = next((s for s in servers if s.get("id") == server_id), None)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    proposed = _restore_redacted_config_secrets(body.config, server.get("config"))
    effective = generate_reforger_config({**server, "config": proposed})
    findings = health.lint_config(
        effective,
        fleet_ports=health.fleet_port_map(servers, exclude_id=server_id),
        raw_config=body.config,
    )
    return {"findings": findings, "counts": health.summarize_findings(findings)}
