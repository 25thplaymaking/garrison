import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from pymongo.errors import DuplicateKeyError

from database import db
from services.a2s_query import query_a2s_info
from services.rcon_bridge import bercon_client
from services.server_logs import (
    get_recent_server_log_entries,
    parse_log_timestamp,
    stable_hash,
)
from services.server_runtime_host import get_server_runtime_host

logger = logging.getLogger(__name__)

_PLAYER_IDENTITY_ADDED_RE = re.compile(
    r"BattlEye Server: Adding player identity=(?P<identity>0x[0-9A-Fa-f]+), name='(?P<name>[^']+)'"
)
_PLAYER_CONNECTED_RE = re.compile(
    r"BattlEye Server: 'Player #(?P<slot>\d+)\s+(?P<name>.+?) \((?P<endpoint>[^)]+)\) connected'"
)
_PLAYER_GUID_RE = re.compile(
    r"BattlEye Server: Setting GUID for player identity=(?P<identity>0x[0-9A-Fa-f]+), GUID=(?P<guid>\d+)"
)
_PLAYER_BE_GUID_RE = re.compile(
    r"BattlEye Server: 'Player #(?P<slot>\d+)\s+(?P<name>.+?) - BE GUID: (?P<be_guid>[0-9a-fA-F]+)'"
)
_PLAYER_DISCONNECTED_RE = re.compile(
    r"BattlEye Server: 'Player #(?P<slot>\d+)\s+(?P<body>.+?)\s+disconnected(?P<suffix>[^']*)'",
    re.IGNORECASE,
)
# Capture Bohemia BI UUID from BackendApi / Game module log lines.
# Matches patterns like:
#   "Game : Player 'Name' (identity: 1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d)"
#   "BackendApi: ... platformId=1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"
#   "... identity=<hex>, uid=1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"
_PLAYER_UUID_RE = re.compile(
    r"(?:identity:\s*|platformId[=:]\s*|uid[=:]\s*|playerIdentityId[=:]\s*)(?P<uuid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)
# Also capture a UUID associated with a player name from Game module log lines.
_PLAYER_GAME_REGISTERED_RE = re.compile(
    r"Player\s+'?(?P<name>[^'(]+?)'?\s*(?:\(#?\d+\)\s*)?(?:registered|identity)[^0-9a-fA-F]*(?P<uuid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)
_PLAYERS_ROW_RE = re.compile(
    r"^(?P<slot>\d+)\s*(?:[\.\-:]|\|)\s*(?P<name>.+?)(?:\s*\|\s*(?P<ping>\d+)ms)?$"
)
# Reforger's `#players` rows follow its header "[Player#] ; [Player UID] ; [Player Name]".
_REFORGER_PLAYERS_ROW_RE = re.compile(
    r"^(?P<player_id>\d+)\s*;\s*(?P<uid>[^;]*?)\s*;\s*(?P<name>.+)$"
)
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

_SNAPSHOT_GRACE_SECONDS = 45
_RECENT_LOG_TAIL = 250


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            return None
    return None


def _normalize_name(name: str | None) -> str:
    return " ".join(str(name or "").split()).strip().lower()


def _build_lookup_keys(data: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    if data.get("player_slot") is not None:
        keys.append(f"slot:{int(data['player_slot'])}")
    if data.get("player_identity"):
        keys.append(f"identity:{str(data['player_identity']).lower()}")
    if data.get("player_guid"):
        keys.append(f"guid:{str(data['player_guid'])}")
    if data.get("player_be_guid"):
        keys.append(f"be_guid:{str(data['player_be_guid']).lower()}")
    if data.get("player_uuid"):
        keys.append(f"uuid:{str(data['player_uuid']).lower()}")
    normalized_name = data.get("player_name_normalized") or _normalize_name(data.get("player_name"))
    if normalized_name:
        keys.append(f"name:{normalized_name}")
    if data.get("endpoint"):
        keys.append(f"endpoint:{str(data['endpoint']).lower()}")
    seen: set[str] = set()
    ordered: list[str] = []
    for key in keys:
        if key and key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered


def _best_identity_key(data: dict[str, Any]) -> str:
    if data.get("player_guid"):
        return f"guid:{data['player_guid']}"
    if data.get("player_be_guid"):
        return f"be_guid:{str(data['player_be_guid']).lower()}"
    if data.get("player_uuid"):
        return f"uuid:{str(data['player_uuid']).lower()}"
    if data.get("player_identity"):
        return f"identity:{str(data['player_identity']).lower()}"
    if data.get("player_slot") is not None:
        return f"slot:{int(data['player_slot'])}:{data.get('player_name_normalized') or _normalize_name(data.get('player_name'))}"
    normalized_name = data.get("player_name_normalized") or _normalize_name(data.get("player_name"))
    if normalized_name:
        return f"name:{normalized_name}"
    return f"unknown:{uuid.uuid4().hex[:12]}"


def _parse_disconnect_body(body: str, suffix: str) -> tuple[str, Optional[str], Optional[str]]:
    parsed_body = body.strip()
    endpoint = None
    endpoint_match = re.match(r"^(?P<name>.+?) \((?P<endpoint>[^)]+)\)$", parsed_body)
    if endpoint_match:
        parsed_body = endpoint_match.group("name").strip()
        endpoint = endpoint_match.group("endpoint").strip()

    reason = suffix.strip()
    if reason:
        reason = reason.lstrip(" :-")
        if reason.startswith("(") and reason.endswith(")"):
            reason = reason[1:-1].strip()
        reason = reason or None

    return parsed_body, endpoint, reason


def parse_player_log_entry(entry: dict[str, Any]) -> Optional[dict[str, Any]]:
    line = str(entry.get("line") or entry.get("raw") or "").strip()
    if not line:
        return None

    timestamp = parse_log_timestamp(entry.get("timestamp"))
    base = {
        "timestamp": timestamp,
        "cursor": entry.get("cursor") or "",
        "source": entry.get("source") or "",
        "raw": entry.get("raw") or line,
    }

    match = _PLAYER_IDENTITY_ADDED_RE.search(line)
    if match:
        name = match.group("name").strip()
        return {
            **base,
            "event_type": "player_identity_added",
            "player_name": name,
            "player_name_normalized": _normalize_name(name),
            "player_identity": match.group("identity"),
        }

    match = _PLAYER_CONNECTED_RE.search(line)
    if match:
        name = match.group("name").strip()
        return {
            **base,
            "event_type": "player_connected",
            "player_name": name,
            "player_name_normalized": _normalize_name(name),
            "player_slot": int(match.group("slot")),
            "endpoint": match.group("endpoint").strip(),
        }

    match = _PLAYER_GUID_RE.search(line)
    if match:
        return {
            **base,
            "event_type": "player_guid",
            "player_identity": match.group("identity"),
            "player_guid": match.group("guid").strip(),
        }

    match = _PLAYER_BE_GUID_RE.search(line)
    if match:
        name = match.group("name").strip()
        return {
            **base,
            "event_type": "player_be_guid",
            "player_name": name,
            "player_name_normalized": _normalize_name(name),
            "player_slot": int(match.group("slot")),
            "player_be_guid": match.group("be_guid").strip().lower(),
        }

    match = _PLAYER_DISCONNECTED_RE.search(line)
    if match:
        name, endpoint, reason = _parse_disconnect_body(
            match.group("body"),
            match.group("suffix") or "",
        )
        return {
            **base,
            "event_type": "player_disconnected",
            "player_name": name,
            "player_name_normalized": _normalize_name(name),
            "player_slot": int(match.group("slot")),
            "endpoint": endpoint,
            "disconnect_reason": reason,
        }

    # Capture Bohemia BI UUID from Game/BackendApi log lines.
    # Check the named-player variant first (carries a player name).
    match = _PLAYER_GAME_REGISTERED_RE.search(line)
    if match:
        name = match.group("name").strip()
        return {
            **base,
            "event_type": "player_uuid",
            "player_name": name,
            "player_name_normalized": _normalize_name(name),
            "player_uuid": match.group("uuid").strip().lower(),
        }
    # Anonymous UUID lines (platformId=..., uid=..., etc.)
    match = _PLAYER_UUID_RE.search(line)
    if match:
        return {
            **base,
            "event_type": "player_uuid",
            "player_uuid": match.group("uuid").strip().lower(),
        }

    return None


def parse_players_snapshot(response: str | None) -> list[dict[str, Any]]:
    players: list[dict[str, Any]] = []
    for raw_line in (response or "").splitlines():
        line = raw_line.strip()
        if not line or line.lower().startswith(("players", "---", "name")):
            continue
        reforger_row = _REFORGER_PLAYERS_ROW_RE.match(line)
        if reforger_row:
            # The RCON player number is not the BattlEye slot the logs record, so the row
            # carries no player_slot: matching uses the UID and name instead.
            name = reforger_row.group("name").strip()
            uid = reforger_row.group("uid").strip()
            players.append(
                {
                    "player_name": name,
                    "player_name_normalized": _normalize_name(name),
                    "player_uuid": uid.lower() if _UUID_RE.match(uid) else None,
                    "ping_ms": None,
                    "raw": line,
                }
            )
            continue
        if "|" in line:
            parts = [part.strip() for part in line.split("|") if part.strip()]
            if len(parts) >= 2 and parts[0].isdigit():
                ping = None
                for part in parts[2:]:
                    if part.lower().endswith("ms") and part[:-2].isdigit():
                        ping = int(part[:-2])
                        break
                players.append(
                    {
                        "player_slot": int(parts[0]),
                        "player_name": parts[1],
                        "player_name_normalized": _normalize_name(parts[1]),
                        "ping_ms": ping,
                        "raw": line,
                    }
                )
                continue
        match = _PLAYERS_ROW_RE.match(line)
        if match:
            name = match.group("name").strip()
            ping_value = match.group("ping")
            players.append(
                {
                    "player_slot": int(match.group("slot")),
                    "player_name": name,
                    "player_name_normalized": _normalize_name(name),
                    "ping_ms": int(ping_value) if ping_value else None,
                    "raw": line,
                }
            )
    return players


def _score_session_match(session: dict[str, Any], data: dict[str, Any]) -> int:
    score = 0
    if data.get("player_guid") and session.get("player_guid") == data.get("player_guid"):
        score += 100
    if data.get("player_be_guid") and session.get("player_be_guid") == data.get("player_be_guid"):
        score += 95
    if data.get("player_uuid") and session.get("player_uuid") == data.get("player_uuid"):
        score += 92
    if data.get("player_identity") and session.get("player_identity") == data.get("player_identity"):
        score += 90
    if data.get("player_slot") is not None and session.get("player_slot") == data.get("player_slot"):
        score += 70
    if data.get("player_name_normalized") and session.get("player_name_normalized") == data.get("player_name_normalized"):
        score += 50
    if data.get("endpoint") and session.get("endpoint") == data.get("endpoint"):
        score += 20
    return score


async def _find_matching_active_session(server_id: str, data: dict[str, Any]) -> Optional[dict[str, Any]]:
    lookup_keys = _build_lookup_keys(data)
    if not lookup_keys:
        return None

    sessions = await db.server_player_sessions.find(
        {
            "server_id": server_id,
            "active": True,
            "lookup_keys": {"$in": lookup_keys},
        },
        {"_id": 0},
    ).sort("updated_at", -1).to_list(20)

    if not sessions:
        return None

    ranked = sorted(
        sessions,
        key=lambda session: (_score_session_match(session, data), session.get("updated_at") or datetime.min.replace(tzinfo=timezone.utc)),
        reverse=True,
    )
    top = ranked[0]
    return top if _score_session_match(top, data) > 0 else None


def _session_update_payload(session: Optional[dict[str, Any]], data: dict[str, Any], *, now: datetime, source: str) -> dict[str, Any]:
    existing = session or {}
    payload = {
        "player_name": data.get("player_name") or existing.get("player_name"),
        "player_name_normalized": data.get("player_name_normalized")
        or existing.get("player_name_normalized")
        or _normalize_name(data.get("player_name") or existing.get("player_name")),
        "player_slot": data.get("player_slot", existing.get("player_slot")),
        "player_identity": data.get("player_identity") or existing.get("player_identity"),
        "player_guid": data.get("player_guid") or existing.get("player_guid"),
        "player_be_guid": data.get("player_be_guid") or existing.get("player_be_guid"),
        "player_uuid": data.get("player_uuid") or existing.get("player_uuid"),
        "endpoint": data.get("endpoint") or existing.get("endpoint"),
        "last_seen_at": now,
        "updated_at": now,
        "active": True,
        "source": existing.get("source") or source,
        "last_event_type": data.get("event_type") or existing.get("last_event_type"),
        "last_event_cursor": data.get("cursor") or existing.get("last_event_cursor"),
        "connected_at": existing.get("connected_at") or now,
        "connected_at_estimated": existing.get("connected_at_estimated", source == "rcon_snapshot"),
        "disconnect_reason": None,
        "disconnect_inferred": False,
        "disconnected_at": None,
    }
    payload["lookup_keys"] = _build_lookup_keys(payload)
    payload["session_identity_key"] = _best_identity_key(payload)
    connected_at = _coerce_datetime(payload.get("connected_at"))
    payload["session_duration_seconds"] = max(
        int((now - connected_at).total_seconds()),
        0,
    ) if connected_at else 0
    return payload


async def _create_session(server_id: str, data: dict[str, Any], *, now: datetime, source: str) -> dict[str, Any]:
    payload = _session_update_payload(None, data, now=now, source=source)
    session_doc = {
        "id": f"playersess_{uuid.uuid4().hex[:16]}",
        "server_id": server_id,
        "created_at": now,
        "first_event_cursor": data.get("cursor"),
        **payload,
    }
    await db.server_player_sessions.insert_one(session_doc)
    session_doc.pop("_id", None)
    return session_doc


async def _update_session(session: dict[str, Any], data: dict[str, Any], *, now: datetime, source: str) -> dict[str, Any]:
    payload = _session_update_payload(session, data, now=now, source=source)
    await db.server_player_sessions.update_one(
        {"id": session["id"]},
        {"$set": payload},
    )
    return {**session, **payload}


async def _close_session(
    session: dict[str, Any],
    *,
    disconnected_at: datetime,
    reason: str,
    inferred: bool,
    source: Optional[str] = None,
    event_type: Optional[str] = None,
    event_cursor: Optional[str] = None,
) -> None:
    connected_at = _coerce_datetime(session.get("connected_at"))
    duration = max(int((disconnected_at - connected_at).total_seconds()), 0) if connected_at else 0
    await db.server_player_sessions.update_one(
        {"id": session["id"], "active": True},
        {
            "$set": {
                "active": False,
                "disconnected_at": disconnected_at,
                "disconnect_reason": reason,
                "disconnect_inferred": inferred,
                "updated_at": disconnected_at,
                "last_seen_at": session.get("last_seen_at") or disconnected_at,
                "session_duration_seconds": duration,
                "source": source or session.get("source"),
                "last_event_type": event_type or session.get("last_event_type"),
                "last_event_cursor": event_cursor or session.get("last_event_cursor"),
            }
        },
    )


async def ingest_player_log_entry(server_id: str, entry: dict[str, Any]) -> Optional[dict[str, Any]]:
    parsed = parse_player_log_entry(entry)
    if not parsed:
        return None

    event_key = f"{server_id}:{parsed['event_type']}:{parsed.get('cursor') or stable_hash(parsed['raw'])}"
    event_doc = {
        "id": f"playerevt_{stable_hash(event_key)}",
        "event_key": event_key,
        "server_id": server_id,
        **parsed,
        "created_at": _now(),
    }

    try:
        await db.server_player_events.insert_one(event_doc)
    except DuplicateKeyError:
        return None

    now = parsed["timestamp"]
    session = await _find_matching_active_session(server_id, parsed)
    if parsed["event_type"] == "player_disconnected":
        if session:
            await _close_session(
                session,
                disconnected_at=now,
                reason=parsed.get("disconnect_reason") or "disconnected",
                inferred=False,
                source="log",
                event_type=parsed.get("event_type"),
                event_cursor=parsed.get("cursor"),
            )
        return event_doc

    if session and parsed.get("player_slot") is not None:
        session_name = _normalize_name(session.get("player_name"))
        event_name = parsed.get("player_name_normalized")
        if session.get("player_slot") == parsed.get("player_slot") and event_name and session_name and event_name != session_name:
            await _close_session(
                session,
                disconnected_at=now,
                reason="slot_reassigned",
                inferred=False,
                source="log",
                event_type=parsed.get("event_type"),
                event_cursor=parsed.get("cursor"),
            )
            session = None

    if session:
        await _update_session(session, parsed, now=now, source="log")
    else:
        await _create_session(server_id, parsed, now=now, source="log")

    return event_doc


async def ingest_recent_player_logs(server: dict[str, Any], *, tail: int = _RECENT_LOG_TAIL) -> dict[str, int]:
    entries = await get_recent_server_log_entries(server, tail=tail)
    processed = 0
    created_events = 0
    for entry in entries:
        processed += 1
        event = await ingest_player_log_entry(server["id"], entry)
        if event:
            created_events += 1
    return {"entries_scanned": processed, "events_created": created_events}


async def _fetch_live_player_snapshot(server: dict[str, Any]) -> Optional[list[dict[str, Any]]]:
    if server.get("status") != "running":
        return None

    ports = server.get("ports") or {}
    # The game logs every RCON command, so an empty server is answered from A2S instead.
    # RCON stays the source of names whenever A2S reports players or does not answer.
    info = await query_a2s_info(get_server_runtime_host(), int(ports.get("query", 17777)))
    if info and info.get("player_count") == 0:
        return []

    rcon = (server.get("config") or {}).get("rcon") or {}
    password = str(rcon.get("password") or "")
    if not password:
        return None

    success, response = await bercon_client.execute(
        host=get_server_runtime_host(),
        port=int(ports.get("rcon", 19999)),
        password=password,
        command="#players",
    )
    if not success:
        return None
    return parse_players_snapshot(response)


async def reconcile_server_player_snapshot(server: dict[str, Any]) -> dict[str, int]:
    server_id = str(server.get("id") or "")
    snapshot = await _fetch_live_player_snapshot(server)
    if snapshot is None:
        return {"snapshot_players": 0, "closed_sessions": 0}

    now = _now()
    snapshot_name_set = {
        player["player_name_normalized"]
        for player in snapshot
        if player.get("player_name_normalized")
    }

    seen_session_ids: set[str] = set()
    for player in snapshot:
        session = await _find_matching_active_session(server_id, player)
        if (
            session
            and player.get("player_slot") is not None
            and session.get("player_slot") == player.get("player_slot")
        ):
            session_name = session.get("player_name_normalized")
            snapshot_name = player.get("player_name_normalized")
            if session_name and snapshot_name and session_name != snapshot_name:
                await _close_session(
                    session,
                    disconnected_at=now,
                    reason="slot_reassigned",
                    inferred=True,
                    source="rcon_snapshot",
                )
                session = None

        if session:
            session = await _update_session(session, player, now=now, source="rcon_snapshot")
        else:
            session = await _create_session(server_id, player, now=now, source="rcon_snapshot")
        seen_session_ids.add(session["id"])

    active_sessions = await db.server_player_sessions.find(
        {"server_id": server_id, "active": True},
        {"_id": 0},
    ).to_list(500)

    # The snapshot is the authoritative list of who is online: every active session it did
    # not refresh is either a player who left or a second session for someone still here.
    closed = 0
    grace_cutoff = now - timedelta(seconds=_SNAPSHOT_GRACE_SECONDS)
    for session in active_sessions:
        if session.get("id") in seen_session_ids:
            continue
        last_seen_at = _coerce_datetime(session.get("last_seen_at")) or now
        if last_seen_at > grace_cutoff:
            continue

        session_name = session.get("player_name_normalized")
        still_online = bool(session_name) and session_name in snapshot_name_set
        await _close_session(
            session,
            disconnected_at=now,
            reason="duplicate_session" if still_online else "rcon_snapshot_absent",
            inferred=True,
            source="rcon_snapshot",
        )
        closed += 1

    return {"snapshot_players": len(snapshot), "closed_sessions": closed}


async def close_active_sessions_for_server(server_id: str, *, reason: str) -> int:
    sessions = await db.server_player_sessions.find(
        {"server_id": server_id, "active": True},
        {"_id": 0},
    ).to_list(500)
    if not sessions:
        return 0
    closed = 0
    now = _now()
    for session in sessions:
        await _close_session(
            session,
            disconnected_at=now,
            reason=reason,
            inferred=True,
            source="server_state",
        )
        closed += 1
    return closed


async def process_server_player_activity(server: dict[str, Any]) -> dict[str, int]:
    log_result = await ingest_recent_player_logs(server)
    snapshot_result = await reconcile_server_player_snapshot(server)
    return {**log_result, **snapshot_result}


async def player_tracking_loop(interval: int = 20) -> None:
    logger.info("Player tracking loop started (interval=%ss)", interval)
    while True:
        try:
            servers = await db.managed_servers.find({}, {"_id": 0}).to_list(500)
            for server in servers:
                server_id = str(server.get("id") or "")
                if not server_id:
                    continue
                try:
                    if server.get("status") == "running":
                        await process_server_player_activity(server)
                    else:
                        await close_active_sessions_for_server(
                            server_id,
                            reason=f"server_{server.get('status') or 'offline'}",
                        )
                except Exception as exc:
                    logger.warning(
                        "Player tracking failed for server %s: %s",
                        server_id,
                        exc,
                    )
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Player tracking loop error: %s", exc)
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                break
    logger.info("Player tracking loop stopped")


async def get_server_player_overview(server_id: str, *, session_limit: int = 100) -> dict[str, Any]:
    now = _now()
    cutoff = now - timedelta(hours=24)

    active_players = await db.server_player_sessions.find(
        {"server_id": server_id, "active": True},
        {"_id": 0},
    ).sort("connected_at", -1).to_list(200)

    recent_sessions = await db.server_player_sessions.find(
        {
            "server_id": server_id,
            "$or": [
                {"active": True},
                {"disconnected_at": {"$gte": cutoff}},
                {"connected_at": {"$gte": cutoff}},
            ],
        },
        {"_id": 0},
    ).sort("updated_at", -1).limit(session_limit).to_list(session_limit)

    completed_sessions = await db.server_player_sessions.find(
        {
            "server_id": server_id,
            "active": False,
            "disconnected_at": {"$gte": cutoff},
            "session_duration_seconds": {"$gt": 0},
        },
        {"_id": 0, "session_duration_seconds": 1},
    ).to_list(2000)

    avg_session_seconds = None
    if completed_sessions:
        durations = [int(item.get("session_duration_seconds") or 0) for item in completed_sessions]
        if durations:
            avg_session_seconds = int(sum(durations) / len(durations))

    unique_identities = await db.server_player_sessions.distinct(
        "session_identity_key",
        {
            "server_id": server_id,
            "$or": [
                {"connected_at": {"$gte": cutoff}},
                {"disconnected_at": {"$gte": cutoff}},
                {"last_seen_at": {"$gte": cutoff}},
            ],
        },
    )

    metrics_peak = await db.server_metrics.find_one(
        {"server_id": server_id, "timestamp": {"$gte": cutoff}},
        {"_id": 0, "player_count": 1},
        sort=[("player_count", -1)],
    )
    peak_today = max(
        len(active_players),
        int((metrics_peak or {}).get("player_count") or 0),
    )

    def _serialize_session(session: dict[str, Any]) -> dict[str, Any]:
        connected_at = _coerce_datetime(session.get("connected_at"))
        if session.get("active") and connected_at:
            duration = max(int((now - connected_at).total_seconds()), 0)
        else:
            duration = int(session.get("session_duration_seconds") or 0)
        return {
            **session,
            "status": "active" if session.get("active") else "disconnected",
            "session_duration_seconds": duration,
        }

    serialized_active = [_serialize_session(session) for session in active_players]
    serialized_sessions = [_serialize_session(session) for session in recent_sessions]
    latest_update = max(
        [
            _coerce_datetime(item.get("updated_at"))
            for item in [*active_players, *recent_sessions]
            if _coerce_datetime(item.get("updated_at")) is not None
        ] or [now]
    )

    return {
        "server_id": server_id,
        "summary": {
            "online": len(serialized_active),
            "peak_today": peak_today,
            "avg_session_seconds": avg_session_seconds,
            "unique_24h": len([key for key in unique_identities if key]),
        },
        "active_players": serialized_active,
        "sessions": serialized_sessions,
        "updated_at": latest_update,
    }
