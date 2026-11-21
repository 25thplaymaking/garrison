import asyncio
import json
import os
import shutil
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("JWT_ALGORITHM", "HS256")

import routes.servers as server_routes
from routes.servers import _build_log_entries, _derive_sat_reconciliation_updates, _derive_troubleshooting, _detect_rcon_runtime_drift, _normalize_server_contract, _parse_log_line, _parse_log_since, _reject_ws, _resolve_server_root, _safe_resolve, _server_response, _stable_hash, _validate_player_id
from services.server_config_generator import (
    apply_backend_managed_config_fields,
    PERSISTENCE_DISABLED,
    VALID_GAME_KEYS,
    _normalize_navmesh_streaming,
    _normalize_third_person,
    _sanitize_operating,
    _sanitize_persistence,
    attempt_auto_recovery,
    format_mod_for_config,
    generate_reforger_config,
    ensure_required_mods,
    mods_for_config,
    normalize_mod_entry,
    normalize_server_config,
)
from services.docker_agent import _normalize_host_cpu_percent
from services.reforger_orchestrator import ProvisioningResult, StageResult, extract_config_errors
import services.reforger_orchestrator as reforger_orchestrator
from services.reforger_orchestrator import build_container_environment, build_startup_parameters
from services.sat_config_service import normalize_sat_config
from services.server_metrics_collector import _PERIOD_DELTAS


def test_normalize_server_config_upgrades_legacy_flat_shape():
    server = {
        "id": "srv-1",
        "name": "Alpha",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
    }
    normalized = normalize_server_config(
        {
            "name": "Alpha Custom",
            "playerCountLimit": 80,
            "disableThirdPerson": True,
            "VONTransmitCrossFaction": False,
            "missionHeader": {"modes": ["Conflict"]},
        },
        server,
    )

    assert normalized["game"]["name"] == "Alpha Custom"
    assert normalized["game"]["maxPlayers"] == 80
    # Legacy boolean True (TPP was disabled) migrates to the new "DISABLE" enum.
    assert normalized["game"]["gameProperties"]["disableThirdPerson"] == "DISABLE"
    assert normalized["game"]["gameProperties"]["VONCanTransmitCrossFaction"] is False
    assert normalized["game"]["gameProperties"]["missionHeader"] == {"modes": ["Conflict"]}
    assert "missionHeader" not in normalized["game"]  # must NOT be at game level


def test_generate_reforger_config_uses_nested_canonical_shape():
    server = {
        "id": "srv-2",
        "name": "Bravo",
        "ports": {"game": 2201, "query": 18888, "rcon": 21111},
        "environment": {"rcon_password": "secret"},
        "mods": [{"mod_id": "abc", "name": "Server Admin Tools"}],
        "config": {
            "game": {
                "name": "Bravo Live",
                "gameProperties": {
                    "disableThirdPerson": "ENABLE_DRIVER_ONLY",
                    "VONTransmitCrossFaction": False,
                    "missionHeader": {"rotations": [1, 2]},
                },
            }
        },
    }

    generated = generate_reforger_config(server)

    assert generated["game"]["name"] == "Bravo Live"
    assert generated["game"]["gameProperties"]["missionHeader"] == {"rotations": [1, 2]}
    assert "missionHeader" not in generated["game"]  # must NOT be at game level
    assert generated["game"]["gameProperties"]["disableThirdPerson"] == "ENABLE_DRIVER_ONLY"
    assert generated["game"]["gameProperties"]["VONCanTransmitCrossFaction"] is False
    assert generated["bindPort"] == 2201
    assert generated["publicPort"] == 2201
    assert generated["a2s"]["port"] == 18888
    assert generated["rcon"]["port"] == 21111


def test_normalize_third_person_enum_and_legacy_migration():
    # Canonical enum values pass through (case-insensitively).
    assert _normalize_third_person("DISABLE") == "DISABLE"
    assert _normalize_third_person("ENABLE") == "ENABLE"
    assert _normalize_third_person("ENABLE_DRIVER_ONLY") == "ENABLE_DRIVER_ONLY"
    assert _normalize_third_person("enable_driver_only") == "ENABLE_DRIVER_ONLY"
    # Legacy booleans migrate forward.
    assert _normalize_third_person(True) == "DISABLE"
    assert _normalize_third_person(False) == "ENABLE"
    # Unknown / missing values are dropped (key omitted from config).
    assert _normalize_third_person("SOMETIMES") is None
    assert _normalize_third_person(None) is None


def test_normalize_relocates_and_strips_misplaced_game_level_keys():
    # Reproduces a real broken config: disableThirdPerson correctly under
    # gameProperties, but ALSO duplicated directly under game (with a typo'd
    # value) plus an unknown game-level key.  The stray game-level keys make the
    # engine reject the config (additionalProperties:false on game), so they
    # must not survive normalisation.
    raw = {
        "game": {
            "name": "Server 2 - Training",
            "gameProperties": {
                "disableThirdPerson": "ENABLE_DRIVER_ONLY",
                "serverMaxViewDistance": 5000,
            },
            "disableThirdPerson": "ENABLE_DRIVERS_ONLY",  # misplaced + typo
            "totallyBogusKey": 123,
        }
    }

    normalized = normalize_server_config(raw, {"id": "srv", "name": "Server 2 - Training"})
    game = normalized["game"]

    # The correct gameProperties value wins and is preserved.
    assert game["gameProperties"]["disableThirdPerson"] == "ENABLE_DRIVER_ONLY"
    # Neither the misplaced setting nor the junk key survive at the game level.
    assert "disableThirdPerson" not in game
    assert "totallyBogusKey" not in game
    # Only engine-accepted keys remain directly under game.
    assert set(game.keys()) <= VALID_GAME_KEYS


def test_normalize_relocates_lone_game_level_game_property():
    # A gameProperties setting placed ONLY at the game level (no gameProperties
    # copy) is relocated down rather than silently dropped.
    raw = {"game": {"name": "S", "disableThirdPerson": "DISABLE", "serverMaxViewDistance": 4000}}

    normalized = normalize_server_config(raw, {"id": "s", "name": "S"})
    game = normalized["game"]

    assert game["gameProperties"]["disableThirdPerson"] == "DISABLE"
    assert game["gameProperties"]["serverMaxViewDistance"] == 4000
    assert "disableThirdPerson" not in game
    assert "serverMaxViewDistance" not in game


def test_generate_reforger_config_drops_invalid_third_person():
    server = {
        "id": "srv-3",
        "name": "Charlie",
        "ports": {"game": 2401, "query": 19999, "rcon": 22222},
        "config": {"game": {"gameProperties": {"disableThirdPerson": "NONSENSE"}}},
    }

    generated = generate_reforger_config(server)

    assert "disableThirdPerson" not in generated["game"].get("gameProperties", {})


def test_apply_backend_managed_config_fields_preserves_raw_json_payload():
    server = {
        "id": "srv-2b",
        "name": "Bravo",
        "ports": {"game": 2201, "query": 18888, "rcon": 21111},
        "config": {
            "rcon": {
                "password": "server-secret",
                "permission": "monitor",
            }
        },
        "mods": [{"mod_id": "abc", "name": "Server Admin Tools"}],
    }
    raw_config = {
        "bindPort": 9999,
        "publicPort": 9999,
        "game": {
            "name": "Bravo Live",
            "scenarioId": "{ABC}Missions/Custom.conf",
            "mods": [{"modId": "raw-mod", "name": "Raw Mod", "version": "1.2.3"}],
        },
        "rcon": {
            "password": "user-secret",
            "permission": "admin",
            "port": 19999,
        },
    }

    managed = apply_backend_managed_config_fields(raw_config, server)

    assert managed["game"]["name"] == "Bravo Live"
    assert managed["game"]["mods"] == [{"modId": "raw-mod", "name": "Raw Mod", "version": "1.2.3"}]
    assert managed["bindPort"] == 2201
    assert managed["publicPort"] == 2201
    assert managed["a2s"]["port"] == 18888
    assert managed["rcon"]["port"] == 21111
    assert managed["rcon"]["password"] == "server-secret"
    assert managed["rcon"]["permission"] == "monitor"


def test_detect_rcon_runtime_drift_returns_none_when_runtime_matches():
    server = {
        "ports": {"rcon": 21111},
        "config": {
            "rcon": {
                "password": "secret",
                "port": 21111,
                "permission": "admin",
            }
        },
    }

    drift = _detect_rcon_runtime_drift(
        server,
        {
            "RCON_PASSWORD": "secret",
            "RCON_PORT": "21111",
            "RCON_PERMISSION": "admin",
        },
    )

    assert drift is None


def test_detect_rcon_runtime_drift_flags_stale_container_env():
    server = {
        "ports": {"rcon": 21111},
        "config": {
            "rcon": {
                "password": "secret",
                "port": 21111,
                "permission": "admin",
            }
        },
    }

    drift = _detect_rcon_runtime_drift(
        server,
        {
            "RCON_PASSWORD": "old-secret",
            "RCON_PORT": "21111",
            "RCON_PERMISSION": "admin",
        },
    )

    assert drift is not None
    assert drift["code"] == "runtime_drift"
    assert drift["needs_reconfigure"] is True
    assert drift["changed_fields"] == ["password"]


def test_detect_rcon_runtime_drift_treats_missing_runtime_keys_as_reconfigure_needed():
    server = {
        "ports": {"rcon": 21111},
        "config": {
            "rcon": {
                "password": "secret",
                "port": 21111,
                "permission": "admin",
            }
        },
    }

    drift = _detect_rcon_runtime_drift(server, {"RCON_PASSWORD": "secret"})

    assert drift is not None
    assert drift["changed_fields"] == ["permission", "port"]


