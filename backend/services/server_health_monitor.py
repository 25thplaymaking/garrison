"""Background service that monitors Docker container health for managed game servers."""

import logging
import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import Dict
import uuid

from database import db
from models.server import SERVER_STATUSES  # noqa: F401 – used for validation reference
from services import crash_analysis
from services.docker_agent import DockerAgent
from services.server_notifications import sync_server_notifications

logger = logging.getLogger(__name__)

docker_agent = DockerAgent()

# Tracks automatic restart attempts per server_id.  Reset when a server is
# manually started or has been running stably for > 5 minutes.
_restart_counts: Dict[str, int] = {}

# Statuses whose container the monitor watches: those that should be alive,
# and crash loops. Docker keeps relaunching a looping container, and a loop
# often ends on its own (a Workshop outage passes); left unwatched, a recovered
# server read "crash loop" until someone restarted it by hand.
_ACTIVE_STATUSES = [s for s in ("running", "starting", "crash_loop") if s in SERVER_STATUSES]

STABILITY_THRESHOLD_SECONDS = 300  # 5 minutes before restart counter resets
_running_since: Dict[str, datetime] = {}

# server_id -> container StartedAt already swept for recovered incidents, so
# the stable-run check runs once per container run instead of every poll.
_incidents_checked_for_run: Dict[str, str] = {}

# Docker's own restart policy (unless-stopped) relaunches a dying container
# within seconds, so a 15s poll almost always sees it "running" and the crash
# path above never fires. Docker's RestartCount is the only reliable signal:
# this many restarts inside the window is a crash loop.
DOCKER_RESTART_LOOP_THRESHOLD = 3
DOCKER_RESTART_LOOP_WINDOW = timedelta(minutes=15)
# server_id -> (restart_count, first_seen_at) baseline for the current window
_docker_restart_baseline: Dict[str, tuple] = {}

# How the failure messages this monitor writes begin. Once the server has run
# past the stability threshold they describe a failure that is over, and a
# manual start does not overwrite them, so the monitor clears them itself.
_MONITOR_FAILURE_PREFIXES = (
    "Docker restarted the container ",
    "Container for server '",
    "Server did not become operational before the startup grace window expired.",
)

_ERROR_MARKER = re.compile(r"\((E|F)\):")
# Wrong-GUID resource warnings are emitted by most workshop mods on every boot
# and never stop a server; they would drown out the real cause.
_ERROR_NOISE = re.compile(r"Wrong GUID/name for resource")


def _parse_datetime(value):
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _seconds_up(status_info, now: datetime) -> float:
    """How long the container has run since its last (re)start; 0 if unknown."""
    started_at = _parse_datetime((status_info or {}).get("started_at"))
    if not started_at or started_at.year < 2000:
        return 0.0
    return (now - started_at).total_seconds()


def _cleared_monitor_messages(server: dict) -> dict:
    """Blank the record's messages that hold a failure this monitor reported."""
    return {
        field: ""
        for field in ("summary_message", "last_docker_error")
        if str(server.get(field) or "").startswith(_MONITOR_FAILURE_PREFIXES)
    }


# Auto-detected incident kinds that describe a server failing to come up or
# stay up. One open record per server and kind: a crash loop used to file a
# new "critical" incident every few minutes (six identical ones in an hour),
# and nothing ever closed them, so the overview showed weeks-old failures as
# open. Recurrences now bump ``occurrences`` on the open record, and the
# monitor resolves them once the server has stayed up past the stability
# threshold.
AUTO_RESOLVED_INCIDENT_TYPES = ("crash", "crash_loop", "startup_failure")
_ACTIVE_INCIDENT_STATUSES = ["open", "investigating"]
_SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


