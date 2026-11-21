"""Data models for the Arma Reforger server management domain."""

from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field

from config import SERVER_DOCKER_IMAGE


SERVER_STATUSES = [
    "created",
    "initializing",
    "starting",
    "running",
    "stopping",
    "stopped",
    "error",
    "crash_loop",
    "provisioning_failed",
    "provisioning_partial",
    "deletion_pending",
]

SERVER_DEPLOYMENT_STATES = [
    "creating",
    "created",
    "failed",
]

SERVER_PROVISIONING_STATES = [
    "queued",
    "running",
    "completed",
    "warning",
    "failed",
    "deleting",
]

SERVER_READINESS_STATES = [
    "pending",
    "initializing",
    "ready",
    "degraded",
    "failed",
]

SAT_DISCOVERY_STATES = [
    "pending",
    "discovered",
    "missing",
    "not_applicable",
    "error",
]

SCHEDULE_ACTION_TYPES = ["restart", "start", "stop", "downtime_window"]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _default_ports() -> Dict[str, int]:
    return {
        "game": 2001,
        "query": 17777,
        "rcon": 19999,
    }


class ManagedServer(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    docker_image: str = SERVER_DOCKER_IMAGE
    container_name: str = ""
    container_id: str = ""
    status: str = "created"
    deployment_state: str = "creating"
    provisioning_state: str = "queued"
    provisioning_step: str = "queued"
    readiness_state: str = "pending"
    summary_message: str = ""
    last_docker_error: str = ""
    last_known_container_status: str = ""
    provisioning_stages: Dict[str, Any] = Field(default_factory=dict)
    provisioning_warnings: List[Dict[str, Any]] = Field(default_factory=list)
    auto_recovery_attempts: int = 0
    auto_recovery_log: List[str] = Field(default_factory=list)
    restart_cycles: int = 0
    needs_manual_intervention: bool = False
    data_root: str = ""
    config_path: str = ""
    profile_path: str = ""
    workshop_path: str = ""
    diagnostics_path: str = ""
    sat_config_path: str = ""
    sat_status: str = "pending"
    sat_enabled: bool = True
    ports: Dict[str, int] = Field(default_factory=_default_ports)
    port_allocations: Dict[str, int] = Field(default_factory=_default_ports)
    config: Dict[str, Any] = Field(default_factory=dict)
    config_history: List[Dict[str, Any]] = Field(default_factory=list)
    mods: List[Dict[str, Any]] = Field(default_factory=list)
    environment: Dict[str, str] = Field(default_factory=dict)
    volumes: Dict[str, str] = Field(default_factory=dict)
    created_by: str = ""
    created_at: datetime = Field(default_factory=_utc_now)
    updated_at: datetime = Field(default_factory=_utc_now)
    last_started: Optional[datetime] = None
    last_stopped: Optional[datetime] = None
    health_check_interval: int = 15
    auto_restart: bool = True
    max_restart_attempts: int = 3
    log_stats_enabled: bool = True
    max_fps: int = 120
    # Run the engine through the call-target-limit patch (131,072 -> 262,144);
    # see services/reforger_script_limit_patch.py.
    script_limit_patch: bool = False
    startup_parameters: List[str] = Field(default_factory=list)
    startup_grace_until: Optional[datetime] = None
    tags: List[str] = Field(default_factory=list)
    notes: List[Dict[str, Any]] = Field(default_factory=list)


class ServerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    config: Dict[str, Any] = Field(default_factory=dict)
    mods: List[Dict[str, Any]] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    auto_restart: bool = True
    max_restart_attempts: int = 3
    log_stats_enabled: bool = True
    max_fps: int = 120
    startup_parameters: List[str] = Field(default_factory=list)
    sat_enabled: bool = True


class ServerUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: Optional[str] = None
    description: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    mods: Optional[List[Dict[str, Any]]] = None
    tags: Optional[List[str]] = None
    auto_restart: Optional[bool] = None
    max_restart_attempts: Optional[int] = None
    log_stats_enabled: Optional[bool] = None
    max_fps: Optional[int] = None
    script_limit_patch: Optional[bool] = None
    startup_parameters: Optional[List[str]] = None
    sat_enabled: Optional[bool] = None

    # Optimistic concurrency token, not a stored field. The config revision the
    # client was editing from; a save is refused if history has moved on since.
    # Optional on purpose: API clients that omit it keep last-write-wins behaviour.
    base_revision: Optional[int] = None


class WorkshopMod(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mod_id: str
    name: str
    author: str = ""
    version: str = ""
    summary: str = ""
    description: str = ""
    license: str = ""
    tags: List[str] = Field(default_factory=list)
    dependencies: List[Dict[str, Any]] = Field(default_factory=list)
    scenario_ids: List[str] = Field(default_factory=list)
    scenarios: List[Dict[str, Any]] = Field(default_factory=list)
    versions: List[Dict[str, Any]] = Field(default_factory=list)
    changelog: str = ""
    thumbnail_url: str = ""
    workshop_url: str = ""
    game_version: str = ""
    current_version_size: int = 0
    rating: float = 0.0
    rating_count: int = 0
    subscribers: int = 0
    downloads: int = 0
    created_at: str = ""
    updated_at: str = ""
    last_fetched: datetime = Field(default_factory=_utc_now)
    manually_entered: bool = False
    metadata_source: str = "manual"
    availability_status: str = "unknown"
    removed_from_workshop: bool = False
    removed_detected_at: Optional[str] = None
    availability_checked_at: Optional[str] = None
    availability_error: str = ""


class WorkshopModCreate(BaseModel):
    mod_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    author: str = ""
    version: str = ""
    description: str = ""
    license: str = ""
    tags: List[str] = Field(default_factory=list)
    dependencies: List[Dict[str, Any]] = Field(default_factory=list)
    scenario_ids: List[str] = Field(default_factory=list)


class ModPresetModEntry(BaseModel):
    """A single mod entry within a mod preset.

    Mirrors the live server mod-list representation: the shape produced by
    ``toModPayload``/``normalizeModEntry`` in ModsModule.jsx and consumed by
    ``server_config_generator.normalize_mod_entry`` (which accepts either
    ``mod_id`` or ``modId`` as the identifier). Keeping this shape aligned
    lets a saved preset round-trip cleanly through
    ``_exec_server_mod_preset_change`` without a field mismatch.
    """

    model_config = ConfigDict(extra="ignore")

    mod_id: str = Field(min_length=1)
    name: Optional[str] = None
    version: Optional[str] = None
    enabled: bool = True
    author: Optional[str] = None
    description: Optional[str] = None
    thumbnail_url: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    dependencies: List[Dict[str, Any]] = Field(default_factory=list)
    scenario_ids: List[str] = Field(default_factory=list)
    metadata_source: Optional[str] = None
    system_managed: bool = False
    dependency_of: List[str] = Field(default_factory=list)


class ModPreset(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    mods: List[ModPresetModEntry] = Field(default_factory=list, max_length=200)
    scenario_id: str = ""
    created_by: str = ""
    created_at: datetime = Field(default_factory=_utc_now)
    updated_at: datetime = Field(default_factory=_utc_now)


class ModPresetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    mods: List[ModPresetModEntry] = Field(default_factory=list, max_length=200)
    scenario_id: str = ""


class ModPresetUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    mods: Optional[List[ModPresetModEntry]] = Field(default=None, max_length=200)
    scenario_id: Optional[str] = None


class ModLoadoutMirrorRequest(BaseModel):
    target_server_ids: List[str] = Field(default_factory=list)
    preserve_system_managed: bool = True
    include_disabled: bool = True
    include_pinned_versions: bool = True
    create_backups: bool = True
    restart_targets: bool = False
    reconfigure_targets: bool = False


INCIDENT_TYPES = [
    "crash",
    "config_error",
    "startup_failure",
    "performance",
    "mod_error",
    "scheduled_action_failure",
]

INCIDENT_STATUSES = ["open", "investigating", "resolved"]


class ServerIncident(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"inc_{uuid.uuid4().hex[:12]}")
    server_id: str
    incident_type: str = "crash"
    severity: str = "medium"
    title: str = ""
    description: str = ""
    status: str = "open"
    detected_at: datetime = Field(default_factory=_utc_now)
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[str] = None
    resolution_notes: str = ""
    related_mod_issues: List[str] = Field(default_factory=list)
    log_excerpts: List[str] = Field(default_factory=list)
    auto_detected: bool = False


class IncidentCreate(BaseModel):
    server_id: str
    incident_type: str = "crash"
    severity: str = "medium"
    title: str = Field(min_length=1)
    description: str = ""


class IncidentResolve(BaseModel):
    resolution_notes: str = ""


class ModIssue(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"mi_{uuid.uuid4().hex[:12]}")
    mod_id: str
    mod_name: str
    error_signature: str = ""
    error_pattern: str = ""
    occurrence_count: int = 0
    severity: str = "low"
    source_category: str = "runtime-script"
    issue_type: str = "mod-runtime"
    impact_summary: str = ""
    first_seen: datetime = Field(default_factory=_utc_now)
    last_seen: datetime = Field(default_factory=_utc_now)
    confidence_score: float = 0.0
    attribution_method: str = "manual"
    source_streams: List[str] = Field(default_factory=list)
    affected_servers: List[Dict[str, Any]] = Field(default_factory=list)
    evidence: List[Dict[str, Any]] = Field(default_factory=list)
    recommended_actions: List[str] = Field(default_factory=list)
    status: str = "active"
    designated_area: str = "mod-analysis"
    attribution_type: str = "mod"
    troublesome: bool = False
    troublesome_reason: str = ""
    resolved_by: Optional[str] = None
    resolved_at: Optional[datetime] = None
    resolution_notes: str = ""


class ServerBackup(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"bk_{uuid.uuid4().hex[:12]}")
    server_id: str
    backup_type: str = "manual"
    file_path: str = ""
    size_bytes: int = 0
    config_snapshot: Dict[str, Any] = Field(default_factory=dict)
    mods_snapshot: List[Dict[str, Any]] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utc_now)
    created_by: str = ""


WATCHER_TYPES = ["health", "log", "threshold"]
WATCHER_VERDICTS = ["active", "monitoring", "resolved", "false_positive", "ignored"]
WATCHER_COMPARISONS = ["gt", "gte", "lt", "lte"]

WatcherType = Literal["health", "log", "threshold"]
WatcherSeverity = Literal["low", "medium", "high", "critical"]
WatcherMetric = Literal["cpu_percent", "memory_mb", "player_count", "server_fps", "avg_player_ping_ms"]
WatcherComparison = Literal["gt", "gte", "lt", "lte"]
DetectionStatus = Literal["active", "monitoring", "resolved", "false_positive", "ignored"]
SourceType = Literal["watcher", "system", "provisioning"]


class ServerWatcher(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"watch_{uuid.uuid4().hex[:12]}")
    server_id: str
    name: str
    type: WatcherType = "health"
    enabled: bool = True
    notify: bool = True
    pattern: str = ""
    metric: WatcherMetric = "cpu_percent"
    comparison: WatcherComparison = "gt"
    threshold: float = 90.0
    severity: WatcherSeverity = "medium"
    source_category: str = "runtime-script"
    description: str = ""
    template_key: str = ""
    system_managed: bool = False
    recommended_actions: List[str] = Field(default_factory=list)
    created_by: str = ""
    created_at: datetime = Field(default_factory=_utc_now)
    updated_at: datetime = Field(default_factory=_utc_now)
    trigger_count: int = 0
    last_triggered_at: Optional[datetime] = None


class ServerWatcherCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    type: WatcherType = "health"
    enabled: bool = True
    notify: bool = True
    pattern: str = ""
    metric: WatcherMetric = "cpu_percent"
    comparison: WatcherComparison = "gt"
    threshold: float = 90.0
    severity: WatcherSeverity = "medium"
    source_category: str = "runtime-script"
    description: str = ""
    template_key: str = ""
    system_managed: bool = False
    recommended_actions: List[str] = Field(default_factory=list)


class ServerWatcherUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[WatcherType] = None
    enabled: Optional[bool] = None
    notify: Optional[bool] = None
    pattern: Optional[str] = None
    metric: Optional[WatcherMetric] = None
    comparison: Optional[WatcherComparison] = None
    threshold: Optional[float] = None
    severity: Optional[WatcherSeverity] = None
    source_category: Optional[str] = None
    description: Optional[str] = None
    template_key: Optional[str] = None
    system_managed: Optional[bool] = None
    recommended_actions: Optional[List[str]] = None


class WatcherDetection(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"detect_{uuid.uuid4().hex[:12]}")
    server_id: str
    watcher_id: str = ""
    detection_key: str = ""
    title: str
    summary: str = ""
    severity: WatcherSeverity = "medium"
    status: DetectionStatus = "active"
    source_category: str = "runtime-script"
    source_type: SourceType = "watcher"
    source_streams: List[str] = Field(default_factory=list)
    occurrence_count: int = 0
    confidence_score: float = 0.0
    first_seen: datetime = Field(default_factory=_utc_now)
    last_seen: datetime = Field(default_factory=_utc_now)
    evidence: List[Dict[str, Any]] = Field(default_factory=list)
    log_snapshot: List[Dict[str, Any]] = Field(default_factory=list)
    recommended_actions: List[str] = Field(default_factory=list)
    human_summary: str = ""
    human_impact: str = ""
    human_action: str = ""
    verdict_notes: str = ""
    ignored_at: Optional[datetime] = None
    ignored_by: str = ""
    updated_at: datetime = Field(default_factory=_utc_now)


class ScheduledAction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"sched_{uuid.uuid4().hex[:12]}")
    server_id: str
    action_type: str = "restart"
    schedule: str = ""
    timezone: str = "UTC"
    enabled: bool = True
    downtime_minutes: Optional[int] = None
    downtime_restore_at: Optional[datetime] = None
    last_run: Optional[datetime] = None
    next_run: Optional[datetime] = None
    last_result: Optional[Dict[str, Any]] = None
    execution_history: List[Dict[str, Any]] = Field(default_factory=list)
    created_by: str = ""
    created_at: datetime = Field(default_factory=_utc_now)
    updated_at: datetime = Field(default_factory=_utc_now)


class ScheduledActionCreate(BaseModel):
    action_type: str = "restart"
    schedule: str = Field(min_length=1)
    timezone: str = "UTC"
    enabled: bool = True
    downtime_minutes: Optional[int] = None


class ScheduledActionUpdate(BaseModel):
    action_type: Optional[str] = None
    schedule: Optional[str] = None
    timezone: Optional[str] = None
    enabled: Optional[bool] = None
    downtime_minutes: Optional[int] = None


class WebhookConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"wh_{uuid.uuid4().hex[:12]}")
    name: str
    url: str
    events: List[str] = Field(default_factory=list)
    enabled: bool = True
    created_by: str = ""
    created_at: datetime = Field(default_factory=_utc_now)


class WebhookConfigCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1)
    events: List[str] = Field(default_factory=list)
    enabled: bool = True


class ServerNote(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"note_{uuid.uuid4().hex[:12]}")
    author_id: str = ""
    author_name: str = ""
    title: str = ""
    category: Literal["general", "mod_change", "mod_request", "moderation", "development", "community", "incident", "test", "handoff"] = "general"
    status: Literal["open", "in_progress", "blocked", "resolved", "archived"] = "open"
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    tags: List[str] = Field(default_factory=list)
    related_mods: List[str] = Field(default_factory=list)
    requested_actions: List[str] = Field(default_factory=list)
    follow_up_required: bool = False
    event_at: Optional[datetime] = None
    content: str = ""
    created_at: datetime = Field(default_factory=_utc_now)
    updated_at: datetime = Field(default_factory=_utc_now)


class ServerNoteCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    category: Literal["general", "mod_change", "mod_request", "moderation", "development", "community", "incident", "test", "handoff"] = "general"
    status: Literal["open", "in_progress", "blocked", "resolved", "archived"] = "open"
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    tags: List[str] = Field(default_factory=list)
    related_mods: List[str] = Field(default_factory=list)
    requested_actions: List[str] = Field(default_factory=list)
    follow_up_required: bool = False
    event_at: Optional[datetime] = None
    content: str = Field(min_length=1, max_length=5000)


NOTIFICATION_STATUSES = ["active", "cleared"]
NOTIFICATION_SEVERITIES = ["info", "warning", "error", "critical"]


class ServerNotification(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: f"notif_{uuid.uuid4().hex[:12]}")
    server_id: str
    notification_type: str
    severity: str = "warning"
    title: str
    message: str = ""
    checklist: List[Dict[str, Any]] = Field(default_factory=list)
    dedupe_key: str = ""
    source: str = ""
    status: str = "active"
    acknowledged: bool = False
    acknowledged_at: Optional[datetime] = None
    acknowledged_by: str = ""
    cleared_at: Optional[datetime] = None
    cleared_by: str = ""
    created_at: datetime = Field(default_factory=_utc_now)
    updated_at: datetime = Field(default_factory=_utc_now)
