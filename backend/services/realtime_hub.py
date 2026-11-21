"""App-level realtime hub — topic pub/sub over one WebSocket per client.

Server-side mutations call `notify(topic,
event, data)` and every browser subscribed to that topic receives
`{"topic", "event", "data", "ts"}`. The frontend bridge invalidates the
TanStack Query cache on receipt, so polling loops become push-driven.

Backend note: subscriptions live in this process's memory, but production
runs uvicorn with `--workers 2`, so a browser's WebSocket and the request
that mutates state routinely land on *different* worker processes. A purely
in-process fan-out therefore loses roughly half of all hints. The Mongo
relay below closes that gap: `publish()` fans out to local subscribers
immediately and also writes the hint to the TTL-bounded `realtime_events`
collection; every worker polls that collection (`start_relay()`, wired at app
startup) and re-delivers events that originated on other workers. Mongo is
standalone here — no change streams — so a short poll is the only shared
signal both workers can see; hints are idempotent invalidations, which makes
at-least-once delivery with ~2s cross-worker latency acceptable.

Design rules:
  * `notify()` is fire-and-forget and exception-proof — a mutation must never
    fail or slow down because a browser socket is misbehaving.
  * Topics are an explicit allowlist with per-topic authorization. An
    unauthorized SUBSCRIBE is refused per-topic, not by dropping the socket.
  * Payloads are hints ("something in this domain changed"), not data. The
    client refetches through the normal RBAC-checked REST endpoints, so the
    hub can never leak more than the subscriber could already read.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Set
from uuid import uuid4

from bson import ObjectId
from fastapi import WebSocket

from database import db
from middleware.rbac import Permission, has_permission

logger = logging.getLogger("realtime")

# ── Cross-worker relay constants ──────────────────────────────────────────────

RELAY_COLLECTION = "realtime_events"
# How often each worker looks for hints published by its siblings. Hints are
# cache invalidations, not data — 2s of cross-worker lag is invisible next to
# the polling fallbacks this system replaced.
RELAY_POLL_SECONDS = 2.0
# One id per worker process, so the poller can skip events it already fanned
# out locally at publish time.
WORKER_ID = uuid4().hex


def _perm(permission: Permission) -> Callable[[dict], bool]:
    return lambda user: has_permission(user.get("role", ""), permission)


# Topic allowlist -> authorization predicate. Anything not listed is refused.
TOPIC_AUTHORIZERS: Dict[str, Callable[[dict], bool]] = {
    # Live game-server activity (status, players, metrics). Hints only: the
    # client re-fetches through the normal permission-checked endpoints.
    "game": _perm(Permission.MANAGE_SERVERS),
}


class _Connection:
    __slots__ = ("websocket", "user", "topics", "send_lock")

    def __init__(self, websocket: WebSocket, user: dict):
        self.websocket = websocket
        self.user = user
        self.topics: Set[str] = set()
        # Serialize sends per-connection; concurrent send_json on one socket
        # is undefined behavior in starlette.
        self.send_lock = asyncio.Lock()


class RealtimeHub:
    def __init__(self):
        self._connections: Set[_Connection] = set()

    # ── Connection lifecycle ──────────────────────────────────────────────

    def register(self, websocket: WebSocket, user: dict) -> _Connection:
        conn = _Connection(websocket, user)
        self._connections.add(conn)
        return conn

    def unregister(self, conn: _Connection) -> None:
        self._connections.discard(conn)

    # ── Subscriptions ─────────────────────────────────────────────────────

    @staticmethod
    def can_subscribe(user: dict, topic: str) -> bool:
        authorize = TOPIC_AUTHORIZERS.get(topic)
        return bool(authorize and authorize(user))

    def subscribe(self, conn: _Connection, topics: list[str]) -> dict[str, list[str]]:
        """Apply a SUBSCRIBE request; returns {'ok': [...], 'refused': [...]}."""
        ok, refused = [], []
        for topic in topics:
            if self.can_subscribe(conn.user, topic):
                conn.topics.add(topic)
                ok.append(topic)
            else:
                refused.append(topic)
        return {"ok": ok, "refused": refused}

    def unsubscribe(self, conn: _Connection, topics: list[str]) -> None:
        for topic in topics:
            conn.topics.discard(topic)

    # ── Publishing ────────────────────────────────────────────────────────

    async def publish(self, topic: str, event: str, data: Optional[dict] = None) -> int:
        """Fan out an event to local subscribers and relay it to other workers.

        Returns the local delivery count; cross-worker deliveries happen on
        the sibling workers' poll ticks and are not counted here.
        """
        message = {
            "topic": topic,
            "event": event,
            "data": data or {},
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        delivered = await self._deliver_local(message)
        if _relay_enabled:
            # Best-effort and off the caller's path: a mutation must never
            # slow down or fail because Mongo hiccuped on a hint.
            task = asyncio.get_running_loop().create_task(_relay_insert(message))
            task.add_done_callback(_log_publish_failure)
        return delivered

    async def _deliver_local(self, message: dict) -> int:
        """Send one prepared message to this process's subscribers."""
        topic = message.get("topic")
        delivered = 0
        for conn in list(self._connections):
            if topic not in conn.topics:
                continue
            try:
                async with conn.send_lock:
                    await conn.websocket.send_json(message)
                delivered += 1
            except Exception:
                # Dead socket: drop it; the route's receive loop will clean up.
                self.unregister(conn)
        return delivered

    # ── Introspection (admin/diagnostics) ─────────────────────────────────

    def stats(self) -> dict[str, Any]:
        by_topic: Dict[str, int] = {}
        for conn in self._connections:
            for topic in conn.topics:
                by_topic[topic] = by_topic.get(topic, 0) + 1
        return {"connections": len(self._connections), "subscriptions": by_topic}


