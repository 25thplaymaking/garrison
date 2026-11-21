"""Config Health: config lint, config detection and status verdicts."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-secret-key-that-is-long-enough-for-hs256-tests")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services import config_health as health
from services.server_config_generator import generate_reforger_config


def _server(tmp_path: Path, **overrides) -> dict:
    server = {
        "id": "srv-1",
        "name": "Test Server",
        "status": "running",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "rcon_password": "rconsecret123",
        "config": {
            "game": {
                "name": "Test Server",
                "scenarioId": "{59AD59368755F41A}Missions/21_GM_Eden.conf",
                "maxPlayers": 64,
                "passwordAdmin": "adminpw",
            },
            "rcon": {"password": "rconsecret123"},
        },
        "mods": [],
        "sat_enabled": False,
        "data_root": str(tmp_path),
    }
    server.update(overrides)
    return server


def _rules(findings, severity=None):
    return {f["rule"] for f in findings if severity is None or f["severity"] == severity}


def test_clean_generated_config_has_no_errors(tmp_path):
    findings = health.lint_config(generate_reforger_config(_server(tmp_path)))
    assert health.summarize_findings(findings)["error"] == 0, findings


def test_range_scenario_and_password_rules():
    config = {
        "bindPort": 2001, "publicPort": 2001,
        "a2s": {"port": 17777}, "rcon": {"port": 19999, "password": "a b", "permission": "root"},
        "game": {
            "name": "x", "scenarioId": "Missions/Eden.conf", "maxPlayers": 200,
            "passwordAdmin": "has space",
            "gameProperties": {"serverMaxViewDistance": 2000, "networkViewDistance": 4000,
                               "disableThirdPerson": "SOMETIMES"},
        },
    }
    errors = _rules(health.lint_config(config), "error")
    assert {"scenario", "range", "rcon-password", "admin-password", "enum"} <= errors
    assert "view-distance" in _rules(health.lint_config(config), "warning")


def test_unknown_keys_are_errors_on_effective_and_info_on_raw():
    config = {"bindPort": 1, "publicPort": 1, "a2s": {"port": 2}, "rcon": {"port": 3, "password": "abc"},
              "game": {"name": "x", "scenarioId": "{59AD59368755F41A}M/a.conf", "bogus": 1}, "typo": True}
    findings = health.lint_config(config, raw_config={"game": {"battlEye": True, "nonsense": 1}})
    paths = {(f["path"], f["severity"]) for f in findings}
    assert ("typo", "error") in paths and ("game.bogus", "error") in paths
    assert ("game.nonsense", "info") in paths
    assert ("game.battlEye", "info") not in paths  # relocated by the generator, not dropped


def test_port_clash_inside_server_and_across_fleet():
    config = {"bindPort": 2001, "publicPort": 2001, "a2s": {"port": 2001}, "rcon": {"port": 19999, "password": "abc"},
              "game": {"name": "x", "scenarioId": "{59AD59368755F41A}M/a.conf"}}
    findings = health.lint_config(config, fleet_ports={19999: "Other Server"})
    messages = " ".join(f["message"] for f in findings if f["rule"] == "port-clash")
    assert "bindPort and a2s.port" in messages and "Other Server" in messages


def test_fleet_port_map_skips_self_and_deleting():
    fleet = [{"id": "a", "name": "A", "ports": {"game": 1}}, {"id": "b", "name": "B", "ports": {"game": 2}},
             {"id": "c", "name": "C", "status": "deletion_pending", "ports": {"game": 3}}]
    assert health.fleet_port_map(fleet, exclude_id="a") == {2: "B"}


def test_duplicate_and_invalid_mods():
    config = {"game": {"mods": [{"modId": "5AAAC70D754245DD"}, {"modId": "5aaac70d754245dd"}, {"modId": "nope"}]}}
    rules = _rules(health.lint_config(config))
    assert {"mod-duplicate", "mod-id"} <= rules


def test_detect_missing_invalid_in_sync_and_drift(tmp_path):
    server = _server(tmp_path)
    assert health.detect_config(server)["state"] == "missing"

    path = tmp_path / "Configs" / "server-config.json"
    path.parent.mkdir(parents=True)
    path.write_text("{ not json", encoding="utf-8")
    invalid = health.detect_config(server)
    assert invalid["state"] == "invalid" and "line 1" in invalid["parse_error"]

    expected = generate_reforger_config(server)
    path.write_text(json.dumps(expected), encoding="utf-8")
    assert health.detect_config(server)["state"] == "in_sync"

    edited = json.loads(json.dumps(expected))
    edited["game"]["maxPlayers"] = 10
    edited["rcon"]["password"] = "handedited"
    path.write_text(json.dumps(edited), encoding="utf-8")
    drift = health.detect_config(server)
    assert drift["state"] == "drift"
    by_path = {d["path"]: d for d in drift["drift"]}
    assert by_path["game.maxPlayers"]["on_disk"] == "10"
    # Secrets are never echoed, only flagged.
    assert by_path["rcon.password"] == {"path": "rcon.password", "kind": "changed",
                                        "expected": "(set)", "on_disk": "(set)"}
    assert "handedited" not in json.dumps(drift) and "rconsecret123" not in json.dumps(drift)


def _status(server, **kw):
    base = dict(container={"status": "running", "running": True, "restart_count": 0},
                a2s={"player_count": 3, "max_players": 64, "map": "Everon"}, a2s_checked=True, open_incidents=0,
                detection={"state": "in_sync", "message": "ok"}, lint_counts={"error": 0, "warning": 0, "info": 0})
    base.update(kw)
    return health.build_status(server, **base)


def test_status_verdicts(tmp_path):
    server = _server(tmp_path)
    healthy = _status(server)
    assert healthy["overall"] == "online" and healthy["score"] == 100
    assert "3/64 players on Everon" in " ".join(c["detail"] for c in healthy["checks"])

    assert _status(server, container={"status": "exited", "running": False})["overall"] == "down"
    assert _status(server, a2s=None)["overall"] == "degraded"
    assert _status(server, detection={"state": "drift", "message": "x"})["overall"] == "degraded"
    advisory = _status(server, lint_counts={"error": 0, "warning": 2, "info": 0})
    assert advisory["overall"] == "online" and advisory["score"] == 95 and "2 warning" in advisory["headline"]
    assert _status(server, lint_counts={"error": 1, "warning": 0, "info": 0})["overall"] == "degraded"

    stopped = _status({**server, "status": "stopped"}, container={"status": "exited", "running": False}, a2s=None,
                      a2s_checked=False)
    assert stopped["overall"] == "stopped" and stopped["score"] is None