async def record_auto_incident(incident: dict, *, database=None) -> str:
    """Insert an auto-detected incident or fold it into the open one of its kind.

    Returns the id of the incident that now carries the detection. ``database``
    lets a route pass the handle it already uses.
    """
    store = db if database is None else database
    detected_at = incident.get("detected_at") or datetime.now(timezone.utc).isoformat()
    existing = await store.server_incidents.find_one(
        {
            "server_id": incident["server_id"],
            "incident_type": incident.get("incident_type"),
            "auto_detected": True,
            "status": {"$in": _ACTIVE_INCIDENT_STATUSES},
        },
        {"_id": 0, "id": 1, "severity": 1},
        sort=[("detected_at", -1)],
    )
    if not existing:
        await store.server_incidents.insert_one(
            {**incident, "occurrences": 1, "last_detected_at": detected_at}
        )
        return incident["id"]

    updates = {
        key: incident[key]
        for key in ("title", "description", "evidence", "diagnosis", "docker_restart_count")
        if key in incident
    }
    updates["last_detected_at"] = detected_at
    if _SEVERITY_RANK.get(incident.get("severity"), 0) > _SEVERITY_RANK.get(existing.get("severity"), 0):
        updates["severity"] = incident["severity"]
    await store.server_incidents.update_one(
        {"id": existing["id"]},
        {"$set": updates, "$inc": {"occurrences": 1}},
    )
    return existing["id"]


async def resolve_recovered_incidents(server_id: str, status_info, now: datetime) -> int:
    """Close failure incidents once the container has stayed up past the threshold.

    Only incidents last seen before the current container start are closed, so
    a failure recorded during this run stays open.
    """
    started_at = _parse_datetime((status_info or {}).get("started_at"))
    if not started_at or started_at.year < 2000:
        return 0
    if (now - started_at).total_seconds() < STABILITY_THRESHOLD_SECONDS:
        return 0
    started_iso = started_at.isoformat()
    result = await db.server_incidents.update_many(
        {
            "server_id": server_id,
            "auto_detected": True,
            "status": {"$in": _ACTIVE_INCIDENT_STATUSES},
            "incident_type": {"$in": list(AUTO_RESOLVED_INCIDENT_TYPES)},
            "detected_at": {"$lt": started_iso},
            "$or": [
                {"last_detected_at": {"$exists": False}},
                {"last_detected_at": {"$lt": started_iso}},
            ],
        },
        {"$set": {
            "status": "resolved",
            "resolved_at": now.isoformat(),
            "resolved_by": "system",
            "resolution_notes": "Auto-resolved: the server has run for 5+ minutes since this was detected.",
        }},
    )
    return int(getattr(result, "modified_count", 0) or 0)


async def server_health_loop(check_interval: int = 15):
    """Continuously check managed-server containers and react to failures.

    Follows the same async-loop pattern used by ``_valyu_background_ingestion``
    and ``_expire_loa_requests`` in *server.py*.
    """
    logger.info("Server health monitor started (interval=%ds)", check_interval)

    while True:
        try:
            cursor = db.managed_servers.find(
                {"status": {"$in": _ACTIVE_STATUSES}},
                {"_id": 0},
            )
            servers = await cursor.to_list(500)

            # With the daemon unreachable every container lookup returns None,
            # which reads as "container disappeared" and would mark every
            # running server crashed and file an incident for each. Skip the
            # pass instead; nothing observed this cycle is about the servers.
            if servers:
                docker_ok, docker_error = await docker_agent.ping()
                if not docker_ok:
                    logger.warning(
                        "Server health check skipped: Docker is not reachable (%s)", docker_error,
                    )
                    await asyncio.sleep(check_interval)
                    continue

            for server in servers:
                server_id = server.get("id", "")
                server_name = server.get("name", server_id)
                container_name = server.get("container_name", server_name)
                current_status = server.get("status")

                try:
                    status_info = await docker_agent.get_container_status(container_name)
                    await _evaluate_server(server, server_id, server_name,
                                           container_name, current_status,
                                           status_info)
                except Exception as exc:
                    logger.warning("Health check failed for %s: %s", server_name, exc)

            await asyncio.sleep(check_interval)

        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Server health monitor error: %s", exc)
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                break

    logger.info("Server health monitor stopped")


# ---------------------------------------------------------------------- #
#  Internal helpers
# ---------------------------------------------------------------------- #

