"""Sign-in, panel accounts and the audit log."""

import re
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from database import db
from middleware.auth import get_current_user
from middleware.ip_rate_limiter import check_account_rate_limit, rate_limit_ip
from middleware.rbac import Permission, permissions_for, require_permission
from services.audit_service import log_audit
from services.auth_service import (
    DUMMY_HASH,
    clear_auth_cookie,
    create_access_token,
    hash_password,
    password_problem,
    set_auth_cookie,
    verify_password,
)

router = APIRouter()

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
_login_ip_limit = rate_limit_ip("login_ip", max_per_window=20, window_seconds=300)


def public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user.get("role", "operator"),
        "is_active": bool(user.get("is_active", False)),
        "permissions": permissions_for(user.get("role", "")),
        "created_at": user.get("created_at"),
        "last_login_at": user.get("last_login_at"),
    }


def _session_token(user: dict) -> str:
    return create_access_token({"sub": user["id"], "tv": int(user.get("token_version") or 0)})


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


@router.post("/auth/login")
async def login(body: LoginRequest, request: Request, response: Response, _: None = Depends(_login_ip_limit)):
    username = body.username.strip()
    check_account_rate_limit("login_account", username, 10, 900, request=request)
    user = await db.users.find_one({"username_lower": username.lower()}, {"_id": 0})
    # Always run one bcrypt check so an unknown username is not faster.
    ok = verify_password(body.password, (user or {}).get("password_hash") or DUMMY_HASH)
    if not user or not ok or not user.get("is_active", False):
        raise HTTPException(status_code=401, detail="Wrong username or password")
    now = datetime.now(timezone.utc).isoformat()
    await db.users.update_one({"id": user["id"]}, {"$set": {"last_login_at": now}})
    set_auth_cookie(response, _session_token(user), request)
    await log_audit(user_id=user["id"], action_type="login", resource_type="user", resource_id=user["id"])
    return public_user({**user, "last_login_at": now})


@router.post("/auth/logout")
async def logout(request: Request, response: Response):
    clear_auth_cookie(response, request)
    return {"ok": True}


@router.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    return public_user(current_user)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


@router.post("/auth/password")
async def change_password(body: PasswordChange, request: Request, response: Response,
                          current_user: dict = Depends(get_current_user)):
    stored = await db.users.find_one({"id": current_user["id"]}, {"_id": 0, "password_hash": 1, "token_version": 1})
    if not stored or not verify_password(body.current_password, stored.get("password_hash", "")):
        raise HTTPException(status_code=400, detail="Current password is wrong")
    problem = password_problem(body.new_password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    version = int(stored.get("token_version") or 0) + 1
    await db.users.update_one(
        {"id": current_user["id"]},
        {"$set": {"password_hash": hash_password(body.new_password), "token_version": version}},
    )
    # Other sessions end; this one gets a fresh cookie.
    set_auth_cookie(response, _session_token({**current_user, "token_version": version}), request)
    await log_audit(user_id=current_user["id"], action_type="password_change", resource_type="user", resource_id=current_user["id"])
    return {"ok": True}


# ── Account management (admins) ─────────────────────────────────────────────

_require_admin = require_permission(Permission.MANAGE_USERS)


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=256)
    role: Literal["admin", "operator"] = "operator"


class UserUpdate(BaseModel):
    role: Optional[Literal["admin", "operator"]] = None
    is_active: Optional[bool] = None
    password: Optional[str] = Field(default=None, max_length=256)


async def create_user_record(username: str, password: str, role: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "username": username,
        "username_lower": username.lower(),
        "password_hash": hash_password(password),
        "role": role,
        "is_active": True,
        "token_version": 0,
        "created_at": now,
        "last_login_at": None,
    }
    await db.users.insert_one(dict(doc))
    return doc


@router.get("/users")
async def list_users(current_user: dict = Depends(_require_admin)):
    users = await db.users.find({}, {"_id": 0, "password_hash": 0}).sort("username_lower", 1).to_list(500)
    return [public_user(u) for u in users]


@router.post("/users", status_code=201)
async def create_user(body: UserCreate, current_user: dict = Depends(_require_admin)):
    username = body.username.strip()
    if not USERNAME_RE.match(username):
        raise HTTPException(status_code=400, detail="Username: 3-32 letters, digits, dot, dash or underscore.")
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if await db.users.find_one({"username_lower": username.lower()}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="That username is taken")
    doc = await create_user_record(username, body.password, body.role)
    await log_audit(user_id=current_user["id"], action_type="user_create", resource_type="user",
                    resource_id=doc["id"], after={"username": username, "role": body.role})
    return public_user(doc)


async def _active_admin_count(exclude_id: str) -> int:
    return await db.users.count_documents({"role": "admin", "is_active": True, "id": {"$ne": exclude_id}})


@router.patch("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate, current_user: dict = Depends(_require_admin)):
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    updates: dict = {}
    demoting = body.role is not None and body.role != "admin" and user.get("role") == "admin"
    disabling = body.is_active is False and user.get("is_active", False)
    if (demoting or disabling) and user.get("role") == "admin" and await _active_admin_count(user_id) == 0:
        raise HTTPException(status_code=400, detail="Keep at least one active admin")
    if body.role is not None:
        updates["role"] = body.role
    if body.is_active is not None:
        updates["is_active"] = body.is_active
    if body.password:
        problem = password_problem(body.password)
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        updates["password_hash"] = hash_password(body.password)
    if "password_hash" in updates or disabling:
        updates["token_version"] = int(user.get("token_version") or 0) + 1
    if not updates:
        return public_user(user)
    await db.users.update_one({"id": user_id}, {"$set": updates})
    await log_audit(
        user_id=current_user["id"], action_type="user_update", resource_type="user", resource_id=user_id,
        before={k: user.get(k) for k in ("role", "is_active")},
        after={k: v for k, v in updates.items() if k in ("role", "is_active")} | ({"password": "reset"} if body.password else {}),
    )
    return public_user({**user, **updates})


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, current_user: dict = Depends(_require_admin)):
    if user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("role") == "admin" and user.get("is_active") and await _active_admin_count(user_id) == 0:
        raise HTTPException(status_code=400, detail="Keep at least one active admin")
    await db.users.delete_one({"id": user_id})
    await log_audit(user_id=current_user["id"], action_type="user_delete", resource_type="user",
                    resource_id=user_id, before={"username": user.get("username"), "role": user.get("role")})
    return {"ok": True}


# ── Audit log ───────────────────────────────────────────────────────────────

@router.get("/audit-logs")
async def list_audit_logs(
    limit: int = Query(100, ge=1, le=500),
    skip: int = Query(0, ge=0),
    resource_id: Optional[str] = Query(None, max_length=128),
    current_user: dict = Depends(_require_admin),
):
    query = {"resource_id": resource_id} if resource_id else {}
    rows = await db.audit_logs.find(query, {"_id": 0}).sort("timestamp", -1).skip(skip).limit(limit).to_list(limit)
    ids = {r.get("user_id") for r in rows if r.get("user_id")}
    names = {
        u["id"]: u["username"]
        for u in await db.users.find({"id": {"$in": list(ids)}}, {"_id": 0, "id": 1, "username": 1}).to_list(len(ids) or 1)
    }
    for r in rows:
        r["username"] = names.get(r.get("user_id"), r.get("user_id") or "system")
    return {"items": rows, "total": await db.audit_logs.count_documents(query)}
