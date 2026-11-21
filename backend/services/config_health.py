"""Config Health: config detection, config lint and status.

Config Health sits on top of the Reforger orchestrator. It answers three questions for every managed server, and for the
fleet as a whole:

1. Config detection: is there a config file on disk where the server record
   says it is, can the engine parse it, and does it still match what the
   backend would generate from the record? A mismatch ("drift") means a saved
   change has not been applied yet, or someone hand-edited the file.
2. Config lint: does the config break a rule the engine enforces (ranges,
   types, ``additionalProperties: false`` objects, password rules, port
   clashes across the fleet)? Ranges come from
   ``docs/reforger-server-config-reference.md`` (reconciled against the
   Bohemia Server Config wiki).
3. Status: one overall verdict built from separate checks (container,
   desired vs actual state, Steam query, incidents, crash loop, config).

Everything here is read-only. Secrets never leave this module: drift on a
password path is reported as "differs", never with either value.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from config import SERVER_CONFIG_FILENAME
from services.config_revisions import _render, flatten_config
from services.server_config_generator import (
    THIRD_PERSON_VALUES,
    VALID_GAME_KEYS,
    VALID_OPERATING_KEYS,
    generate_reforger_config,
    validate_config,
)

HEALTH_VERSION = "1.0"

ERROR = "error"
WARNING = "warning"
INFO = "info"

VALID_ROOT_KEYS = frozenset({
    "bindAddress", "bindPort", "publicAddress", "publicPort",
    "a2s", "rcon", "game", "operating",
})
VALID_RCON_KEYS = frozenset({
    "address", "port", "password", "permission", "maxClients", "blacklist", "whitelist",
})
VALID_GAME_PROPERTY_KEYS = frozenset({
    "serverMaxViewDistance", "serverMinGrassDistance", "networkViewDistance",
    "fastValidation", "battlEye", "disableThirdPerson", "VONDisableUI",
    "VONDisableDirectSpeechUI", "VONCanTransmitCrossFaction", "VONTransmitCrossFaction",
    "missionHeader", "persistence",
})
SECRET_PATHS = frozenset({"rcon.password", "game.password", "game.passwordAdmin"})
SCENARIO_RE = re.compile(r"^\{[0-9A-Fa-f]{16}\}.+\.conf$")
MOD_ID_RE = re.compile(r"^[0-9A-Fa-f]{16}$")
PLATFORMS = frozenset({"PLATFORM_PC", "PLATFORM_XBL", "PLATFORM_PSN"})


def _finding(rule: str, severity: str, path: str, message: str, fix: str = "") -> Dict[str, str]:
    return {"rule": rule, "severity": severity, "path": path, "message": message, "fix": fix}


def _get(obj: Any, dotted: str) -> Any:
    for key in dotted.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_range(findings: list, config: dict, path: str, lo: int, hi: int, *, rule: str,
                 allow: Iterable[int] = ()) -> None:
    value = _get(config, path)
    if value is None:
        return
    if not _is_int(value):
        findings.append(_finding(rule, ERROR, path, f"{path} must be a whole number, got {type(value).__name__}.",
                                 f"Set a number between {lo} and {hi}."))
        return
    if value in allow:
        return
    if not lo <= value <= hi:
        findings.append(_finding(rule, ERROR, path, f"{path} is {value}; the engine accepts {lo} to {hi}.",
                                 f"Set a value between {lo} and {hi}."))


def _unknown_keys(findings: list, obj: Any, allowed: frozenset, prefix: str, severity: str, note: str) -> None:
    if not isinstance(obj, dict):
        return
    for key in sorted(set(obj) - allowed):
        path = f"{prefix}.{key}" if prefix else key
        findings.append(_finding("unknown-key", severity, path, f"{path} is not a field the engine knows. {note}",
                                 "Remove it, or move it to the block it belongs in."))


def lint_config(config: Dict[str, Any], *, fleet_ports: Optional[Dict[int, str]] = None,
                raw_config: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    """Return lint findings for an effective (backend-generated) config.

    ``raw_config`` is what the operator typed before normalisation; unknown
    keys in it are reported as info because the generator drops them on save.
    ``fleet_ports`` maps every port used by OTHER servers to that server's name.
    """
    findings: List[Dict[str, str]] = []
    config = config if isinstance(config, dict) else {}

    ok, errors = validate_config(config)
    for message in errors:
        findings.append(_finding("required", ERROR, message.split(" ")[0], message, "Fill in the missing field."))

    # Objects the engine validates with additionalProperties: false.
    _unknown_keys(findings, config, VALID_ROOT_KEYS, "", ERROR, "The engine refuses to start on unknown root keys.")
    _unknown_keys(findings, config.get("game"), VALID_GAME_KEYS, "game", ERROR,
                  "The engine refuses to start on unknown game keys.")
    _unknown_keys(findings, config.get("rcon"), VALID_RCON_KEYS, "rcon", ERROR, "")
    _unknown_keys(findings, _get(config, "game.gameProperties"), VALID_GAME_PROPERTY_KEYS,
                  "game.gameProperties", WARNING, "")
    if raw_config is not None:
        before = len(findings)
        _unknown_keys(findings, raw_config, VALID_ROOT_KEYS, "", INFO, "It will be dropped when you save.")
        _unknown_keys(findings, raw_config.get("game") if isinstance(raw_config, dict) else None,
                      VALID_GAME_KEYS | {"persistence"} | set(VALID_GAME_PROPERTY_KEYS), "game", INFO,
                      "It will be dropped when you save.")
        for item in findings[before:]:
            item["rule"] = "dropped-on-save"

    operating = config.get("operating")
    if isinstance(operating, dict):
        for key, value in operating.items():
            expected = VALID_OPERATING_KEYS.get(key)
            if expected is None:
                findings.append(_finding("unknown-key", ERROR, f"operating.{key}",
                                         f"operating.{key} is not a field the engine knows.", "Remove it."))
            elif expected is int and not _is_int(value) or expected is not int and not isinstance(value, expected):
                findings.append(_finding("type", ERROR, f"operating.{key}",
                                         f"operating.{key} must be a {expected.__name__}.",
                                         f"Change it to a {expected.__name__}."))

    # Game block.
    name = _get(config, "game.name")
    if isinstance(name, str) and len(name) > 100:
        findings.append(_finding("range", ERROR, "game.name", f"Server name is {len(name)} characters; the limit is 100.",
                                 "Shorten the name."))
    scenario = _get(config, "game.scenarioId")
    if isinstance(scenario, str) and scenario.strip() and not SCENARIO_RE.match(scenario.strip()):
        findings.append(_finding("scenario", ERROR, "game.scenarioId",
                                 "Scenario ID should look like {16 hex digits}Missions/Name.conf.",
                                 "Copy the scenario ID exactly from the Workshop page or #listScenarios."))
    _check_range(findings, config, "game.maxPlayers", 1, 128, rule="range")
    admins = _get(config, "game.admins")
    if isinstance(admins, list) and len(admins) > 20:
        findings.append(_finding("range", ERROR, "game.admins", f"{len(admins)} admins listed; the engine allows 20.",
                                 "Trim the admin list to 20 IDs."))
    platforms = _get(config, "game.supportedPlatforms")
    if isinstance(platforms, list):
        bad = [p for p in platforms if p not in PLATFORMS]
        if bad:
            findings.append(_finding("enum", ERROR, "game.supportedPlatforms", f"Unknown platform(s): {', '.join(map(str, bad))}.",
                                     "Use PLATFORM_PC, PLATFORM_XBL or PLATFORM_PSN."))

    admin_pw = _get(config, "game.passwordAdmin")
    if not admin_pw:
        findings.append(_finding("admin-password", WARNING, "game.passwordAdmin",
                                 "No admin password: nobody can #login as admin in game.",
                                 "Set game.passwordAdmin."))
    elif isinstance(admin_pw, str) and " " in admin_pw:
        findings.append(_finding("admin-password", ERROR, "game.passwordAdmin",
                                 "The admin password contains a space; the engine rejects that.", "Remove the spaces."))

    # Mods.
    mods = _get(config, "game.mods")
    if isinstance(mods, list):
        seen: Dict[str, int] = {}
        for index, mod in enumerate(mods):
            path = f"game.mods[{index}]"
            mod_id = str((mod or {}).get("modId") or "") if isinstance(mod, dict) else ""
            label = (mod or {}).get("name") if isinstance(mod, dict) else None
            if not MOD_ID_RE.match(mod_id):
                findings.append(_finding("mod-id", ERROR, path, f"Mod {label or index} has an invalid ID '{mod_id}'.",
                                         "A Workshop ID is 16 hex characters."))
                continue
            key = mod_id.upper()
            if key in seen:
                findings.append(_finding("mod-duplicate", WARNING, path,
                                         f"Mod {label or mod_id} is listed twice (also entry {seen[key]}).",
                                         "Remove the duplicate entry."))
            else:
                seen[key] = index

    # gameProperties.
    _check_range(findings, config, "game.gameProperties.serverMaxViewDistance", 500, 10000, rule="range")
    _check_range(findings, config, "game.gameProperties.serverMinGrassDistance", 50, 150, rule="range", allow=(0,))
    _check_range(findings, config, "game.gameProperties.networkViewDistance", 500, 5000, rule="range")
    view = _get(config, "game.gameProperties.serverMaxViewDistance")
    net = _get(config, "game.gameProperties.networkViewDistance")
    if _is_int(view) and _is_int(net) and net > view:
        findings.append(_finding("view-distance", WARNING, "game.gameProperties.networkViewDistance",
                                 f"Network view distance ({net} m) is above the view distance cap ({view} m). "
                                 "The server replicates things players can never see.",
                                 "Lower networkViewDistance to the view distance or below."))
    third = _get(config, "game.gameProperties.disableThirdPerson")
    if third is not None and not isinstance(third, bool) and third not in THIRD_PERSON_VALUES:
        findings.append(_finding("enum", ERROR, "game.gameProperties.disableThirdPerson",
                                 f"'{third}' is not a third-person mode.", "Use DISABLE, ENABLE or ENABLE_DRIVER_ONLY."))
    if _get(config, "game.gameProperties.fastValidation") is False:
        findings.append(_finding("fast-validation", WARNING, "game.gameProperties.fastValidation",
                                 "fastValidation is off. Bohemia recommends it on for public servers.",
                                 "Set fastValidation to true."))
    if _get(config, "game.gameProperties.battlEye") is False:
        findings.append(_finding("battleye", INFO, "game.gameProperties.battlEye", "BattlEye anti-cheat is off.", ""))

    persistence = _get(config, "game.gameProperties.persistence")
    if isinstance(persistence, dict):
        _check_range(findings, config, "game.gameProperties.persistence.autoSaveInterval", 0, 60, rule="range")
        _check_range(findings, config, "game.gameProperties.persistence.saveRetention", 1, 128, rule="range")
        _check_range(findings, config, "game.gameProperties.persistence.hiveId", 0, 16383, rule="range")
        if persistence.get("loadSessionSave") is True:
            findings.append(_finding("persistence", INFO, "game.gameProperties.persistence.loadSessionSave",
                                     "Persistence is on: the server restores its last save on every launch.",
                                     "Set loadSessionSave to false for a fresh start each launch."))
    if isinstance(_get(config, "game.persistence"), dict):
        findings.append(_finding("persistence", ERROR, "game.persistence",
                                 "Persistence sits under game; the engine only reads game.gameProperties.persistence.",
                                 "Move the block under gameProperties."))

    # Operating.
    _check_range(findings, config, "operating.slotReservationTimeout", 5, 300, rule="range")
    _check_range(findings, config, "operating.joinQueue.maxSize", 0, 50, rule="range")
    ai_limit = _get(config, "operating.aiLimit")
    if _is_int(ai_limit) and ai_limit == 0:
        findings.append(_finding("ai-limit", WARNING, "operating.aiLimit", "aiLimit 0 means no AI can spawn.",
                                 "Use -1 for no ceiling, or a positive limit."))

    # RCON.
    rcon_pw = _get(config, "rcon.password")
    if isinstance(rcon_pw, str) and rcon_pw:
        if len(rcon_pw) < 3 or " " in rcon_pw:
            findings.append(_finding("rcon-password", ERROR, "rcon.password",
                                     "RCON password must be at least 3 characters with no spaces, or RCON will not start.",
                                     "Regenerate the RCON password."))
    permission = _get(config, "rcon.permission")
    if permission is not None and permission not in ("admin", "monitor"):
        findings.append(_finding("enum", ERROR, "rcon.permission", f"'{permission}' is not an RCON permission.",
                                 "Use admin or monitor."))
    _check_range(findings, config, "rcon.maxClients", 1, 16, rule="range")

    # Ports: range, self-clash, fleet clash.
    port_paths = ("bindPort", "publicPort", "a2s.port", "rcon.port")
    for path in port_paths:
        _check_range(findings, config, path, 1, 65535, rule="port")
    own = {path: _get(config, path) for path in ("bindPort", "a2s.port", "rcon.port")}
    by_port: Dict[int, List[str]] = {}
    for path, port in own.items():
        if _is_int(port):
            by_port.setdefault(port, []).append(path)
    for port, paths in by_port.items():
        if len(paths) > 1:
            findings.append(_finding("port-clash", ERROR, paths[0],
                                     f"Port {port} is used by {' and '.join(paths)} on this server.",
                                     "Give each socket its own port."))
    for path, port in own.items():
        if _is_int(port) and fleet_ports and port in fleet_ports:
            findings.append(_finding("port-clash", ERROR, path,
                                     f"Port {port} ({path}) is already used by {fleet_ports[port]}.",
                                     "Re-allocate this server's ports."))
    return findings


def summarize_findings(findings: List[Dict[str, str]]) -> Dict[str, int]:
    counts = {ERROR: 0, WARNING: 0, INFO: 0}
    for item in findings:
        counts[item["severity"]] = counts.get(item["severity"], 0) + 1
    return counts


def fleet_port_map(servers: List[Dict[str, Any]], exclude_id: Optional[str] = None) -> Dict[int, str]:
    ports: Dict[int, str] = {}
    for server in servers:
        if server.get("id") == exclude_id or server.get("status") == "deletion_pending":
            continue
        for value in (server.get("ports") or {}).values():
            if _is_int(value):
                ports[value] = server.get("name") or server.get("id") or "another server"
    return ports


def config_file_path(server: Dict[str, Any]) -> Optional[Path]:
    if server.get("config_path"):
        return Path(server["config_path"])
    if server.get("data_root"):
        return Path(server["data_root"]) / "Configs" / SERVER_CONFIG_FILENAME
    return None


def _display(path: str, value: Any) -> Any:
    if path in SECRET_PATHS or path.endswith(".password"):
        return "(set)" if value not in (None, "") else "(empty)"
    return "(absent)" if value is None else _render(value)


def detect_config(server: Dict[str, Any]) -> Dict[str, Any]:
    """Find the server's config file and compare it to what the backend would write."""
    path = config_file_path(server)
    result: Dict[str, Any] = {
        "path": str(path) if path else None,
        "exists": False,
        "readable": False,
        "parse_error": None,
        "size_bytes": None,
        "modified_at": None,
        "in_sync": False,
        "drift": [],
        "state": "missing",
        "message": "",
    }
    if path is None:
        result["message"] = "The server record has no config path or data root."
        return result
    if not path.exists():
        result["message"] = "No config file on disk. Reconfigure the server to write one."
        return result
    result["exists"] = True
    try:
        stat = path.stat()
        result["size_bytes"] = stat.st_size
        result["modified_at"] = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        text = path.read_text(encoding="utf-8")
        result["readable"] = True
    except OSError as exc:
        result["state"] = "unreadable"
        result["message"] = f"The backend cannot read the file ({exc.strerror or exc})."
        return result
    try:
        on_disk = json.loads(text)
    except json.JSONDecodeError as exc:
        result["state"] = "invalid"
        result["parse_error"] = f"line {exc.lineno}, column {exc.colno}: {exc.msg}"
        result["message"] = "The file is not valid JSON; the engine will refuse to start."
        return result

    expected = generate_reforger_config(server)
    flat_disk = flatten_config(on_disk)
    flat_expected = flatten_config(expected)
    drift = []
    for key in sorted(set(flat_disk) | set(flat_expected)):
        a, b = flat_expected.get(key), flat_disk.get(key)
        if a == b:
            continue
        kind = "missing_on_disk" if key not in flat_disk else ("extra_on_disk" if key not in flat_expected else "changed")
        drift.append({"path": key, "kind": kind, "expected": _display(key, a), "on_disk": _display(key, b)})
    result["drift"] = drift[:200]
    result["drift_count"] = len(drift)
    result["in_sync"] = not drift
    result["state"] = "in_sync" if not drift else "drift"
    result["message"] = (
        "The file on disk matches the saved config."
        if not drift
        else f"{len(drift)} field(s) differ from the saved config. Apply (reconfigure) to write the saved "
             "config, or someone edited the file by hand."
    )
    return result


