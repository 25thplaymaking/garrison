"""Server config change history.

Previously each change pushed the whole previous config into a
`config_history` array on the server document. Two problems came with that:

* The array is unbounded. Live servers reached 33-44 entries and their
  documents reached 348-440 KB.
* 56 call sites read the server with `find_one({"id": ...}, {"_id": 0})` — no
  projection — so every one of them dragged all of those embedded configs
  across on requests that never look at the history.

So revisions live in their own indexed collection, like mod revisions do, and
the server document keeps only the current config.

The other half is the diff. A raw before/after of a nested Reforger config is
unreadable, so changes are flattened to dotted paths (`game.gameProperties.
serverMaxViewDistance: 2500 → 3000`). `game.mods` is deliberately summarised
rather than expanded: the mod list has its own revision history, and inlining
130 entries would bury the setting that actually changed.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from database import db

logger = logging.getLogger(__name__)

COLLECTION = "server_config_revisions"

# Paths whose contents are tracked elsewhere and would swamp a settings diff.
_SUMMARISED_PATHS = {"game.mods"}

# Longer values are truncated for display; the full value stays in the snapshot.
_MAX_VALUE_CHARS = 300


def _render(value: Any) -> str:
    """A short, readable rendering of a config value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, str)):
        text = str(value)
    else:
        try:
            text = json.dumps(value, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            text = repr(value)
    return text if len(text) <= _MAX_VALUE_CHARS else text[:_MAX_VALUE_CHARS] + "…"


def flatten_config(config: Any, prefix: str = "") -> Dict[str, Any]:
    """Flatten nested dicts to dotted paths.

    Lists are kept whole rather than indexed: a Reforger config's lists are
    value-like (admin ids, mission rotations), and per-index paths would report
    an insertion at the front as a change to every element behind it.
    """
    out: Dict[str, Any] = {}
    if not isinstance(config, dict):
        return {prefix or "": config} if prefix else {}
    for key, value in config.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if path in _SUMMARISED_PATHS:
            out[path] = f"<{len(value) if isinstance(value, list) else 1} entries>"
        elif isinstance(value, dict):
            nested = flatten_config(value, path)
            # An empty dict is itself a value worth showing as present.
            out.update(nested or {path: {}})
        else:
            out[path] = value
    return out


def summarize_config_diff(before: Any, after: Any) -> dict:
    """Describe what changed between two configs, as dotted paths."""
    b = flatten_config(before or {})
    a = flatten_config(after or {})

    added = [
        {"path": p, "value": _render(a[p])}
        for p in sorted(a.keys() - b.keys())
    ]
    removed = [
        {"path": p, "value": _render(b[p])}
        for p in sorted(b.keys() - a.keys())
    ]
    changed = [
        {"path": p, "from": _render(b[p]), "to": _render(a[p])}
        for p in sorted(a.keys() & b.keys())
        if b[p] != a[p]
    ]
    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "added_count": len(added),
        "removed_count": len(removed),
        "changed_count": len(changed),
        "total_changes": len(added) + len(removed) + len(changed),
    }


async def current_version(server_id: str) -> int:
    """The newest recorded version, or 0 when this server has no history yet.

    The concurrency token for config saves. A client reads it with the config
    and sends it back on save; if it no longer matches, someone else wrote in
    between and the save is refused rather than silently overwriting them.
    """
    latest = await db[COLLECTION].find_one(
        {"server_id": server_id}, {"_id": 0, "version": 1}, sort=[("version", -1)]
    )
    return int(latest.get("version", 0)) if latest else 0


async def latest_revision_meta(server_id: str) -> Optional[dict]:
    """Who made the newest change and when — for a conflict message."""
    return await db[COLLECTION].find_one(
        {"server_id": server_id},
        {"_id": 0, "version": 1, "changed_by_name": 1, "changed_at": 1},
        sort=[("version", -1)],
    )


