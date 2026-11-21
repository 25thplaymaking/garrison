"""
Hybrid sliding-window rate limiter — per-IP (dependency) and per-account
(manual call from the route handler).

Protects sign-in and the paid AI routes from brute force and abuse.

Design
------
* **Per-IP** rate limits attach as FastAPI dependencies on the route, so
  abuse is rejected with HTTP 429 before the request body is even parsed
  (cheap fail). This catches "one IP brute-forcing many accounts".

* **Per-account** rate limits run manually from the route handler AFTER
  the request body has been read, since we need to know which account is
  the target. This catches the inverse: "many IPs trying one account"
  (distributed credential stuffing from a botnet, where each IP slips
  under the per-IP limit).

* Both buckets share a single in-process sliding-window store keyed by
  `(bucket_name, scope, identifier)`. The store is process-local — fine
  for a single-uvicorn deploy; for horizontal scale-out the same API
  fronts a Redis backend cleanly.

* Triggered limits emit an audit log row so attacks are visible to ops
  without parsing nginx logs.

Trusting proxy headers
----------------------
`get_client_ip` reads `X-Forwarded-For` only when `TRUST_PROXY_HEADERS=true`.
Set it only when the panel sits behind your own reverse proxy; otherwise any
client could fake its address and dodge the limits.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Callable, Optional

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)


# ─── Sliding-window store ────────────────────────────────────────────────────
# key → list[monotonic_timestamp]. Trimmed lazily on each access.
_windows: dict[tuple[str, str, str], list[float]] = defaultdict(list)


class RateLimitBucket:
    __slots__ = ("name", "max_per_window", "window_seconds")

    def __init__(self, name: str, max_per_window: int, window_seconds: int) -> None:
        self.name = name
        self.max_per_window = max_per_window
        self.window_seconds = window_seconds

    def __repr__(self) -> str:  # for log lines
        return f"<RateLimitBucket {self.name} {self.max_per_window}/{self.window_seconds}s>"


def _trim(key: tuple[str, str, str], cutoff: float) -> list[float]:
    """Drop entries older than cutoff. Returns the trimmed list."""
    entries = _windows[key]
    idx = 0
    while idx < len(entries) and entries[idx] < cutoff:
        idx += 1
    if idx:
        entries = entries[idx:]
        _windows[key] = entries
    return entries


def _check(bucket: RateLimitBucket, scope: str, identifier: str) -> tuple[bool, int]:
    """Check whether the next request is allowed.

    Returns (allowed, retry_after_seconds). When `allowed` is True the call
    is also *recorded* (the limiter is conservative — once you ask, the
    request counts).
    """
    key = (bucket.name, scope, identifier)
    now = time.monotonic()
    entries = _trim(key, now - bucket.window_seconds)
    if len(entries) >= bucket.max_per_window:
        retry_after = max(1, int(bucket.window_seconds - (now - entries[0])))
        return False, retry_after
    entries.append(now)
    return True, 0


def get_client_ip(request: Request, *, trust_proxy: bool) -> str:
    """Extract the client IP that rate-limit buckets are keyed on.

    Behind the reverse proxy we read ``X-Real-IP``: nginx sets it from
    ``$remote_addr``, which ``nginx-production.conf`` resolves to the true
    visitor via Cloudflare's ``CF-Connecting-IP``. We fall back to the LAST
    ``X-Forwarded-For`` entry, which nginx appends itself.

    NEVER the FIRST ``X-Forwarded-For`` entry (the pre-hardening behaviour).
    nginx writes that header with ``$proxy_add_x_forwarded_for``, which keeps
    whatever the caller sent at the HEAD of the list -- so a client that sends
    its own ``X-Forwarded-For`` chooses its own bucket, and one header per
    request defeats every per-IP limit in the app. This was live and
    exploitable: a fixed spoofed value was 429'd on the 6th call while a fresh
    spoofed value was admitted on the next request. See
    ``tests/test_rate_limiter.py`` for the regression tests.
    """
    if trust_proxy:
        real_ip = (request.headers.get("X-Real-IP") or "").strip()
        if real_ip:
            return real_ip
        forwarded = [
            part.strip()
            for part in (request.headers.get("X-Forwarded-For") or "").split(",")
            if part.strip()
        ]
        if forwarded:
            # nginx appends the socket peer last, so the tail cannot be
            # client-supplied even when the head can.
            return forwarded[-1]
    return request.client.host if request.client else "unknown"


def _should_trust_proxy() -> bool:
    """Read once per call; do NOT cache at module load — env may change in tests."""
    import os
    return os.environ.get("TRUST_PROXY_HEADERS", "false").strip().lower() in ("1", "true", "yes")


def get_request_client_ip(request: Request) -> str:
    """Return the effective client IP using the deployment's proxy policy."""
    return get_client_ip(request, trust_proxy=_should_trust_proxy())


