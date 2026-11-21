import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from database import db
from services.realtime_hub import notify
from services.a2s_query import query_a2s_info
from services.docker_agent import DockerAgent
from services.server_logs import get_recent_server_log_text
from services.server_runtime_host import get_server_runtime_host

logger = logging.getLogger(__name__)

docker_agent = DockerAgent()

_PERIOD_DELTAS = {
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}

_RESOLUTION_SECONDS = {
    "1m": 60,
    "5m": 300,
    "1h": 3600,
}

_FPS_PATTERNS = [
    re.compile(r"\bfps\b[^0-9]{0,8}(\d+(?:\.\d+)?)", re.IGNORECASE),
    re.compile(r"\bavgfps\b[^0-9]{0,8}(\d+(?:\.\d+)?)", re.IGNORECASE),
]

_LOGSTATS_PLAYER_PATTERN = re.compile(r"\bPlayer:\s*(\d+)", re.IGNORECASE)
_LOGSTATS_AI_PATTERN = re.compile(r"\bAI:\s*(\d+)", re.IGNORECASE)
_LOGSTATS_VEHICLE_PATTERN = re.compile(r"\bVeh:\s*(\d+)", re.IGNORECASE)

# Servers write a logStats sample once a minute (reforger_orchestrator.LOG_STATS_INTERVAL_MS),
# while metrics are collected every 15s, so most collections reuse the last sample.
LOGSTATS_SAMPLE_MAX_AGE_SECONDS = 150
_last_logstats: Dict[str, tuple[float, dict]] = {}


def _parse_started_at(value: str | None) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _average(values: list[float | int | None]) -> Optional[float]:
    numeric = [float(value) for value in values if value is not None]
    if not numeric:
        return None
    return sum(numeric) / len(numeric)


async def _collect_a2s_metrics(server: dict) -> dict:
    ports = server.get("ports") or {}
    response = await query_a2s_info(get_server_runtime_host(), int(ports.get("query", 17777)))
    if not response:
        return {}
    return {
        "player_count": response.get("player_count"),
        "max_players": response.get("max_players"),
        "server_name": response.get("name"),
        "current_map": response.get("map"),
        "version": response.get("version"),
    }


def _log_stats_enabled(server: dict) -> bool:
    explicit = server.get("log_stats_enabled")
    if explicit is True:
        return True
    if explicit is False:
        return False
    startup_parameters = server.get("startup_parameters")
    if not isinstance(startup_parameters, list):
        startup_parameters = ((server.get("config") or {}).get("startupParameters") or [])
    for param in startup_parameters or []:
        if isinstance(param, str) and "logstats" in param.lower():
            return True
    return False


async def _collect_fps_metric(server: dict, container_name: str) -> dict:
    if not _log_stats_enabled(server):
        return {}

    logs = await get_recent_server_log_text(server, tail=400) or ""

    last_fps: Optional[float] = None
    last_player_count: Optional[int] = None
    last_ai_count: Optional[int] = None
    last_vehicle_count: Optional[int] = None

    for line in logs.splitlines():
        for pattern in _FPS_PATTERNS:
            match = pattern.search(line)
            if match:
                try:
                    last_fps = float(match.group(1))
                except (TypeError, ValueError):
                    continue
        m = _LOGSTATS_PLAYER_PATTERN.search(line)
        if m:
            try:
                last_player_count = int(m.group(1))
            except (TypeError, ValueError):
                pass
        m = _LOGSTATS_AI_PATTERN.search(line)
        if m:
            try:
                last_ai_count = int(m.group(1))
            except (TypeError, ValueError):
                pass
        m = _LOGSTATS_VEHICLE_PATTERN.search(line)
        if m:
            try:
                last_vehicle_count = int(m.group(1))
            except (TypeError, ValueError):
                pass

    result: dict = {}
    if last_fps is not None:
        result["server_fps"] = round(last_fps, 2)
    if last_player_count is not None:
        result["logstats_player_count"] = last_player_count
    if last_ai_count is not None:
        result["ai_count"] = last_ai_count
    if last_vehicle_count is not None:
        result["vehicle_count"] = last_vehicle_count

    server_id = str(server.get("id") or container_name)
    now = time.monotonic()
    if last_fps is not None:
        _last_logstats[server_id] = (now, result)
        return result
    cached = _last_logstats.get(server_id)
    if cached and now - cached[0] < LOGSTATS_SAMPLE_MAX_AGE_SECONDS:
        return dict(cached[1])
    return result