def test_derive_troubleshooting_prefers_runtime_mounts_for_cd_target():
    server = {
        "id": "srv-3",
        "container_name": "reforger-srv-3",
        "volumes": {
            "/mnt/reforger/srv-3/Configs": "/reforger/Configs",
            "/mnt/reforger/srv-3/profile": "/home/profile",
        },
        "environment": {},
    }
    runtime = {
        "actual_container_name": "reforger-srv-3-real",
        "working_dir": "/reforger",
        "mounts": [
            {"source": "/mnt/reforger/srv-3/Configs", "destination": "/reforger/Configs"},
            {"source": "/mnt/reforger/srv-3/profile", "destination": "/home/profile"},
        ],
    }

    details = _derive_troubleshooting(server, runtime)

    assert details["actual_container_name"] == "reforger-srv-3-real"
    assert details["config_directory"] == "/mnt/reforger/srv-3/Configs"
    assert details["profile_directory"] == "/mnt/reforger/srv-3/profile"
    assert details["cd_target"] == "/mnt/reforger/srv-3/profile"


def test_metrics_period_support_includes_30_days():
    assert _PERIOD_DELTAS["30d"] == timedelta(days=30)


# ── _parse_players_response tests ────────────────────────────────────

from routes.servers import _parse_players_response


def test_parse_players_response_pipe_separated():
    raw = (
        "Players on server:\n"
        "---\n"
        "Name | Ping\n"
        "1 | SomePlayer | 42ms\n"
        "2 | AnotherOne | 120ms\n"
    )
    result = _parse_players_response(raw)
    assert len(result) == 2
    assert result[0]["name"] == "SomePlayer"
    assert result[0]["ping"] == 42
    assert result[1]["name"] == "AnotherOne"
    assert result[1]["ping"] == 120


def test_parse_players_response_empty_and_header_only():
    assert _parse_players_response("") == []
    assert _parse_players_response("Players on server:\n---\n") == []
    assert _parse_players_response(None) == []


def test_parse_players_response_number_prefix_format():
    raw = "1. PlayerAlpha\n2. PlayerBravo\n"
    result = _parse_players_response(raw)
    assert len(result) == 2
    assert result[0]["name"] == "PlayerAlpha"
    assert result[1]["name"] == "PlayerBravo"


# ── normalize idempotency test ───────────────────────────────────────


def test_normalize_server_config_is_idempotent():
    """Normalizing an already-normalized config should produce the same result."""
    server = {
        "id": "srv-4",
        "name": "Charlie",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
    }
    first_pass = normalize_server_config(
        {"game": {"name": "Charlie Custom", "playerCountLimit": 40}},
        server,
    )
    second_pass = normalize_server_config(first_pass, server)
    assert first_pass == second_pass


def test_normalize_server_config_promotes_mixed_shape_root_scenario_id():
    server = {
        "id": "srv-4b",
        "name": "Charlie",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
    }
    normalized = normalize_server_config(
        {
            "scenarioId": "{ROOT000000000001}Missions/RootScenario.conf",
            "game": {"name": "Charlie Custom"},
        },
        server,
    )

    assert normalized["game"]["scenarioId"] == "{ROOT000000000001}Missions/RootScenario.conf"
    assert "scenarioId" not in normalized


def test_normalize_server_config_keeps_nested_scenario_over_stray_root_value():
    server = {
        "id": "srv-4c",
        "name": "Charlie",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
    }
    normalized = normalize_server_config(
        {
            "scenarioId": "{ROOT000000000002}Missions/RootScenario.conf",
            "game": {"scenarioId": "{NEST000000000002}Missions/NestedScenario.conf"},
        },
        server,
    )

    assert normalized["game"]["scenarioId"] == "{NEST000000000002}Missions/NestedScenario.conf"
    assert "scenarioId" not in normalized


# ── mission header validation test ───────────────────────────────────

from routes.servers import _validate_mission_header


def test_validate_mission_header_rejects_non_object():
    with pytest.raises(Exception):
        _validate_mission_header({"game": {"gameProperties": {"missionHeader": "not-an-object"}}})

    with pytest.raises(Exception):
        _validate_mission_header({"game": {"gameProperties": {"missionHeader": [1, 2, 3]}}})

    # Also reject at legacy location
    with pytest.raises(Exception):
        _validate_mission_header({"game": {"missionHeader": "not-an-object"}})


def test_validate_mission_header_accepts_valid_dict():
    # Should not raise — canonical location
    _validate_mission_header({"game": {"gameProperties": {"missionHeader": {"modes": ["Conflict"]}}}})
    _validate_mission_header({"game": {"gameProperties": {"missionHeader": {}}}})
    # Should not raise — legacy location (still accepted for input)
    _validate_mission_header({"game": {"missionHeader": {"modes": ["Conflict"]}}})
    _validate_mission_header({"game": {"missionHeader": {}}})
    _validate_mission_header({})  # no missionHeader at all


# ── format_mod_for_config / mods_for_config tests ───────────────────


def test_format_mod_for_config_emits_only_valid_fields():
    """Only valid Reforger mod fields should appear."""
    mod = {
        "modId": "59673B6FBB95459F",
        "name": "BetterTracers",
        "version": "1.0.5",
        "required": False,
        "author": "SomeAuthor",
        "description": "A mod",
        "thumbnail_url": "https://example.com/img.jpg",
        "tags": ["WEAPON"],
        "metadata_source": "workshop",
    }
    result = format_mod_for_config(mod)
    assert result == {"modId": "59673B6FBB95459F", "name": "BetterTracers", "version": "1.0.5", "required": False}
    assert "author" not in result
    assert "description" not in result
    assert "thumbnail_url" not in result
    assert "tags" not in result


def test_format_mod_for_config_omits_empty_version():
    """An empty or blank version must not appear in the output."""
    assert "version" not in format_mod_for_config({"modId": "AAA", "name": "X", "version": ""})
    assert "version" not in format_mod_for_config({"modId": "AAA", "name": "X", "version": "  "})
    assert "version" not in format_mod_for_config({"modId": "AAA", "name": "X"})


def test_format_mod_for_config_omits_latest_version():
    """Version set to 'latest' (case-insensitive) must be omitted."""
    assert "version" not in format_mod_for_config({"modId": "AAA", "name": "X", "version": "latest"})
    assert "version" not in format_mod_for_config({"modId": "AAA", "name": "X", "version": "Latest"})
    assert "version" not in format_mod_for_config({"modId": "AAA", "name": "X", "version": "LATEST"})


def test_format_mod_for_config_empty_mod_returns_empty():
    """A mod entry without an id should produce an empty dict."""
    assert format_mod_for_config({}) == {}
    assert format_mod_for_config({"name": "NoId"}) == {}


def test_mods_for_config_strips_metadata():
    """mods_for_config should preserve valid mod flags while stripping metadata."""
    mods = [
        {"modId": "59673B6FBB95459F", "name": "BetterTracers", "version": "1.0.5", "author": "Dev"},
        {"modId": "591AF5BDA9F7CE8B", "name": "Capture & Hold", "version": "", "description": "PvP", "required": False},
        {"modId": "5AAAC70D754245DD", "name": "Server Admin Tools"},
    ]
    result = mods_for_config(mods)
    assert len(result) == 3
    assert result[0] == {"modId": "59673B6FBB95459F", "name": "BetterTracers", "version": "1.0.5"}
    assert result[1] == {"modId": "591AF5BDA9F7CE8B", "name": "Capture & Hold", "required": False}  # no version
    assert result[2] == {"modId": "5AAAC70D754245DD", "name": "Server Admin Tools"}
    for entry in result:
        assert "author" not in entry
        assert "description" not in entry


def test_mods_for_config_skips_empty_entries():
    """Entries that produce empty dicts (no mod_id) should be filtered out."""
    mods = [
        {"modId": "59673B6FBB95459F", "name": "BetterTracers"},
        {},
        {"name": "NoId"},
    ]
    result = mods_for_config(mods)
    assert len(result) == 1
    assert result[0]["modId"] == "59673B6FBB95459F"


def test_generate_reforger_config_mods_have_no_metadata():
    """The full config generation path should preserve valid mod flags and strip metadata."""
    server = {
        "id": "srv-mod-test",
        "name": "Test",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "mods": [
            {"mod_id": "59673B6FBB95459F", "name": "BetterTracers", "version": "1.0.5", "author": "Dev"},
            {"mod_id": "591AF5BDA9F7CE8B", "name": "Capture & Hold", "version": "", "required": False},
        ],
    }
    config = generate_reforger_config(server)
    for mod in config["game"]["mods"]:
        assert "modId" in mod
        assert "name" in mod
        assert "author" not in mod
        assert "description" not in mod
    # Version should appear only for BetterTracers
    tracers = [m for m in config["game"]["mods"] if m["modId"] == "59673B6FBB95459F"][0]
    assert tracers["version"] == "1.0.5"
    capture = [m for m in config["game"]["mods"] if m["modId"] == "591AF5BDA9F7CE8B"][0]
    assert "version" not in capture
    assert capture["required"] is False


def test_mod_normalization_canonicalizes_workshop_id_and_thumbnail_alias():
    mod = normalize_mod_entry({
        "modId": "6a4f3ef9908a604f",
        "name": "",
        "thumbnailUrl": "https://cdn.example/mod.png",
        "dependency_of": ["PARENT-MOD"],
    })

    assert mod["modId"] == "6A4F3EF9908A604F"
    assert mod["name"] == "6A4F3EF9908A604F"
    assert mod["thumbnail_url"] == "https://cdn.example/mod.png"
    assert mod["dependency_of"] == ["PARENT-MOD"]


# ── disableNavmeshStreaming normalization tests ──────────────────────


def test_normalize_navmesh_streaming_legacy_true_becomes_empty_array():
    """Legacy ``True`` must be converted to ``[]`` (disable all streaming)."""
    assert _normalize_navmesh_streaming(True) == []


def test_normalize_navmesh_streaming_legacy_false_becomes_none():
    """Legacy ``False`` must be omitted (None = streaming stays enabled)."""
    assert _normalize_navmesh_streaming(False) is None
    assert _normalize_navmesh_streaming(None) is None


def test_normalize_navmesh_streaming_preserves_array():
    """An array value should be kept as-is."""
    assert _normalize_navmesh_streaming([]) == []
    assert _normalize_navmesh_streaming(["Soldier"]) == ["Soldier"]


def test_normalize_navmesh_streaming_tuple_converts_to_list():
    """Tuples should be normalised to lists."""
    assert _normalize_navmesh_streaming(("Soldier",)) == ["Soldier"]


