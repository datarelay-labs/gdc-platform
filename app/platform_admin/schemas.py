"""Pydantic schemas for admin settings API."""

from __future__ import annotations

from datetime import datetime

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator


class HttpsSettingsRead(BaseModel):
    enabled: bool
    certificate_ip_addresses: list[str]
    certificate_dns_names: list[str]
    redirect_http_to_https: bool
    certificate_valid_days: int
    current_access_url: str
    https_active: bool
    certificate_not_after: datetime | None = None
    restart_required_after_save: bool = Field(
        default=False,
        description="Legacy field; TLS is applied by the reverse proxy reload when configured.",
    )
    http_listener_active: bool = False
    https_listener_active: bool = False
    redirect_http_to_https_effective: bool = False
    proxy_status: Literal["ok", "degraded", "unknown", "not_configured"] = "unknown"
    proxy_health_ok: bool | None = None
    proxy_last_reload_at: datetime | None = None
    proxy_last_reload_ok: bool | None = None
    proxy_last_reload_detail: str | None = None
    proxy_fallback_to_http_last: bool = False
    browser_http_url: str = ""
    browser_https_url: str | None = None


class HttpsSettingsUpdate(BaseModel):
    enabled: bool
    certificate_ip_addresses: list[str] = Field(default_factory=list)
    certificate_dns_names: list[str] = Field(default_factory=list)
    redirect_http_to_https: bool = False
    certificate_valid_days: int = 365
    regenerate_certificate: bool = True

    @field_validator("certificate_valid_days")
    @classmethod
    def _valid_days(cls, v: int) -> int:
        if v < 1 or v > 3650:
            raise ValueError("certificate_valid_days must be between 1 and 3650")
        return v


class HttpsSettingsSaveResponse(BaseModel):
    ok: bool = True
    restart_required: bool = True
    certificate_not_after: datetime | None = None
    message: str = "Settings saved. Restart the server to apply HTTPS."
    proxy_reload_applied: bool = False
    proxy_https_effective: bool | None = None
    proxy_fallback_to_http: bool = False


class NetworkSettingsRead(BaseModel):
    http_port: int
    https_port: int
    env_example: dict[str, str]
    restart_required: bool = False
    restart_command: str = "docker compose -f docker-compose.platform.yml up -d --force-recreate reverse-proxy"

    model_config = {"from_attributes": True}


class NetworkSettingsUpdate(BaseModel):
    http_port: int = Field(ge=1, le=65535)
    https_port: int = Field(ge=1, le=65535)


class NetworkSettingsSaveResponse(NetworkSettingsRead):
    restart_required: bool = True
    message: str = (
        "Network settings saved to the database and platform .env. Apply the reverse-proxy change to update published ports."
    )


class NetworkSettingsApplyResponse(BaseModel):
    success: bool
    command: str
    stdout: str = ""
    stderr: str = ""
    exit_code: int
    message: str


class PlatformUserRead(BaseModel):
    id: int
    username: str
    role: str
    status: str
    created_at: datetime
    last_login_at: datetime | None = None
    timezone: str | None = None

    model_config = {"from_attributes": True}


class PlatformUserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=8, max_length=256)
    role: str = Field(
        pattern=r"^(ADMINISTRATOR|OPERATOR|CONNECTOR_OPERATOR|GOVERNANCE_OPERATOR|GOVERNANCE_REVIEWER|GOVERNANCE_APPROVER|GOVERNANCE_AUDITOR|VIEWER)$"
    )


class PlatformUserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=8, max_length=256)
    role: str | None = None
    status: str | None = None
    timezone: str | None = Field(default=None, max_length=64)

    @field_validator("role")
    @classmethod
    def _role_ok(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v not in (
            "ADMINISTRATOR",
            "OPERATOR",
            "CONNECTOR_OPERATOR",
            "GOVERNANCE_OPERATOR",
            "GOVERNANCE_REVIEWER",
            "GOVERNANCE_APPROVER",
            "GOVERNANCE_AUDITOR",
            "VIEWER",
        ):
            raise ValueError("role must be a valid platform role")
        return v

    @field_validator("status")
    @classmethod
    def _status_ok(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v not in ("ACTIVE", "DISABLED"):
            raise ValueError("status must be ACTIVE or DISABLED")
        return v


class DisplaySettingsRead(BaseModel):
    default_timezone: str
    updated_at: datetime | None = None


class DisplaySettingsUpdate(BaseModel):
    default_timezone: str = Field(min_length=1, max_length=64)

    @field_validator("default_timezone")
    @classmethod
    def _tz_ok(cls, v: str) -> str:
        from app.platform_admin.timezone_util import validate_iana_timezone

        return validate_iana_timezone(v)


class AdminPasswordChange(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)
    confirm_password: str = Field(min_length=8, max_length=256)

    @field_validator("confirm_password")
    @classmethod
    def _passwords_match(cls, v: str, info: ValidationInfo) -> str:
        if info.data.get("new_password") != v:
            raise ValueError("new_password and confirm_password do not match")
        return v


class SystemInfoResponse(BaseModel):
    app_name: str
    app_version: str
    app_env: str
    python_version: str
    database_reachable: bool
    database_url_masked: str
    platform: str
    server_time_utc: datetime | None = None
    timezone: str | None = Field(default=None, description="Host TZ identifier when available.")
    database_version: str | None = None
    uptime_seconds: float | None = Field(default=None, description="Scheduler uptime when scheduler is running.")


class RetentionDataTypeBlock(BaseModel):
    retention_days: int
    enabled: bool
    last_cleanup_at: datetime | None = None
    next_cleanup_at: datetime | None = None
    last_deleted_count: int | None = None
    last_duration_ms: int | None = None
    last_status: str | None = None


class RetentionPolicyRead(BaseModel):
    logs: RetentionDataTypeBlock
    runtime_metrics: RetentionDataTypeBlock
    preview_cache: RetentionDataTypeBlock
    backup_temp: RetentionDataTypeBlock
    cleanup_scheduler_active: bool = False
    cleanup_scheduler_enabled: bool = True
    cleanup_interval_minutes: int = 60
    cleanup_batch_size: int = 5000
    scheduler_started_at: datetime | None = None
    scheduler_last_tick_at: datetime | None = None
    scheduler_last_summary: str | None = None
    cleanup_engine_message: str = (
        "Retention cleanup scheduler is active. Cleanup runs on the configured interval and on demand."
    )
    delivery_logs_scheduler_metrics: dict[str, Any] | None = Field(
        default=None,
        description="Per-process cumulative counters from the operational retention thread (logs category).",
    )

    model_config = {"from_attributes": False}


class RetentionPolicyUpdate(BaseModel):
    logs_retention_days: int | None = Field(default=None, ge=1, le=3650)
    logs_enabled: bool | None = None
    runtime_metrics_retention_days: int | None = Field(default=None, ge=1, le=3650)
    runtime_metrics_enabled: bool | None = None
    preview_cache_retention_days: int | None = Field(default=None, ge=1, le=3650)
    preview_cache_enabled: bool | None = None
    backup_temp_retention_days: int | None = Field(default=None, ge=1, le=3650)
    backup_temp_enabled: bool | None = None
    cleanup_scheduler_enabled: bool | None = None
    cleanup_interval_minutes: int | None = Field(default=None, ge=5, le=1440)
    cleanup_batch_size: int | None = Field(default=None, ge=100, le=100000)


class RetentionCleanupRunRequest(BaseModel):
    categories: list[Literal["logs", "runtime_metrics", "preview_cache", "backup_temp"]] | None = None
    dry_run: bool = True


class RetentionCleanupOutcomeItem(BaseModel):
    category: str
    status: str
    enabled: bool
    dry_run: bool
    matched_count: int
    deleted_count: int
    duration_ms: int
    retention_days: int
    cutoff: datetime | None = None
    message: str
    notes: dict = Field(default_factory=dict)


class RetentionCleanupRunResponse(BaseModel):
    dry_run: bool
    triggered_at: datetime
    outcomes: list[RetentionCleanupOutcomeItem]
    policy: RetentionPolicyRead


class AuditEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    created_at: datetime
    actor_username: str
    action: str
    entity_type: str | None = None
    entity_id: int | None = None
    entity_name: str | None = None
    details: dict = Field(default_factory=dict, validation_alias="details_json", serialization_alias="details")


class AuditLogListResponse(BaseModel):
    total: int
    items: list[AuditEventRead]


class ConfigVersionRead(BaseModel):
    id: int
    version: int
    entity_type: str
    entity_id: int
    entity_name: str | None = None
    changed_by: str
    changed_at: datetime
    summary: str | None = None

    model_config = {"from_attributes": True}


class ConfigVersionListResponse(BaseModel):
    total: int
    items: list[ConfigVersionRead]


class ConfigJsonChangeItem(BaseModel):
    path: str
    change: Literal["modified", "added", "removed"]
    old: object | None = None
    new: object | None = None


class ConfigVersionDetailResponse(BaseModel):
    id: int
    version: int
    entity_type: str
    entity_id: int
    entity_name: str | None = None
    changed_by: str
    changed_at: datetime
    summary: str | None = None
    snapshot_before: dict | None = None
    snapshot_after: dict | None = None
    diff_inline: list[ConfigJsonChangeItem] = Field(default_factory=list)
    snapshots_available: bool = False


class ConfigVersionCompareResponse(BaseModel):
    left_version_row_id: int
    right_version_row_id: int
    entity_type: str
    entity_id: int
    diff: list[ConfigJsonChangeItem] = Field(default_factory=list)


class ConfigSnapshotApplyRequest(BaseModel):
    target: Literal["before", "after"]


class ConfigSnapshotApplyResponse(BaseModel):
    applied_target: Literal["before", "after"]
    source_version_row_id: int
    source_monotonic_version: int
    new_monotonic_version: int
    message: str


class HealthMetricRead(BaseModel):
    key: str
    label: str
    available: bool
    value: str | None = None
    status: Literal["good", "medium", "bad", "unknown"] = "unknown"
    notes: str | None = None
    link_path: str | None = None


class AdminHealthSummaryResponse(BaseModel):
    metrics_window_seconds: int
    metrics: list[HealthMetricRead]


class AlertRuleState(BaseModel):
    alert_type: str
    enabled: bool
    severity: Literal["WARNING", "CRITICAL"] = "WARNING"
    last_triggered_at: datetime | None = None


class AlertSettingsRead(BaseModel):
    rules: list[AlertRuleState]
    webhook_url: str | None = None
    slack_webhook_url: str | None = None
    email_to: str | None = None
    channel_status: dict[str, str] = Field(
        default_factory=dict,
        description="webhook/slack/email → configured | not_configured | planned",
    )
    notification_delivery: dict[str, str] = Field(
        default_factory=dict,
        description="webhook implemented; slack planned; email uses platform SMTP when SMTP_ENABLED.",
    )
    cooldown_seconds: int = 600
    monitor_enabled: bool = True


class AlertSettingsUpdate(BaseModel):
    rules: list[AlertRuleState] | None = None
    webhook_url: str | None = Field(default=None, max_length=1024)
    slack_webhook_url: str | None = Field(default=None, max_length=1024)
    email_to: str | None = Field(default=None, max_length=512)
    cooldown_seconds: int | None = Field(default=None, ge=10, le=86400)
    monitor_enabled: bool | None = None


class AlertTestRequest(BaseModel):
    alert_type: Literal[
        "stream_paused",
        "checkpoint_stalled",
        "destination_failed",
        "high_retry_count",
        "rate_limit_triggered",
    ] = "stream_paused"
    message: str | None = Field(default=None, max_length=512)


class AlertTestResponse(BaseModel):
    ok: bool
    delivery_status: str
    http_status: int | None = None
    duration_ms: int | None = None
    error_message: str | None = None
    webhook_url_masked: str | None = None
    history_id: int


class AlertHistoryItem(BaseModel):
    id: int
    created_at: datetime
    alert_type: str
    severity: str
    stream_id: int | None = None
    stream_name: str | None = None
    route_id: int | None = None
    destination_id: int | None = None
    message: str
    fingerprint: str
    channel: str
    delivery_status: str
    http_status: int | None = None
    error_message: str | None = None
    webhook_url_masked: str | None = None
    duration_ms: int | None = None
    trigger_source: str

    model_config = {"from_attributes": True}


class AlertHistoryListResponse(BaseModel):
    total: int
    items: list[AlertHistoryItem]


class MaintenanceNoticeRead(BaseModel):
    code: str
    message: str
    panel: str


class MaintenanceHealthResponse(BaseModel):
    """Administrator maintenance snapshot (read-only; no secrets in free text)."""

    generated_at: datetime
    overall: Literal["OK", "WARN", "ERROR"]
    ok: list[MaintenanceNoticeRead] = Field(default_factory=list)
    warn: list[MaintenanceNoticeRead] = Field(default_factory=list)
    error: list[MaintenanceNoticeRead] = Field(default_factory=list)
    panels: dict[str, Any] = Field(default_factory=dict)


class DevValidationAdminStatusResponse(BaseModel):
    """Development validation lab + fixture readiness (Administrator read-only)."""

    generated_at: datetime
    lab_effective: bool
    enable_dev_validation_lab: bool
    app_env: str
    fixture_flags: dict[str, bool] = Field(default_factory=dict)
    lab_defaults_applied: bool = False
    lab_defaults_meta: dict[str, Any] = Field(default_factory=dict)
    seeded_lab_streams_by_type: dict[str, int] = Field(default_factory=dict)
    seeded_lab_streams_total: int = 0
    platform_catalog_db: dict[str, Any] = Field(default_factory=dict)
    fixtures_required: list[dict[str, Any]] = Field(default_factory=list)
    fixture_readiness: dict[str, Any] = Field(default_factory=dict)
    fixture_readiness_badge: str = "DISABLED"
    streams_dependency_missing: list[dict[str, Any]] = Field(default_factory=list)
    validation_lab: dict[str, Any] | None = None