hub = RealtimeHub()


def notify(topic: str, event: str, data: Optional[dict] = None) -> None:
    """Fire-and-forget publish for mutation call sites.

    Never raises and never blocks: outside a running event loop (unit tests,
    sync scripts) it silently no-ops.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(hub.publish(topic, event, data))
    task.add_done_callback(_log_publish_failure)


def _log_publish_failure(task: asyncio.Task) -> None:
    exc = task.exception()
    if exc:
        logger.warning("realtime publish failed: %s", exc)


# ── Cross-worker relay ────────────────────────────────────────────────────────
#
# Disabled until `start_relay()` runs (app startup wires it). Unit tests and
# sync scripts that call `publish()` therefore never touch Mongo.

_relay_enabled = False
_relay_task: Optional[asyncio.Task] = None


async def _relay_insert(message: dict) -> None:
    await db[RELAY_COLLECTION].insert_one({
        **message,
        "origin": WORKER_ID,
        # TTL anchor. The collection only ever holds the last minute of hints.
        "created_at": datetime.now(timezone.utc),
    })


async def _drain_relay_once(cursor_id: ObjectId) -> ObjectId:
    """Deliver every relayed event newer than `cursor_id`; return the new cursor.

    The cursor advances past our own events too — they were already fanned out
    locally at publish time and are skipped here, not reprocessed forever.
    """
    docs = await (
        db[RELAY_COLLECTION]
        .find({"_id": {"$gt": cursor_id}})
        .sort("_id", 1)
        .to_list(500)
    )
    for doc in docs:
        cursor_id = doc["_id"]
        if doc.get("origin") == WORKER_ID:
            continue
        await hub._deliver_local({
            "topic": doc.get("topic"),
            "event": doc.get("event"),
            "data": doc.get("data") or {},
            "ts": doc.get("ts"),
        })
    return cursor_id


async def _relay_loop() -> None:
    # Start strictly at "now": replaying hints from before this worker existed
    # would invalidate caches nobody holds.
    cursor_id = ObjectId.from_datetime(datetime.now(timezone.utc))
    while True:
        await asyncio.sleep(RELAY_POLL_SECONDS)
        try:
            cursor_id = await _drain_relay_once(cursor_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Mongo blips must not kill the loop — skip the tick and retry.
            logger.warning("realtime relay poll failed: %s", exc)


def start_relay() -> None:
    """Enable cross-worker relaying and start this worker's poller.

    Called once per worker at app startup. Without it the hub is local-only,
    which loses hints whenever the WebSocket and the mutating request are
    served by different uvicorn workers.
    """
    global _relay_enabled, _relay_task
    if _relay_task is not None and not _relay_task.done():
        return
    _relay_enabled = True
    _relay_task = asyncio.get_running_loop().create_task(_relay_loop())
    logger.info("realtime relay started (worker %s)", WORKER_ID[:8])


async def stop_relay() -> None:
    """Stop the poller and drop back to local-only delivery (app shutdown)."""
    global _relay_enabled, _relay_task
    _relay_enabled = False
    task, _relay_task = _relay_task, None
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