def _check(check_id: str, label: str, state: str, detail: str) -> Dict[str, str]:
    return {"id": check_id, "label": label, "state": state, "detail": detail}


def build_status(server: Dict[str, Any], *, container: Optional[Dict[str, Any]], a2s: Optional[Dict[str, Any]],
                 a2s_checked: bool, open_incidents: int, detection: Dict[str, Any],
                 lint_counts: Dict[str, int]) -> Dict[str, Any]:
    """Combine separate checks into one verdict and a 0-100 score."""
    checks: List[Dict[str, str]] = []
    desired = server.get("status") or "unknown"
    running = bool(container and container.get("running"))
    wants_running = desired in {"running", "starting", "initializing", "degraded"}

    if container is None:
        checks.append(_check("container", "Container", "fail" if wants_running else "skip",
                             "No container found." if wants_running else "No container (server is not deployed)."))
    else:
        restarts = int(container.get("restart_count") or 0)
        state = "pass" if running else ("fail" if wants_running else "skip")
        checks.append(_check("container", "Container", state,
                             f"{container.get('status', 'unknown')}" + (f", {restarts} Docker restarts" if restarts else "")))
        if restarts >= 3:
            checks.append(_check("restarts", "Restart count", "warn", f"Docker restarted it {restarts} times."))

    if wants_running and not running:
        checks.append(_check("desired-state", "Desired vs actual", "fail",
                             f"The panel says {desired} but the container is not running."))
    elif running and desired in {"stopped", "created"}:
        checks.append(_check("desired-state", "Desired vs actual", "warn",
                             f"The container runs but the panel says {desired}."))
    else:
        checks.append(_check("desired-state", "Desired vs actual", "pass", f"Panel and container agree ({desired})."))

    if running:
        if not a2s_checked:
            checks.append(_check("query", "Steam query", "skip", "Not checked."))
        elif a2s:
            players = a2s.get("player_count")
            maxp = a2s.get("max_players")
            checks.append(_check("query", "Steam query", "pass",
                                 f"Answering: {players}/{maxp} players on {a2s.get('map') or 'unknown map'}."))
        else:
            checks.append(_check("query", "Steam query", "warn",
                                 "No answer on the query port. Normal for a few minutes after start; "
                                 "otherwise the game is not listening."))

    readiness = server.get("readiness_state")
    if readiness and readiness not in {"ready"}:
        checks.append(_check("readiness", "Provisioning", "warn" if readiness == "degraded" else "fail",
                             f"Readiness is {readiness}."))

    if server.get("needs_manual_intervention") or desired == "crash_loop":
        checks.append(_check("crash-loop", "Crash loop", "fail", "Auto-restart gave up; it needs a person."))
    if open_incidents:
        checks.append(_check("incidents", "Open incidents", "warn", f"{open_incidents} open incident(s)."))
    else:
        checks.append(_check("incidents", "Open incidents", "pass", "None open."))

    det_state = detection.get("state")
    checks.append(_check(
        "config-file", "Config file",
        {"in_sync": "pass", "drift": "warn"}.get(det_state, "fail"),
        detection.get("message") or det_state or "",
    ))
    if lint_counts.get(ERROR):
        checks.append(_check("config-lint", "Config rules", "fail", f"{lint_counts[ERROR]} error(s), {lint_counts.get(WARNING, 0)} warning(s)."))
    elif lint_counts.get(WARNING):
        # Advisory: a tuning warning is worth showing but does not make a
        # running server "degraded".
        checks.append({**_check("config-lint", "Config rules", "warn",
                                f"{lint_counts[WARNING]} warning(s); the server still runs."), "advisory": True})
    else:
        checks.append(_check("config-lint", "Config rules", "pass", "No problems found."))

    if server.get("last_docker_error") and not running and wants_running:
        checks.append(_check("docker-error", "Last Docker error", "fail", str(server["last_docker_error"])[:300]))

    weights = {"pass": 0, "skip": 0, "warn": 10, "fail": 30}
    score = max(0, 100 - sum(5 if c.get("advisory") else weights[c["state"]] for c in checks))
    fails = [c for c in checks if c["state"] == "fail"]
    warns = [c for c in checks if c["state"] == "warn" and not c.get("advisory")]
    advisories = [c for c in checks if c.get("advisory")]
    if desired == "deletion_pending":
        overall = "deleting"
    elif not wants_running and not running:
        overall = "stopped"
    elif any(c["id"] in {"container", "desired-state", "crash-loop"} for c in fails):
        overall = "down"
    elif fails or warns:
        overall = "degraded"
    else:
        overall = "online"
    headline = (fails or warns or advisories or [None])[0]
    return {
        "overall": overall,
        "score": score if overall != "stopped" else None,
        "headline": headline["detail"] if headline else "All checks pass.",
        "checks": checks,
    }


def inspection_disabled() -> bool:
    return str(os.environ.get("CONFIG_HEALTH_DISABLE_LIVE_PROBES", "")).strip().lower() in {"1", "true", "yes"}