async def _evaluate_server(server: dict, server_id: str, server_name: str,
                           container_name: str, current_status: str,
                           status_info, now: datetime = None):
    """Evaluate a single server's container state and take action."""

    now = now or datetime.now(timezone.utc)
    startup_grace_until = _parse_datetime(server.get("startup_grace_until"))
    container_missing = status_info is None

    if not container_missing and await _check_docker_restart_loop(
        server, server_id, server_name, container_name, status_info, now,
    ):
        return

    # --- Crash loop: over once the container stays up ----------------------
    if current_status == "crash_loop":
        if (not container_missing
                and status_info.get("running")
                and _seconds_up(status_info, now) >= STABILITY_THRESHOLD_SECONDS):
            await _end_crash_loop(server, server_id, server_name, status_info, now)
        return

    container_dead = (
        not container_missing
        and not status_info.get("running", False)
        and status_info.get("status") in ("exited", "dead")
    )

    if (container_missing or container_dead) and current_status in {"starting", "initializing"}:
        if startup_grace_until and now < startup_grace_until:
            logger.info(
                "Server %s is still within its startup grace window until %s",
                server_name,
                startup_grace_until.isoformat(),
            )
            return
        await _handle_startup_failure(server, server_id, server_name)
        return

    # --- Container crashed / disappeared while it should be running --------
    if (container_missing or container_dead) and current_status == "running":
        if startup_grace_until and now < startup_grace_until:
            logger.info(
                "Container for %s exited inside the startup grace window, delaying crash classification",
                server_name,
            )
            return
        # Before flagging as crash, check if the server is in an expected
        # restart cycle (mod download / content mounting).  Servers in the
        # "initializing" or "starting" provisioning states are expected to
        # restart during first boot.
        provisioning_state = server.get("provisioning_state", "ready")
        if provisioning_state in ("allocating", "preparing_filesystem",
                                   "writing_config", "creating_container",
                                   "starting_container", "waiting_for_profile",
                                   "discovering_sat"):
            logger.info(
                "Container for %s exited during provisioning (state=%s) — "
                "expected restart cycle, not flagging as crash",
                server_name, provisioning_state,
            )
            return

        # Also check recent logs for mod download activity
        try:
            from services.reforger_orchestrator import is_in_mod_cycle
            logs = await docker_agent.get_container_logs(container_name, tail=100)
            if is_in_mod_cycle(logs):
                logger.info(
                    "Container for %s exited during mod download cycle — "
                    "not flagging as crash",
                    server_name,
                )
                return
        except Exception:
            pass

        await _handle_crash(server, server_id, server_name, container_name)
        return

    # --- Container is running and server was still "starting" -------------
    if (not container_missing
            and status_info.get("running")
            and current_status == "starting"):
        updates = {
            "status": "running",
            "readiness_state": "ready",
            "provisioning_state": "ready",
            "startup_grace_until": None,
            "updated_at": now,
        }
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": updates},
        )
        await sync_server_notifications({**server, **updates})
        _running_since[server_id] = now
        logger.info("Server %s transitioned from starting → running", server_name)
        return

    if (not container_missing
            and status_info.get("running")
            and current_status == "running"
            and server.get("readiness_state") in {"initializing", "degraded"}):
        updates = {
            "readiness_state": "ready",
            "provisioning_state": "ready",
            "startup_grace_until": None,
            "updated_at": now,
        }
        await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
        await sync_server_notifications({**server, **updates})

    # --- Stable-running reset: clear restart counter after 5 minutes ------
    if current_status == "running" and server_id in _restart_counts:
        started = _running_since.get(server_id)
        if started:
            elapsed = (datetime.now(timezone.utc) - started).total_seconds()
            if elapsed > STABILITY_THRESHOLD_SECONDS:
                _restart_counts.pop(server_id, None)
                _running_since.pop(server_id, None)
                logger.info("Restart counter reset for %s (stable >5 min)", server_name)

    # --- Recovered: close the failure incidents from before this run --------
    if (not container_missing
            and status_info.get("running")
            and current_status == "running"):
        run_key = str(status_info.get("started_at") or "")
        if run_key and _incidents_checked_for_run.get(server_id) != run_key:
            if (now - (_parse_datetime(run_key) or now)).total_seconds() >= STABILITY_THRESHOLD_SECONDS:
                resolved = await resolve_recovered_incidents(server_id, status_info, now)
                cleared = _cleared_monitor_messages(server)
                if cleared:
                    # Matched on the old text so a newer message is never wiped.
                    await db.managed_servers.update_one(
                        {"id": server_id, **{field: server.get(field) for field in cleared}},
                        {"$set": cleared},
                    )
                _incidents_checked_for_run[server_id] = run_key
                if resolved:
                    logger.info("Auto-resolved %d incident(s) for %s (stable >5 min)", resolved, server_name)