def test_generated_config_omits_navmesh_by_default():
    """Default config should NOT contain disableNavmeshStreaming."""
    server = {"id": "srv-nm", "name": "NM", "ports": {"game": 2001, "query": 17777, "rcon": 19999}}
    config = generate_reforger_config(server)
    assert "disableNavmeshStreaming" not in config.get("operating", {})


def test_generated_config_legacy_true_produces_array():
    """A legacy boolean True in the config should produce an array in output."""
    server = {
        "id": "srv-nm2", "name": "NM2",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "config": {"operating": {"disableNavmeshStreaming": True}},
    }
    config = generate_reforger_config(server)
    assert config["operating"]["disableNavmeshStreaming"] == []


def test_normalize_config_navmesh_is_idempotent():
    """Normalizing with disableNavmeshStreaming=True twice should be stable."""
    server = {"id": "srv-nm3", "name": "NM3", "ports": {"game": 2001, "query": 17777, "rcon": 19999}}
    first = normalize_server_config({"operating": {"disableNavmeshStreaming": True}}, server)
    second = normalize_server_config(first, server)
    assert first == second


# ── _sanitize_operating tests ────────────────────────────────────────


def test_sanitize_operating_drops_unknown_keys():
    """Unknown keys must be stripped."""
    result = _sanitize_operating({"unknownField": True, "lobbyPlayerSynchronise": True})
    assert "unknownField" not in result
    assert result["lobbyPlayerSynchronise"] is True


def test_sanitize_operating_drops_wrong_types():
    """Values with incorrect types must be stripped."""
    result = _sanitize_operating({"lobbyPlayerSynchronise": "yes", "playerSaveTime": "fast"})
    assert "lobbyPlayerSynchronise" not in result
    assert "playerSaveTime" not in result


def test_sanitize_operating_rejects_bool_for_int_fields():
    """Booleans must be rejected for integer-typed keys (bool is subclass of int)."""
    result = _sanitize_operating({"playerSaveTime": True, "aiLimit": False})
    assert "playerSaveTime" not in result
    assert "aiLimit" not in result


def test_sanitize_operating_accepts_valid_int_fields():
    """Proper int values must be accepted."""
    result = _sanitize_operating({"playerSaveTime": 120, "aiLimit": -1})
    assert result["playerSaveTime"] == 120
    assert result["aiLimit"] == -1


def test_sanitize_operating_coerces_legacy_navmesh_bool():
    """Legacy boolean disableNavmeshStreaming must be coerced to array."""
    result = _sanitize_operating({"disableNavmeshStreaming": True})
    assert result["disableNavmeshStreaming"] == []
    # False → omit
    result2 = _sanitize_operating({"disableNavmeshStreaming": False})
    assert "disableNavmeshStreaming" not in result2


# ── persistence tests ────────────────────────────────────────────────


def _server(config):
    return {
        "id": "srv-p", "name": "P",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "environment": {"rcon_password": "secret"},
        "config": config,
    }


def test_persistence_defaults_off_for_new_servers():
    """A server with no persistence config must ship with persistence disabled
    under the engine-correct gameProperties path."""
    generated = generate_reforger_config(_server({}))
    persistence = generated["game"]["gameProperties"]["persistence"]
    assert persistence == PERSISTENCE_DISABLED
    # Must NOT live at the bare game.persistence path (engine ignores it there).
    assert "persistence" not in {k for k in generated["game"] if k != "gameProperties"}


def test_persistence_emitted_under_gameproperties_path():
    """Operator-supplied persistence is written under game.gameProperties.persistence."""
    generated = generate_reforger_config(_server({
        "game": {"gameProperties": {"persistence": {"loadSessionSave": True, "autoSaveInterval": 5}}},
    }))
    persistence = generated["game"]["gameProperties"]["persistence"]
    assert persistence["loadSessionSave"] is True
    assert persistence["autoSaveInterval"] == 5
    assert "persistence" not in {k for k in generated["game"] if k != "gameProperties"}


def test_persistence_legacy_path_is_migrated():
    """A legacy game.persistence block must be folded into gameProperties."""
    generated = generate_reforger_config(_server({
        "game": {"persistence": {"loadSessionSave": True, "hiveId": 7}},
    }))
    persistence = generated["game"]["gameProperties"]["persistence"]
    assert persistence["loadSessionSave"] is True
    assert persistence["hiveId"] == 7
    assert "persistence" not in {k for k in generated["game"] if k != "gameProperties"}


def test_persistence_disable_toggle_round_trips():
    """An explicit disabled persistence block must survive normalization unchanged."""
    config = {"game": {"gameProperties": {"persistence": dict(PERSISTENCE_DISABLED)}}}
    first = normalize_server_config(config, _server({}))
    second = normalize_server_config(first, _server({}))
    assert first["game"]["gameProperties"]["persistence"] == PERSISTENCE_DISABLED
    assert second == first


def test_sanitize_persistence_clamps_and_filters():
    """Ranges are clamped; booleans only kept when explicitly boolean."""
    result = _sanitize_persistence({
        "autoSaveInterval": 999,
        "saveRetention": 0,
        "hiveId": -5,
        "loadSessionSave": "yes",  # wrong type → dropped
        "keepSessionSave": True,
    })
    assert result["autoSaveInterval"] == 60
    assert result["saveRetention"] == 1
    assert result["hiveId"] == 0
    assert "loadSessionSave" not in result
    assert result["keepSessionSave"] is True


# ── auto-recovery tests ──────────────────────────────────────────────


def test_auto_recovery_fixes_type_mismatch():
    """Auto-recovery should fix a type-mismatch error in the config."""
    server = {
        "id": "srv-ar", "name": "AR",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "config": {"operating": {"disableNavmeshStreaming": True}},
    }
    error_msg = 'Param "#/operating/disableNavmeshStreaming" has an incorrect type. Expected "array", but the value is "boolean"'
    recovered, descs = attempt_auto_recovery(server, error_msg)
    assert recovered is True
    assert len(descs) >= 1
    # After recovery, the config should have an array
    assert isinstance(server["config"]["operating"]["disableNavmeshStreaming"], list)


def test_auto_recovery_returns_false_for_unknown_errors():
    """Auto-recovery should return False for errors it can't fix."""
    server = {
        "id": "srv-ar2", "name": "AR2",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "config": {},
    }
    recovered, descs = attempt_auto_recovery(server, "Some random engine error")
    assert recovered is False
    assert descs == []


# ── extract_config_errors tests ──────────────────────────────────────


def test_extract_config_errors_finds_type_errors():
    """Should detect type-mismatch error lines in container logs."""
    logs = (
        '2026-04-03T08:04:25.647Z BACKEND (E): Param "#/operating/disableNavmeshStreaming" has an incorrect type. Expected "array", but the value is "boolean"\n'
        '2026-04-03T08:04:25.647Z BACKEND (E): JSON is invalid!\n'
        '2026-04-03T08:04:25.647Z BACKEND (E): There are errors in server config!\n'
        '2026-04-03T08:04:25.647Z ENGINE : Normal log line\n'
    )
    errors = extract_config_errors(logs)
    assert len(errors) == 3
    assert any("incorrect type" in e for e in errors)
    assert any("JSON is invalid" in e for e in errors)
    assert any("errors in server config" in e for e in errors)


def test_extract_config_errors_returns_empty_for_clean_logs():
    """Clean logs should produce no config errors."""
    assert extract_config_errors("") == []
    assert extract_config_errors("Game started\nScenario loaded\n") == []


def test_normalize_server_contract_upgrades_legacy_partial_status():
    server = {
        "status": "provisioning_partial",
        "readiness_state": "ready",
        "provisioning_stages": {
            "sat_discovery": {"name": "sat_discovery", "status": "failed", "error": "missing config"},
        },
    }
    normalized = _normalize_server_contract(server)
    assert normalized["status"] == "running"
    assert normalized["provisioning_state"] == "warning"
    assert normalized["readiness_state"] == "ready"
    assert normalized["provisioning_warnings"][0]["stage"] == "sat_discovery"


def test_server_response_redacts_config_passwords_and_drops_stored_credentials():
    server = {
        "id": "srv-1",
        "config": {
            "rcon": {"password": "rcon-secret", "port": 19999},
            "game": {"password": "join-secret", "passwordAdmin": "admin-secret", "name": "Op Server"},
        },
        "admin_credentials": [
            {"id": "c1", "label": "Host Panel", "username": "root", "value": "panel-pw", "notes": "OVH"},
            {"id": "c2", "label": "No secret set", "username": "root", "value": "", "notes": ""},
        ],
    }
    doc = _server_response(server)
    assert doc["config"]["rcon"]["password"] == "***"
    assert doc["config"]["rcon"]["port"] == 19999
    assert doc["config"]["game"]["password"] == "***"
    assert doc["config"]["game"]["passwordAdmin"] == "***"
    assert doc["config"]["game"]["name"] == "Op Server"
    assert "admin_credentials" not in doc


def test_provisioning_result_reports_running_when_container_started():
    result = ProvisioningResult(
        stages=[
            StageResult(name="container_creation", status="success"),
            StageResult(name="initial_startup", status="success"),
            StageResult(name="sat_discovery", status="failed"),
        ]
    )
    assert result.container_started is True
    assert result.overall_status == "running"
    assert result.readiness_state == "degraded"
    assert "follow-up stages need attention" in result.summary_message


def test_log_helpers_build_structured_entries_and_parse_since():
    logs = "2026-04-03T10:00:00Z Engine ready\n2026-04-03T10:00:05Z Scenario loaded"
    entries = _build_log_entries(logs)
    assert len(entries) == 2
    assert entries[0]["timestamp"] == "2026-04-03T10:00:00Z"
    assert entries[0]["line"] == "Engine ready"
    assert entries[0]["source"] == "docker"
    assert _parse_log_since("2026-04-03T10:00:05Z") == 1775210405
    assert _parse_log_since("1775210405") == 1775210405


