"""HTTP routes for operator administration (HTTPS config, local users, password change)."""

from __future__ import annotations

import os
import platform
import sys
from dataclasses import dataclass
from typing import Any, Literal
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from starlette.status import HTTP_422_UNPROCESSABLE_CONTENT
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import get_password_hash, verify_password
from app.config import settings
from app.database import get_db
from app.platform_admin.cert_service import (
    backup_tls_pem_files,
    generate_self_signed_certificate,
    read_certificate_not_after_pem,
    verify_tls_pem_pair,
)
from app.platform_admin.timezone_util import validate_iana_timezone
from app.platform_admin.cleanup_scheduler import get_cleanup_scheduler
from app.platform_admin.cleanup_service import CATEGORIES, run_cleanup
from app.platform_admin.alert_monitor import get_alert_monitor
from app.platform_admin.alert_service import (
    ALERT_TYPES,
    AlertEvent,
    deliver_alert,
    list_alert_history,
)
from app.platform_admin.models import PlatformUser
from app.database import utcnow
from app.platform_admin import journal
from app.platform_admin.dev_validation_lab_admin import build_dev_validation_admin_status
from app.platform_admin.health_summary import build_admin_health_summary
from app.platform_admin.maintenance_health import build_maintenance_health
from app.platform_admin.config_json_diff import diff_json
from app.platform_admin.config_rollback_service import ConfigSnapshotApplyError, apply_versioned_snapshot
from app.platform_admin.repository import (
    count_administrators,
    count_audit_events,
    count_config_versions,
    get_alert_settings_row,
    get_config_version_by_id,
    get_display_settings_row,
    get_https_config_row,
    get_network_config_row,
    get_retention_policy_row,
    get_user_by_id,
    get_user_by_username,
    list_audit_events,
    list_config_versions,
    list_users,
)
from app.platform_admin.schemas import (
    AdminHealthSummaryResponse,
    AdminPasswordChange,
    AlertHistoryItem,
    AlertHistoryListResponse,
    AlertRuleState,
    AlertSettingsRead,
    AlertSettingsUpdate,
    AlertTestRequest,
    AlertTestResponse,
    AuditEventRead,
    AuditLogListResponse,
    DisplaySettingsRead,
    DisplaySettingsUpdate,
    ConfigJsonChangeItem,
    ConfigSnapshotApplyRequest,
    ConfigSnapshotApplyResponse,
    ConfigVersionCompareResponse,
    ConfigVersionDetailResponse,
    ConfigVersionListResponse,
    ConfigVersionRead,
    HealthMetricRead,
    MaintenanceHealthResponse,
    DevValidationAdminStatusResponse,
    NetworkSettingsApplyResponse,
    NetworkSettingsRead,
    NetworkSettingsSaveResponse,
    NetworkSettingsUpdate,
    HttpsSettingsRead,
    HttpsSettingsSaveResponse,
    HttpsSettingsUpdate,
    PlatformUserCreate,
    PlatformUserRead,
    PlatformUserUpdate,
    RetentionCleanupOutcomeItem,
    RetentionCleanupRunRequest,
    RetentionCleanupRunResponse,
    RetentionDataTypeBlock,
    RetentionPolicyRead,
    RetentionPolicyUpdate,
    SystemInfoResponse,
)
from app.platform_admin.network_config import (
    NetworkPortConfig,
    NetworkPortValidationError,
    apply_reverse_proxy_recreate,
    read_platform_env_ports,
    update_platform_env_ports,
    validate_network_ports,
)
from app.platform_admin.nginx_runtime import (
    apply_nginx_runtime,
    probe_proxy_health,
    tls_ready_for_proxy,
)
from app.platform_admin.validation import normalize_username, validate_dns_sans, validate_ip_sans
from app.scheduler.runtime_state import scheduler_uptime_seconds
from app.admin.support_bundle import build_support_bundle_zip_bytes
from app.auth.role_guard import ROLE_ADMINISTRATOR, require_roles

router = APIRouter()


@dataclass(frozen=True)
class ProxyConfigSyncResult:
    proxy_reload_ok: bool
    proxy_https_effective: bool
    proxy_reload_detail: str


def _retention_block(r: object, cat: str) -> RetentionDataTypeBlock:
    raw_days = getattr(r, f"{cat}_retention_days", None)
    retention_days = int(raw_days) if raw_days is not None else 30
    return RetentionDataTypeBlock(
        retention_days=retention_days,
        enabled=bool(getattr(r, f"{cat}_enabled")),
        last_cleanup_at=getattr(r, f"{cat}_last_cleanup_at"),
        next_cleanup_at=getattr(r, f"{cat}_next_cleanup_at"),
        last_deleted_count=getattr(r, f"{cat}_last_deleted_count", None),
        last_duration_ms=getattr(r, f"{cat}_last_duration_ms", None),
        last_status=getattr(r, f"{cat}_last_status", None),
    )