async def collect_server_metrics(server: dict) -> Optional[dict]:
    server_id = server.get("id", "")
    container_name = server.get("container_name") or server.get("name", server_id)
    logger.debug("Collecting metrics for server=%s container=%s", server_id, container_name)
    stats = await docker_agent.get_container_stats(container_name)
    if stats is None:
        logger.warning("No stats returned for server %s (%s)", server_id, container_name)
        return None

    details = await docker_agent.inspect_container(container_name)
    started_at = _parse_started_at((details or {}).get("started_at"))
    uptime_seconds = int((datetime.now(timezone.utc) - started_at).total_seconds()) if started_at else None
    game_config = (server.get("config") or {}).get("game") or {}

    # Player count comes from A2S, not RCON: the game logs every RCON command it receives.
    a2s_metrics: dict = {}
    fps_metrics: dict = {}
    try:
        a2s_metrics = await _collect_a2s_metrics(server)
    except Exception as exc:
        logger.debug("A2S metrics collection failed for %s: %s", server_id, exc)
    try:
        fps_metrics = await _collect_fps_metric(server, container_name)
    except Exception as exc:
        logger.debug("FPS metrics collection failed for %s: %s", server_id, exc)

    player_count = a2s_metrics.get("player_count")
    if player_count is None:
        player_count = fps_metrics.get("logstats_player_count")
    max_players = game_config.get("maxPlayers") or a2s_metrics.get("max_players")
    # Reforger's `#players` reports no ping, so there is no source for it.
    avg_player_ping_ms = None
    server_fps = fps_metrics.get("server_fps")
    ai_count = fps_metrics.get("ai_count")
    vehicle_count = fps_metrics.get("vehicle_count")

    doc = {
        "server_id": server_id,
        "timestamp": datetime.now(timezone.utc),
        "cpu_percent": stats["cpu_host_percent"],
        "cpu_host_percent": stats["cpu_host_percent"],
        "cpu_raw_percent": stats["cpu_raw_percent"],
        "cpu_cores_used": stats["cpu_cores_used"],
        "cpu_core_count": stats["cpu_core_count"],
        "memory_mb": stats["memory_mb"],
        "memory_limit_mb": stats["memory_limit_mb"],
        "network_rx_bytes": stats["network_rx"],
        "network_tx_bytes": stats["network_tx"],
        "player_count": player_count,
        "max_players": max_players,
        "ai_count": ai_count,
        "vehicle_count": vehicle_count,
        "uptime_seconds": uptime_seconds,
        "server_fps": server_fps,
        "avg_player_ping_ms": avg_player_ping_ms,
        "fps": server_fps,
        "ping": avg_player_ping_ms,
        "server_name": a2s_metrics.get("server_name") or server.get("name"),
        "current_map": a2s_metrics.get("current_map"),
        "version": a2s_metrics.get("version"),
        "metric_sources": {
            "cpu": "docker",
            "memory": "docker",
            "network_rx_bytes": "docker",
            "network_tx_bytes": "docker",
            "player_count": "a2s" if a2s_metrics.get("player_count") is not None else ("logStats" if fps_metrics.get("logstats_player_count") is not None else None),
            "avg_player_ping_ms": None,
            "server_fps": "logStats" if server_fps is not None else None,
            "ai_count": "logStats" if ai_count is not None else None,
            "vehicle_count": "logStats" if vehicle_count is not None else None,
            "server_name": "a2s" if a2s_metrics.get("server_name") else None,
            "current_map": "a2s" if a2s_metrics.get("current_map") else None,
        },
    }

    previous = await db.server_metrics.find_one(
        {"server_id": doc["server_id"]},
        {"_id": 0, "current_map": 1, "player_count": 1},
        sort=[("timestamp", -1)],
    )
    await db.server_metrics.insert_one(doc)
    # Push a hint when the member-visible live state actually changed, so the
    # Now Playing panel updates instantly without per-client fast polling.
    if not previous or (
        previous.get("current_map") != doc.get("current_map")
        or previous.get("player_count") != doc.get("player_count")
    ):
        notify("game", "status", {"server_id": doc["server_id"]})
    return doc


async def metrics_collection_loop(interval: int = 15):
    logger.info("Metrics collection loop started (interval=%ds)", interval)

    while True:
        try:
            servers = await db.managed_servers.find({"status": "running"}, {"_id": 0}).to_list(500)
            for server in servers:
                server_name = server.get("name", server.get("id", "unknown"))
                try:
                    await collect_server_metrics(server)
                except Exception as exc:
                    logger.warning("Metrics collection failed for %s: %s", server_name, exc)
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Metrics collection loop error: %s", exc)
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                break

    logger.info("Metrics collection loop stopped")


