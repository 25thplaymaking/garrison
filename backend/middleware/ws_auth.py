"""WebSocket authentication, matching the REST session check.

The session cookie is read first (browsers send it on the handshake). A
`?token=` query parameter is the fallback for clients that cannot set cookies.
"""

from fastapi import WebSocket

from config import COOKIE_NAME
from database import db
from middleware.auth import decode_session_token


async def authenticate_websocket(websocket: WebSocket) -> dict | None:
    """Return the authenticated user, or None to reject the socket."""
    token = websocket.cookies.get(COOKIE_NAME) or websocket.query_params.get("token")
    if not token:
        return None
    payload = decode_session_token(token)
    if payload is None:
        return None
    user = await resolve_websocket_user(payload["sub"])
    if user is None or int(user.get("token_version") or 0) != int(payload.get("tv") or 0):
        return None
    return user


async def resolve_websocket_user(user_id: str) -> dict | None:
    """Re-read the account. Long-lived sockets call this before sensitive
    sends so a revoked role or disabled account stops working mid-session."""
    if not user_id:
        return None
    try:
        user = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    except Exception:
        return None
    if not user or not user.get("is_active", False):
        return None
    return user