def _retention_read(row: object) -> RetentionPolicyRead:
    r = row
    scheduler = get_cleanup_scheduler()
    scheduler_active = bool(scheduler and scheduler.is_running())
    scheduler_started_at = scheduler.started_at if scheduler else None
    scheduler_last_tick_at = scheduler.last_tick_at() if scheduler else None
    scheduler_last_summary = scheduler.last_outcome_summary() if scheduler else None
    if bool(r.cleanup_scheduler_enabled) and scheduler_active:
        msg = (
            "Retention cleanup scheduler is active. Cleanup runs on the configured interval"
            " and on demand."
        )
    elif not bool(r.cleanup_scheduler_enabled):
        msg = "Retention cleanup scheduler is disabled in the retention policy."
    else:
        msg = "Retention cleanup scheduler thread is not running in this process."
    return RetentionPolicyRead(
        logs=_retention_block(r, "logs"),
        runtime_metrics=_retention_block(r, "runtime_metrics"),
        preview_cache=_retention_block(r, "preview_cache"),
        backup_temp=_retention_block(r, "backup_temp"),
        cleanup_scheduler_active=scheduler_active,
        cleanup_scheduler_enabled=bool(r.cleanup_scheduler_enabled),
        cleanup_interval_minutes=int(r.cleanup_interval_minutes or 60),
        cleanup_batch_size=int(r.cleanup_batch_size or 5000),
        scheduler_started_at=scheduler_started_at,
        scheduler_last_tick_at=scheduler_last_tick_at,
        scheduler_last_summary=scheduler_last_summary,
        cleanup_engine_message=msg,
        delivery_logs_scheduler_metrics=_scheduler_delivery_logs_metrics(),
    )


def _scheduler_delivery_logs_metrics() -> dict[str, Any] | None:
    sched = get_cleanup_scheduler()
    if sched is None:
        return None
    fn = getattr(sched, "delivery_logs_cleanup_metrics", None)
    if not callable(fn):
        return None
    try:
        return fn()
    except Exception:
        return None


def _alert_read(row: object) -> AlertSettingsRead:
    raw_rules = list(row.rules_json or [])
    rules: list[AlertRuleState] = []
    for item in raw_rules:
        if not isinstance(item, dict):
            continue
        try:
            rules.append(AlertRuleState.model_validate(item))
        except Exception:
            continue
    wh = (row.webhook_url or "").strip()
    sl = (row.slack_webhook_url or "").strip()
    em = (row.email_to or "").strip()
    channel_status = {
        "webhook": "configured" if wh else "not_configured",
        "slack": "configured" if sl else "not_configured",
        "email": "configured" if em else "not_configured",
    }
    notification_delivery = {
        "webhook": "implemented",
        "slack": "planned",
        "email": "implemented",
    }
    return AlertSettingsRead(
        rules=rules,
        webhook_url=row.webhook_url,
        slack_webhook_url=row.slack_webhook_url,
        email_to=row.email_to,
        channel_status=channel_status,
        notification_delivery=notification_delivery,
        cooldown_seconds=int(getattr(row, "cooldown_seconds", 600) or 600),
        monitor_enabled=bool(getattr(row, "monitor_enabled", True)),
    )


def _http_error(code: str, message: str, status_code: int = HTTP_422_UNPROCESSABLE_CONTENT) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"error_code": code, "message": message})


def _tls_paths() -> tuple[Path, Path]:
    cert = Path(settings.GDC_TLS_CERT_PATH).expanduser()
    key = Path(settings.GDC_TLS_KEY_PATH).expanduser()
    if not cert.is_absolute():
        cert = Path.cwd() / cert
    if not key.is_absolute():
        key = Path.cwd() / key
    return cert, key


def _raw_browser_host(request: Request) -> str:
    x = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    if x:
        return x
    return (request.headers.get("host") or "127.0.0.1").strip() or "127.0.0.1"