def test_log_helpers_suppress_stock_thermal_profile_warning_pair():
    logs = "\n".join([
        "2026-08-27T12:00:00Z Engine ready",
        '2026-08-27T12:00:01Z RESOURCES    : GetResourceObject @"{CC547D988287BF7C}system/thermal/thermalProfileDefault.conf"',
        "2026-08-27T12:00:01Z RESOURCES (E): Failed to open",
        "2026-08-27T12:00:02Z Scenario loaded",
    ])

    entries = _build_log_entries(logs)

    assert [entry["line"] for entry in entries] == ["Engine ready", "Scenario loaded"]


def test_log_helpers_preserve_unrelated_resource_failure_pair():
    logs = "\n".join([
        'RESOURCES    : GetResourceObject @"{AAAAAAAAAAAAAAAA}some/mod/missingResource.conf"',
        "RESOURCES (E): Failed to open",
    ])

    entries = _build_log_entries(logs)

    assert [entry["line"] for entry in entries] == logs.splitlines()


def test_log_noise_filter_tracks_pair_across_stream_chunks_and_resets():
    from services.server_logs import KnownLogNoiseFilter, build_log_entries

    noise_filter = KnownLogNoiseFilter()
    lookup = 'RESOURCES : GetResourceObject @"{CC547D988287BF7C}system/thermal/thermalProfileDefault.conf"'

    assert build_log_entries(lookup, noise_filter=noise_filter) == []
    assert build_log_entries(
        "RESOURCES (E): Failed to open",
        noise_filter=noise_filter,
    ) == []

    entries = build_log_entries(
        "RESOURCES (E): Failed to open",
        noise_filter=noise_filter,
    )
    assert [entry["line"] for entry in entries] == ["RESOURCES (E): Failed to open"]


def test_log_noise_filter_does_not_hide_generic_error_after_intervening_line():
    logs = "\n".join([
        'RESOURCES : GetResourceObject @"{CC547D988287BF7C}system/thermal/thermalProfileDefault.conf"',
        "WORLD        : Loading terrain",
        "RESOURCES (E): Failed to open",
    ])

    entries = _build_log_entries(logs)

    assert [entry["line"] for entry in entries] == [
        "WORLD        : Loading terrain",
        "RESOURCES (E): Failed to open",
    ]


def test_profile_log_history_suppresses_thermal_warning_pair(tmp_path):
    from services.server_logs import _read_recent_file_records

    log_path = tmp_path / "console.log"
    log_path.write_text("\n".join([
        "Engine ready",
        'RESOURCES : GetResourceObject @"{CC547D988287BF7C}system/thermal/thermalProfileDefault.conf"',
        "RESOURCES (E): Failed to open",
        "Scenario loaded",
    ]), encoding="utf-8")

    records = _read_recent_file_records(log_path, tail=10)

    assert records == [(0, "Engine ready"), (3, "Scenario loaded")]


def test_parse_log_since_handles_docker_nanosecond_timestamps():
    """Docker returns RFC 3339 Nano (9 frac digits); fromisoformat only handles 6."""
    nano_ts = "2026-04-03T10:00:05.123456789Z"
    result = _parse_log_since(nano_ts)
    assert result == 1775210405, f"Expected 1775210405, got {result}"


def test_reject_ws_accepts_before_closing():
    class FakeWebSocket:
        def __init__(self):
            self.accept_calls = 0
            self.closed = []

        async def accept(self):
            self.accept_calls += 1

        async def close(self, code: int, reason: str):
            self.closed.append((code, reason))

    websocket = FakeWebSocket()

    asyncio.run(_reject_ws(websocket, 4001, "Authentication required"))

    assert websocket.accept_calls == 1
    assert websocket.closed == [(4001, "Authentication required")]


def test_parse_log_line_rejects_non_iso_first_token():
    """Lines whose first word is not an ISO timestamp must NOT be split."""
    entry = _parse_log_line("Traceback (most recent call last)", 0)
    # The full raw line should be in 'line', not just the suffix
    assert entry["line"] == "Traceback (most recent call last)"
    assert entry["raw"] == "Traceback (most recent call last)"


def test_parse_log_line_accepts_docker_iso_timestamp():
    """Lines prefixed with an ISO timestamp should be split correctly."""
    entry = _parse_log_line("2026-04-03T10:00:00.000000000Z Engine started", 0)
    assert entry["timestamp"] == "2026-04-03T10:00:00.000000000Z"
    assert entry["line"] == "Engine started"


def test_log_cursor_is_stable_across_calls():
    """Log cursors must not change between calls (no process-salted hash)."""
    entry_a = _parse_log_line("2026-04-03T10:00:00Z Engine ready", 0)
    entry_b = _parse_log_line("2026-04-03T10:00:00Z Engine ready", 0)
    assert entry_a["cursor"] == entry_b["cursor"], "cursor changed between calls"
    # Stable hash is an 8-char hex string
    raw_hash = _stable_hash("hello")
    assert len(raw_hash) == 8
    assert all(ch in "0123456789abcdef" for ch in raw_hash)


def test_prepare_server_deployment_marks_server_created(monkeypatch):
    server = {
        "id": "srv-prep",
        "name": "Prep",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "log_stats_enabled": True,
        "max_fps": 120,
        "startup_parameters": [],
    }

    async def fake_ensure_filesystem(_server):
        return None

    async def fake_write_config_file(_server):
        return True, "C:/reforger/srv-prep/Configs/server-config.json"

    async def fake_ensure_container(_server):
        return {
            "container_id": "container-123",
            "environment": {"ARMA_CONFIG": "server-config.json"},
            "volumes": {"C:/reforger/srv-prep/profile": "/home/profile"},
            "last_known_container_status": "created",
        }

    monkeypatch.setattr(reforger_orchestrator, "ensure_filesystem", fake_ensure_filesystem)
    monkeypatch.setattr(reforger_orchestrator, "write_config_file", fake_write_config_file)
    monkeypatch.setattr(reforger_orchestrator, "ensure_container", fake_ensure_container)

    updates = asyncio.run(reforger_orchestrator.prepare_server_deployment(server))

    assert updates["deployment_state"] == "created"
    assert updates["status"] == "created"
    assert updates["provisioning_state"] == "queued"
    assert updates["summary_message"].startswith("Server container created successfully")
    assert updates["provisioning_stages"]["container_creation"]["status"] == "success"


def test_player_id_validation_rejects_whitespace_and_control_chars():
    import pytest
    # Valid IDs
    _validate_player_id("76561198012345678")
    _validate_player_id("ABCDEF1234567890")
    _validate_player_id("player-abc.123_xyz")
    # Invalid IDs
    with pytest.raises(ValueError):
        _validate_player_id("")
    with pytest.raises(ValueError):
        _validate_player_id("player id with spaces")
    with pytest.raises(ValueError):
        _validate_player_id("player\nid")
    with pytest.raises(ValueError):
        _validate_player_id("player\x00id")
    with pytest.raises(ValueError):
        # Too long (> 128 chars)
        _validate_player_id("A" * 129)


def test_cpu_normalization_scales_multicore_usage_to_host_percent():
    assert _normalize_host_cpu_percent(250.0, 4) == 62.5


