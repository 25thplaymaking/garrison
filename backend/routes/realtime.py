"""App-level realtime WebSocket endpoint.

One socket per browser tab, many topics. Protocol (JSON messages):

  client → server:
    {"type": "SUBSCRIBE",   "topics": ["game", ...]}
    {"type": "UNSUBSCRIBE", "topics": [...]}
    {"type": "PING"}

  server → client:
    {"type": "HELLO", "topics": [<topics this user may subscribe to>]}
    {"type": "SUBSCRIBED", "ok": [...], "refused": [...]}
    {"type": "PONG"}
    {"topic": ..., "event": ..., "data": {...}, "ts": ...}   # published events

Auth: the session cookie (query-param token fallback), checked by
middleware.ws_auth. Topic authorization lives in
services.realtime_hub.TOPIC_AUTHORIZERS.
"""
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect


from middleware.ws_auth import authenticate_websocket
from services.realtime_hub import TOPIC_AUTHORIZERS, hub

router = APIRouter()
logger = logging.getLogger("realtime")

MAX_TOPICS_PER_MESSAGE = 20


@router.websocket("/ws/realtime")
async def ws_realtime(websocket: WebSocket):
    user = await authenticate_websocket(websocket)
    await websocket.accept()
    if not user:
        # Accept first, then close with the app code. A close before accept is
        # answered by the ASGI server as an HTTP 403 handshake failure, which
        # browsers report as 1006; the client then never sees 4001 and keeps
        # reconnecting.
        await websocket.close(code=4001, reason="Authentication required")
        return

    conn = hub.register(websocket, user)
    try:
        await websocket.send_json({
            "type": "HELLO",
            "topics": sorted(
                topic for topic in TOPIC_AUTHORIZERS
                if hub.can_subscribe(user, topic)
            ),
        })
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")
            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
            elif msg_type == "SUBSCRIBE":
                topics = [
                    t for t in (message.get("topics") or [])[:MAX_TOPICS_PER_MESSAGE]
                    if isinstance(t, str)
                ]
                result = hub.subscribe(conn, topics)
                await websocket.send_json({"type": "SUBSCRIBED", **result})
            elif msg_type == "UNSUBSCRIBE":
                topics = [
                    t for t in (message.get("topics") or [])[:MAX_TOPICS_PER_MESSAGE]
                    if isinstance(t, str)
                ]
                hub.unsubscribe(conn, topics)
            # Unknown types are ignored — forward compatibility.
    except WebSocketDisconnect:
        pass
    except Exception:
        # Malformed JSON or transport error: close quietly, never crash the app.
        logger.debug("realtime socket error", exc_info=True)
    finally:
        hub.unregister(conn)
