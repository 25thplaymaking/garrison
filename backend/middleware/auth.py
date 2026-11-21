"""Session authentication: an HttpOnly cookie holding a signed JWT."""

import logging
import time

import jwt
from fastapi import HTTPException, Request, Response

from config import COOKIE_MAX_AGE, COOKIE_NAME, JWT_ALGORITHM, JWT_SECRET, SESSION_RENEW_AFTER_SECONDS
from database import db
from services.auth_service import create_access_token, set_auth_cookie

logger = logging.getLogger(__name__)


def decode_session_token(token: str) -> dict | None:
    """Return the token's claims, or None when it is not a valid session."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.exceptions.PyJWTError:
        return None
    # Only session tokens carry no purpose claim; anything signed for another
    # purpose must never work as a login.
    if not payload.get("sub") or payload.get("purpose"):
        return None
    return payload


async def load_active_user(user_id: str, token_version: int | None) -> dict | None:
    """Read the account fresh on every request so a role change, a disabled
    account or a password change takes effect at once."""
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not user or not user.get("is_active", False):
        return None
    # Changing a password (or an admin resetting it) bumps token_version and
    # so ends every session issued before it.
    if int(user.get("token_version") or 0) != int(token_version or 0):
        return None
    return user


def renew_session_if_due(payload: dict, response: Response | None, *, now: float | None = None,
                         request: Request | None = None) -> bool:
    """Sliding session: re-issue the cookie once half its life is used up."""
    if response is None:
        return False
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    remaining = exp - (time.time() if now is None else now)
    if remaining > COOKIE_MAX_AGE - SESSION_RENEW_AFTER_SECONDS:
        return False
    claims = {k: v for k, v in payload.items() if k not in ("exp", "iat", "nbf")}
    set_auth_cookie(response, create_access_token(claims), request)
    return True


async def get_current_user(request: Request, response: Response = None) -> dict:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_session_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    user = await load_active_user(payload["sub"], payload.get("tv"))
    if user is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    try:
        renew_session_if_due(payload, response, request=request)
    except Exception:  # pragma: no cover - renewal must never cost a session
        logger.exception("session renewal failed; continuing with the current token")
    return user
