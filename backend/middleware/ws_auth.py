"""WebSocket authentication, matching the REST session check.

The session cookie is read first (browsers send it on the handshake). A
`?token=` query parameter is the fallback for clients that cannot set cookies.
"""

from urllib.parse import urlsplit

from fastapi import WebSocket

from config import COOKIE_NAME, SITE_URL
from database import db
from middleware.auth import decode_session_token


def origin_allowed(websocket: WebSocket) -> bool:
    """Browsers always send Origin on a WebSocket handshake and attach the
    session cookie no matter which page opened the socket. Refuse handshakes
    from any page that is not the panel itself (cross-site WebSocket
    hijacking), so another site cannot drive the console or RCON with a
    signed-in operator's cookie. Clients without an Origin are not browsers."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    origin_host = urlsplit(origin).netloc.lower()
    allowed = {websocket.headers.get("host", "").lower()}
    if SITE_URL:
        allowed.add(urlsplit(SITE_URL).netloc.lower())
    allowed.discard("")
    return bool(origin_host) and origin_host in allowed


async def authenticate_websocket(websocket: WebSocket) -> dict | None:
    """Return the authenticated user, or None to reject the socket."""
    if not origin_allowed(websocket):
        return None
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