async def _end_crash_loop(server: dict, server_id: str, server_name: str,
                          status_info: dict, now: datetime):
    """Return a crash-looped server to running once its container stays up.

    Clears everything the loop raised: the status (card, issue count, down
    state), the critical notification, the loop text, and the incident.
    """
    updates = {
        "status": "running",
        "readiness_state": "ready",
        "startup_grace_until": None,
        "updated_at": now,
        **_cleared_monitor_messages(server),
    }
    # Only from crash_loop: an operator may have stopped or restarted the
    # server since this poll read it, and that must stand.
    result = await db.managed_servers.update_one(
        {"id": server_id, "status": "crash_loop"}, {"$set": updates},
    )
    if not getattr(result, "modified_count", 0):
        return
    await sync_server_notifications({**server, **updates})
    _restart_counts.pop(server_id, None)
    resolved = await resolve_recovered_incidents(server_id, status_info, now)
    _incidents_checked_for_run[server_id] = str(status_info.get("started_at") or "")
    logger.info(
        "Crash loop over for %s: container up %d min without a restart; "
        "back to running, %d incident(s) resolved",
        server_name, _seconds_up(status_info, now) // 60, resolved,
    )


async def _handle_crash(server: dict, server_id: str, server_name: str,
                        container_name: str):
    """React to a container that has crashed or gone missing."""

    # Move to error state
    updates = {
        "status": "error",
        "readiness_state": "failed",
        "startup_grace_until": None,
        "updated_at": datetime.now(timezone.utc),
    }
    await db.managed_servers.update_one(
        {"id": server_id},
        {"$set": updates},
    )
    await sync_server_notifications({**server, **updates})

    # Record an auto-detected incident
    diagnosis = await diagnose_failure(server)
    description = f"Container for server '{server_name}' crashed or exited unexpectedly."
    if diagnosis:
        description += " Cause: " + describe_diagnosis(diagnosis)
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"last_docker_error": description[:1000]}},
        )
    incident = _make_incident(
        server_id, server_name,
        severity="high",
        description=description,
    )
    if diagnosis:
        incident["diagnosis"] = compact_diagnosis(diagnosis)
    incident_id = await record_auto_incident(incident)
    logger.warning("Crash detected for server %s — incident %s",
                   server_name, incident_id)

    # Auto-restart logic
    auto_restart = server.get("auto_restart", False)
    max_attempts = server.get("max_restart_attempts", 3)
    attempts = _restart_counts.get(server_id, 0)

    if auto_restart and attempts < max_attempts:
        _restart_counts[server_id] = attempts + 1
        logger.info("Auto-restarting %s (attempt %d/%d)",
                     server_name, attempts + 1, max_attempts)

        ok, err = await docker_agent.restart_container(container_name)
        if ok:
            restart_updates = {
                "status": "starting",
                "readiness_state": "initializing",
                "startup_grace_until": datetime.now(timezone.utc) + timedelta(minutes=5),
                "updated_at": datetime.now(timezone.utc),
            }
            await db.managed_servers.update_one(
                {"id": server_id},
                {"$set": restart_updates},
            )
            await sync_server_notifications({**server, **restart_updates})
            _running_since.pop(server_id, None)
        else:
            logger.error("Restart failed for %s: %s", server_name, err)

    elif auto_restart and attempts >= max_attempts:
        # Restart budget exhausted → crash-loop
        await db.managed_servers.update_one(
            {"id": server_id},
            {"$set": {"status": "crash_loop"}},
        )
        await sync_server_notifications({**server, "status": "crash_loop"})

        critical_incident = _make_incident(
            server_id, server_name,
            severity="critical",
            description=(
                f"Server '{server_name}' has exhausted all {max_attempts} "
                f"restart attempts and entered crash-loop state."
            ),
        )
        critical_incident["incident_type"] = "crash_loop"
        critical_incident["title"] = f"Crash loop detected — {server_name}"
        incident_id = await record_auto_incident(critical_incident)
        logger.critical("Server %s entered crash_loop — incident %s",
                        server_name, incident_id)


