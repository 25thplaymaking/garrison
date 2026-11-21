"""WebSocket endpoints for the Server Management Portal.

Extracted from `routes.servers` as part of a token-light refactor pass.
"""

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from database import db
from middleware.ws_auth import authenticate_websocket, resolve_websocket_user
from services.server_logs import (
    build_log_entries,
    build_log_entry,
    get_recent_server_log_entries,
    parse_log_since,
    record_server_log_event,
    stable_hash,
    stream_server_log_entries,
)
from services.log_streamer import log_streamer
from services.rcon_bridge import bercon_client
from routes.servers import _get_rcon_runtime_drift
from services.server_runtime_host import get_server_runtime_host

logger = logging.getLogger(__name__)
router = APIRouter()


_authenticate_ws = authenticate_websocket
_refresh_ws_user = resolve_websocket_user

# How often an open log stream re-reads its viewer (RCON re-reads before every
# command). A socket must not outlive a demotion, deactivation or revoked
# override for longer than this.
LOG_STREAM_REAUTH_SECONDS = 30.0


async def _current_server_operator(user_id: str) -> Optional[dict]:
    """The caller's current effective identity if they still hold MANAGE_SERVERS.

    The handshake resolves the user once; long-lived console sockets call this
    again so a role change, deactivation or an expired/revoked uptime override
    ends access without waiting for the client to disconnect.
    """
    from middleware.rbac import has_permission, Permission

    fresh = await _refresh_ws_user(str(user_id or ""))
    if fresh and has_permission(fresh.get("role", ""), Permission.MANAGE_SERVERS):
        return fresh
    return None


async def _reject_ws(websocket: WebSocket, code: int, reason: str) -> None:
    """Accept then close so clients receive a WebSocket close code instead of a failed handshake."""
    try:
        await websocket.accept()
    except Exception:
        pass
    try:
        await websocket.close(code=code, reason=reason)
    except Exception:
        pass


_ISO_TS_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')
_NANO_FRAC_RE = re.compile(r'(\.\d{6})\d+')


def _stable_hash(text: str) -> str:
    return stable_hash(text)


def _parse_log_line(raw_line: str, fallback_index: int) -> dict:
    return build_log_entry(raw_line, fallback_index)


def _build_log_entries(logs: str) -> list[dict]:
    return build_log_entries(logs)


def _parse_log_since(value: Optional[str]) -> Optional[int]:
    return parse_log_since(value)


# ── WebSocket: ws_server_logs ──────────────────────────────────────────────