async def get_metrics_summary(server_id: str) -> dict:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)

    latest = await db.server_metrics.find_one(
        {"server_id": server_id},
        {"_id": 0},
        sort=[("timestamp", -1)],
    )

    recent = await db.server_metrics.find(
        {"server_id": server_id, "timestamp": {"$gte": cutoff}},
        {"_id": 0},
    ).to_list(10_000)

    if not recent:
        return {"server_id": server_id, "latest": latest, "trend_24h": None}

    avg_cpu = _average([d.get("cpu_host_percent", d.get("cpu_percent")) for d in recent])
    avg_cpu_raw = _average([d.get("cpu_raw_percent") for d in recent])
    avg_memory = _average([d.get("memory_mb") for d in recent])
    avg_ping = _average([d.get("avg_player_ping_ms") for d in recent])
    avg_fps = _average([d.get("server_fps") for d in recent])
    avg_ai = _average([d.get("ai_count") for d in recent])
    avg_vehicle = _average([d.get("vehicle_count") for d in recent])
    player_counts = [d.get("player_count") or 0 for d in recent]

    return {
        "server_id": server_id,
        "latest": latest,
        "trend_24h": {
            "avg_cpu_percent": round(avg_cpu, 2) if avg_cpu is not None else None,
            "avg_cpu": round(avg_cpu, 2) if avg_cpu is not None else None,
            "avg_cpu_raw_percent": round(avg_cpu_raw, 2) if avg_cpu_raw is not None else None,
            "avg_memory_mb": round(avg_memory, 2) if avg_memory is not None else None,
            "avg_memory": round(avg_memory, 2) if avg_memory is not None else None,
            "avg_player_ping_ms": round(avg_ping, 2) if avg_ping is not None else None,
            "avg_server_fps": round(avg_fps, 2) if avg_fps is not None else None,
            "avg_ai_count": round(avg_ai, 1) if avg_ai is not None else None,
            "avg_vehicle_count": round(avg_vehicle, 1) if avg_vehicle is not None else None,
            "min_player_count": min(player_counts),
            "max_player_count": max(player_counts),
            "sample_count": len(recent),
        },
    }


async def get_metrics_range(server_id: str, period: str = "1h", resolution: str = "raw") -> list:
    delta = _PERIOD_DELTAS.get(period, timedelta(hours=1))
    cutoff = datetime.now(timezone.utc) - delta
    base_match = {"server_id": server_id, "timestamp": {"$gte": cutoff}}

    if resolution == "raw":
        newest = await db.server_metrics.find(base_match, {"_id": 0}).sort("timestamp", -1).to_list(10_000)
        return list(reversed(newest))

    bucket_seconds = _RESOLUTION_SECONDS.get(resolution)
    if bucket_seconds is None:
        logger.warning("Unknown resolution %r, falling back to raw", resolution)
        newest = await db.server_metrics.find(base_match, {"_id": 0}).sort("timestamp", -1).to_list(10_000)
        return list(reversed(newest))

    pipeline: List[Dict] = [
        {"$match": base_match},
        {"$sort": {"timestamp": 1}},
        {
            "$group": {
                "_id": {
                    "$subtract": [
                        {"$toLong": "$timestamp"},
                        {"$mod": [{"$toLong": "$timestamp"}, bucket_seconds * 1000]},
                    ]
                },
                "timestamp": {"$first": "$timestamp"},
                "avg_cpu_percent": {"$avg": "$cpu_host_percent"},
                "avg_cpu_raw_percent": {"$avg": "$cpu_raw_percent"},
                "avg_memory_mb": {"$avg": "$memory_mb"},
                "max_memory_mb": {"$max": "$memory_mb"},
                "memory_limit_mb": {"$last": "$memory_limit_mb"},
                "max_network_rx_bytes": {"$max": "$network_rx_bytes"},
                "max_network_tx_bytes": {"$max": "$network_tx_bytes"},
                "max_player_count": {"$max": "$player_count"},
                "avg_player_count": {"$avg": "$player_count"},
                "avg_player_ping_ms": {"$avg": "$avg_player_ping_ms"},
                "avg_server_fps": {"$avg": "$server_fps"},
                "avg_ai_count": {"$avg": "$ai_count"},
                "avg_vehicle_count": {"$avg": "$vehicle_count"},
                "uptime_seconds": {"$last": "$uptime_seconds"},
                "cpu_cores_used": {"$avg": "$cpu_cores_used"},
                "cpu_core_count": {"$last": "$cpu_core_count"},
                "max_players": {"$max": "$max_players"},
                "sample_count": {"$sum": 1},
            }
        },
        {"$sort": {"timestamp": 1}},
        {
            "$project": {
                "_id": 0,
                "server_id": server_id,
                "timestamp": 1,
                "avg_cpu_percent": {"$round": ["$avg_cpu_percent", 2]},
                "avg_cpu_raw_percent": {"$round": ["$avg_cpu_raw_percent", 2]},
                "avg_memory_mb": {"$round": ["$avg_memory_mb", 2]},
                "max_memory_mb": 1,
                "memory_limit_mb": 1,
                "max_network_rx_bytes": 1,
                "max_network_tx_bytes": 1,
                "max_player_count": 1,
                "avg_player_count": {"$round": ["$avg_player_count", 2]},
                "avg_player_ping_ms": {"$round": ["$avg_player_ping_ms", 2]},
                "avg_server_fps": {"$round": ["$avg_server_fps", 2]},
                "avg_ai_count": {"$round": ["$avg_ai_count", 1]},
                "avg_vehicle_count": {"$round": ["$avg_vehicle_count", 1]},
                "uptime_seconds": 1,
                "cpu_cores_used": 1,
                "cpu_core_count": 1,
                "max_players": 1,
                "sample_count": 1,
            }
        },
    ]

    return await db.server_metrics.aggregate(pipeline).to_list(10_000)
