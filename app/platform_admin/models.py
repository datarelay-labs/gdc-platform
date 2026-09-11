"""ORM models for operator administration (not connector runtime auth)."""

from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import JSONB

from app.database import Base, utcnow


class PlatformUser(Base):
    """Local UI/API operator account (role is advisory until auth is wired)."""

    __tablename__ = "platform_users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(128), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(32), nullable=False, default="VIEWER")
    status = Column(String(16), nullable=False, default="ACTIVE")
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    # token_version is bumped on password change / role change / forced logout
    # so any JWT carrying a stale tv claim is rejected.  See spec 020.
    token_version = Column(Integer, nullable=False, default=1, server_default="1")
    must_change_password = Column(Boolean, nullable=False, default=False, server_default="false")
    timezone = Column(String(64), nullable=True)


class PlatformDisplaySettings(Base):
    """Single-row UI display preferences (platform default timezone for timestamps)."""

    __tablename__ = "platform_display_settings"

    id = Column(Integer, primary_key=True)
    default_timezone = Column(String(64), nullable=False, default="UTC", server_default="UTC")
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class PlatformHttpsConfig(Base):
    """Single-row HTTPS / TLS self-signed settings (apply on process restart)."""

    __tablename__ = "platform_https_config"

    id = Column(Integer, primary_key=True)
    enabled = Column(Boolean, nullable=False, default=False)
    certificate_ip_addresses = Column(JSONB, nullable=False)
    certificate_dns_names = Column(JSONB, nullable=False)
    redirect_http_to_https = Column(Boolean, nullable=False, default=False)
    certificate_valid_days = Column(Integer, nullable=False, default=365)
    cert_not_after = Column(DateTime(timezone=True), nullable=True)
    cert_generated_at = Column(DateTime(timezone=True), nullable=True)
    proxy_last_reload_at = Column(DateTime(timezone=True), nullable=True)
    proxy_last_reload_ok = Column(Boolean, nullable=True)
    proxy_last_reload_detail = Column(String(1024), nullable=True)
    proxy_last_https_effective = Column(Boolean, nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


RETENTION_POLICY_ROW_ID = 1
ALERT_SETTINGS_ROW_ID = 1
NETWORK_CONFIG_ROW_ID = 1
DISPLAY_SETTINGS_ROW_ID = 1


class PlatformRetentionPolicy(Base):
    """Single-row retention targets for logs, metrics, cache, and backup temp."""

    __tablename__ = "platform_retention_policy"

    id = Column(Integer, primary_key=True)
    cleanup_scheduler_enabled = Column(Boolean, nullable=False, default=True)
    cleanup_interval_minutes = Column(Integer, nullable=False, default=60)
    cleanup_batch_size = Column(Integer, nullable=False, default=5000)

    logs_retention_days = Column(Integer, nullable=False, default=30)
    logs_enabled = Column(Boolean, nullable=False, default=True)
    logs_last_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    logs_next_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    logs_last_deleted_count = Column(Integer, nullable=True)
    logs_last_duration_ms = Column(Integer, nullable=True)
    logs_last_status = Column(String(32), nullable=True)

    runtime_metrics_retention_days = Column(Integer, nullable=False, default=30)
    runtime_metrics_enabled = Column(Boolean, nullable=False, default=True)
    runtime_metrics_last_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    runtime_metrics_next_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    runtime_metrics_last_deleted_count = Column(Integer, nullable=True)
    runtime_metrics_last_duration_ms = Column(Integer, nullable=True)
    runtime_metrics_last_status = Column(String(32), nullable=True)

    preview_cache_retention_days = Column(Integer, nullable=False, default=7)
    preview_cache_enabled = Column(Boolean, nullable=False, default=True)
    preview_cache_last_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    preview_cache_next_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    preview_cache_last_deleted_count = Column(Integer, nullable=True)
    preview_cache_last_duration_ms = Column(Integer, nullable=True)
    preview_cache_last_status = Column(String(32), nullable=True)

    backup_temp_retention_days = Column(Integer, nullable=False, default=14)
    backup_temp_enabled = Column(Boolean, nullable=False, default=True)
    backup_temp_last_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    backup_temp_next_cleanup_at = Column(DateTime(timezone=True), nullable=True)
    backup_temp_last_deleted_count = Column(Integer, nullable=True)
    backup_temp_last_duration_ms = Column(Integer, nullable=True)
    backup_temp_last_status = Column(String(32), nullable=True)

    # Throttle + last-run summaries for backfill / validation snapshot cleanup (see app.retention).
    operational_retention_meta = Column(JSONB, nullable=False, server_default="{}")

    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class PlatformAuditEvent(Base):
    """Append-only operator audit trail."""

    __tablename__ = "platform_audit_events"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    actor_username = Column(String(128), nullable=False, default="system")
    action = Column(String(64), nullable=False)
    entity_type = Column(String(64), nullable=True)
    entity_id = Column(Integer, nullable=True)
    entity_name = Column(String(256), nullable=True)
    details_json = Column(JSONB, nullable=False, default=dict)


class PlatformConfigVersion(Base):
    """Configuration change history with optional before/after snapshots (spec 023)."""

    __tablename__ = "platform_config_versions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    version = Column(Integer, nullable=False, unique=True)
    entity_type = Column(String(64), nullable=False)
    entity_id = Column(Integer, nullable=False)
    entity_name = Column(String(256), nullable=True)
    changed_by = Column(String(128), nullable=False, default="system")
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    summary = Column(String(512), nullable=True)
    snapshot_before_json = Column(JSONB, nullable=True)
    snapshot_after_json = Column(JSONB, nullable=True)


class PlatformAlertSettings(Base):
    """Alert rule toggles, channel endpoints, and cooldown configuration.

    Webhook delivery is implemented (see ``app.platform_admin.alert_service``). Email uses the
    platform SMTP sender when ``SMTP_ENABLED`` is configured. Slack remains a planned placeholder.
    """

    __tablename__ = "platform_alert_settings"

    id = Column(Integer, primary_key=True)
    rules_json = Column(JSONB, nullable=False)
    webhook_url = Column(String(1024), nullable=True)
    slack_webhook_url = Column(String(1024), nullable=True)
    email_to = Column(String(512), nullable=True)
    cooldown_seconds = Column(Integer, nullable=False, default=600)
    monitor_enabled = Column(Boolean, nullable=False, default=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class PlatformAlertHistory(Base):
    """Append-only delivery log for webhook alerts (success and failure)."""

    __tablename__ = "platform_alert_history"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    alert_type = Column(String(64), nullable=False, index=True)
    severity = Column(String(16), nullable=False)
    stream_id = Column(Integer, nullable=True, index=True)
    stream_name = Column(String(256), nullable=True)
    route_id = Column(Integer, nullable=True)
    destination_id = Column(Integer, nullable=True)
    message = Column(String(1024), nullable=False)
    fingerprint = Column(String(64), nullable=False, index=True)
    channel = Column(String(32), nullable=False, default="webhook")
    delivery_status = Column(String(32), nullable=False)
    http_status = Column(Integer, nullable=True)
    error_message = Column(String(512), nullable=True)
    webhook_url_masked = Column(String(512), nullable=True)
    duration_ms = Column(Integer, nullable=True)
    payload_json = Column(JSONB, nullable=False, default=dict)
    trigger_source = Column(String(32), nullable=False, default="monitor")


class PlatformNetworkConfig(Base):
    """Single-row externally published reverse-proxy port settings."""

    __tablename__ = "platform_network_config"

    id = Column(Integer, primary_key=True)
    http_port = Column(Integer, nullable=False, default=18080)
    https_port = Column(Integer, nullable=False, default=18443)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