def test_normalize_sat_config_dedupes_admins_bans_and_messages():
    normalized = normalize_sat_config({
        "admins": [
            {"id": "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", "name": "Insane"},
            {"playerId": "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", "label": "Insane Updated"},
            {"guid": "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "name": "LtLast"},
        ],
        "bans": [
            {"playerId": "00000000-0000-0000-0000-000000000002", "reason": "First reason"},
            {"id": "00000000-0000-0000-0000-000000000002", "reason": "Replacement reason"},
            "00000000-0000-0000-0000-000000000003",
        ],
        "serverMessage": [
            "Alpha",
            "Alpha",
            " Bravo ",
            "",
        ],
        "eventsApiEventsEnabled": "event_a\nevent_b\nevent_a\n",
    })

    assert normalized["admins"] == {
        "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d": "Insane Updated",
        "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e": "LtLast",
    }
    assert normalized["bans"] == {
        "00000000-0000-0000-0000-000000000002": "Replacement reason",
        "00000000-0000-0000-0000-000000000003": "",
    }
    assert normalized["serverMessage"] == ["Alpha", "Bravo"]
    assert normalized["eventsApiEventsEnabled"] == ["event_a", "event_b"]


def test_normalize_sat_config_dedupes_message_objects_by_payload():
    normalized = normalize_sat_config({
        "repeatedChatMessages": [
            {"message": " Status check ", "intervalMinutes": 15},
            {"message": "Status check", "intervalMinutes": 15},
            {"message": "", "intervalMinutes": 30},
        ],
        "scheduledChatMessages": [
            {"message": "Server restart soon", "hour": 22, "minute": 0},
            {"message": "Server restart soon", "hour": 22, "minute": 0},
            {"message": "Other message", "hour": 23, "minute": 30},
        ],
    })

    assert normalized["repeatedChatMessages"] == [
        {"message": "Status check", "intervalMinutes": 15},
    ]
    assert normalized["scheduledChatMessages"] == [
        {"message": "Server restart soon", "hour": 22, "minute": 0},
        {"message": "Other message", "hour": 23, "minute": 30},
    ]


def test_build_container_environment_includes_rcon_port():
    """Container env should expose RCON_PORT matching the server's allocated port."""
    server = {
        "id": "srv-rcon-port",
        "name": "RCON Port Test",
        "ports": {"game": 2011, "query": 17787, "rcon": 20009},
        "config": {
            "rcon": {"password": "testpass", "permission": "admin"},
            "game": {"scenarioId": "{ECC61978EDCC2B5A}Missions/23_campaign.conf"},
        },
        "mods": [],
        "max_fps": 60,
        "startup_parameters": [],
    }
    env = build_container_environment(server)
    assert env["RCON_PORT"] == "20009"
    assert env["RCON_PASSWORD"] == "testpass"
    assert env["RCON_PERMISSION"] == "admin"


def test_build_container_environment_rcon_port_uses_default_when_missing():
    """When no RCON port is configured, RCON_PORT env should default to 19999."""
    server = {
        "id": "srv-rcon-default",
        "name": "Default RCON",
        "ports": {"game": 2001, "query": 17777},
        "config": {
            "game": {"scenarioId": "{ECC61978EDCC2B5A}Missions/23_campaign.conf"},
        },
        "mods": [],
        "max_fps": 120,
        "startup_parameters": [],
    }
    env = build_container_environment(server)
    assert env["RCON_PORT"] == "19999"


def test_build_startup_parameters_cannot_reenable_nothrow():
    parameters = build_startup_parameters({
        "log_stats_enabled": False,
        "startup_parameters": ["-backendlog", "-nothrow", "-NoThrow", "-loadSessionSave"],
    })

    assert parameters == ["-backendlog", "-loadSessionSave"]


def test_build_startup_parameters_logs_stats_once_a_minute():
    # A bare -logstats writes three log lines every second, which filled the logs.
    parameters = build_startup_parameters({
        "startup_parameters": ["-logStats 1000", "-backendlog"],
    })

    assert parameters == ["-logstats 60000", "-backendlog"]


# ── Reforger networkViewDistance unlock (config-schema patch) ─────────────────

def _runtime_server(server_id="srv-runtime"):
    return {
        "id": server_id,
        "name": "Runtime",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "config": {"rcon": {"password": "p", "permission": "admin"}},
        "mods": [],
        "max_fps": 60,
        "startup_parameters": [],
    }


def test_runtime_update_aborts_before_replacement_when_persistent_mount_is_missing(monkeypatch):
    server = reforger_orchestrator.apply_runtime_defaults(_runtime_server("srv-unsafe-mount"))

    class UnsafeMountDocker:
        async def inspect_container(self, _name):
            return {
                "mounts": [
                    {"Destination": "/reforger/Configs", "Source": str(Path(server["config_path"]).parent)},
                    {"Destination": "/home/profile", "Source": server["profile_path"]},
                    # workshop is deliberately absent: removing this container
                    # could discard data that was not persisted correctly.
                ]
            }

    monkeypatch.setattr(reforger_orchestrator, "docker_agent", UnsafeMountDocker())

    with pytest.raises(reforger_orchestrator.ProvisioningError, match="workshop"):
        asyncio.run(reforger_orchestrator.verify_persistent_container_mounts(server))


class _FakeDockerForFix:
    def __init__(self, *, container, env=None, status=None, pull_ok=True):
        self._container = container
        self._env = env or {}
        self._status = status or {}
        self.pull_ok = pull_ok
        self.removed = False
        self.started = False
        self.events = []

    async def get_container(self, name):
        return self._container

    async def get_container_environment(self, name):
        return self._env

    async def get_container_status(self, name):
        return self._status

    async def pull_image(self, image):
        self.events.append(("pull", image))
        return (True, None) if self.pull_ok else (False, "pull failed")

    async def remove_container(self, name, force=False):
        self.removed = True
        self.events.append(("remove", name))
        return True, None

    async def start_existing_container(self, name):
        self.started = True
        self.events.append(("start", name))
        return True, None


def _patch_fix_deps(monkeypatch, fake_docker):
    async def fake_ensure_fs(_server):
        return None

    async def fake_verify_mounts(_server):
        return None

    async def fake_write(_server):
        raise AssertionError("runtime-only updates must not rewrite the server config")

    async def fake_ensure_container(_server):
        return {"container_id": "new-id", "environment": {}, "volumes": {}}

    monkeypatch.setattr(reforger_orchestrator, "docker_agent", fake_docker)
    monkeypatch.setattr(reforger_orchestrator, "ensure_filesystem", fake_ensure_fs)
    monkeypatch.setattr(reforger_orchestrator, "verify_persistent_container_mounts", fake_verify_mounts)
    monkeypatch.setattr(reforger_orchestrator, "write_config_file", fake_write)
    monkeypatch.setattr(reforger_orchestrator, "ensure_container", fake_ensure_container)


def test_update_server_runtime_pulls_before_recreate_and_restores_running_state(monkeypatch):
    fake = _FakeDockerForFix(container=object(), status={"running": True})
    _patch_fix_deps(monkeypatch, fake)

    res = asyncio.run(reforger_orchestrator.update_server_runtime(_runtime_server("srv-update")))

    assert res["action"] == "recreated"
    assert res["was_running"] is True
    assert [event[0] for event in fake.events] == ["pull", "remove", "start"]


def test_update_server_runtime_leaves_stopped_server_stopped(monkeypatch):
    fake = _FakeDockerForFix(container=object(), status={"running": False})
    _patch_fix_deps(monkeypatch, fake)

    res = asyncio.run(reforger_orchestrator.update_server_runtime(_runtime_server("srv-stopped-update")))

    assert res["was_running"] is False
    assert fake.removed is True
    assert fake.started is False


def test_update_server_runtime_keeps_container_when_image_pull_fails(monkeypatch):
    fake = _FakeDockerForFix(container=object(), status={"running": True}, pull_ok=False)
    _patch_fix_deps(monkeypatch, fake)

    with pytest.raises(reforger_orchestrator.ProvisioningError, match="pull failed"):
        asyncio.run(reforger_orchestrator.update_server_runtime(_runtime_server("srv-pull-fail")))

    assert fake.removed is False
    assert fake.started is False


class _FakeServersColl:
    def __init__(self, docs):
        self.docs = docs
        self.updated = []

    def find(self, query=None, projection=None):
        return _FakeCursor(self.docs)

    async def update_one(self, query, update):
        self.updated.append((query, update))
        return None


class _FakeManagedServersCollection:
    def __init__(self, server):
        self.server = server

    async def find_one(self, query, projection=None):
        if not self.server or query.get("id") != self.server.get("id"):
            return None
        return self.server

    async def update_one(self, query, update):
        if not self.server or query.get("id") != self.server.get("id"):
            return None
        for key, value in (update.get("$set") or {}).items():
            self.server[key] = value
        for key, value in (update.get("$push") or {}).items():
            self.server.setdefault(key, []).append(value)
        return None


def test_update_runtime_endpoint_preserves_mods_config_and_stopped_state(monkeypatch):
    original_config = {"game": {"scenarioId": "{ABC}Missions/Test.conf"}, "rcon": {"password": "secret"}}
    original_mods = [{"mod_id": "A", "name": "Original Mod", "version": "1.2.3"}]
    server = {
        "id": "srv-preserve",
        "name": "Preserve Me",
        "status": "stopped",
        "docker_image": "example/reforger:latest",
        "config": json.loads(json.dumps(original_config)),
        "mods": json.loads(json.dumps(original_mods)),
    }
    collection = _FakeManagedServersCollection(server)
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(managed_servers=collection))

    async def no_gate(**kwargs):
        return None

    async def no_op(*args, **kwargs):
        return None

    async def fake_update_runtime(current):
        assert current["config"] == original_config
        assert current["mods"] == original_mods
        return {
            "server_id": current["id"],
            "action": "recreated",
            "was_running": False,
            "image_pulled": True,
            "container_id": "replacement",
            "environment": {"ARMA_CONFIG": "server-config.json"},
            "volumes": {"/host/Configs": "/reforger/Configs"},
        }

    monkeypatch.setattr(server_routes, "log_audit", no_op)
    monkeypatch.setattr(server_routes, "sync_server_notifications", no_op)
    monkeypatch.setattr(server_routes, "orchestrator_update_server_runtime", fake_update_runtime)

    result = asyncio.run(server_routes.update_server_runtime("srv-preserve", current_user={"id": "operator"}))

    assert result["status"] == "stopped"
    assert result["preserved"] == ["config", "profile", "workshop_mods", "database_settings"]
    assert server["config"] == original_config
    assert server["mods"] == original_mods
    assert server["status"] == "stopped"


class _FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, limit):
        return list(self.docs)


class _FakeQueryableCollection:
    def __init__(self, docs):
        self.docs = docs

    def find(self, query=None, projection=None):
        docs = list(self.docs)
        if query and "mod_id" in query:
            allowed = set((query.get("mod_id") or {}).get("$in") or [])
            docs = [doc for doc in docs if doc.get("mod_id") in allowed]
        return _FakeCursor(docs)


class _FakeManagedServersCollectionById:
    def __init__(self, servers):
        self.servers = {server["id"]: server for server in servers}

    async def find_one(self, query, projection=None):
        server = self.servers.get(query.get("id"))
        return server

    async def update_one(self, query, update):
        server = self.servers.get(query.get("id"))
        if not server:
            return None
        for key, value in (update.get("$set") or {}).items():
            server[key] = value
        for key, value in (update.get("$push") or {}).items():
            server.setdefault(key, []).append(value)
        return None


class _FakeInsertCollection:
    def __init__(self):
        self.docs = []

    async def insert_one(self, doc):
        self.docs.append(doc)
        return SimpleNamespace(inserted_id=doc.get("id"))


def test_get_server_scenarios_includes_shared_library_entries(monkeypatch):
    server = {
        "id": "srv-scenarios",
        "mods": [{"mod_id": "mod-enabled", "name": "Enabled Mod"}],
        "custom_scenarios": ["{LOCAL000000000001}Missions/LocalOnly.conf"],
    }
    shared_docs = [
        {
            "scenario_id": "{SHARED0000000001}Missions/SharedEnabled.conf",
            "name": "Shared Enabled",
            "mod_id": "mod-enabled",
            "mod_name": "Enabled Mod",
        },
        {
            "scenario_id": "{SHARED0000000002}Missions/SharedMissing.conf",
            "name": "Shared Missing",
            "mod_id": "mod-missing",
            "mod_name": "Missing Mod",
        },
    ]
    workshop_docs = [
        {
            "mod_id": "mod-enabled",
            "name": "Enabled Mod",
            "scenarios": [
                {
                    "scenario_id": "{MOD0000000000001}Missions/Enabled.conf",
                    "name": "Enabled Scenario",
                },
            ],
        },
    ]

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(
            managed_servers=_FakeManagedServersCollection(server),
            shared_server_scenarios=_FakeQueryableCollection(shared_docs),
            workshop_mods=_FakeQueryableCollection(workshop_docs),
        ),
    )

    result = asyncio.run(server_routes.get_server_scenarios("srv-scenarios", current_user={"id": "tester"}))

    assert [scenario["name"] for scenario in result["shared"]] == ["Shared Enabled", "Shared Missing"]
    assert result["shared"][0]["available_on_server"] is True
    assert result["shared"][1]["available_on_server"] is False
    assert result["mod"][0]["id"] == "{MOD0000000000001}Missions/Enabled.conf"
    assert result["custom"][0]["id"] == "{LOCAL000000000001}Missions/LocalOnly.conf"