def summarize_engine_errors(logs: str, limit: int = 5) -> list:
    """Distinct engine (E)/(F) lines from a log tail, most telling first.

    Reforger marks errors with ``(E)``/``(F)`` rather than the word "error",
    so keyword matching misses them. Timestamps are stripped so repeats from
    successive boots collapse into one entry.

    Ranking by frequency alone put the shutdown resource-leak report
    (``ui/fonts/robotomono_msdf_28.edds``, printed once per boot exactly like
    the real failure) at the top, so known noise is dropped and lines that
    name a cause (compile errors, a missing scenario, an invalid config)
    outrank merely frequent ones.
    """
    counts: Dict[str, int] = {}
    first_seen: Dict[str, int] = {}
    for index, raw in enumerate((logs or "").splitlines()):
        if not _ERROR_MARKER.search(raw) or _ERROR_NOISE.search(raw):
            continue
        line = raw.split(" ", 1)[1] if raw[:4].isdigit() and " " in raw else raw
        line = re.sub(r"^\s*\d{2}:\d{2}:\d{2}\.\d+\s+", "", line).strip()
        if crash_analysis.line_priority(line) < 0:
            continue
        counts[line] = counts.get(line, 0) + 1
        first_seen.setdefault(line, index)
    ranked = sorted(
        counts,
        key=lambda k: (-crash_analysis.line_priority(k), -counts[k], first_seen[k]),
    )
    return ranked[:limit]


async def diagnose_failure(server: dict):
    """Root-cause analysis of the server's most recent failed boot, or None."""
    try:
        result = await asyncio.to_thread(crash_analysis.diagnose_server, server, running=False)
    except Exception as exc:  # diagnosis must never break health monitoring
        logger.warning("Crash analysis failed for %s: %s", server.get("name") or server.get("id"), exc)
        return None
    diagnosis = (result or {}).get("diagnosis")
    if not diagnosis or not diagnosis.get("primary") or diagnosis.get("stale"):
        return None
    if diagnosis.get("outcome") not in {"failed_to_start", "crashed_runtime"}:
        return None
    return diagnosis


def describe_diagnosis(diagnosis: dict) -> str:
    primary = diagnosis["primary"]
    text = f"{primary['title']}: {primary['summary']}"
    named = [c for c in diagnosis.get("culprits") or [] if c.get("role") != "download"][:2]
    if named:
        text += " Likely mod: " + ", ".join(f"{c['name']} ({c['mod_id']})" for c in named) + "."
    return text


def compact_diagnosis(diagnosis: dict) -> dict:
    """What an incident keeps: enough to explain and act without re-reading logs."""
    primary = diagnosis["primary"]
    evidence = (primary.get("evidence") or [{}])[0]
    return {
        "session": diagnosis.get("session"),
        "outcome": diagnosis.get("outcome"),
        "kind": primary.get("kind"),
        "title": primary.get("title"),
        "summary": primary.get("summary"),
        "explanation": primary.get("explanation"),
        "evidence": {k: evidence.get(k) for k in ("file", "line", "text")},
        "culprits": [
            {k: c.get(k) for k in ("mod_id", "name", "role", "in_mod_list")}
            for c in (diagnosis.get("culprits") or [])[:5]
        ],
        "actions": [{k: a.get(k) for k in ("type", "label")} for a in (diagnosis.get("actions") or [])[:5]],
        "noise_note": diagnosis.get("noise_note"),
    }


