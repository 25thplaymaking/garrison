"""
Workshop Metadata Ingestion Service.

Fetches Arma Reforger mod metadata from the Workshop and populates
the ``workshop_mods`` collection.  Follows the same cache-first / TTL /
upsert pattern used by ``worldmonitor_ingest.py``.
"""

import logging
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Optional, Any

from database import db

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cache helpers  (mirror worldmonitor_ingest pattern)
# ---------------------------------------------------------------------------
_CACHE_COLLECTION = "workshop_cache"
_CACHE_TTL_MINUTES = 24 * 60  # 24 hours

WORKSHOP_BASE_URL = "https://reforger.armaplatform.com/workshop"


def _coerce_utc(value):
    """Normalize a Mongo/string datetime to aware UTC. Mongo BSON dates come
    back naive; older string entries may also be naive. Returns None on
    unparseable values."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


async def _ws_get_cached(key: str, ttl_minutes: int = _CACHE_TTL_MINUTES) -> Optional[dict]:
    """Return cached data for *key* if it exists and has not expired."""
    doc = await db[_CACHE_COLLECTION].find_one({"key": key}, {"_id": 0})
    if doc:
        cached_at = _coerce_utc(doc.get("cached_at"))
        if cached_at:
            age = (datetime.now(timezone.utc) - cached_at).total_seconds()
            if age < ttl_minutes * 60:
                return doc.get("data")
    return None


async def _ws_set_cached(key: str, data: Any) -> None:
    """Store *data* under *key* with a UTC timestamp."""
    await db[_CACHE_COLLECTION].update_one(
        {"key": key},
        {"$set": {
            "key": key,
            "cached_at": datetime.now(timezone.utc).isoformat(),
            "data": data,
        }},
        upsert=True,
    )


# ---------------------------------------------------------------------------
# Metadata extraction helpers
# ---------------------------------------------------------------------------

def _normalize_metadata(raw: dict, mod_id: str) -> dict:
    """Turn a raw API/scrape response into a normalised mod document."""
    checked_at = datetime.now(timezone.utc).isoformat()
    flags = raw.get("workshop_flags") or {}
    return {
        "mod_id": mod_id,
        "name": raw.get("name", ""),
        "author": raw.get("author", ""),
        "version": raw.get("version", ""),
        "summary": raw.get("summary", ""),
        "description": raw.get("description", ""),
        "license": raw.get("license", ""),
        "tags": raw.get("tags", []),
        "dependencies": raw.get("dependencies", []),
        # This record came from a full detail scrape, so its dependency list is
        # authoritative — an empty list here means the mod genuinely has none,
        # not that we never looked. Resolution trusts this flag to avoid the
        # "all dependencies fulfilled" false positive on never-fetched deps.
        "dependencies_verified": True,
        "scenario_ids": raw.get("scenario_ids") or raw.get("scenarioIds", []),
        "scenarios": raw.get("scenarios", []),
        "versions": raw.get("versions", []),
        "changelog": raw.get("changelog", ""),
        "thumbnail_url": raw.get("thumbnail_url") or raw.get("thumbnailUrl", ""),
        "workshop_url": raw.get("workshop_url", "") or f"{WORKSHOP_BASE_URL}/{mod_id}",
        "game_version": raw.get("game_version", ""),
        "current_version_size": raw.get("current_version_size", 0),
        "rating": raw.get("rating", 0),
        "rating_count": raw.get("rating_count", 0),
        "subscribers": raw.get("subscribers", 0),
        "downloads": raw.get("downloads", 0),
        "created_at": raw.get("created_at", ""),
        "updated_at": raw.get("updated_at", ""),
        "metadata_source": "workshop",
        "metadata_completeness": "full",
        "metadata_locked": False,
        "last_fetched": checked_at,
        "availability_status": "available",
        "removed_from_workshop": False,
        "removed_detected_at": None,
        "availability_checked_at": checked_at,
        "availability_error": "",
        "workshop_flags": {key: bool(flags.get(key)) for key in ("blocked", "private", "unlisted", "obsolete")},
        # A dedicated server cannot download a blocked or private asset.
        "downloadable": not (flags.get("blocked") or flags.get("private")),
    }


def _partial_record(mod_id: str) -> dict:
    """Return a minimal record when metadata could not be auto-fetched."""
    checked_at = datetime.now(timezone.utc).isoformat()
    return {
        "mod_id": mod_id,
        "name": "",
        "author": "",
        "version": "",
        "summary": "",
        "description": "",
        "license": "",
        "tags": [],
        "dependencies": [],
        # Fetch failed — the empty dependency list is unproven; resolution will
        # refetch live rather than trust it.
        "dependencies_verified": False,
        "scenario_ids": [],
        "scenarios": [],
        "versions": [],
        "changelog": "",
        "thumbnail_url": "",
        "workshop_url": f"{WORKSHOP_BASE_URL}/{mod_id}",
        "game_version": "",
        "current_version_size": 0,
        "rating": 0,
        "rating_count": 0,
        "subscribers": 0,
        "downloads": 0,
        "created_at": "",
        "updated_at": "",
        "metadata_source": "workshop",
        "metadata_completeness": "minimal",
        "metadata_incomplete": True,
        "metadata_locked": False,
        "last_fetched": checked_at,
        "availability_status": "unknown",
        "removed_from_workshop": False,
        "removed_detected_at": None,
        "availability_checked_at": checked_at,
        "availability_error": "Workshop metadata could not be reached or parsed",
    }


async def _fetch_from_workshop(mod_id: str, *, force_refresh: bool = False) -> dict:
    """Fetch mod metadata by scraping the detail page's __NEXT_DATA__ JSON.

    The Arma Reforger Workshop detail page embeds comprehensive mod data
    (dependencies with names, scenarios, version history, stats, changelog)
    in a ``<script id="__NEXT_DATA__">`` JSON blob.  This is far richer than
    any JSON API endpoint.

    Falls back to a partial record when the page is unreachable.
    """
    try:
        from services.workshop_proxy import fetch_mod_details
        details = await fetch_mod_details(mod_id, force_refresh=force_refresh)
        if details:
            return _normalize_metadata(details, mod_id)
    except Exception as exc:
        from services.workshop_proxy import WorkshopModUnavailableError
        if isinstance(exc, WorkshopModUnavailableError):
            raise
        logger.debug("Workshop detail fetch for %s failed: %s", mod_id, exc)

    logger.info("Returning partial record for mod %s (metadata unavailable)", mod_id)
    return _partial_record(mod_id)


# ---------------------------------------------------------------------------
# Primary public function
# ---------------------------------------------------------------------------

async def _mark_mod_removed(mod_id: str, reason: str) -> dict:
    """Persist an availability tombstone while preserving last-known metadata."""
    checked_at = datetime.now(timezone.utc).isoformat()
    existing = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})
    base = existing or _partial_record(mod_id)
    availability = {
        "availability_status": "removed",
        "removed_from_workshop": True,
        "removed_detected_at": checked_at,
        "availability_checked_at": checked_at,
        "availability_error": reason,
        # Without this the tombstone always looked stale, so every refresh
        # pass re-fetched every removed mod (473 re-fetches of 45 mods a week).
        "last_fetched": checked_at,
        "downloadable": False,
    }
    insert_base = {
        key: value
        for key, value in base.items()
        if key not in availability and key != "mod_id"
    }
    await db.workshop_mods.update_one(
        {"mod_id": mod_id},
        {
            "$set": availability,
            "$setOnInsert": {
                **insert_base,
                "indexed_at": checked_at,
            },
        },
        upsert=True,
    )
    return {**base, **availability}


async def fetch_mod_metadata(
    mod_id: str,
    *,
    force_refresh: bool = False,
) -> Optional[dict]:
    """Fetch mod metadata with cache-first strategy and upsert into DB.

    1. Check the ``workshop_cache`` collection (24-hour TTL).
       If the cached record lacks enriched fields, treat as a cache miss.
    2. On cache miss, fetch from the Arma Reforger Workshop.
    3. Cache the result and upsert into ``workshop_mods``.
    """
    cache_key = f"mod:{mod_id}"

    cached = None if force_refresh else await _ws_get_cached(cache_key)
    if cached:
        if cached.get("removed_from_workshop"):
            return cached
        # Invalidate cache entries that lack enriched fields (pre-upgrade data)
        has_enriched = cached.get("versions") or cached.get("subscribers")
        if has_enriched:
            return cached
        logger.debug("Cache hit for %s lacks enriched fields — refetching", mod_id)

    try:
        metadata = await _fetch_from_workshop(mod_id, force_refresh=force_refresh)
    except Exception as exc:
        from services.workshop_proxy import WorkshopModUnavailableError
        if not isinstance(exc, WorkshopModUnavailableError):
            raise
        removed = await _mark_mod_removed(mod_id, exc.reason)
        await _ws_set_cached(cache_key, removed)
        logger.warning("Workshop mod %s marked removed (%s)", mod_id, exc.reason)
        return removed
    if metadata is None:
        return None

    # Cache the result
    await _ws_set_cached(cache_key, metadata)

    # Upsert into the canonical workshop_mods collection
    # Preserve manual_overrides and metadata_locked flag
    existing = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})
    if existing and existing.get("metadata_locked"):
        # Don't overwrite locked (manually curated) records;
        # availability still comes from the Workshop and remains observable.
        availability = {
            key: metadata[key]
            for key in (
                "availability_status",
                "removed_from_workshop",
                "removed_detected_at",
                "availability_checked_at",
                "availability_error",
            )
        }
        await db.workshop_mods.update_one(
            {"mod_id": mod_id},
            {"$set": availability},
        )
        return {**existing, **availability}

    # A transient fetch or parser failure must not erase good stored metadata
    # or clear a previously authoritative removed status.
    if metadata.get("metadata_incomplete") and existing:
        transient = {
            "availability_checked_at": metadata["availability_checked_at"],
            "availability_error": metadata["availability_error"],
        }
        await db.workshop_mods.update_one(
            {"mod_id": mod_id},
            {"$set": transient},
        )
        return {**existing, **transient}

    update_doc = {**metadata}
    if existing and existing.get("manual_overrides"):
        # Merge: keep manual_overrides, apply them on top
        update_doc["manual_overrides"] = existing["manual_overrides"]
        for field, val in existing["manual_overrides"].items():
            if val is not None:  # Apply manual overrides, allowing falsy values
                update_doc[field] = val
        update_doc["metadata_source"] = "hybrid"

    await db.workshop_mods.update_one(
        {"mod_id": mod_id},
        {
            "$set": update_doc,
            "$setOnInsert": {"indexed_at": datetime.now(timezone.utc).isoformat()},
        },
        upsert=True,
    )

    return metadata


# ---------------------------------------------------------------------------
# Convenience wrapper (used by API endpoints)
# ---------------------------------------------------------------------------

async def fetch_and_store_mod(
    mod_id: str,
    *,
    force_refresh: bool = False,
) -> Optional[dict]:
    """On-demand fetch + store.  Returns the stored document."""
    await fetch_mod_metadata(mod_id, force_refresh=force_refresh)
    doc = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})
    return doc


# ---------------------------------------------------------------------------
# Background refresh loop
# ---------------------------------------------------------------------------
_RATE_LIMIT_DELAY = 6  # seconds between fetches (≈10 per minute)
# A removed mod is re-checked weekly in case its author restores it.
TOMBSTONE_RECHECK = timedelta(days=7)
# Records outside every loadout are only fetched when incomplete, capped per pass.
_UNUSED_INCOMPLETE_PER_PASS = 50
_DEPENDENCY_WALK_DEPTH = 4
_STATE_KEY = "workshop_refresh_loop"


def _iso_before(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) - delta).isoformat()


def record_needs_refresh(existing: Optional[dict], stale_threshold: str, tombstone_threshold: str) -> bool:
    """Whether the loop should fetch this record now."""
    if not existing:
        return True
    if existing.get("metadata_locked") or existing.get("metadata_source") == "manual":
        return False
    if existing.get("removed_from_workshop"):
        checked = existing.get("availability_checked_at") or existing.get("last_fetched") or ""
        return checked < tombstone_threshold
    return bool(
        existing.get("metadata_incomplete")
        or existing.get("metadata_completeness") == "minimal"
        or (existing.get("last_fetched") or "") < stale_threshold
    )


async def loadout_mod_ids() -> set:
    """Every mod in any managed server's saved loadout, plus their dependencies.

    Dependencies are never in a saved config, but Reforger downloads them and
    the resolver walks them, so they are kept fresh too (and fetched ahead of
    time when no record exists yet).
    """
    wanted: set = set()
    async for srv in db.managed_servers.find({}, {"mods": 1, "_id": 0}):
        for mod in srv.get("mods") or []:
            mid = (mod.get("mod_id") or mod.get("modId") or "").strip().upper()
            if mid:
                wanted.add(mid)
    frontier = set(wanted)
    for _ in range(_DEPENDENCY_WALK_DEPTH):
        if not frontier:
            break
        next_frontier: set = set()
        async for doc in db.workshop_mods.find(
            {"mod_id": {"$in": sorted(frontier)}}, {"dependencies": 1, "_id": 0},
        ):
            for dep in doc.get("dependencies") or []:
                did = (dep.get("mod_id") or dep.get("modId") or "").strip().upper()
                if did and did not in wanted:
                    wanted.add(did)
                    next_frontier.add(did)
        frontier = next_frontier
    return wanted


async def run_refresh_pass(interval_hours: int) -> int:
    """One refresh pass. Returns the number of records fetched."""
    stale_threshold = _iso_before(timedelta(hours=interval_hours))
    tombstone_threshold = _iso_before(TOMBSTONE_RECHECK)
    wanted = await loadout_mod_ids()

    refreshed = 0
    for mod_id in sorted(wanted):
        existing = await db.workshop_mods.find_one({"mod_id": mod_id}, {"_id": 0})
        if not record_needs_refresh(existing, stale_threshold, tombstone_threshold):
            continue
        try:
            await fetch_mod_metadata(mod_id, force_refresh=True)
            refreshed += 1
        except Exception as exc:
            logger.warning("Failed to refresh loadout mod %s: %s", mod_id, repr(exc))
        await asyncio.sleep(_RATE_LIMIT_DELAY)

    # Browsed/searched mods outside every loadout are served stale-while-
    # revalidate when someone opens them; re-scraping thousands of them daily
    # only starved interactive lookups of the shared rate limit. Only fill in
    # a bounded number of incomplete ones.
    cursor = db.workshop_mods.find(
        {
            "mod_id": {"$nin": sorted(wanted)},
            "metadata_source": {"$ne": "manual"},
            "metadata_locked": {"$ne": True},
            "removed_from_workshop": {"$ne": True},
            "metadata_incomplete": True,
        },
        {"mod_id": 1, "_id": 0},
    ).limit(_UNUSED_INCOMPLETE_PER_PASS)
    async for doc in cursor:
        mod_id = doc.get("mod_id")
        if not mod_id:
            continue
        try:
            await fetch_mod_metadata(mod_id, force_refresh=True)
            refreshed += 1
        except Exception as exc:
            logger.warning("Failed to refresh mod %s: %s", mod_id, repr(exc))
        await asyncio.sleep(_RATE_LIMIT_DELAY)
    return refreshed


async def _seconds_until_next_pass(interval_hours: int) -> float:
    """Resume the schedule across restarts instead of re-running a full pass."""
    try:
        state = await db.background_job_state.find_one({"_id": _STATE_KEY})
    except Exception:
        return 0.0
    last = (state or {}).get("last_pass_at")
    if not isinstance(last, datetime):
        return 0.0
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - last).total_seconds()
    return max(interval_hours * 3600 - elapsed, 0.0)


async def workshop_refresh_loop(interval_hours: int = 24) -> None:
    """Keep loadout mods (and their dependencies) fresh.

    Follows the same ``asyncio`` while-loop / ``CancelledError`` pattern as
    ``_valyu_background_ingestion`` in ``server.py``.
    """
    logger.info("Workshop refresh loop started (interval=%dh)", interval_hours)
    while True:
        try:
            wait = await _seconds_until_next_pass(interval_hours)
            if wait > 0:
                await asyncio.sleep(wait)
            refreshed = await run_refresh_pass(interval_hours)
            await db.background_job_state.update_one(
                {"_id": _STATE_KEY},
                {"$set": {"last_pass_at": datetime.now(timezone.utc), "last_refreshed": refreshed}},
                upsert=True,
            )
            if refreshed:
                logger.info("Workshop refresh: updated %d mods", refreshed)
        except asyncio.CancelledError:
            logger.info("Workshop refresh loop cancelled – shutting down")
            break
        except Exception as exc:
            logger.error("Workshop refresh loop error: %s", repr(exc))
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                break
