"""Server-down alerts to the webhooks set up on the Integrations tab.

Every minute the loop compares each server's status with the last pass and
posts one alert when a server ENTERS a failed state; it does not repeat while
the server stays down. The JSON body carries `content` (what a Discord webhook
shows) plus structured fields for any other receiver.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

import httpx

from database import db

logger = logging.getLogger(__name__)

UNHEALTHY_STATES = {"error", "failed", "crashed", "crash_loop"}


def detect_down_transitions(
    servers: List[Dict[str, Any]],
    last_status: Dict[str, str],
) -> tuple[List[Dict[str, Any]], Dict[str, str]]:
    """Return (servers that just went down, updated status map). Pure."""
    alerts: List[Dict[str, Any]] = []
    new_last = dict(last_status)
    for server in servers:
        sid = str(server.get("id") or "")
        if not sid:
            continue
        status = str(server.get("status") or "").lower()
        previous = last_status.get(sid)
        # The first pass after a panel restart only records state: a server
        # that was already down before the restart is not news.
        if previous is not None and status in UNHEALTHY_STATES and previous not in UNHEALTHY_STATES:
            alerts.append({"id": sid, "name": server.get("name") or sid, "status": status})
        new_last[sid] = status
    return alerts, new_last


def alert_payload(alert: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "event": "server_down",
        "content": f"\U0001F534 **{alert['name']}** is down (status: `{alert['status']}`).",
        "server_id": alert["id"],
        "server_name": alert["name"],
        "status": alert["status"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def deliver(alerts: List[Dict[str, Any]]) -> int:
    """POST every alert to every enabled webhook. Returns successful posts."""
    if not alerts:
        return 0
    hooks = await db.server_webhooks.find({"enabled": {"$ne": False}}, {"_id": 0, "url": 1, "name": 1}).to_list(50)
    sent = 0
    async with httpx.AsyncClient(timeout=10.0) as client:
        for alert in alerts:
            body = alert_payload(alert)
            for hook in hooks:
                try:
                    response = await client.post(hook["url"], json=body)
                    if response.status_code < 300:
                        sent += 1
                    else:
                        logger.warning("Webhook %s answered %s", hook.get("name"), response.status_code)
                except Exception as exc:
                    logger.warning("Webhook %s unreachable: %s", hook.get("name"), exc)
    return sent


async def webhook_alert_loop(interval: int = 60) -> None:
    last_status: Dict[str, str] = {}
    while True:
        try:
            servers = await db.managed_servers.find({}, {"_id": 0, "id": 1, "name": 1, "status": 1}).to_list(500)
            alerts, last_status = detect_down_transitions(servers, last_status)
            await deliver(alerts)
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception:  # pragma: no cover - the loop must survive a bad pass
            logger.exception("webhook alert pass failed")
            await asyncio.sleep(interval)