async def _check_docker_restart_loop(server: dict, server_id: str, server_name: str,
                                     container_name: str, status_info: dict,
                                     now: datetime) -> bool:
    """Flag a container Docker keeps relaunching. Returns True when flagged."""
    count = int(status_info.get("restart_count") or 0)
    baseline = _docker_restart_baseline.get(server_id)
    # New container (recreate resets RestartCount) or window expired: rebase.
    if baseline is None or count < baseline[0] or now - baseline[1] > DOCKER_RESTART_LOOP_WINDOW:
        _docker_restart_baseline[server_id] = (count, now)
        return False
    restarts = count - baseline[0]
    if restarts < DOCKER_RESTART_LOOP_THRESHOLD:
        return False

    _docker_restart_baseline.pop(server_id, None)
    diagnosis = await diagnose_failure(server)
    errors = []
    try:
        errors = summarize_engine_errors(
            await docker_agent.get_container_logs(container_name, tail=3000)
        )
    except Exception as exc:
        logger.warning("Could not read logs for crash-loop diagnosis of %s: %s", server_name, exc)

    summary = (
        f"Docker restarted the container {restarts} times in "
        f"{int(DOCKER_RESTART_LOOP_WINDOW.total_seconds() // 60)} min "
        f"(lifetime restarts: {count}). The game exits during boot."
    )
    if diagnosis:
        summary += " Cause: " + describe_diagnosis(diagnosis)
    elif errors:
        summary += " Top engine errors: " + " | ".join(errors[:3])
    updates = {
        "status": "crash_loop",
        "readiness_state": "failed",
        "summary_message": summary[:1000],
        "last_docker_error": summary[:1000],
        "startup_grace_until": None,
        "updated_at": now,
    }
    await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
    incident = _make_incident(server_id, server_name, severity="critical", description=summary)
    incident["incident_type"] = "crash_loop"
    incident["title"] = f"Crash loop detected — {server_name}"
    incident["evidence"] = errors
    incident["docker_restart_count"] = count
    if diagnosis:
        incident["diagnosis"] = compact_diagnosis(diagnosis)
    incident_id = await record_auto_incident(incident)
    await sync_server_notifications({**server, **updates})
    logger.critical("Docker restart loop for %s: %d restarts — incident %s",
                    server_name, restarts, incident_id)
    return True


def _make_incident(server_id: str, server_name: str, *,
                   severity: str, description: str) -> dict:
    """Build a standardised incident document."""
    return {
        "id": f"inc_{uuid.uuid4().hex[:12]}",
        "server_id": server_id,
        "incident_type": "crash",
        "severity": severity,
        "title": f"Container crash detected — {server_name}",
        "description": description,
        "status": "open",
        "detected_at": datetime.now(timezone.utc).isoformat(),
        "auto_detected": True,
    }


async def _handle_startup_failure(server: dict, server_id: str, server_name: str):
    """Mark a server as failed when it never leaves the startup window."""
    diagnosis = await diagnose_failure(server)
    message = "Server did not become operational before the startup grace window expired."
    if diagnosis:
        message += " Cause: " + describe_diagnosis(diagnosis)
    updates = {
        "status": "error",
        "readiness_state": "failed",
        "startup_grace_until": None,
        "last_docker_error": message[:1000],
        "updated_at": datetime.now(timezone.utc),
    }
    await db.managed_servers.update_one({"id": server_id}, {"$set": updates})
    incident = {
        "id": f"inc_{uuid.uuid4().hex[:12]}",
        "server_id": server_id,
        "incident_type": "startup_failure",
        "severity": "high",
        "title": f"Startup timeout - {server_name}",
        "description": updates["last_docker_error"],
        "status": "open",
        "detected_at": datetime.now(timezone.utc).isoformat(),
        "auto_detected": True,
    }
    if diagnosis:
        incident["diagnosis"] = compact_diagnosis(diagnosis)
    await record_auto_incident(incident)
    await sync_server_notifications({**server, **updates})
