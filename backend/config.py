"""Garrison settings. Everything comes from environment variables (see .env.example)."""

import os
import logging
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")
load_dotenv(ROOT_DIR.parent / ".env")

logger = logging.getLogger(__name__)

# ── Database ────────────────────────────────────────────────────────────────
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://127.0.0.1:27017")
DB_NAME = os.environ.get("DB_NAME", "garrison")

# ── Sessions ────────────────────────────────────────────────────────────────
# HS256 needs a key of at least 256 bits (RFC 7518 3.2). Refuse to boot on a
# short or placeholder secret rather than sign sessions with a guessable key.
JWT_SECRET = os.environ.get("JWT_SECRET", "")
if len(JWT_SECRET.encode("utf-8")) < 32:
    raise RuntimeError(
        "JWT_SECRET must be set to at least 32 characters. Generate one with "
        "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"`."
    )
if "CHANGE_ME" in JWT_SECRET.upper():
    raise RuntimeError("JWT_SECRET is still the placeholder from .env.example. Set a real value.")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = int(os.environ.get("JWT_EXPIRATION_HOURS", 24))
COOKIE_NAME = "garrison_session"
COOKIE_MAX_AGE = JWT_EXPIRATION_HOURS * 3600
SESSION_RENEW_AFTER_SECONDS = COOKIE_MAX_AGE // 2
# "auto" (default) marks the cookie Secure whenever the request arrived over
# HTTPS, directly or through a proxy that sets X-Forwarded-Proto. "true" always
# marks it Secure (HTTPS-only sign-in); "false" never does.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto").strip().lower()

# First admin account, created on first start when no users exist.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin").strip() or "admin"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

# Public URL of the panel (used in links inside notifications).
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")

# ── Optional AI helpers (file assist, crash fixes, log triage) ─────────────
# Off unless OPENAI_API_KEY or ANTHROPIC_API_KEY is set.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
FILE_MANAGER_AI_MODEL = os.environ.get("FILE_MANAGER_AI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
FILE_MANAGER_AI_MAX_INPUT_CHARS = int(os.environ.get("FILE_MANAGER_AI_MAX_INPUT_CHARS", 40000))
FILE_MANAGER_AI_TIMEOUT_SECONDS = int(os.environ.get("FILE_MANAGER_AI_TIMEOUT_SECONDS", 45))
LLM_ACCOUNT_HOURLY_BUDGET = int(os.environ.get("LLM_ACCOUNT_HOURLY_BUDGET", 30))
DIAGNOSTICS_AI_MODEL = os.environ.get("DIAGNOSTICS_AI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
DIAGNOSTICS_TRIAGE_INTERVAL = int(os.environ.get("DIAGNOSTICS_TRIAGE_INTERVAL", 600))

# ── Docker and game servers ─────────────────────────────────────────────────
DOCKER_SOCKET_PATH = os.environ.get("DOCKER_SOCKET_PATH", "unix:///var/run/docker.sock")
SERVER_DOCKER_IMAGE = os.environ.get(
    "SERVER_DOCKER_IMAGE",
    "ghcr.io/acemod/arma-reforger:latest",
).strip()
# Where each server's files live. When Garrison itself runs in a container,
# this path must be the SAME on the host and inside the container, because
# Docker mounts it into the game containers by host path.
SERVER_DATA_ROOT = Path(
    os.environ.get("SERVER_DATA_ROOT", str(ROOT_DIR / "server-data"))
)
SERVER_DATA_ROOT.mkdir(parents=True, exist_ok=True)
SERVER_CONFIG_FILENAME = os.environ.get("SERVER_CONFIG_FILENAME", "server-config.json").strip() or "server-config.json"
SERVER_PROFILE_READY_TIMEOUT_SECONDS = int(os.environ.get("SERVER_PROFILE_READY_TIMEOUT_SECONDS", 120))
SERVER_PROFILE_POLL_SECONDS = int(os.environ.get("SERVER_PROFILE_POLL_SECONDS", 5))
# Server Admin Tools (Workshop mod 5AAAC70D754245DD): added to new servers
# unless switched off per server. Gives bans, kick logs and admin commands.
SERVER_SAT_REQUIRED_MOD_ID = os.environ.get("SERVER_SAT_REQUIRED_MOD_ID", "5AAAC70D754245DD").strip()
# Optional ServerAdminTools_Config.json copied onto new servers as a baseline.
SERVER_SAT_BASELINE_PATH = os.environ.get("SERVER_SAT_BASELINE_PATH", "").strip()

# ── Container runtime permissions ──────────────────────────────────────────
# Containers write logs, mods and profile data that the panel's file manager
# must still be able to edit. umask 002 plus setgid group-writable data folders
# keep container output manageable without making anything world-writable.
REFORGER_CONTAINER_USER = os.environ.get("REFORGER_CONTAINER_USER", "").strip()
REFORGER_CONTAINER_UMASK = os.environ.get("REFORGER_CONTAINER_UMASK", "002").strip()
REFORGER_CONTAINER_CAP_ADD = [
    c.strip() for c in os.environ.get("REFORGER_CONTAINER_CAP_ADD", "").split(",") if c.strip()
]
REFORGER_CONTAINER_GROUP_ADD = [
    g.strip() for g in os.environ.get("REFORGER_CONTAINER_GROUP_ADD", "").split(",") if g.strip()
]


def _parse_octal_mode(env_name: str, default: int) -> int:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    try:
        return int(raw, 8)
    except ValueError:
        return default


REFORGER_DATA_DIR_MODE = _parse_octal_mode("REFORGER_DATA_DIR_MODE", 0o2775)

# The stock dedicated server refuses to start when networkViewDistance is
# outside 500-5000 m. Generated configs are clamped to that range.
STOCK_NETWORK_VIEW_DISTANCE_MIN = 500
STOCK_NETWORK_VIEW_DISTANCE_MAX = 5000

# Large mod sets can overflow the 8 MB main-thread stack on world load. An
# unlimited stack rlimit lets the main thread grow without enlarging worker
# threads. Disable with REFORGER_MAIN_STACK_UNLIMITED=0.
REFORGER_MAIN_STACK_UNLIMITED = os.environ.get(
    "REFORGER_MAIN_STACK_UNLIMITED", "1"
).strip().lower() not in ("0", "false", "no", "off")


def _validate_port(env_name: str, value: int) -> int:
    if not (1 <= value <= 65535):
        raise ValueError(f"Invalid value for {env_name}: {value}. Expected 1-65535.")
    return value


def _validate_positive_int(env_name: str, value: int) -> int:
    if value <= 0:
        raise ValueError(f"Invalid value for {env_name}: {value}. Expected a number above 0.")
    return value


# Each new server takes the next free block of ports from these bases.
SERVER_PORT_BASE_GAME = _validate_port("SERVER_PORT_BASE_GAME", int(os.environ.get("SERVER_PORT_BASE_GAME", 2001)))
SERVER_PORT_BASE_QUERY = _validate_port("SERVER_PORT_BASE_QUERY", int(os.environ.get("SERVER_PORT_BASE_QUERY", 17777)))
SERVER_PORT_BASE_RCON = _validate_port("SERVER_PORT_BASE_RCON", int(os.environ.get("SERVER_PORT_BASE_RCON", 19999)))
SERVER_PORT_BLOCK_SIZE = _validate_positive_int("SERVER_PORT_BLOCK_SIZE", int(os.environ.get("SERVER_PORT_BLOCK_SIZE", 10)))

SERVER_HEALTH_CHECK_INTERVAL = int(os.environ.get("SERVER_HEALTH_CHECK_INTERVAL", 15))
# Each metrics pass runs an RCON #players, an A2S query and a log tail per
# server, so keep it at a minute or more.
SERVER_METRICS_INTERVAL = int(os.environ.get("SERVER_METRICS_INTERVAL", 60))
SERVER_METRICS_RETENTION_DAYS = int(os.environ.get("SERVER_METRICS_RETENTION_DAYS", 7))
SERVER_LOG_ANALYSIS_INTERVAL = int(os.environ.get("SERVER_LOG_ANALYSIS_INTERVAL", 60))
WORKSHOP_REFRESH_INTERVAL_HOURS = int(os.environ.get("WORKSHOP_REFRESH_INTERVAL_HOURS", 24))

# Log monitor. External log collectors may POST to /api/log with this key.
LOG_COLLECTOR_API_KEY = os.environ.get("LOG_COLLECTOR_API_KEY", "").strip()
LOG_MONITOR_INTERVAL = _validate_positive_int("LOG_MONITOR_INTERVAL", int(os.environ.get("LOG_MONITOR_INTERVAL", 60)))
