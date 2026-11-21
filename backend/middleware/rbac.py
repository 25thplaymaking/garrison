"""Roles and permissions.

Two roles:
  admin     manages servers and panel accounts
  operator  manages servers
"""

from enum import Enum

from fastapi import Depends, HTTPException

from middleware.auth import get_current_user


class Role(str, Enum):
    ADMIN = "admin"
    OPERATOR = "operator"


class Permission(str, Enum):
    MANAGE_SERVERS = "manage_servers"
    MANAGE_USERS = "manage_users"


ROLE_PERMISSIONS = {
    Role.ADMIN: {Permission.MANAGE_SERVERS, Permission.MANAGE_USERS},
    Role.OPERATOR: {Permission.MANAGE_SERVERS},
}


def _resolve_role(role_str: str):
    try:
        return Role(str(role_str or "").strip().lower())
    except ValueError:
        return None


def has_permission(role_str: str, permission: Permission) -> bool:
    role = _resolve_role(role_str)
    return role is not None and permission in ROLE_PERMISSIONS.get(role, set())


def permissions_for(role_str: str) -> list[str]:
    role = _resolve_role(role_str)
    return sorted(p.value for p in ROLE_PERMISSIONS.get(role, set())) if role else []


def require_permission(permission: Permission):
    """FastAPI dependency: the signed-in user must hold this permission."""
    async def _check(current_user: dict = Depends(get_current_user)):
        if not has_permission(current_user.get("role", ""), permission):
            raise HTTPException(status_code=403, detail=f"Permission '{permission.value}' required")
        return current_user
    return _check