def test_enrich_mods_backfills_thumbnail_from_workshop_cache(monkeypatch):
    """Mods added before icons existed have no thumbnail_url; it is backfilled
    on read from the workshop_mods cache without clobbering explicit values."""
    server = {
        "id": "srv-icons",
        "mods": [
            {"mod_id": "mod-old", "name": "Old Mod"},  # pre-icon: no thumbnail
            {"mod_id": "mod-pinned", "name": "Pinned Name", "thumbnail_url": "https://cdn/keep.png"},
            {"mod_id": "6a4f3ef9908a604f", "name": "6a4f3ef9908a604f"},
            {"mod_id": "mod-unknown", "name": "Unknown"},  # not in cache
        ],
    }
    workshop_docs = [
        {"mod_id": "mod-old", "name": "Old Mod Canonical", "author": "Acme", "thumbnail_url": "https://cdn/old.png"},
        {"mod_id": "mod-pinned", "name": "Other", "thumbnail_url": "https://cdn/other.png"},
        {"mod_id": "6A4F3EF9908A604F", "name": "Map Graphics", "thumbnail_url": "https://cdn/mod.png"},
    ]

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(workshop_mods=_FakeQueryableCollection(workshop_docs)),
    )

    scheduled: set[str] = set()
    monkeypatch.setattr(server_routes, "_schedule_workshop_backfill", scheduled.update)

    result = asyncio.run(server_routes._enrich_mods_with_workshop_metadata(server))
    by_id = {m["mod_id"]: m for m in result["mods"]}

    # Missing thumbnail + author filled; existing name preserved.
    assert by_id["mod-old"]["thumbnail_url"] == "https://cdn/old.png"
    assert by_id["mod-old"]["author"] == "Acme"
    assert by_id["mod-old"]["name"] == "Old Mod"
    # Explicit thumbnail is never overwritten.
    assert by_id["mod-pinned"]["thumbnail_url"] == "https://cdn/keep.png"
    assert by_id["mod-pinned"]["name"] == "Pinned Name"
    assert by_id["6A4F3EF9908A604F"]["name"] == "Map Graphics"
    assert by_id["6A4F3EF9908A604F"]["thumbnail_url"] == "https://cdn/mod.png"
    # Mod absent from the cache is untouched.
    assert "thumbnail_url" not in by_id["mod-unknown"]
    # A mod still without a logo (cache miss) is queued for a background scrape
    # so however it was ingested (mirror/manual/import) it self-heals on re-read.
    assert "mod-unknown" in scheduled
    assert "mod-old" not in scheduled  # filled from cache, no scrape needed
    assert "mod-pinned" not in scheduled  # has an explicit thumbnail


def test_sync_workshop_metadata_does_not_replace_real_label_with_imported_id(monkeypatch):
    class RecordingCollection:
        def __init__(self, doc=None):
            self.doc = dict(doc or {})

        async def find_one(self, query, projection=None):
            return dict(self.doc) if self.doc else None

        async def update_one(self, query, update, upsert=False):
            self.doc.update(update.get("$set") or {})

    fetched = {
        "mod_id": "6A4F3EF9908A604F",
        "name": "Map Graphics",
        "thumbnail_url": "https://cdn/mod.png",
        "dependencies_verified": True,
    }
    workshop = RecordingCollection(fetched)
    history = RecordingCollection()
    live_fetch = AsyncMock(side_effect=AssertionError("save path must not fetch live Workshop metadata"))
    monkeypatch.setattr("services.workshop_ingest.fetch_and_store_mod", live_fetch)
    scheduled = set()
    monkeypatch.setattr(server_routes, "_schedule_workshop_backfill", scheduled.update)
    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(workshop_mods=workshop, mod_download_history=history),
    )

    asyncio.run(server_routes._sync_workshop_mod_metadata(
        "srv-import",
        [{"modId": "6A4F3EF9908A604F", "name": "6A4F3EF9908A604F"}],
        {"id": "operator", "username": "Operator"},
    ))

    assert workshop.doc["name"] == "Map Graphics"
    assert workshop.doc["thumbnail_url"] == "https://cdn/mod.png"
    live_fetch.assert_not_awaited()
    assert scheduled == set()


def test_activate_server_scenario_updates_nested_game_scenario(monkeypatch):
    server = {
        "id": "srv-activate",
        "name": "Scenario Activation",
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "config": {
            "scenarioId": "{LEGACY0000000001}Missions/LegacyRoot.conf",
            "game": {"name": "Activation Test"},
        },
    }
    captured = {}

    async def fake_update_server(server_id, body, current_user):
        captured["server_id"] = server_id
        captured["config"] = body.config
        captured["current_user"] = current_user
        return {"ok": True}

    monkeypatch.setattr(server_routes, "update_server", fake_update_server)
    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )

    result = asyncio.run(
        server_routes.activate_server_scenario(
            "srv-activate",
            server_routes.ScenarioActivationRequest(
                scenario_id="{NEW0000000000001}Missions/NewScenario.conf",
            ),
            current_user={"id": "tester"},
        ),
    )

    assert result == {"ok": True}
    assert captured["server_id"] == "srv-activate"
    assert captured["config"]["game"]["scenarioId"] == "{NEW0000000000001}Missions/NewScenario.conf"
    assert "scenarioId" not in captured["config"]


def test_update_server_syncs_mods_from_raw_json(monkeypatch):
    server = {
        "id": "srv-raw-json",
        "name": "Raw JSON Sync",
        "sat_enabled": False,
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "profile_path": "",
        "config_path": "C:/tmp/server.json",
        "config_history": [],
        "mods": [{"modId": "OLDMOD", "name": "Old Mod", "version": "0.9.0"}],
        "config": {
            "game": {
                "name": "Raw JSON Sync",
                "scenarioId": "{OLD0000000000001}Missions/Old.conf",
                "mods": [{"modId": "OLDMOD", "name": "Old Mod", "version": "0.9.0"}],
            },
            "rcon": {
                "password": "secret",
                "permission": "admin",
            },
        },
    }

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )
    monkeypatch.setattr(server_routes, "discover_sat_config", lambda profile_path: ("", "not_applicable"))
    monkeypatch.setattr(server_routes, "log_audit", lambda **kwargs: asyncio.sleep(0))
    monkeypatch.setattr(server_routes, "sync_server_notifications", lambda updated: asyncio.sleep(0))
    monkeypatch.setattr(server_routes, "_server_response", lambda updated: updated)

    async def fake_write_config_file(server_doc, config_dir=None, *, config=None):
        return True, "C:/tmp/server.json"

    monkeypatch.setattr(server_routes, "write_config_file", fake_write_config_file)

    result = asyncio.run(
        server_routes.update_server(
            "srv-raw-json",
            server_routes.ServerUpdate(
                config={
                    "game": {
                        "name": "Raw JSON Sync",
                        "scenarioId": "{NEW0000000000001}Missions/New.conf",
                        "mods": [{"modId": "NEWMOD", "name": "New Mod", "version": "1.2.3"}],
                    }
                },
            ),
            current_user={"id": "tester"},
        ),
    )

    assert result["mods"] == [{"modId": "NEWMOD", "name": "New Mod", "version": "1.2.3"}]
    assert result["config"]["game"]["mods"] == [{"modId": "NEWMOD", "name": "New Mod", "version": "1.2.3"}]


def test_mirror_server_mods_preserves_target_system_managed_and_runtime_fields(monkeypatch):
    source = {
        "id": "operations",
        "name": "Operations",
        "mods": [
            {"mod_id": "SRC1", "name": "Source One", "version": "1.0.0", "enabled": True},
            {"modId": "SRC2", "name": "Source Two", "version": "2.0.0", "enabled": False},
            {"mod_id": "SRC-SYS", "name": "Source System", "system_managed": True},
        ],
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "config": {},
    }
    target = {
        "id": "training",
        "name": "Training",
        "mods": [
            {"mod_id": "TARGET-SYS", "name": "Target System", "system_managed": True, "enabled": True},
            {"mod_id": "TARGET-EDIT", "name": "Target Editable", "enabled": True},
        ],
        "ports": {"game": 2011, "query": 17787, "rcon": 20009},
        "container_name": "training-container",
        "container_id": "runtime-container-id",
        "docker_image": "target-image",
        "environment": {"RCON_PASSWORD": "target-secret"},
        "volumes": {"C:/target": "/profile"},
        "config": {},
        "sat_enabled": False,
    }
    backups = _FakeInsertCollection()
    captured_write_docs = []

    async def fake_write_config_file(server_doc, config_dir=None, *, config=None):
        captured_write_docs.append(server_doc)
        return True, "C:/target/server.json"

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(
            managed_servers=_FakeManagedServersCollectionById([source, target]),
            server_backups=backups,
        ),
    )
    monkeypatch.setattr(server_routes, "write_config_file", fake_write_config_file)
    monkeypatch.setattr(server_routes, "_sync_workshop_mod_metadata", lambda *args, **kwargs: asyncio.sleep(0))
    monkeypatch.setattr(server_routes, "log_audit", lambda **kwargs: asyncio.sleep(0))
    monkeypatch.setattr(server_routes, "sync_server_notifications", lambda updated: asyncio.sleep(0))

    async def failed_restart(*args, **kwargs):
        raise RuntimeError("Container restart was refused")

    monkeypatch.setattr(server_routes, "restart_server", failed_restart)

    result = asyncio.run(server_routes.mirror_server_mods(
        "operations",
        server_routes.ModLoadoutMirrorRequest(
            target_server_ids=["training"],
            restart_targets=True,
        ),
        current_user={"id": "tester"},
    ))

    assert result["succeeded"] == 1
    assert result["failed"] == 0
    assert [mod.get("mod_id") or mod.get("modId") for mod in target["mods"]] == ["SRC1", "SRC2", "TARGET-SYS"]
    assert target["mods"][0]["version"] == "1.0.0"
    assert target["mods"][1]["enabled"] is False
    assert target["mods"][2]["system_managed"] is True
    assert target["ports"] == {"game": 2011, "query": 17787, "rcon": 20009}
    assert target["container_name"] == "training-container"
    assert target["environment"] == {"RCON_PASSWORD": "target-secret"}
    assert backups.docs[0]["server_id"] == "training"
    assert backups.docs[0]["mods_snapshot"][1]["mod_id"] == "TARGET-EDIT"
    assert captured_write_docs[0]["container_id"] == "runtime-container-id"
    assert result["post_action_failures"] == 1
    assert result["results"][0]["post_action"] == "restart_failed"
    assert result["results"][0]["post_action_error"] == "Container restart was refused"