@router.websocket("/ws/servers/{server_id}/logs")
async def ws_server_logs(websocket: WebSocket, server_id: str):
    """Stream merged logs in real-time via WebSocket using shared fan-out.

    Query params:
      - token: JWT auth token
      - tail: number of initial history lines (default 500)
      - since_seq: sequence number for reconnect backfill (preferred over 'since')
      - since: unix timestamp or ISO timestamp for reconnect backfill (legacy)
    """
    from middleware.rbac import has_permission, Permission
    from services.log_streamer import log_streamer

    user = await _authenticate_ws(websocket)
    if not user:
        logger.info("ws_console.auth_failed server=%s reason=no_token", server_id)
        await _reject_ws(websocket, code=4001, reason="Authentication required")
        return

    if not has_permission(user.get("role", ""), Permission.MANAGE_SERVERS):
        logger.info(
            "ws_console.auth_failed server=%s user=%s reason=insufficient_permissions",
            server_id, user.get("id"),
        )
        await _reject_ws(websocket, code=4003, reason="Insufficient permissions")
        return

    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        logger.info("ws_console.rejected server=%s reason=not_found", server_id)
        await _reject_ws(websocket, code=4004, reason="Server not found")
        return

    # Check server status — provide explicit error if not running
    server_status = server.get("status", "unknown")
    if server_status in ("stopped", "error", "unknown"):
        logger.info(
            "ws_console.rejected server=%s reason=not_running status=%s",
            server_id, server_status,
        )
        await _reject_ws(
            websocket,
            code=4006,
            reason=f"Server is not running (status: {server_status})",
        )
        return

    await websocket.accept()

    tail_str = websocket.query_params.get("tail", "500")
    try:
        tail = int(tail_str)
    except (TypeError, ValueError):
        tail = 500
    tail = max(0, min(5000, tail))
    since_seq_str = websocket.query_params.get("since_seq", "")
    since_seq = int(since_seq_str) if since_seq_str and since_seq_str.isdigit() else None
    since = _parse_log_since(websocket.query_params.get("since"))

    # Cursor dedup set with proper LRU trimming
    seen_cursors: set[str] = set()
    # Ordered list for LRU trimming (append new, trim from front)
    cursor_order: list[str] = []
    _MAX_CURSORS = 4000
    _TRIM_TO = 3000  # Keep most recent 3000 when trimming

    sub_id: Optional[int] = None
    session = None
    _receive_task: Optional[asyncio.Task] = None

    logger.info(
        "ws_console.connected server=%s user=%s tail=%d since_seq=%s",
        server_id, user.get("id"), tail, since_seq,
    )

    try:
        # 1. Send connected status
        await websocket.send_json({
            "type": "status",
            "state": "connected",
            "server_id": server_id,
            "protocol": "garrison.ws.logs.v1",
        })

        # 2. Get or create the shared stream session
        session = await log_streamer.get_or_create(server)

        # 3. Send backfill from ring buffer (or initial history)
        is_reconnect = since_seq is not None
        reconnect_gap = False
        if is_reconnect:
            backfill = session.get_backfill(since_seq=since_seq)
            reconnect_gap = session.has_reconnect_gap(int(since_seq or 0))
        else:
            backfill = session.get_backfill(count=tail)

        # If ring buffer doesn't have enough history, fall back to REST-style fetch
        if not is_reconnect and len(backfill) < tail:
            initial_entries = await get_recent_server_log_entries(
                server, tail=tail, since=since,
            )
            backfill = initial_entries

        backfill_count = len(backfill)
        await websocket.send_json({
            "type": "status",
            "state": "backfilling",
            "count": backfill_count,
            "reconnect": is_reconnect,
            "reconnect_gap": reconnect_gap,
            "earliest_seq": session.earliest_seq,
            "last_seq": session.last_seq,
        })

        for entry in backfill:
            cursor = entry.get("cursor", "")
            if cursor:
                seen_cursors.add(cursor)
                cursor_order.append(cursor)
            await websocket.send_json({
                "type": "log",
                "cursor": cursor,
                "seq": entry.get("seq", 0),
                "timestamp": entry.get("timestamp", ""),
                "line": entry.get("line", ""),
                "raw": entry.get("raw", ""),
                "source": entry.get("source", "docker"),
                "stream": entry.get("stream", entry.get("source", "docker")),
            })

        logger.info(
            "ws_console.backfill_sent server=%s count=%d is_reconnect=%s",
            server_id, backfill_count, is_reconnect,
        )

        # 4. Subscribe before signalling live to avoid missing entries produced
        #    between the backfill snapshot and the subscription.
        sub_id, queue = session.subscribe()

        # Concurrent receive task: detect client disconnect immediately rather than
        # waiting up to 20 s for the next heartbeat send to fail.  Starlette's
        # websocket.receive() returns {"type": "websocket.disconnect"} on close.
        _client_gone = asyncio.Event()

        async def _watch_disconnect() -> None:
            try:
                while True:
                    msg = await websocket.receive()
                    if msg.get("type") == "websocket.disconnect":
                        break
            except Exception:
                pass
            finally:
                _client_gone.set()

        _receive_task = asyncio.create_task(_watch_disconnect())

        # 5. Transition to live streaming
        await websocket.send_json({
            "type": "status",
            "state": "live",
            "backfill_count": backfill_count,
            "last_seq": session.last_seq,
            "earliest_seq": session.earliest_seq,
            "reconnect_gap": reconnect_gap,
            "sources": session.source_status,
            "protocol": "garrison.ws.logs.v1",
        })

        last_auth_check = time.monotonic()
        while not _client_gone.is_set():
            if time.monotonic() - last_auth_check >= LOG_STREAM_REAUTH_SECONDS:
                last_auth_check = time.monotonic()
                if await _current_server_operator(user.get("id")) is None:
                    logger.info(
                        "ws_console.revoked server=%s user=%s", server_id, user.get("id"),
                    )
                    await websocket.close(code=4003, reason="Insufficient permissions")
                    break
            try:
                entry = await asyncio.wait_for(queue.get(), timeout=20.0)
            except asyncio.TimeoutError:
                if _client_gone.is_set():
                    break
                # Send heartbeat to keep connection alive and detect dead clients
                try:
                    await websocket.send_json({
                        "type": "heartbeat",
                        "seq": session.last_seq,
                        "earliest_seq": session.earliest_seq,
                        "subscriber_count": session.subscriber_count,
                        "protocol": "garrison.ws.logs.v1",
                    })
                except Exception:
                    break
                continue

            # Handle heartbeat passthrough from stream session
            if entry.get("type") == "heartbeat":
                await websocket.send_json(entry)
                continue

            cursor = entry.get("cursor", "")
            if cursor:
                # Dedup check
                if cursor in seen_cursors:
                    continue

                seen_cursors.add(cursor)
                cursor_order.append(cursor)

                # LRU trim: keep most recent _TRIM_TO entries
                if len(seen_cursors) > _MAX_CURSORS:
                    remove_count = len(cursor_order) - _TRIM_TO
                    removed = cursor_order[:remove_count]
                    cursor_order = cursor_order[remove_count:]
                    for old_cursor in removed:
                        seen_cursors.discard(old_cursor)

            await websocket.send_json({
                "type": "log",
                "cursor": cursor,
                "seq": entry.get("seq", 0),
                "timestamp": entry.get("timestamp", ""),
                "line": entry.get("line", ""),
                "raw": entry.get("raw", ""),
                "source": entry.get("source", "docker"),
                "stream": entry.get("stream", entry.get("source", "docker")),
            })

    except WebSocketDisconnect:
        logger.info("ws_console.disconnected server=%s user=%s", server_id, user.get("id"))
    except asyncio.CancelledError:
        logger.debug("ws_console.cancelled server=%s", server_id)
    except Exception as exc:
        logger.error(
            "ws_console.error server=%s user=%s error=%s",
            server_id, user.get("id"), exc,
        )
        try:
            await websocket.send_json({
                "type": "error",
                "code": "stream_error",
                "message": str(exc)[:200],
            })
        except Exception:
            pass
        try:
            await websocket.close(code=1011, reason="Internal error")
        except Exception:
            pass
    finally:
        if _receive_task is not None:
            _receive_task.cancel()
            try:
                await _receive_task
            except (asyncio.CancelledError, Exception):
                pass
        if session and sub_id is not None:
            session.unsubscribe(sub_id)


