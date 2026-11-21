"""Server config secrets: redacted on read, preserved on write.

Redacting a secret on read is only half the job. The config editor seeds itself
from `GET /servers/{id}`, so it holds the mask where the passwords are. Saving
any unrelated field then PUTs that mask back — and without the write-side merge
the real admin, join and RCON passwords are overwritten with three asterisks.
The uptime supervisor would go on to restore `"***"` as the GM password at the
end of every session.
"""
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

from routes.servers import (  # noqa: E402
    REDACTED_SENTINEL,
    _redact_config_secrets,
    _restore_redacted_config_secrets,
    _server_response,
)

REAL_ADMIN = "the-real-gm-password"
REAL_JOIN = "the-real-join-password"
REAL_RCON = "the-real-rcon-password"


def stored_config():
    return {
        "game": {
            "name": "Night Ops",
            "passwordAdmin": REAL_ADMIN,
            "password": REAL_JOIN,
            "gameProperties": {"disableThirdPerson": True},
        },
        "rcon": {"password": REAL_RCON, "permission": "admin"},
    }


# ── Reading: secrets must not leave the server ──────────────────────────────

def test_the_admin_password_is_masked_on_read():
    out = _redact_config_secrets(stored_config())
    assert out["game"]["passwordAdmin"] == REDACTED_SENTINEL


def test_the_join_and_rcon_passwords_are_masked_on_read():
    out = _redact_config_secrets(stored_config())
    assert out["game"]["password"] == REDACTED_SENTINEL
    assert out["rcon"]["password"] == REDACTED_SENTINEL


def test_no_real_secret_survives_anywhere_in_the_response():
    import json

    body = json.dumps(_server_response({"id": "s1", "config": stored_config()}))
    for secret in (REAL_ADMIN, REAL_JOIN, REAL_RCON):
        assert secret not in body


def test_redacting_does_not_mutate_the_stored_config():
    """The stored record is the source of truth for the uptime revert."""
    config = stored_config()
    _redact_config_secrets(config)
    assert config["game"]["passwordAdmin"] == REAL_ADMIN


def test_non_secret_settings_are_untouched():
    out = _redact_config_secrets(stored_config())
    assert out["game"]["name"] == "Night Ops"
    assert out["game"]["gameProperties"]["disableThirdPerson"] is True


# ── Writing: an echoed mask means "unchanged", never a new password ─────────

def test_an_echoed_mask_restores_the_stored_admin_password():
    """The bug this guards: saving any field wiped every password."""
    incoming = _redact_config_secrets(stored_config())
    merged = _restore_redacted_config_secrets(incoming, stored_config())
    assert merged["game"]["passwordAdmin"] == REAL_ADMIN


def test_an_echoed_mask_restores_join_and_rcon_too():
    incoming = _redact_config_secrets(stored_config())
    merged = _restore_redacted_config_secrets(incoming, stored_config())
    assert merged["game"]["password"] == REAL_JOIN
    assert merged["rcon"]["password"] == REAL_RCON


def test_a_full_read_edit_write_cycle_preserves_every_secret():
    """End to end: fetch, change one unrelated setting, save."""
    from_api = _server_response({"id": "s1", "config": stored_config()})["config"]
    from_api["game"]["name"] = "Training Night"

    merged = _restore_redacted_config_secrets(from_api, stored_config())

    assert merged["game"]["name"] == "Training Night"
    assert merged["game"]["passwordAdmin"] == REAL_ADMIN
    assert merged["game"]["password"] == REAL_JOIN
    assert merged["rcon"]["password"] == REAL_RCON


def test_a_genuinely_new_password_is_written_through():
    incoming = _redact_config_secrets(stored_config())
    incoming["game"]["passwordAdmin"] = "a-brand-new-password"

    merged = _restore_redacted_config_secrets(incoming, stored_config())
    assert merged["game"]["passwordAdmin"] == "a-brand-new-password"


def test_clearing_a_password_deliberately_is_honoured():
    """An empty string is a real intent to clear, not an echoed mask."""
    incoming = _redact_config_secrets(stored_config())
    incoming["game"]["passwordAdmin"] = ""

    merged = _restore_redacted_config_secrets(incoming, stored_config())
    assert merged["game"]["passwordAdmin"] == ""


def test_a_missing_stored_secret_becomes_empty_not_the_mask():
    """Never let the literal mask reach the config generator."""
    incoming = _redact_config_secrets(stored_config())
    merged = _restore_redacted_config_secrets(incoming, {"game": {}, "rcon": {}})

    assert merged["game"]["passwordAdmin"] == ""
    assert merged["rcon"]["password"] == ""


def test_merging_does_not_mutate_the_incoming_payload():
    incoming = _redact_config_secrets(stored_config())
    _restore_redacted_config_secrets(incoming, stored_config())
    assert incoming["game"]["passwordAdmin"] == REDACTED_SENTINEL


def test_a_config_without_secrets_passes_through():
    config = {"game": {"name": "x"}}
    assert _restore_redacted_config_secrets(config, {})["game"]["name"] == "x"


def test_non_dict_input_is_returned_unchanged():
    assert _restore_redacted_config_secrets(None, stored_config()) is None


def test_the_mask_never_reaches_a_saved_config():
    """The single property that matters: no save can persist the sentinel."""
    import json

    incoming = _redact_config_secrets(stored_config())
    merged = _restore_redacted_config_secrets(incoming, stored_config())
    assert REDACTED_SENTINEL not in json.dumps(merged)