# ─── Audit-log integration ───────────────────────────────────────────────────

async def _audit_block(bucket: RateLimitBucket, scope: str, identifier: str, request: Request) -> None:
    """Best-effort write to audit_logs when a limit fires. Never raises —
    if the DB is unavailable we still 429 the request."""
    try:
        from services.audit_service import log_audit
        path = str(request.url.path) if request.url else "<unknown>"
        method = request.method if request else "GET"
        await log_audit(
            user_id=None,
            action_type="rate_limit_block",
            resource_type="endpoint",
            resource_id=path,
            metadata={
                "bucket": bucket.name,
                "scope": scope,
                "identifier_hash": _hash_for_log(identifier),
                "method": method,
                "max_per_window": bucket.max_per_window,
                "window_seconds": bucket.window_seconds,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("rate_limit audit-log failed (%s): %s", bucket, exc)


def _hash_for_log(value: str) -> str:
    """Short stable hash so the audit log records "who got blocked" without
    pinning the raw IP or email in logs forever."""
    import hashlib
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


# ─── Public API: per-IP FastAPI dependency ───────────────────────────────────

def rate_limit_ip(bucket_name: str, max_per_window: int, window_seconds: int) -> Callable:
    """Return a FastAPI dependency that enforces a per-IP sliding-window limit.

    Usage:
        _login_ip_limit = rate_limit_ip("auth_login", 5, 900)

        @router.post("/auth/login")
        async def login(..., _: None = Depends(_login_ip_limit)):
            ...
    """
    bucket = RateLimitBucket(bucket_name, max_per_window, window_seconds)

    async def _dep(request: Request) -> None:
        ip = get_client_ip(request, trust_proxy=_should_trust_proxy())
        allowed, retry_after = _check(bucket, "ip", ip)
        if not allowed:
            # Fire-and-forget audit log so blocks don't add latency.
            asyncio.create_task(_audit_block(bucket, "ip", ip, request))
            raise HTTPException(
                status_code=429,
                detail=(
                    "Too many requests from your network. "
                    f"Try again in about {retry_after} seconds."
                ),
                headers={"Retry-After": str(retry_after)},
            )

    return _dep


# ─── Public API: per-IP, called from inside the route ────────────────────────

def check_ip_rate_limit(
    bucket_name: str,
    ip: str,
    max_per_window: int,
    window_seconds: int,
    request: Optional[Request] = None,
) -> None:
    """Enforce a per-IP sliding-window limit imperatively, for call sites that
    only need to gate part of a route (e.g. the upstream-fetch branch of a
    handler that also serves from local disk) rather than the whole request
    via the `Depends(rate_limit_ip(...))` dependency above.

    Raises HTTPException(429) on block; returns None on allow.
    """
    bucket = RateLimitBucket(bucket_name, max_per_window, window_seconds)
    allowed, retry_after = _check(bucket, "ip", ip)
    if not allowed:
        if request is not None:
            asyncio.create_task(_audit_block(bucket, "ip", ip, request))
        raise HTTPException(
            status_code=429,
            detail=(
                "Too many requests from your network. "
                f"Try again in about {retry_after} seconds."
            ),
            headers={"Retry-After": str(retry_after)},
        )


# ─── Public API: per-account, called from inside the route ───────────────────

def check_account_rate_limit(
    bucket_name: str,
    account_key: str,
    max_per_window: int,
    window_seconds: int,
    request: Optional[Request] = None,
    action_label: str = "login attempts",
) -> None:
    """Enforce a per-account sliding-window limit. Call this AFTER the
    request body has been parsed (so you have the email / user-id) but
    BEFORE the expensive auth check (so a brute force attacker doesn't
    cause us to do bcrypt verifications).

    Raises HTTPException(429) on block; returns None on allow.
    """
    bucket = RateLimitBucket(bucket_name, max_per_window, window_seconds)
    identifier = account_key.strip().lower()
    if not identifier:
        return  # Nothing to track — empty payloads are someone else's problem.

    allowed, retry_after = _check(bucket, "account", identifier)
    if not allowed:
        if request is not None:
            asyncio.create_task(_audit_block(bucket, "account", identifier, request))
        raise HTTPException(
            status_code=429,
            detail=(
                f"Too many {action_label} for this account. "
                f"Try again in about {retry_after} seconds."
            ),
            headers={"Retry-After": str(retry_after)},
        )


# ─── Testing hook ────────────────────────────────────────────────────────────

def reset_all() -> None:
    """Clear the global sliding-window store. Tests use this between cases."""
    _windows.clear()