def _hostname_for_https_link(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return "127.0.0.1"
    if raw.startswith("["):
        end = raw.find("]")
        return raw[: end + 1] if end != -1 else raw
    if raw.count(":") > 1:
        return raw
    if raw.count(":") == 1:
        host, port = raw.rsplit(":", 1)
        if port.isdigit():
            return host
    return raw


def _browser_http_url(request: Request, *, http_port: int) -> str:
    host = _hostname_for_https_link(_raw_browser_host(request))
    if int(http_port) in (0, 80):
        return f"http://{host}"
    return f"http://{host}:{int(http_port)}"


def _browser_https_url(request: Request, *, https_port: int) -> str | None:
    host = _hostname_for_https_link(_raw_browser_host(request))
    if int(https_port) in (0, 443):
        return f"https://{host}"
    return f"https://{host}:{int(https_port)}"


def _build_current_access_url(request: Request, *, https_enabled: bool) -> str:
    scheme = "https" if https_enabled else "http"
    xf_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if xf_proto in ("http", "https"):
        scheme = xf_proto
    raw = _raw_browser_host(request)
    if "://" in raw:
        return raw
    host = _hostname_for_https_link(raw)
    port = request.url.port
    if not port and ":" in raw:
        try:
            port = int(raw.rsplit(":", maxsplit=1)[-1])
        except ValueError:
            port = None
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


def _effective_cert_expiry(row: object, cert_path: Path) -> datetime | None:
    if getattr(row, "cert_not_after", None):
        return row.cert_not_after
    return read_certificate_not_after_pem(cert_path)


def _compute_proxy_status(
    *, reload_url_configured: bool, row: object, health_ok: bool | None
) -> Literal["ok", "degraded", "unknown", "not_configured"]:
    if not reload_url_configured:
        return "not_configured"
    if getattr(row, "proxy_last_reload_ok", None) is False:
        return "degraded"
    if (settings.GDC_PROXY_INTERNAL_HEALTH_URL or "").strip():
        if health_ok is False:
            return "degraded"
    if reload_url_configured and getattr(row, "proxy_last_reload_ok", None) is None:
        return "unknown"
    return "ok"


def _mask_database_url(url: str) -> str:
    try:
        p = urlparse(url)
        if p.password:
            netloc = p.netloc.replace(f":{p.password}@", ":****@")
            return p._replace(netloc=netloc).geturl()
    except Exception:
        pass
    return "****"


def _effective_network_ports(row: object) -> NetworkPortConfig:
    env_cfg = read_platform_env_ports()
    if env_cfg is not None:
        return env_cfg
    return validate_network_ports(getattr(row, "http_port"), getattr(row, "https_port"))


def _network_read(row: object, *, restart_required: bool = False) -> NetworkSettingsRead:
    cfg = _effective_network_ports(row)
    return NetworkSettingsRead(
        http_port=cfg.http_port,
        https_port=cfg.https_port,
        env_example={
            "GDC_HTTP_PORT": str(cfg.http_port),
            "GDC_HTTPS_PORT": str(cfg.https_port),
        },
        restart_required=restart_required,
    )


def _sync_proxy_config_from_https_toggle(db: Session, *, https_port: int) -> ProxyConfigSyncResult:
    """Write nginx site config from the authoritative Admin HTTPS toggle."""

    https_row = get_https_config_row(db)
    cert_path, key_path = _tls_paths()
    outcome = apply_nginx_runtime(
        desired_https=bool(https_row.enabled),
        desired_redirect=bool(https_row.redirect_http_to_https),
        cert_host_path=cert_path,
        key_host_path=key_path,
        https_port=https_port,
    )
    https_row.proxy_last_reload_at = utcnow()
    https_row.proxy_last_reload_ok = outcome.reload_ok
    https_row.proxy_last_reload_detail = (outcome.reload_detail or "")[:1024]
    https_row.proxy_last_https_effective = outcome.used_https_block
    db.flush()
    return ProxyConfigSyncResult(
        proxy_reload_ok=outcome.reload_ok,
        proxy_https_effective=outcome.used_https_block,
        proxy_reload_detail=outcome.reload_detail,
    )


@router.get("/network-settings", response_model=NetworkSettingsRead)
def read_network_settings(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> NetworkSettingsRead:
    row = get_network_config_row(db)
    return _network_read(row)


@router.put("/network-settings", response_model=NetworkSettingsSaveResponse)
def update_network_settings(
    payload: NetworkSettingsUpdate,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> NetworkSettingsSaveResponse:
    try:
        cfg = validate_network_ports(payload.http_port, payload.https_port)
    except NetworkPortValidationError as exc:
        raise _http_error("NETWORK_PORT_INVALID", str(exc)) from exc

    row = get_network_config_row(db)
    row.http_port = cfg.http_port
    row.https_port = cfg.https_port
    env_update = update_platform_env_ports(cfg)
    journal.record_audit_event(
        db,
        action="NETWORK_SETTINGS_UPDATED",
        actor_username="system",
        details={
            "http_port": cfg.http_port,
            "https_port": cfg.https_port,
            "env_path": str(env_update.env_path),
            "env_backup_path": str(env_update.backup_path),
            "restart_required": True,
        },
    )
    db.commit()
    db.refresh(row)
    read = _network_read(row, restart_required=True)
    return NetworkSettingsSaveResponse(
        http_port=read.http_port,
        https_port=read.https_port,
        env_example=read.env_example,
        restart_required=True,
    )


@router.post("/network-settings/apply", response_model=NetworkSettingsApplyResponse)
def apply_network_settings(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> NetworkSettingsApplyResponse:
    row = get_network_config_row(db)
    cfg = _effective_network_ports(row)
    proxy_sync = _sync_proxy_config_from_https_toggle(db, https_port=cfg.https_port)
    result = apply_reverse_proxy_recreate(http_port=cfg.http_port, https_port=cfg.https_port)
    https_row = get_https_config_row(db)
    if result.success:
        https_row.proxy_last_reload_at = utcnow()
        https_row.proxy_last_reload_ok = True
        https_row.proxy_last_reload_detail = "reverse proxy recreated from network settings apply"
        https_row.proxy_last_https_effective = proxy_sync.proxy_https_effective
    journal.record_audit_event(
        db,
        action="NETWORK_SETTINGS_APPLY_REVERSE_PROXY_RECREATE",
        actor_username="system",
        details={
            "command": result.command,
            "success": result.success,
            "exit_code": result.exit_code,
            "https_effective": proxy_sync.proxy_https_effective,
            "config_reload_ok_before_recreate": proxy_sync.proxy_reload_ok,
            "config_reload_detail_before_recreate": proxy_sync.proxy_reload_detail,
        },
    )
    db.commit()
    message = (
        "Reverse proxy recreated. Reconnect using the configured HTTP/HTTPS port if the browser disconnects."
        if result.success
        else "Reverse proxy recreate failed. Review stdout and stderr."
    )
    return NetworkSettingsApplyResponse(
        success=result.success,
        command=result.command,
        stdout=result.stdout,
        stderr=result.stderr,
        exit_code=result.exit_code,
        message=message,
    )


@router.get("/https-settings", response_model=HttpsSettingsRead)
def read_https_settings(request: Request, db: Session = Depends(get_db)) -> HttpsSettingsRead:
    row = get_https_config_row(db)
    network_cfg = _effective_network_ports(get_network_config_row(db))
    ips = list(row.certificate_ip_addresses or [])
    dns = list(row.certificate_dns_names or [])
    cert_path, key_path = _tls_paths()
    current = _build_current_access_url(request, https_enabled=bool(row.enabled))
    reload_url_configured = bool((settings.GDC_PROXY_RELOAD_URL or "").strip())
    health_ok: bool | None = None
    if (settings.GDC_PROXY_INTERNAL_HEALTH_URL or "").strip():
        ok_h, _ = probe_proxy_health()
        health_ok = ok_h

    tls_ok, _ = tls_ready_for_proxy(cert_path, key_path) if row.enabled else (False, "")
    https_listener = bool(
        row.enabled
        and tls_ok
        and getattr(row, "proxy_last_https_effective", None) is True
        and getattr(row, "proxy_last_reload_ok", None) is not False
    )
    http_listener = True
    if (settings.GDC_PROXY_INTERNAL_HEALTH_URL or "").strip():
        http_listener = bool(health_ok)

    redirect_effective = bool(row.redirect_http_to_https and https_listener)
    proxy_status: Literal["ok", "degraded", "unknown", "not_configured"] = _compute_proxy_status(
        reload_url_configured=reload_url_configured, row=row, health_ok=health_ok
    )
    fb = "fell back" in (getattr(row, "proxy_last_reload_detail", None) or "").lower()

    return HttpsSettingsRead(
        enabled=bool(row.enabled),
        certificate_ip_addresses=ips,
        certificate_dns_names=dns,
        redirect_http_to_https=bool(row.redirect_http_to_https),
        certificate_valid_days=int(row.certificate_valid_days or 365),
        current_access_url=current,
        https_active=https_listener,
        certificate_not_after=_effective_cert_expiry(row, cert_path),
        restart_required_after_save=False,
        http_listener_active=http_listener,
        https_listener_active=https_listener,
        redirect_http_to_https_effective=redirect_effective,
        proxy_status=proxy_status,
        proxy_health_ok=health_ok,
        proxy_last_reload_at=getattr(row, "proxy_last_reload_at", None),
        proxy_last_reload_ok=getattr(row, "proxy_last_reload_ok", None),
        proxy_last_reload_detail=getattr(row, "proxy_last_reload_detail", None),
        proxy_fallback_to_http_last=fb,
        browser_http_url=_browser_http_url(request, http_port=network_cfg.http_port),
        browser_https_url=_browser_https_url(request, https_port=network_cfg.https_port) if row.enabled else None,
    )


@router.put("/https-settings", response_model=HttpsSettingsSaveResponse)
def update_https_settings(payload: HttpsSettingsUpdate, request: Request, db: Session = Depends(get_db)) -> HttpsSettingsSaveResponse:
    try:
        ips = validate_ip_sans(payload.certificate_ip_addresses)
        dns = validate_dns_sans(payload.certificate_dns_names)
    except ValueError as exc:
        raise _http_error("HTTPS_SAN_INVALID", str(exc)) from exc

    if payload.enabled and not ips and not dns:
        raise _http_error(
            "HTTPS_SAN_REQUIRED",
            "When HTTPS is enabled, provide at least one certificate IP or DNS SAN.",
        )

    row = get_https_config_row(db)
    row.enabled = payload.enabled
    row.certificate_ip_addresses = ips
    row.certificate_dns_names = dns
    row.redirect_http_to_https = payload.redirect_http_to_https
    row.certificate_valid_days = payload.certificate_valid_days

    cert_path, key_path = _tls_paths()
    cert_not_after: datetime | None = None
    if payload.enabled:
        if payload.regenerate_certificate:
            backup_tls_pem_files(cert_path, key_path)
            try:
                cert_not_after = generate_self_signed_certificate(
                    ip_sans=ips,
                    dns_sans=dns,
                    valid_days=payload.certificate_valid_days,
                    cert_path=cert_path,
                    key_path=key_path,
                )
            except Exception as exc:
                raise _http_error("HTTPS_CERT_GENERATION_FAILED", str(exc), status.HTTP_500_INTERNAL_SERVER_ERROR) from exc
            row.cert_generated_at = utcnow()
        else:
            ok_pair, msg = verify_tls_pem_pair(cert_path, key_path)
            if not ok_pair:
                raise _http_error("HTTPS_CERT_INVALID", msg or "invalid TLS PEM material", status.HTTP_422_UNPROCESSABLE_CONTENT)
            cert_not_after = read_certificate_not_after_pem(cert_path)
        row.cert_not_after = cert_not_after
    else:
        row.cert_not_after = None
        row.cert_generated_at = None

    journal.record_audit_event(
        db,
        action="HTTPS_SETTINGS_UPDATED",
        actor_username="system",
        details={
            "enabled": payload.enabled,
            "redirect_http_to_https": payload.redirect_http_to_https,
            "certificate_valid_days": payload.certificate_valid_days,
            "regenerate_certificate": payload.regenerate_certificate,
        },
    )
    db.commit()

    outcome = apply_nginx_runtime(
        desired_https=bool(payload.enabled),
        desired_redirect=bool(payload.redirect_http_to_https),
        cert_host_path=cert_path,
        key_host_path=key_path,
        https_port=_effective_network_ports(get_network_config_row(db)).https_port,
    )
    row2 = get_https_config_row(db)
    row2.proxy_last_reload_at = utcnow()
    row2.proxy_last_reload_ok = outcome.reload_ok
    row2.proxy_last_reload_detail = (outcome.reload_detail or "")[:1024]
    row2.proxy_last_https_effective = outcome.used_https_block
    db.commit()

    reload_url_set = bool((settings.GDC_PROXY_RELOAD_URL or "").strip())
    restart_required = (not reload_url_set) or (not outcome.reload_ok)
    if restart_required and not reload_url_set:
        msg = (
            "HTTPS settings saved and nginx configuration was written. "
            "Reload the reverse proxy container (or set GDC_PROXY_RELOAD_URL) to apply changes."
        )
    elif restart_required:
        msg = "HTTPS settings saved, but the reverse proxy reload failed; HTTP fallback may be active. Check proxy logs."
    elif outcome.fell_back_to_http:
        msg = (
            "HTTPS settings saved; TLS listener failed to load and the proxy fell back to HTTP-only "
            "so the UI stays reachable."
        )
    else:
        msg = "HTTPS settings saved and the reverse proxy was reloaded successfully."

    return HttpsSettingsSaveResponse(
        certificate_not_after=cert_not_after,
        restart_required=restart_required,
        message=msg,
        proxy_reload_applied=outcome.reload_ok,
        proxy_https_effective=outcome.used_https_block,
        proxy_fallback_to_http=outcome.fell_back_to_http,
    )


@router.get("/users", response_model=list[PlatformUserRead])
def read_users(db: Session = Depends(get_db)) -> list[PlatformUserRead]:
    return [PlatformUserRead.model_validate(u) for u in list_users(db)]


@router.post("/users", response_model=PlatformUserRead, status_code=status.HTTP_201_CREATED)
def create_user(payload: PlatformUserCreate, db: Session = Depends(get_db)) -> PlatformUserRead:
    try:
        username = normalize_username(payload.username)
    except ValueError as exc:
        raise _http_error("USER_USERNAME_INVALID", str(exc)) from exc

    user = PlatformUser(
        username=username,
        password_hash=get_password_hash(payload.password),
        role=payload.role,
        status="ACTIVE",
    )
    db.add(user)
    try:
        db.flush()
        journal.record_audit_event(
            db,
            action="USER_CREATED",
            actor_username=username,
            entity_type="PLATFORM_USER",
            entity_id=int(user.id),
            entity_name=username,
            details={"role": payload.role},
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "USER_USERNAME_TAKEN", "message": f"username already exists: {username}"},
        ) from exc
    db.refresh(user)
    return PlatformUserRead.model_validate(user)


@router.patch("/users/{user_id}", response_model=PlatformUserRead)
def update_user(user_id: int, payload: PlatformUserUpdate, db: Session = Depends(get_db)) -> PlatformUserRead:
    user = get_user_by_id(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error_code": "USER_NOT_FOUND", "message": "user not found"})

    if payload.role is not None or payload.status is not None:
        was_admin = user.role == "ADMINISTRATOR" and user.status == "ACTIVE"
        new_role = payload.role if payload.role is not None else user.role
        new_status = payload.status if payload.status is not None else user.status
        if was_admin and (new_role != "ADMINISTRATOR" or new_status != "ACTIVE"):
            if count_administrators(db) <= 1:
                raise _http_error("USER_LAST_ADMIN", "Cannot demote or disable the last active Administrator.")

    bump_token_version = False
    if payload.password is not None:
        user.password_hash = get_password_hash(payload.password)
        user.must_change_password = False
        bump_token_version = True
    if payload.role is not None and payload.role != user.role:
        user.role = payload.role
        bump_token_version = True
    if payload.status is not None and payload.status != user.status:
        user.status = payload.status
        if payload.status != "ACTIVE":
            bump_token_version = True
    if payload.timezone is not None:
        from app.platform_admin.timezone_util import validate_iana_timezone

        user.timezone = validate_iana_timezone(payload.timezone) if str(payload.timezone).strip() else None

    if bump_token_version:
        user.token_version = int(getattr(user, "token_version", 1) or 1) + 1

    details = payload.model_dump(exclude_unset=True, exclude={"password": True})
    if payload.password is not None:
        details["password_rotated"] = True
    if bump_token_version:
        details["token_version_bumped"] = True
    journal.record_audit_event(
        db,
        action="USER_UPDATED",
        actor_username="system",
        entity_type="PLATFORM_USER",
        entity_id=int(user.id),
        entity_name=user.username,
        details=details,
    )
    db.commit()
    db.refresh(user)
    return PlatformUserRead.model_validate(user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: int, db: Session = Depends(get_db)) -> None:
    user = get_user_by_id(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error_code": "USER_NOT_FOUND", "message": "user not found"})

    if user.role == "ADMINISTRATOR" and user.status == "ACTIVE" and count_administrators(db) <= 1:
        raise _http_error("USER_LAST_ADMIN", "Cannot delete the last active Administrator.", status.HTTP_400_BAD_REQUEST)

    uname = user.username
    uid = int(user.id)
    journal.record_audit_event(
        db,
        action="USER_DELETED",
        actor_username="system",
        entity_type="PLATFORM_USER",
        entity_id=uid,
        entity_name=uname,
        details={},
    )
    db.delete(user)
    db.commit()


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(payload: AdminPasswordChange, db: Session = Depends(get_db)) -> None:
    try:
        username = normalize_username(payload.username)
    except ValueError as exc:
        raise _http_error("USER_USERNAME_INVALID", str(exc)) from exc

    user = get_user_by_username(db, username)
    if user is None or user.status != "ACTIVE":
        raise _http_error("USER_AUTH_FAILED", "Invalid username or password.", status.HTTP_400_BAD_REQUEST)

    if not verify_password(payload.current_password, user.password_hash):
        raise _http_error("USER_AUTH_FAILED", "Invalid username or password.", status.HTTP_400_BAD_REQUEST)

    user.password_hash = get_password_hash(payload.new_password)
    user.must_change_password = False
    user.token_version = int(getattr(user, "token_version", 1) or 1) + 1
    journal.record_audit_event(
        db,
        action="PASSWORD_CHANGED",
        actor_username=username,
        entity_type="PLATFORM_USER",
        entity_id=int(user.id),
        entity_name=username,
        details={"token_version_bumped": True},
    )
    db.commit()


@router.get("/system", response_model=SystemInfoResponse)
def system_info(db: Session = Depends(get_db)) -> SystemInfoResponse:
    masked = _mask_database_url(settings.DATABASE_URL)
    reachable = True
    db_version: str | None = None
    try:
        db.execute(text("SELECT 1"))
        db_version = str(db.execute(text("SELECT version()")).scalar() or "")
    except Exception:
        reachable = False

    now = datetime.now(timezone.utc)
    tz = os.environ.get("TZ")
    _su = scheduler_uptime_seconds()

    return SystemInfoResponse(
        app_name=settings.APP_NAME,
        app_version="0.1.0",
        app_env=settings.APP_ENV,
        python_version=sys.version.split()[0],
        database_reachable=reachable,
        database_url_masked=masked,
        platform=platform.platform(),
        server_time_utc=now,
        timezone=tz,
        database_version=db_version,
        uptime_seconds=float(_su) if _su is not None else None,
    )


@router.get("/retention-policy", response_model=RetentionPolicyRead)
def read_retention_policy(db: Session = Depends(get_db)) -> RetentionPolicyRead:
    row = get_retention_policy_row(db)
    return _retention_read(row)


@router.put("/retention-policy", response_model=RetentionPolicyRead)
def update_retention_policy(payload: RetentionPolicyUpdate, db: Session = Depends(get_db)) -> RetentionPolicyRead:
    row = get_retention_policy_row(db)
    data = payload.model_dump(exclude_unset=True)
    allowed = {
        "logs_retention_days",
        "logs_enabled",
        "runtime_metrics_retention_days",
        "runtime_metrics_enabled",
        "preview_cache_retention_days",
        "preview_cache_enabled",
        "backup_temp_retention_days",
        "backup_temp_enabled",
        "cleanup_scheduler_enabled",
        "cleanup_interval_minutes",
        "cleanup_batch_size",
    }
    for k, v in data.items():
        if k in allowed and hasattr(row, k):
            setattr(row, k, v)
    journal.record_audit_event(
        db,
        action="RETENTION_POLICY_UPDATED",
        actor_username="system",
        details=data,
    )
    db.commit()
    db.refresh(row)
    return _retention_read(row)


def _display_settings_read(row: object) -> DisplaySettingsRead:
    return DisplaySettingsRead(
        default_timezone=str(getattr(row, "default_timezone", None) or "UTC"),
        updated_at=getattr(row, "updated_at", None),
    )


@router.get("/display-settings", response_model=DisplaySettingsRead)
def read_display_settings(db: Session = Depends(get_db)) -> DisplaySettingsRead:
    row = get_display_settings_row(db)
    return _display_settings_read(row)


@router.put("/display-settings", response_model=DisplaySettingsRead)
def update_display_settings(payload: DisplaySettingsUpdate, db: Session = Depends(get_db)) -> DisplaySettingsRead:
    tz = validate_iana_timezone(payload.default_timezone)
    row = get_display_settings_row(db)
    row.default_timezone = tz
    journal.record_audit_event(
        db,
        action="DISPLAY_SETTINGS_UPDATED",
        actor_username="system",
        details={"default_timezone": tz},
    )
    db.commit()
    db.refresh(row)
    return _display_settings_read(row)


@router.post("/retention-policy/run", response_model=RetentionCleanupRunResponse)
def run_retention_cleanup(
    payload: RetentionCleanupRunRequest | None = None,
    db: Session = Depends(get_db),
) -> RetentionCleanupRunResponse:
    """Trigger retention cleanup synchronously (Run cleanup now)."""

    triggered_at = utcnow()
    body = payload or RetentionCleanupRunRequest()
    categories = body.categories if body.categories else None
    outcomes = run_cleanup(
        db,
        categories=categories,
        dry_run=body.dry_run,
        actor_username="system",
        trigger="manual",
    )
    row = get_retention_policy_row(db)
    return RetentionCleanupRunResponse(
        dry_run=body.dry_run,
        triggered_at=triggered_at,
        outcomes=[
            RetentionCleanupOutcomeItem(
                category=o.category,
                status=o.status,
                enabled=o.enabled,
                dry_run=o.dry_run,
                matched_count=o.matched_count,
                deleted_count=o.deleted_count,
                duration_ms=o.duration_ms,
                retention_days=o.retention_days,
                cutoff=o.cutoff,
                message=o.message,
                notes=dict(o.notes or {}),
            )
            for o in outcomes
        ],
        policy=_retention_read(row),
    )


@router.get("/audit-log", response_model=AuditLogListResponse)
def read_audit_log(
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> AuditLogListResponse:
    total = count_audit_events(db)
    rows = list_audit_events(db, limit=limit, offset=offset)
    return AuditLogListResponse(total=total, items=[AuditEventRead.model_validate(r) for r in rows])


@router.get("/config-versions/compare", response_model=ConfigVersionCompareResponse)
def compare_config_versions(
    db: Session = Depends(get_db),
    left_id: int = Query(..., ge=1, description="platform_config_versions.id (left)"),
    right_id: int = Query(..., ge=1, description="platform_config_versions.id (right)"),
) -> ConfigVersionCompareResponse:
    left = get_config_version_by_id(db, left_id)
    right = get_config_version_by_id(db, right_id)
    if left is None or right is None:
        raise _http_error("CONFIG_VERSION_NOT_FOUND", "One or both config version rows were not found.", status.HTTP_404_NOT_FOUND)
    if str(left.entity_type) != str(right.entity_type) or int(left.entity_id) != int(right.entity_id):
        raise _http_error(
            "CONFIG_COMPARE_ENTITY_MISMATCH",
            "Compared rows must share the same entity_type and entity_id.",
            status.HTTP_400_BAD_REQUEST,
        )

    def _side_doc(row: object) -> dict:
        after = getattr(row, "snapshot_after_json", None)
        before = getattr(row, "snapshot_before_json", None)
        if after is not None:
            return dict(after)
        if before is not None:
            return dict(before)
        return {}

    changes = diff_json(_side_doc(left), _side_doc(right))
    return ConfigVersionCompareResponse(
        left_version_row_id=left_id,
        right_version_row_id=right_id,
        entity_type=str(left.entity_type),
        entity_id=int(left.entity_id),
        diff=[ConfigJsonChangeItem.model_validate(x) for x in changes],
    )


@router.get("/config-versions/{row_id}", response_model=ConfigVersionDetailResponse)
def read_config_version_detail(row_id: int, db: Session = Depends(get_db)) -> ConfigVersionDetailResponse:
    row = get_config_version_by_id(db, row_id)
    if row is None:
        raise _http_error("CONFIG_VERSION_NOT_FOUND", f"config version not found: {row_id}", status.HTTP_404_NOT_FOUND)
    before = row.snapshot_before_json
    after = row.snapshot_after_json
    before_d = dict(before) if before is not None else None
    after_d = dict(after) if after is not None else None
    if before_d is not None or after_d is not None:
        inline = diff_json(before_d if before_d is not None else {}, after_d if after_d is not None else {})
    else:
        inline = []
    snaps = before_d is not None or after_d is not None
    return ConfigVersionDetailResponse(
        id=int(row.id),
        version=int(row.version),
        entity_type=str(row.entity_type),
        entity_id=int(row.entity_id),
        entity_name=row.entity_name,
        changed_by=str(row.changed_by),
        changed_at=row.created_at,
        summary=row.summary,
        snapshot_before=before_d,
        snapshot_after=after_d,
        diff_inline=[ConfigJsonChangeItem.model_validate(x) for x in inline],
        snapshots_available=snaps,
    )


@router.post("/config-versions/{row_id}/apply-snapshot", response_model=ConfigSnapshotApplyResponse)
def apply_config_version_snapshot(
    row_id: int,
    body: ConfigSnapshotApplyRequest,
    db: Session = Depends(get_db),
) -> ConfigSnapshotApplyResponse:
    row = get_config_version_by_id(db, row_id)
    if row is None:
        raise _http_error("CONFIG_VERSION_NOT_FOUND", f"config version not found: {row_id}", status.HTTP_404_NOT_FOUND)
    try:
        new_v, _ = apply_versioned_snapshot(db, version_row=row, target=body.target, actor_username="system")
    except ConfigSnapshotApplyError as exc:
        raise _http_error(exc.error_code, str(exc), exc.http_status) from exc
    except ValueError as exc:
        raise _http_error("CONFIG_SNAPSHOT_APPLY_FAILED", str(exc), HTTP_422_UNPROCESSABLE_CONTENT) from exc
    return ConfigSnapshotApplyResponse(
        applied_target=body.target,
        source_version_row_id=int(row.id),
        source_monotonic_version=int(row.version),
        new_monotonic_version=int(new_v),
        message="Snapshot applied. A new configuration version row records the resulting state.",
    )


@router.get("/config-versions", response_model=ConfigVersionListResponse)
def read_config_versions(
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    entity_type: str | None = Query(None, description="Filter by entity_type (e.g. STREAM_CONFIG)."),
    entity_id: int | None = Query(None, ge=1, description="Filter by entity_id (requires entity_type)."),
) -> ConfigVersionListResponse:
    if entity_id is not None and entity_type is None:
        raise _http_error(
            "CONFIG_VERSION_FILTER_INVALID",
            "entity_id filter requires entity_type.",
            status.HTTP_400_BAD_REQUEST,
        )
    total = count_config_versions(db, entity_type=entity_type, entity_id=entity_id)
    rows = list_config_versions(db, limit=limit, offset=offset, entity_type=entity_type, entity_id=entity_id)
    return ConfigVersionListResponse(
        total=total,
        items=[
            ConfigVersionRead(
                id=int(r.id),
                version=int(r.version),
                entity_type=str(r.entity_type),
                entity_id=int(r.entity_id),
                entity_name=r.entity_name,
                changed_by=str(r.changed_by),
                changed_at=r.created_at,
                summary=r.summary,
            )
            for r in rows
        ],
    )


@router.get("/dev-validation/status", response_model=DevValidationAdminStatusResponse)
@router.get("/dev-validation/status/", response_model=DevValidationAdminStatusResponse, include_in_schema=False)
def read_dev_validation_lab_status(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> DevValidationAdminStatusResponse:
    """Lab fixture expectations, live probes, dependency-missing lab streams, and validation summary."""

    raw = build_dev_validation_admin_status(db)
    return DevValidationAdminStatusResponse.model_validate(raw)


@router.get("/maintenance/health", response_model=MaintenanceHealthResponse)
def read_maintenance_health(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> MaintenanceHealthResponse:
    """Read-only production maintenance snapshot (Administrator only)."""

    raw = build_maintenance_health(db)
    return MaintenanceHealthResponse.model_validate(raw)


@router.get("/support-bundle")
def download_support_bundle(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_roles(ROLE_ADMINISTRATOR)),
) -> Response:
    """Download a ZIP of masked JSON diagnostics (administrator only; read-only)."""

    body, filename = build_support_bundle_zip_bytes(db)
    return Response(
        content=body,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/health-summary", response_model=AdminHealthSummaryResponse)
def read_admin_health_summary(db: Session = Depends(get_db)) -> AdminHealthSummaryResponse:
    raw = build_admin_health_summary(db)
    metrics = [HealthMetricRead.model_validate(m) for m in raw["metrics"]]
    return AdminHealthSummaryResponse(metrics_window_seconds=int(raw["metrics_window_seconds"]), metrics=metrics)


@router.get("/alert-settings", response_model=AlertSettingsRead)
def read_alert_settings(db: Session = Depends(get_db)) -> AlertSettingsRead:
    row = get_alert_settings_row(db)
    return _alert_read(row)


@router.put("/alert-settings", response_model=AlertSettingsRead)
def update_alert_settings(payload: AlertSettingsUpdate, db: Session = Depends(get_db)) -> AlertSettingsRead:
    row = get_alert_settings_row(db)
    if payload.rules is not None:
        row.rules_json = [r.model_dump(mode="json") for r in payload.rules]
    if payload.webhook_url is not None:
        row.webhook_url = payload.webhook_url or None
    if payload.slack_webhook_url is not None:
        row.slack_webhook_url = payload.slack_webhook_url or None
    if payload.email_to is not None:
        row.email_to = payload.email_to or None
    if payload.cooldown_seconds is not None:
        row.cooldown_seconds = int(payload.cooldown_seconds)
    if payload.monitor_enabled is not None:
        row.monitor_enabled = bool(payload.monitor_enabled)
    journal.record_audit_event(
        db,
        action="ALERT_RULE_UPDATED",
        actor_username="system",
        details={"channels_updated": payload.model_dump(exclude_unset=True)},
    )
    db.commit()
    db.refresh(row)
    return _alert_read(row)


@router.post("/alert-settings/test", response_model=AlertTestResponse)
def post_alert_settings_test(
    payload: AlertTestRequest | None = None,
    db: Session = Depends(get_db),
) -> AlertTestResponse:
    """Send a synthetic alert through the configured webhook (test button)."""

    body = payload or AlertTestRequest()
    if body.alert_type not in ALERT_TYPES:
        raise _http_error("ALERT_TYPE_INVALID", f"unknown alert_type: {body.alert_type}")
    msg = (body.message or f"Test alert ({body.alert_type}) from Admin Settings").strip()
    event = AlertEvent(
        alert_type=body.alert_type,
        message=msg or f"Test alert ({body.alert_type})",
        trigger_source="manual_test",
    )
    result = deliver_alert(db, event, force=True)
    journal.record_audit_event(
        db,
        action="ALERT_TEST_DISPATCHED",
        actor_username="system",
        details={
            "alert_type": body.alert_type,
            "delivery_status": result.delivery_status,
            "http_status": result.http_status,
        },
    )
    db.commit()
    return AlertTestResponse(
        ok=bool(result.delivered),
        delivery_status=result.delivery_status,
        http_status=result.http_status,
        duration_ms=result.duration_ms,
        error_message=result.error_message,
        webhook_url_masked=result.webhook_url_masked,
        history_id=result.history_id,
    )


@router.get("/alert-history", response_model=AlertHistoryListResponse)
def read_alert_history(
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    alert_type: str | None = Query(None),
    stream_id: int | None = Query(None),
) -> AlertHistoryListResponse:
    total, rows = list_alert_history(
        db,
        limit=limit,
        offset=offset,
        alert_type=alert_type,
        stream_id=stream_id,
    )
    items = [AlertHistoryItem.model_validate(r) for r in rows]
    return AlertHistoryListResponse(total=total, items=items)