# ── WebSocket: ws_server_rcon ──────────────────────────────────────────────

@router.websocket("/ws/servers/{server_id}/rcon")
async def ws_server_rcon(websocket: WebSocket, server_id: str):
    """Interactive RCON console via WebSocket.

    Client sends JSON: {"command": "..."}
    Server responds with typed messages:
      {"type": "response", "command": "...", "response": "...", "success": true}
      {"type": "error", "code": "auth_failed|timeout|disabled|execution_failed|rate_limited", "message": "..."}
      {"type": "status", "state": "ready", "server_id": "..."}
    """
    from middleware.rbac import has_permission, Permission
    from services.audit_service import log_audit as ws_log_audit
    from services.rcon_bridge import validate_rcon_command
    from middleware.rate_limiter import rcon_rate_limiter

    user = await _authenticate_ws(websocket)
    if not user:
        logger.info("ws_rcon.auth_failed server=%s reason=no_token", server_id)
        await _reject_ws(websocket, code=4001, reason="Authentication required")
        return

    if not has_permission(user.get("role", ""), Permission.MANAGE_SERVERS):
        logger.info(
            "ws_rcon.auth_failed server=%s user=%s reason=insufficient_permissions",
            server_id, user.get("id"),
        )
        await _reject_ws(websocket, code=4003, reason="Insufficient permissions")
        return

    server = await db.managed_servers.find_one({"id": server_id}, {"_id": 0})
    if not server:
        logger.info("ws_rcon.rejected server=%s reason=not_found", server_id)
        await _reject_ws(websocket, code=4004, reason="Server not found")
        return

    if server.get("status") != "running":
        logger.info(
            "ws_rcon.rejected server=%s reason=not_running status=%s",
            server_id, server.get("status"),
        )
        await _reject_ws(websocket, code=4006, reason="Server is not running")
        return

    await websocket.accept()

    ports = server.get("ports", {})
    rcon_port = int(ports.get("rcon", 19999))
    rcon_password = str(((server.get("config") or {}).get("rcon") or {}).get("password") or "")

    # Check if RCON is configured
    if not rcon_password:
        logger.info("ws_rcon.no_password server=%s", server_id)
        await websocket.send_json({
            "type": "error",
            "code": "disabled",
            "message": "RCON is not configured — set an RCON password in Server Settings",
        })
        await websocket.close(code=4007, reason="RCON not configured")
        return

    # Send ready status
    await websocket.send_json({
        "type": "status",
        "state": "ready",
        "server_id": server_id,
        "protocol": "garrison.ws.rcon.v1",
    })

    logger.info(
        "ws_rcon.connected server=%s user=%s port=%d",
        server_id, user.get("id"), rcon_port,
    )

    # Keep one receiver active while commands execute so disconnects cancel a
    # queued/in-flight RCON request instead of letting it dispatch later.
    incoming_messages: asyncio.Queue[str] = asyncio.Queue(maxsize=10)
    client_gone = asyncio.Event()

    async def _receive_messages() -> None:
        try:
            while True:
                raw_message = await websocket.receive_text()
                try:
                    incoming_messages.put_nowait(raw_message)
                except asyncio.QueueFull:
                    await websocket.close(code=1013, reason="Too many queued commands")
                    return
        except WebSocketDisconnect:
            pass
        finally:
            client_gone.set()

    async def _next_message() -> Optional[str]:
        message_task = asyncio.create_task(incoming_messages.get())
        disconnect_task = asyncio.create_task(client_gone.wait())
        try:
            done, _ = await asyncio.wait(
                {message_task, disconnect_task},
                timeout=20.0,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                return None
            if disconnect_task in done:
                raise WebSocketDisconnect(code=1000)
            return message_task.result()
        finally:
            for task in (message_task, disconnect_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(message_task, disconnect_task, return_exceptions=True)

    async def _execute_while_connected(command: str) -> tuple[bool, str]:
        if client_gone.is_set():
            raise WebSocketDisconnect(code=1000)
        execution_task = asyncio.create_task(
            asyncio.wait_for(
                bercon_client.execute(
                    host=get_server_runtime_host(),
                    port=rcon_port,
                    password=rcon_password,
                    command=command,
                ),
                timeout=15,
            )
        )
        disconnect_task = asyncio.create_task(client_gone.wait())
        try:
            done, _ = await asyncio.wait(
                {execution_task, disconnect_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                execution_task.cancel()
                await asyncio.gather(execution_task, return_exceptions=True)
                raise WebSocketDisconnect(code=1000)
            return await execution_task
        finally:
            if not disconnect_task.done():
                disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)

    receive_task = asyncio.create_task(_receive_messages())

    try:
        while True:
            raw = await _next_message()
            if raw is None:
                await websocket.send_json({
                    "type": "heartbeat",
                    "state": "alive",
                    "server_id": server_id,
                    "protocol": "garrison.ws.rcon.v1",
                })
                continue
            try:
                import json
                msg = json.loads(raw)
                command = msg.get("command", "").strip()
            except Exception:
                command = raw.strip()

            if not command:
                continue

            # Re-read the caller before every command: a socket opened while
            # they held MANAGE_SERVERS (or an override grant) must not keep
            # executing RCON after a demotion, deactivation or revocation.
            fresh_user = await _current_server_operator(user.get("id"))
            if fresh_user is None:
                logger.info("ws_rcon.revoked server=%s user=%s", server_id, user.get("id"))
                await websocket.send_json({
                    "type": "error",
                    "code": "auth_failed",
                    "message": "You no longer have server management access",
                    "command": command,
                })
                await websocket.close(code=4003, reason="Insufficient permissions")
                return
            user = fresh_user

            # Validate command input
            try:
                command = validate_rcon_command(command)
            except ValueError as ve:
                await websocket.send_json({
                    "type": "error",
                    "code": "invalid_command",
                    "message": str(ve),
                    "command": command,
                })
                continue

            # Rate-limit check
            allowed, remaining = rcon_rate_limiter.reserve(user["id"], server_id)
            if not allowed:
                await websocket.send_json({
                    "type": "error",
                    "code": "rate_limited",
                    "message": "Rate limit exceeded — please wait before sending more commands",
                    "command": command,
                    "remaining": remaining,
                })
                continue

            # Audit log the command
            await ws_log_audit(
                user_id=user["id"],
                action_type="rcon_command",
                resource_type="server",
                resource_id=server_id,
                metadata={"command": command[:500], "via": "websocket"},
            )

            cmd_start = time.monotonic()
            success, response = False, "RCON execution failed unexpectedly"
            error_code = "execution_failed"

            try:
                success, response = await _execute_while_connected(command)
                error_code = None  # Success

                # Classify failures from the response text
                if not success:
                    resp_lower = (response or "").lower()
                    if "auth" in resp_lower or "password" in resp_lower or "login" in resp_lower:
                        runtime_drift = await _get_rcon_runtime_drift(server)
                        if runtime_drift:
                            error_code = runtime_drift["code"]
                            response = runtime_drift["detail"]
                        else:
                            error_code = "auth_failed"
                    elif "timed out" in resp_lower or "timeout" in resp_lower:
                        error_code = "timeout"
                    else:
                        error_code = "execution_failed"

            except asyncio.TimeoutError:
                success, response = False, "RCON command timed out after 15 seconds"
                error_code = "timeout"
            except ConnectionRefusedError:
                success, response = False, "RCON port unreachable — check firewall settings"
                error_code = "unreachable"
            except OSError as os_err:
                success, response = False, f"Network error: {os_err}"
                error_code = "unreachable"
            except Exception as exc:
                logger.exception("ws_rcon.execution_error server=%s command=%s", server_id, command[:100])
                success, response = False, "RCON execution failed"
                error_code = "execution_failed"
            cmd_duration_ms = round((time.monotonic() - cmd_start) * 1000)
            logger.info(
                "ws_rcon.command server=%s command=%s success=%s duration_ms=%d error_code=%s",
                server_id, command[:100], success, cmd_duration_ms, error_code,
            )

            await record_server_log_event(
                server_id,
                source="rcon:command",
                line=f"> {command}",
                metadata={"success": success, "via": "websocket"},
            )
            if response:
                await record_server_log_event(
                    server_id,
                    source="rcon:response",
                    line=response[:4000],
                    raw=response[:4000],
                    metadata={"success": success, "command": command[:500], "via": "websocket"},
                )

            if success:
                await websocket.send_json({
                    "type": "response",
                    "command": command,
                    "response": response,
                    "success": True,
                    "duration_ms": cmd_duration_ms,
                })
            else:
                await websocket.send_json({
                    "type": "error",
                    "code": error_code,
                    "command": command,
                    "message": response,
                    "success": False,
                    "duration_ms": cmd_duration_ms,
                })

    except WebSocketDisconnect:
        logger.info("ws_rcon.disconnected server=%s user=%s", server_id, user.get("id"))
    except asyncio.CancelledError:
        logger.debug("ws_rcon.cancelled server=%s", server_id)
    except Exception as exc:
        logger.error(
            "ws_rcon.error server=%s user=%s error=%s",
            server_id, user.get("id"), exc,
        )
        try:
            await websocket.close(code=1011, reason="Internal error")
        except Exception:
            pass
    finally:
        receive_task.cancel()
        await asyncio.gather(receive_task, return_exceptions=True)

