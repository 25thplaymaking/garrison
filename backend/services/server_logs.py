"""Unified server log aggregation across Docker, profile files, and RCON events."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

from database import db
from services.docker_agent import DockerAgent

logger = logging.getLogger(__name__)

docker_agent = DockerAgent()

_ISO_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
_NANO_FRAC_RE = re.compile(r"(\.\d{6})\d+")
_PROFILE_LOG_PATTERNS = (
    "console.log",
    "console*.log",
    "backend*.log",
    "*.rpt",
)
_THERMAL_PROFILE_LOOKUP_RE = re.compile(
    r'\bRESOURCES\s*:\s*GetResourceObject\s+@\s*"?'
    r'\{CC547D988287BF7C\}system/thermal/thermalProfileDefault\.conf"?\s*$',
    re.IGNORECASE,
)
_RESOURCE_FAILED_OPEN_RE = re.compile(
    r"\bRESOURCES\s*\(E\)\s*:\s*Failed to open\s*$",
    re.IGNORECASE,
)


class KnownLogNoiseFilter:
    """Suppress the stock dedicated-server thermal-profile warning pair.

    The second line is intentionally matched only when it immediately follows
    the exact thermal-profile lookup. Other resource failures stay visible.
    Instances retain that one-line pairing state across streamed chunks.
    """

    def __init__(self) -> None:
        self._awaiting_thermal_failed_open = False

    def should_suppress(self, raw_line: str) -> bool:
        if not raw_line.strip():
            return False

        if _THERMAL_PROFILE_LOOKUP_RE.search(raw_line):
            self._awaiting_thermal_failed_open = True
            return True

        suppress = (
            self._awaiting_thermal_failed_open
            and _RESOURCE_FAILED_OPEN_RE.search(raw_line) is not None
        )
        self._awaiting_thermal_failed_open = False
        return suppress


def stable_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:8]


def parse_log_since(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        normalized = _NANO_FRAC_RE.sub(r"\1", value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        return int(parsed.timestamp())
    except ValueError:
        return None


def parse_log_timestamp(value: Optional[str]) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    try:
        normalized = _NANO_FRAC_RE.sub(r"\1", value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def _source_label(source: str, path: str = "") -> str:
    if not path:
        return source
    return f"{source}:{Path(path).name}"


def _source_for_path(path: Path) -> str:
    name = path.name.lower()
    if "backend" in name:
        return "backend"
    if name.endswith(".rpt"):
        return "engine"
    if name.startswith("console"):
        return "console"
    return "profile"


def build_log_entry(
    raw_line: str,
    fallback_index: int,
    *,
    source: str = "docker",
    source_path: str = "",
    cursor_hint: str = "",
    fallback_timestamp: Optional[str] = None,
) -> dict:
    timestamp = None
    line = raw_line
    if " " in raw_line:
        possible_ts, possible_line = raw_line.split(" ", 1)
        if _ISO_TS_RE.match(possible_ts):
            timestamp = possible_ts
            line = possible_line
    timestamp = timestamp or fallback_timestamp or datetime.now(timezone.utc).isoformat()
    source_name = _source_label(source, source_path)
    cursor_parts = [source_name]
    if source_path:
        cursor_parts.append(source_path)
    cursor_parts.append(timestamp)
    cursor_parts.append(cursor_hint or str(fallback_index))
    cursor_parts.append(stable_hash(raw_line))
    cursor = "|".join(cursor_parts)
    return {
        "cursor": cursor,
        "timestamp": timestamp,
        "line": line,
        "raw": raw_line,
        "source": source_name,
        "stream": source_name,
        "path": source_path,
    }


def build_log_entries(
    logs: str,
    *,
    source: str = "docker",
    source_path: str = "",
    start_index: int = 0,
    cursor_prefix: str = "",
    fallback_timestamp: Optional[str] = None,
    noise_filter: Optional[KnownLogNoiseFilter] = None,
) -> list[dict]:
    active_noise_filter = noise_filter or KnownLogNoiseFilter()
    entries: list[dict] = []
    for index, raw_line in enumerate((logs or "").splitlines()):
        if not raw_line.strip() or active_noise_filter.should_suppress(raw_line):
            continue
        entries.append(
            build_log_entry(
                raw_line,
                start_index + index,
                source=source,
                source_path=source_path,
                cursor_hint=f"{cursor_prefix}{start_index + index}" if cursor_prefix else str(start_index + index),
                fallback_timestamp=fallback_timestamp,
            )
        )
    return entries


# Read only a bounded tail window of a log file instead of the whole file.
# Profile logs can grow to tens of GB (a mod error loop once produced a 20 GB
# crash.log); reading them fully ballooned the backend to ~95 GB and OOM-killed
# it. The window is generous enough to always contain `tail` lines after noise
# filtering. Line numbers are relative to the window — the cursor also carries
# the per-line timestamp and raw hash, so dedup stays correct.
_TAIL_READ_WINDOW_BYTES = 16 * 1024 * 1024


def _read_recent_file_records(path: Path, tail: int) -> list[tuple[int, str]]:
    try:
        size = path.stat().st_size
        if size == 0:
            return []
        read_size = min(size, _TAIL_READ_WINDOW_BYTES)
        with open(path, "rb") as handle:
            if read_size < size:
                handle.seek(size - read_size)
            data = handle.read(read_size)
    except OSError:
        return []
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    # When reading only a tail window, the first line is likely a partial line
    # cut mid-way — drop it so we never emit a truncated record.
    if read_size < size and lines:
        lines = lines[1:]
    lines = [line for line in lines if line.strip()]
    noise_filter = KnownLogNoiseFilter()
    records = [
        (index, line)
        for index, line in enumerate(lines)
        if not noise_filter.should_suppress(line)
    ]
    return records[-tail:] if tail > 0 else records


def _count_file_lines(path: Path) -> int:
    try:
        count = 0
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                count += chunk.count(b"\n")
        return count
    except OSError:
        return 0


def discover_log_files(server: Dict[str, Any]) -> list[Path]:
    profile_root = Path(str(server.get("profile_path") or ""))
    if not profile_root.exists():
        return []
    matches: dict[str, Path] = {}
    for pattern in _PROFILE_LOG_PATTERNS:
        try:
            for match in profile_root.rglob(pattern):
                if match.is_file():
                    matches[str(match.resolve())] = match
        except OSError:
            continue
    return sorted(
        matches.values(),
        key=lambda item: item.stat().st_mtime if item.exists() else 0,
        reverse=True,
    )[:8]


async def _read_profile_log_entries(server: Dict[str, Any], tail: int, since: Optional[int]) -> list[dict]:
    files = await asyncio.to_thread(discover_log_files, server)
    entries: list[dict] = []
    for path in files:
        try:
            stat = await asyncio.to_thread(path.stat)
        except OSError:
            continue
        records = await asyncio.to_thread(_read_recent_file_records, path, tail)
        fallback_timestamp = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        file_entries = [
            build_log_entry(
                raw_line,
                line_number,
                source=_source_for_path(path),
                source_path=str(path),
                cursor_hint=f"L{line_number}",
                fallback_timestamp=fallback_timestamp,
            )
            for line_number, raw_line in records
        ]
        if since is not None:
            file_entries = [
                entry for entry in file_entries
                if parse_log_timestamp(entry["timestamp"]).timestamp() >= since
            ]
        entries.extend(file_entries)
    return entries


async def _read_rcon_log_entries(server_id: str, since: Optional[int], limit: int) -> list[dict]:
    query: Dict[str, Any] = {"server_id": server_id}
    if since is not None:
        query["timestamp"] = {"$gte": datetime.fromtimestamp(since, tz=timezone.utc)}
    docs = await db.server_log_events.find(query, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    docs.reverse()
    entries: list[dict] = []
    noise_filter = KnownLogNoiseFilter()
    for doc in docs:
        line = doc.get("line") or ""
        if not line or noise_filter.should_suppress(line):
            continue
        entries.append(
            {
                "cursor": doc.get("cursor") or f"rcon|{doc.get('id')}",
                "timestamp": doc.get("timestamp").isoformat() if isinstance(doc.get("timestamp"), datetime) else str(doc.get("timestamp") or datetime.now(timezone.utc).isoformat()),
                "line": line,
                "raw": doc.get("raw") or line,
                "source": doc.get("source") or "rcon",
                "stream": doc.get("source") or "rcon",
                "path": "",
            }
        )
    return entries


def _sort_entries(entries: list[dict]) -> list[dict]:
    return sorted(
        entries,
        key=lambda entry: (
            parse_log_timestamp(entry.get("timestamp")).timestamp(),
            entry.get("cursor") or "",
        ),
    )


async def get_recent_server_log_entries(
    server: Dict[str, Any],
    *,
    tail: int = 200,
    since: Optional[int] = None,
) -> list[dict]:
    container_name = server.get("container_name") or server.get("name", "")
    # Fetch one preceding line so a tail boundary cannot orphan the generic
    # second half of the known thermal-profile warning pair.
    docker_tail = tail + 1 if tail > 0 else tail
    docker_logs = await docker_agent.get_container_logs(container_name, tail=docker_tail, since=since)
    docker_entries = build_log_entries(docker_logs, source="docker")
    profile_entries = await _read_profile_log_entries(server, tail=tail, since=since)
    rcon_entries = await _read_rcon_log_entries(str(server.get("id") or ""), since, tail)
    merged = _sort_entries([*docker_entries, *profile_entries, *rcon_entries])
    if tail > 0:
        return merged[-tail:]
    return merged


async def get_recent_server_log_text(
    server: Dict[str, Any],
    *,
    tail: int = 200,
    since: Optional[int] = None,
) -> str:
    entries = await get_recent_server_log_entries(server, tail=tail, since=since)
    return "\n".join(entry.get("raw") or entry.get("line") or "" for entry in entries)


async def record_server_log_event(
    server_id: str,
    *,
    line: str,
    source: str = "rcon",
    raw: str = "",
    metadata: Optional[dict] = None,
) -> dict:
    timestamp = datetime.now(timezone.utc)
    payload = {
        "id": f"logevt_{stable_hash(f'{server_id}|{timestamp.isoformat()}|{line}')}",
        "server_id": server_id,
        "timestamp": timestamp,
        "source": source,
        "line": line,
        "raw": raw or line,
        "metadata": metadata or {},
    }
    payload["cursor"] = f"{source}|{timestamp.isoformat()}|{stable_hash(payload['raw'])}"
    await db.server_log_events.insert_one(payload)
    return payload


async def capture_log_snapshot(
    server: Dict[str, Any],
    trigger_line: str = "",
    *,
    context_lines: int = 8,
    tail: int = 200,
) -> List[dict]:
    """Capture a contextual snapshot of logs around a trigger line.

    Returns a list of log entries with a ``is_trigger`` marker on entries
    matching *trigger_line*.  If *trigger_line* is empty the most recent
    *context_lines* entries are returned as a general snapshot.
    """
    entries = await get_recent_server_log_entries(server, tail=tail)
    if not entries:
        return []

    if not trigger_line:
        snapshot_entries = entries[-context_lines:]
        return [
            {
                "line": e.get("line") or e.get("raw") or "",
                "timestamp": e.get("timestamp") or "",
                "source": e.get("source") or "unknown",
                "is_trigger": False,
            }
            for e in snapshot_entries
        ]

    trigger_lower = trigger_line.lower()
    trigger_indices: List[int] = []
    for idx, entry in enumerate(entries):
        text = (entry.get("line") or entry.get("raw") or "").lower()
        if trigger_lower in text:
            trigger_indices.append(idx)

    if not trigger_indices:
        return [
            {
                "line": e.get("line") or e.get("raw") or "",
                "timestamp": e.get("timestamp") or "",
                "source": e.get("source") or "unknown",
                "is_trigger": False,
            }
            for e in entries[-context_lines:]
        ]

    last_trigger = trigger_indices[-1]
    start = max(0, last_trigger - context_lines)
    end = min(len(entries), last_trigger + context_lines + 1)

    return [
        {
            "line": entries[i].get("line") or entries[i].get("raw") or "",
            "timestamp": entries[i].get("timestamp") or "",
            "source": entries[i].get("source") or "unknown",
            "is_trigger": i in trigger_indices,
        }
        for i in range(start, end)
    ]


async def probe_source_availability(
    server: Dict[str, Any],
) -> Dict[str, Dict[str, Any]]:
    """Check availability of each log source without actually streaming.

    Returns a dict like::

        {
            "docker":  {"available": True},
            "profile": {"available": False, "reason": "path_not_found"},
            "rcon":    {"available": True},
        }
    """
    sources: Dict[str, Dict[str, Any]] = {}

    # --- Docker ---
    container_name = server.get("container_name") or server.get("name", "")
    if not container_name:
        sources["docker"] = {"available": False, "reason": "no_container_name"}
    else:
        docker_available, err = await docker_agent.ping()
        if not docker_available:
            if err:
                logger.warning("Docker ping failed during source availability probe: %s", err)
            sources["docker"] = {"available": False, "reason": "docker_unavailable"}
        else:
            container = await docker_agent.get_container(container_name)
            if container is None:
                sources["docker"] = {"available": False, "reason": "container_not_found"}
            else:
                sources["docker"] = {"available": True}

    # --- Profile files ---
    profile_path = server.get("profile_path") or ""
    if not profile_path:
        sources["profile"] = {"available": False, "reason": "no_profile_path"}
    else:
        p = Path(str(profile_path))
        if not p.exists():
            sources["profile"] = {"available": False, "reason": "path_not_found"}
        elif not p.is_dir():
            sources["profile"] = {"available": False, "reason": "not_a_directory"}
        else:
            files = await asyncio.to_thread(discover_log_files, server)
            if files:
                sources["profile"] = {"available": True, "file_count": len(files)}
            else:
                sources["profile"] = {"available": False, "reason": "no_log_files"}

    # --- RCON events ---
    server_id = str(server.get("id") or "")
    try:
        count = await db.server_log_events.count_documents({"server_id": server_id}, limit=1)
        sources["rcon"] = {"available": True, "has_events": count > 0}
    except Exception as exc:
        logger.warning("Failed to probe RCON event availability for server %s", server_id, exc_info=exc)
        sources["rcon"] = {"available": False, "reason": "db_error"}

    return sources


async def stream_server_log_entries(
    server: Dict[str, Any],
    *,
    since: Optional[int] = None,
    tail: int = 0,
) -> AsyncIterator[dict]:
    server_id = str(server.get("id") or "")
    container_name = server.get("container_name") or server.get("name", "")
    queue: asyncio.Queue[Optional[dict]] = asyncio.Queue(maxsize=1024)
    stop_event = asyncio.Event()

    if tail > 0:
        for entry in await get_recent_server_log_entries(server, tail=tail, since=since):
            yield entry

    async def _queue_put_safe(entry: dict) -> None:
        """Put an entry on the queue with a timeout to prevent indefinite blocking."""
        try:
            await asyncio.wait_for(queue.put(entry), timeout=5.0)
        except asyncio.TimeoutError:
            logger.debug("Queue put timeout for server %s – dropping entry", server_id)

    _DOCKER_MAX_BACKOFF = 30.0
    _DOCKER_BACKOFF_BASE = 1.0
    _DOCKER_BACKOFF_CAP_EXP = 5
    # Delay between restarts after Docker container stops/restarts (seconds).
    _DOCKER_RESTART_DELAY = 3.0

    async def pump_docker() -> None:
        """Stream Docker container logs. Restarts automatically when the container
        stops/restarts so Docker logs resume after a server reboot without
        recreating the entire stream session."""
        error_count = 0
        noise_filter = KnownLogNoiseFilter()
        while not stop_event.is_set():
            try:
                # Re-probe on each attempt so Docker/container restarts are handled.
                docker_available, err = await docker_agent.ping()
                if not docker_available:
                    logger.warning(
                        "Docker unavailable for server %s (will retry): %s",
                        server_id, err,
                    )
                    error_count += 1
                    await asyncio.sleep(min(_DOCKER_MAX_BACKOFF, _DOCKER_BACKOFF_BASE * (2 ** min(error_count, _DOCKER_BACKOFF_CAP_EXP))))
                    continue

                container = await docker_agent.get_container(container_name)
                if container is None:
                    logger.warning(
                        "Container '%s' not found for server %s (will retry)",
                        container_name, server_id,
                    )
                    error_count += 1
                    await asyncio.sleep(min(30.0, _DOCKER_BACKOFF_BASE * (2 ** min(error_count, 4))))
                    continue

                # Connection re-established — reset error back-off.
                error_count = 0
                async for chunk in docker_agent.stream_container_logs(container_name, tail=0, since=since):
                    for entry in build_log_entries(
                        chunk,
                        source="docker",
                        noise_filter=noise_filter,
                    ):
                        await _queue_put_safe(entry)

                # Stream ended normally (container stopped/restarted).
                # Wait a moment and loop back to reconnect.
                if not stop_event.is_set():
                    logger.info(
                        "Docker log stream ended for server %s container=%s — reconnecting in %.1fs",
                        server_id, container_name, _DOCKER_RESTART_DELAY,
                    )
                    await asyncio.sleep(_DOCKER_RESTART_DELAY)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                error_count += 1
                backoff = min(
                    _DOCKER_MAX_BACKOFF,
                    _DOCKER_BACKOFF_BASE * (2 ** min(error_count, _DOCKER_BACKOFF_CAP_EXP)),
                )
                logger.warning(
                    "Docker log pump error for %s (attempt %d): %s – retrying in %.1fs",
                    server_id, error_count, exc, backoff,
                )
                await asyncio.sleep(backoff)

    async def pump_profile_files() -> None:
        positions: dict[str, dict[str, int]] = {}
        noise_filters: dict[str, KnownLogNoiseFilter] = {}
        files: list[Path] = []
        last_discovery: float = 0.0
        _DISCOVERY_INTERVAL = 10.0
        _MAX_DELTA_READ_BYTES = 1024 * 1024  # 1MB max per tick per file
        loop = asyncio.get_running_loop()

        while not stop_event.is_set():
            try:
                now = loop.time()
                if now - last_discovery >= _DISCOVERY_INTERVAL:
                    files = await asyncio.to_thread(discover_log_files, server)
                    last_discovery = now

                for path in files:
                    path_str = str(path)
                    try:
                        stat = path.stat()
                    except OSError:
                        continue
                    current = positions.get(path_str)
                    if current is None:
                        positions[path_str] = {
                            "byte": stat.st_size,
                            "line": await asyncio.to_thread(_count_file_lines, path),
                        }
                        continue

                    previous_byte = current.get("byte", stat.st_size)
                    previous_line = current.get("line", 0)
                    noise_filter = noise_filters.setdefault(path_str, KnownLogNoiseFilter())
                    if stat.st_size < previous_byte:
                        previous_byte = 0
                        previous_line = 0
                        noise_filter = KnownLogNoiseFilter()
                        noise_filters[path_str] = noise_filter
                    if stat.st_size > previous_byte:
                        def _read_delta() -> tuple[str, int]:
                            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                                handle.seek(previous_byte)
                                content = handle.read(_MAX_DELTA_READ_BYTES)
                                return content, handle.tell()

                        chunk, new_byte = await asyncio.to_thread(_read_delta)
                        delta_lines = [line for line in chunk.splitlines() if line.strip()]
                        fallback_timestamp = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
                        for index, raw_line in enumerate(delta_lines):
                            line_number = previous_line + index
                            if noise_filter.should_suppress(raw_line):
                                continue
                            entry = build_log_entry(
                                raw_line,
                                line_number,
                                source=_source_for_path(path),
                                source_path=path_str,
                                cursor_hint=f"L{line_number}",
                                fallback_timestamp=fallback_timestamp,
                            )
                            await _queue_put_safe(entry)
                        positions[path_str] = {"byte": new_byte, "line": previous_line + len(delta_lines)}
                    else:
                        positions[path_str] = {"byte": stat.st_size, "line": previous_line}
            except Exception as exc:
                logger.debug("Profile log pump error for %s: %s", server_id, exc)
            await asyncio.sleep(0.2)

    async def pump_rcon_events() -> None:
        last_seen = since
        seen_cursors: set[str] = set()
        seen_order: deque[str] = deque(maxlen=2000)
        while not stop_event.is_set():
            try:
                entries = await _read_rcon_log_entries(server_id, last_seen, 200)
                for entry in entries:
                    cursor = entry.get("cursor") or ""
                    if cursor in seen_cursors:
                        continue
                    ts = int(parse_log_timestamp(entry["timestamp"]).timestamp())
                    if last_seen is not None and ts < last_seen:
                        continue
                    await _queue_put_safe(entry)
                    if cursor:
                        seen_cursors.add(cursor)
                        seen_order.append(cursor)
                        # Trim deterministically by insertion order to avoid
                        # unbounded growth and non-deterministic set slicing.
                        while len(seen_order) > 1500:
                            old_cursor = seen_order.popleft()
                            seen_cursors.discard(old_cursor)
                    last_seen = max(last_seen or 0, ts)
            except Exception as exc:
                logger.debug("RCON log pump error for %s: %s", server_id, exc)
            await asyncio.sleep(0.2)

    tasks = [
        asyncio.create_task(pump_docker()),
        asyncio.create_task(pump_profile_files()),
        asyncio.create_task(pump_rcon_events()),
    ]

    try:
        while True:
            entry = await queue.get()
            if entry is None:
                break
            yield entry
    finally:
        stop_event.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
