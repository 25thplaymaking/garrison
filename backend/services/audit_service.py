"""Audit log: one record per change anyone makes through the panel."""

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from database import db

logger = logging.getLogger(__name__)

_SECRET_KEY = re.compile(
    r"(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|session|credential|private[_-]?key)",
    re.IGNORECASE,
)


def redact_secrets(value: Any, *, depth: int = 0) -> Any:
    """Mask every value stored under a secret-looking key before it is logged."""
    if depth >= 12:
        return "[truncated]"
    if isinstance(value, dict):
        return {
            key: "[redacted]" if _SECRET_KEY.search(str(key)) and item not in (None, "") else redact_secrets(item, depth=depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_secrets(item, depth=depth + 1) for item in value]
    return value


async def log_audit(
    user_id: str,
    action_type: str,
    resource_type: str,
    resource_id: Optional[str] = None,
    before: Optional[dict] = None,
    after: Optional[dict] = None,
    metadata: Optional[dict] = None,
    **_ignored: Any,
) -> dict:
    entry = {
        "id": f"audit_{uuid.uuid4().hex[:16]}",
        "user_id": user_id,
        "action_type": action_type,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "before": redact_secrets(before),
        "after": redact_secrets(after),
        "metadata": redact_secrets(metadata),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await db.audit_logs.insert_one(dict(entry))
    except Exception as exc:
        logger.error(
            "Failed to persist audit log: %s (action %s, resource %s/%s)",
            exc, action_type, resource_type, resource_id,
        )
    return entry