def test_mirror_server_mods_reports_partial_failures(monkeypatch):
    source = {
        "id": "operations",
        "name": "Operations",
        "mods": [{"mod_id": "SRC1", "name": "Source One", "enabled": True}],
        "ports": {"game": 2001, "query": 17777, "rcon": 19999},
        "config": {},
    }
    target = {
        "id": "training",
        "name": "Training",
        "mods": [],
        "ports": {"game": 2011, "query": 17787, "rcon": 20009},
        "config": {},
        "sat_enabled": False,
    }

    async def fake_write_config_file(server_doc, config_dir=None, *, config=None):
        return True, "C:/target/server.json"

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(
            managed_servers=_FakeManagedServersCollectionById([source, target]),
            server_backups=_FakeInsertCollection(),
        ),
    )
    monkeypatch.setattr(server_routes, "write_config_file", fake_write_config_file)
    monkeypatch.setattr(server_routes, "_sync_workshop_mod_metadata", lambda *args, **kwargs: asyncio.sleep(0))
    monkeypatch.setattr(server_routes, "log_audit", lambda **kwargs: asyncio.sleep(0))
    monkeypatch.setattr(server_routes, "sync_server_notifications", lambda updated: asyncio.sleep(0))

    result = asyncio.run(server_routes.mirror_server_mods(
        "operations",
        server_routes.ModLoadoutMirrorRequest(target_server_ids=["training", "missing", "operations"]),
        current_user={"id": "tester"},
    ))

    assert result["succeeded"] == 1
    assert result["failed"] == 2
    failures = {entry["target_server_id"]: entry["error"] for entry in result["results"] if not entry["ok"]}
    assert failures["missing"] == "Target server not found."
    assert failures["operations"] == "Cannot mirror a server loadout to itself."


def _file_manager_server(tmp_path, server_id="srv-files", stale_config=False):
    config_root = tmp_path / "configs"
    profile_root = tmp_path / "profiles"
    workshop_root = tmp_path / "workshop"
    config_dir = config_root / server_id
    profile_dir = profile_root / server_id
    workshop_dir = workshop_root / server_id

    config_dir.mkdir(parents=True)
    profile_dir.mkdir(parents=True)
    workshop_dir.mkdir(parents=True)

    config_file = config_dir / "server.json"
    config_file.write_text('{"name":"Test"}', encoding="utf-8")
    (profile_dir / "mod-config.json").write_text('{"enabled":true}', encoding="utf-8")
    (workshop_dir / "readme.txt").write_text("hello", encoding="utf-8")

    if stale_config:
        config_path = (tmp_path / "stale" / "Configs" / "server.json").as_posix()
    else:
        config_path = config_file.as_posix()

    return {
        "id": server_id,
        "config_path": config_path,
        "profile_path": "",
        "workshop_path": "",
        "volumes": {
            config_root.as_posix(): "/reforger/Configs",
            profile_root.as_posix(): "/home/profile",
            workshop_root.as_posix(): "/reforger/workshop",
        },
    }, {
        "config_dir": config_dir,
        "profile_dir": profile_dir,
        "workshop_dir": workshop_dir,
    }


def test_safe_resolve_allows_root_only_when_requested(tmp_path):
    base = tmp_path / "root"
    base.mkdir()

    assert _safe_resolve(base.as_posix(), "", allow_root=True) == base.resolve()

    with pytest.raises(server_routes.HTTPException, match="Path is required"):
        _safe_resolve(base.as_posix(), "")

    with pytest.raises(server_routes.HTTPException, match="Path traversal is not allowed"):
        _safe_resolve(base.as_posix(), "../outside", allow_root=True)


def test_resolve_server_root_falls_back_to_server_scoped_paths(tmp_path):
    server, paths = _file_manager_server(tmp_path)
    server["config_path"] = ""

    assert Path(_resolve_server_root(server, "config")) == paths["config_dir"]
    assert Path(_resolve_server_root(server, "profile")) == paths["profile_dir"]
    assert Path(_resolve_server_root(server, "workshop")) == paths["workshop_dir"]


def test_resolve_server_root_prefers_existing_derived_path_over_stale_record(tmp_path):
    server, paths = _file_manager_server(tmp_path, stale_config=True)

    assert Path(_resolve_server_root(server, "config")) == paths["config_dir"]


def test_annotate_server_mod_install_state_detects_workshop_and_profile_addons(tmp_path):
    server, paths = _file_manager_server(tmp_path)
    workshop_mod_id = "59673B6FBB95459F"
    profile_mod_id = "5AAAC70D754245DD"
    missing_mod_id = "591AF5BDA9F7CE8B"

    (paths["workshop_dir"] / "addons" / workshop_mod_id).mkdir(parents=True)
    (paths["profile_dir"] / "Addons" / profile_mod_id).mkdir(parents=True)

    server["mods"] = [
        {"mod_id": workshop_mod_id, "name": "Workshop Installed"},
        {"mod_id": profile_mod_id, "name": "Profile Installed"},
        {"mod_id": missing_mod_id, "name": "Missing Mod"},
    ]

    annotated = server_routes._annotate_server_mod_install_state(server)
    states = {mod["mod_id"]: mod.get("local_installed") for mod in annotated["mods"]}

    assert states[workshop_mod_id] is True
    assert states[profile_mod_id] is True
    assert states[missing_mod_id] is False


def test_annotate_server_mod_install_state_returns_unknown_without_local_roots(tmp_path):
    server = {
        "id": "srv-no-roots",
        "mods": [{"mod_id": "59673B6FBB95459F", "name": "No Roots"}],
        "config_path": "",
        "profile_path": str(tmp_path / "missing-profile"),
        "workshop_path": str(tmp_path / "missing-workshop"),
        "volumes": {},
    }

    annotated = server_routes._annotate_server_mod_install_state(server)

    assert annotated["mods"][0]["local_installed"] is None


def test_list_file_roots_uses_fallback_paths_without_leaking_host_paths(tmp_path, monkeypatch):
    server, _ = _file_manager_server(tmp_path)
    server["config_path"] = ""

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )

    roots = asyncio.run(server_routes.list_file_roots(server["id"], current_user={"id": "tester"}))

    assert {root["key"]: root["exists"] for root in roots} == {
        "config": True,
        "profile": True,
        "workshop": True,
    }
    assert all("path" not in root for root in roots)


def test_browse_server_files_accepts_empty_root_path_and_uses_fallbacks(tmp_path, monkeypatch):
    server, paths = _file_manager_server(tmp_path, stale_config=True)

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )

    result = asyncio.run(
        server_routes.browse_server_files(
            server["id"],
            root="config",
            path="",
            current_user={"id": "tester"},
        )
    )

    assert result["root"] == "config"
    assert result["path"] == ""
    assert "base" not in result
    assert any(entry["name"] == "server.json" for entry in result["entries"])
    assert paths["config_dir"] == Path(_resolve_server_root(server, "config"))


def test_read_server_file_uses_fallback_root_when_stored_paths_are_stale(tmp_path, monkeypatch):
    server, _ = _file_manager_server(tmp_path, stale_config=True)

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )

    result = asyncio.run(
        server_routes.read_server_file(
            server["id"],
            root="config",
            path="server.json",
            current_user={"id": "tester"},
        )
    )

    assert result["name"] == "server.json"
    assert result["root"] == "config"
    assert '"name":"Test"' in result["content"]


def test_write_server_file_creates_new_file_within_root(tmp_path, monkeypatch):
    server, paths = _file_manager_server(tmp_path)

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )
    monkeypatch.setattr(server_routes, "log_audit", lambda **kwargs: asyncio.sleep(0))

    result = asyncio.run(
        server_routes.write_server_file(
            server["id"],
            server_routes.FileWriteBody(content='{"enabled": true}'),
            root="config",
            path="new-config.json",
            current_user={"id": "tester"},
        )
    )

    assert result["path"] == "new-config.json"
    assert (paths["config_dir"] / "new-config.json").read_text(encoding="utf-8") == '{"enabled": true}'


def test_validate_server_file_formats_json_content(tmp_path, monkeypatch):
    server, _ = _file_manager_server(tmp_path)

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )

    result = asyncio.run(
        server_routes.validate_server_file(
            server["id"],
            server_routes.FileWriteBody(content='{"name":"Test","mods":[1,2]}'),
            root="config",
            path="draft.json",
            current_user={"id": "tester"},
        )
    )

    assert result["valid"] is True
    assert result["formatter_applied"] is True
    assert '  "name": "Test"' in result["formatted_content"]


def test_validate_server_file_reports_invalid_json(tmp_path, monkeypatch):
    server, _ = _file_manager_server(tmp_path)

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )

    result = asyncio.run(
        server_routes.validate_server_file(
            server["id"],
            server_routes.FileWriteBody(content='{"name": }'),
            root="config",
            path="broken.json",
            current_user={"id": "tester"},
        )
    )

    assert result["valid"] is False
    assert result["supported"] is True
    assert result["issues"]


