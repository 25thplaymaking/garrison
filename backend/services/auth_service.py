"""Password hashing, session tokens and the session cookie."""

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Request, Response

from config import (
    COOKIE_MAX_AGE,
    COOKIE_NAME,
    COOKIE_SECURE,
    JWT_ALGORITHM,
    JWT_EXPIRATION_HOURS,
    JWT_SECRET,
)

# bcrypt only reads the first 72 bytes of a password.
MAX_PASSWORD_BYTES = 72
MIN_PASSWORD_LENGTH = 10


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8")[:MAX_PASSWORD_BYTES], bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    if not password or not hashed:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:MAX_PASSWORD_BYTES], hashed.encode("ascii"))
    except ValueError:
        return False


# A real hash to compare against when the username does not exist, so a
# wrong username takes as long as a wrong password.
DUMMY_HASH = hash_password("garrison-timing-equaliser")


def password_problem(password: str) -> str | None:
    if len(password or "") < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        return f"Password must be at most {MAX_PASSWORD_BYTES} bytes."
    return None


def create_access_token(claims: dict) -> str:
    now = datetime.now(timezone.utc)
    payload = {**claims, "iat": now, "exp": now + timedelta(hours=JWT_EXPIRATION_HOURS)}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def request_is_https(request: Request | None) -> bool:
    if request is None:
        return False
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or proto == "https"


def cookie_secure(request: Request | None) -> bool:
    if COOKIE_SECURE in ("true", "1", "yes"):
        return True
    if COOKIE_SECURE in ("false", "0", "no"):
        return False
    return request_is_https(request)


def set_auth_cookie(response: Response, token: str, request: Request | None = None) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=cookie_secure(request),
        samesite="lax",
        path="/",
    )


def clear_auth_cookie(response: Response, request: Request | None = None) -> None:
    response.delete_cookie(key=COOKIE_NAME, path="/", secure=cookie_secure(request), httponly=True, samesite="lax")