async def _next_version(server_id: str) -> int:
    """One past the highest version recorded for this server.

    Derived from the stored maximum rather than a document count, so pruning
    history can never reissue a version number that already existed.
    """
    latest = await db[COLLECTION].find_one(
        {"server_id": server_id}, {"_id": 0, "version": 1}, sort=[("version", -1)]
    )
    return int(latest.get("version", 0)) + 1 if latest else 1


async def record_config_revision(
    *,
    server_id: str,
    before_config: Any,
    after_config: Any,
    changed_by: str,
    changed_by_name: str = "",
    source: str = "update",
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """Append a config revision. No-ops when nothing actually changed.

    Never raises: history is a side effect of a write that already succeeded,
    so a failure here must not surface as a failed config update.
    """
    if before_config == after_config:
        return None
    diff = summarize_config_diff(before_config, after_config)
    if diff["total_changes"] == 0:
        return None

    revision = {
        "id": str(uuid.uuid4()),
        "server_id": server_id,
        "version": await _next_version(server_id),
        "source": source,
        "diff": diff,
        "before_config": before_config,
        "after_config": after_config,
        "changed_by": changed_by,
        "changed_by_name": changed_by_name,
        "changed_at": (now or datetime.now(timezone.utc)).isoformat(),
    }
    try:
        await db[COLLECTION].insert_one(dict(revision))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to record config revision for server %s: %s", server_id, exc)
        return None
    revision.pop("_id", None)
    return revision


async def list_config_revisions(
    server_id: str, *, limit: int = 50, offset: int = 0
) -> dict:
    """A page of config revisions, newest first, without the snapshots."""
    total = await db[COLLECTION].count_documents({"server_id": server_id})
    cursor = db[COLLECTION].find(
        {"server_id": server_id},
        {"_id": 0, "before_config": 0, "after_config": 0},
    ).sort("version", -1).skip(offset).limit(limit)
    items: List[dict] = await cursor.to_list(limit)
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total,
    }


async def get_config_revision(server_id: str, version: int) -> Optional[dict]:
    """One revision including both snapshots."""
    return await db[COLLECTION].find_one(
        {"server_id": server_id, "version": version}, {"_id": 0}
    )


async def migrate_embedded_history(server: dict) -> int:
    """Move a server's embedded `config_history` into the revisions collection.

    Idempotent: servers already migrated have no `config_history` left to move,
    and re-running finds nothing.

    Ordering note — an embedded entry stores the config as it was BEFORE that
    change, so entry *i*'s "after" is entry *i+1*'s stored config, and the last
    entry's "after" is the server's current config. That off-by-one is why the
    old endpoint could not show a diff at all.
    """
    history = server.get("config_history") or []
    if not history:
        return 0

    server_id = server.get("id", "")
    ordered = sorted(history, key=lambda e: e.get("version", 0))
    current = server.get("config") or {}

    migrated = 0
    for index, entry in enumerate(ordered):
        before = entry.get("config") or {}
        after = ordered[index + 1].get("config") if index + 1 < len(ordered) else current
        after = after or {}
        diff = summarize_config_diff(before, after)
        if diff["total_changes"] == 0:
            continue
        doc = {
            "id": entry.get("id") or str(uuid.uuid4()),
            "server_id": server_id,
            "version": entry.get("version", index + 1),
            "source": "migrated",
            "diff": diff,
            "before_config": before,
            "after_config": after,
            "changed_by": entry.get("changed_by", ""),
            "changed_by_name": entry.get("changed_by_name", ""),
            "changed_at": entry.get("changed_at", ""),
        }
        try:
            await db[COLLECTION].update_one(
                {"server_id": server_id, "version": doc["version"]},
                {"$setOnInsert": doc},
                upsert=True,
            )
            migrated += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Failed migrating config revision %s for server %s: %s",
                doc["version"], server_id, exc,
            )
    return migrated