def test_ai_assist_server_file_returns_service_payload(tmp_path, monkeypatch):
    server, _ = _file_manager_server(tmp_path)

    monkeypatch.setattr(
        server_routes,
        "db",
        SimpleNamespace(managed_servers=_FakeManagedServersCollection(server)),
    )
    monkeypatch.setattr(server_routes, "log_audit", lambda **kwargs: asyncio.sleep(0))

    async def fake_assist_file_content(file_path, content):
        assert file_path == "draft.json"
        assert content == '{"broken": true,}'
        return {
            "summary": "Removed the trailing comma.",
            "issues": ["Trailing comma in JSON object."],
            "corrected_content": '{"broken": true}\n',
            "changed": True,
            "model": "gpt-4o-mini",
        }

    monkeypatch.setattr(server_routes, "assist_file_content", fake_assist_file_content)

    result = asyncio.run(
        server_routes.ai_assist_server_file(
            server["id"],
            server_routes.FileWriteBody(content='{"broken": true,}'),
            root="config",
            path="draft.json",
            current_user={"id": "tester"},
        )
    )

    assert result["changed"] is True
    assert result["corrected_content"] == '{"broken": true}\n'


# ── Readiness and notification tests ─────────────────────────────────


def test_sat_excluded_from_follow_up_checklist():
    """SAT and profile stages should not appear in operator-facing follow-up checklists."""
    from services.server_notifications import _collect_follow_up_checklist

    server = {
        "provisioning_warnings": [
            {"stage": "sat_discovery", "message": "ServerAdminTools_Config.json was not discovered"},
            {"stage": "profile_generation", "message": "Profile structure not found"},
            {"stage": "mod_sync", "message": "Mod version mismatch"},
        ],
        "provisioning_stages": {
            "sat_discovery": {"name": "sat_discovery", "status": "failed", "error": "SAT config not found"},
            "mod_sync": {"name": "mod_sync", "status": "failed", "error": "mod version mismatch"},
            "container_creation": {"name": "container_creation", "status": "success"},
        },
    }
    checklist = _collect_follow_up_checklist(server)
    stage_names = [item["stage"] for item in checklist]
    assert "sat_discovery" not in stage_names, "SAT discovery should be excluded from follow-up checklist"
    assert "profile_generation" not in stage_names, "Profile generation should be excluded from follow-up checklist"
    assert "mod_sync" in stage_names, "Real operational warnings should still be included"


def test_sat_reconciliation_clears_stale_warning_and_restores_ready_state():
    server = {
        "id": "srv-sat",
        "status": "running",
        "sat_enabled": True,
        "sat_status": "missing",
        "sat_config_path": "",
        "provisioning_state": "warning",
        "provisioning_step": "waiting_for_sat_config",
        "readiness_state": "degraded",
        "summary_message": (
            "Server deployment succeeded, but follow-up provisioning failed: "
            "ServerAdminTools_Config.json was not discovered before the provisioning timeout"
        ),
        "provisioning_warnings": [
            {"stage": "sat_discovery", "message": "ServerAdminTools_Config.json was not discovered"},
        ],
        "provisioning_stages": {
            "sat_discovery": {"name": "sat_discovery", "status": "failed", "error": "missing config"},
        },
    }

    updates = _derive_sat_reconciliation_updates(
        server,
        "C:/servers/profile/ServerAdminTools_Config.json",
        "discovered",
    )

    assert updates["sat_config_path"] == "C:/servers/profile/ServerAdminTools_Config.json"
    assert updates["sat_status"] == "discovered"
    assert updates["provisioning_warnings"] == []
    assert updates["provisioning_state"] == "completed"
    assert updates["provisioning_step"] == "ready"
    assert updates["readiness_state"] == "ready"
    assert updates["summary_message"] == "Server is operational."
    assert updates["provisioning_stages"]["sat_discovery"]["status"] == "success"
    assert updates["provisioning_stages"]["sat_discovery"]["error"] == ""


def test_resolve_sat_path_rediscovers_when_stored_path_is_stale(tmp_path):
    profile_root = tmp_path / "profile"
    profile_root.mkdir()
    actual_sat = profile_root / "ServerAdminTools_Config.json"
    actual_sat.write_text("{}", encoding="utf-8")

    sat_path, sat_status = server_routes._resolve_sat_path({
        "sat_config_path": str(profile_root / "missing" / "ServerAdminTools_Config.json"),
        "sat_status": "missing",
        "profile_path": str(profile_root),
    })

    assert Path(sat_path) == actual_sat
    assert sat_status == "discovered"


def test_sat_failure_does_not_degrade_readiness_when_container_runs():
    """Non-readiness stage failures (SAT, profile) should not set readiness_state to degraded."""
    from services.reforger_orchestrator import NON_READINESS_STAGE_NAMES

    result = ProvisioningResult()
    result.stages = [
        StageResult(name="record_creation", status="success"),
        StageResult(name="filesystem_preparation", status="success"),
        StageResult(name="config_write", status="success"),
        StageResult(name="container_creation", status="success"),
        StageResult(name="initial_startup", status="success"),
        StageResult(name="readiness_check", status="success"),
        StageResult(name="sat_discovery", status="failed", error="SAT config not found"),
        StageResult(name="profile_generation", status="failed", error="Profile not found"),
    ]
    assert result.container_started is True
    failed = [
        s for s in result.failed_stages
        if s.name not in {"record_creation", "filesystem_preparation", "config_write", "container_creation", "initial_startup"}
    ]
    readiness_relevant = [s for s in failed if s.name not in NON_READINESS_STAGE_NAMES]
    assert len(readiness_relevant) == 0, "SAT/profile failures should not affect readiness"


def test_real_stage_failure_still_degrades_readiness():
    """Non-core stage failures that are NOT supplemental tooling should degrade readiness."""
    from services.reforger_orchestrator import NON_READINESS_STAGE_NAMES

    result = ProvisioningResult()
    result.stages = [
        StageResult(name="record_creation", status="success"),
        StageResult(name="container_creation", status="success"),
        StageResult(name="initial_startup", status="success"),
        StageResult(name="readiness_check", status="failed", error="Server did not signal readiness"),
        StageResult(name="sat_discovery", status="failed", error="SAT config not found"),
    ]
    assert result.container_started is True
    failed = [
        s for s in result.failed_stages
        if s.name not in {"record_creation", "filesystem_preparation", "config_write", "container_creation", "initial_startup"}
    ]
    readiness_relevant = [s for s in failed if s.name not in NON_READINESS_STAGE_NAMES]
    assert len(readiness_relevant) == 1, "readiness_check failure should still degrade readiness"
    assert readiness_relevant[0].name == "readiness_check"


def test_detection_model_has_human_fields():
    """WatcherDetection model should have human-friendly fields."""
    from models.server import WatcherDetection
    detection = WatcherDetection(
        server_id="srv-1",
        title="Test Detection",
        human_summary="Something went wrong.",
        human_impact="Players may experience lag.",
        human_action="Restart the server if lag persists.",
        source_type="system",
    )
    assert detection.human_summary == "Something went wrong."
    assert detection.human_impact == "Players may experience lag."
    assert detection.human_action == "Restart the server if lag persists."
    assert detection.source_type == "system"
    assert detection.log_snapshot == []
    assert detection.ignored_at is None


def test_detection_model_supports_ignored_status():
    """WatcherDetection should support 'ignored' as a valid status."""
    from models.server import WatcherDetection
    detection = WatcherDetection(
        server_id="srv-1",
        title="Known Issue",
        status="ignored",
        verdict_notes="This is expected behavior.",
    )
    assert detection.status == "ignored"


def test_log_snapshot_capture_returns_entries(monkeypatch):
    """capture_log_snapshot should return a windowed snapshot and mark trigger lines."""
    from services import server_logs

    entries = (
        [{"line": f"line{i}", "source": "docker"} for i in range(40)]
        + [{"line": "ERROR something broke", "source": "docker"}]
        + [{"line": f"line{i}", "source": "docker"} for i in range(41, 81)]
    )

    async def fake_get_recent(*args, **kwargs):
        return entries

    monkeypatch.setattr(
        server_logs,
        "get_recent_server_log_entries",
        fake_get_recent,
    )

    snapshot = asyncio.run(
        server_logs.capture_log_snapshot({"id": "srv-1"}, trigger_line="ERROR something broke")
    )

    assert snapshot
    assert len(snapshot) < len(entries)

    snapshot_lines = [entry["line"] for entry in snapshot]
    assert "ERROR something broke" in snapshot_lines
    assert any(
        entry["line"] == "ERROR something broke" and entry.get("is_trigger") is True
        for entry in snapshot
    )
    assert "line39" in snapshot_lines
    assert "line41" in snapshot_lines
    assert "line0" not in snapshot_lines
    assert "line80" not in snapshot_lines


# The schema patch that raised this cap was removed on 2026-07-26. Clamping is
# now unconditional, and it is the thing that keeps the backend from writing a
# config the stock server refuses to launch on — so it still needs a test.

def test_generate_reforger_config_clamps_network_view_distance_to_stock_max():
    server = _runtime_server()
    server["config"]["game"] = {"gameProperties": {"networkViewDistance": 10000}}

    generated = generate_reforger_config(server)

    assert generated["game"]["gameProperties"]["networkViewDistance"] == 5000


def test_generate_reforger_config_enforces_network_view_distance_minimum():
    server = _runtime_server()
    server["config"]["game"] = {"gameProperties": {"networkViewDistance": 1}}

    generated = generate_reforger_config(server)

    assert generated["game"]["gameProperties"]["networkViewDistance"] == 500


# ── SAT ban RCON commands ──────────────────────────────────────────────────────

from routes.servers import _sat_ban_create_command


def test_sat_ban_create_command_uses_reforger_syntax():
    # Reforger answers a bare "#ban <id>" with its help text and bans nobody.
    assert _sat_ban_create_command("1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", "") == (
        "#ban create 1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d 0"
    )


def test_sat_ban_create_command_keeps_reason_printable_and_short():
    command = _sat_ban_create_command("abc", "team\tkilling\n  again\x07" + "x" * 400)
    assert command.startswith("#ban create abc 0 team killing again")
    assert all(0x20 <= ord(ch) <= 0x7E for ch in command)
    assert len(command) <= 256
