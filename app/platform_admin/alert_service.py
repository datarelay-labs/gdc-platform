"""Webhook alert delivery for platform alerts.

Design notes
------------

* Webhook is the only channel implemented in this task.  Slack and email remain
  planned placeholders persisted on ``platform_alert_settings``.
* Delivery is fire-and-forget HTTP with retries; failures are persisted in
  ``platform_alert_history`` so the operator can inspect attempts that did not
  reach the receiver.
* Cooldown windows deduplicate identical alerts: the fingerprint is
  ``alert_type|stream_id|route_id|destination_id``; ``cooldown_seconds`` is read
  from ``platform_alert_settings``.
* ``deliver_alert`` *must not* raise to the caller; any errors are swallowed
  and recorded.  This protects StreamRunner / checkpoint progress when the
  monitor or a control endpoint asks us to dispatch.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.platform_admin.models import (
    PlatformAlertHistory,
    PlatformAlertSettings,
)
from app.platform_admin.repository import get_alert_settings_row

logger = logging.getLogger(__name__)

UTC = timezone.utc

ALERT_TYPES: tuple[str, ...] = (
    "stream_paused",
    "checkpoint_stalled",
    "destination_failed",
    "high_retry_count",
    "rate_limit_triggered",
)

ALERT_SEVERITY_DEFAULT = {
    "stream_paused": "WARNING",
    "checkpoint_stalled": "CRITICAL",
    "destination_failed": "CRITICAL",
    "high_retry_count": "WARNING",
    "rate_limit_triggered": "WARNING",
}

_HTTP_TIMEOUT_SEC = 8.0
_DEFAULT_RETRY_BACKOFFS = (1.0, 3.0)
_PAYLOAD_SCHEMA = "gdc.platform.alert/v1"


@dataclass(frozen=True)
class AlertEvent:
    """Domain event passed into :func:`deliver_alert`."""

    alert_type: str
    message: str
    severity: str | None = None
    stream_id: int | None = None
    stream_name: str | None = None
    route_id: int | None = None
    destination_id: int | None = None
    trigger_source: str = "monitor"
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AlertDeliveryResult:
    """Returned by :func:`deliver_alert` for callers/tests."""

    delivered: bool
    delivery_status: str
    history_id: int
    http_status: int | None = None
    duration_ms: int | None = None
    error_message: str | None = None
    webhook_url_masked: str | None = None
    cooldown_skipped: bool = False
    rule_disabled: bool = False


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _fingerprint(event: AlertEvent) -> str:
    raw = (
        f"{event.alert_type}|{event.stream_id or 0}|{event.route_id or 0}|{event.destination_id or 0}"
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def mask_webhook_url(url: str | None) -> str | None:
    """Best-effort masking of webhook URLs for logs and history rows.

    The scheme + host are preserved; path and query are summarized so secrets in
    URL paths/queries cannot leak.
    """

    if not url:
        return None
    try:
        parsed = urlparse(url)
        path = "/<redacted>" if parsed.path and parsed.path != "/" else parsed.path
        query = "?<redacted>" if parsed.query else ""
        netloc = parsed.netloc or ""
        masked = urlunparse((parsed.scheme, netloc, path, "", "", "")).rstrip("?")
        if query:
            masked = f"{masked}{query}"
        return masked
    except Exception:  # pragma: no cover - very defensive
        return "<unparseable>"


def _resolve_rule(
    settings_row: PlatformAlertSettings, alert_type: str
) -> tuple[bool, str]:
    enabled = True
    severity = ALERT_SEVERITY_DEFAULT.get(alert_type, "WARNING")
    rules = list(settings_row.rules_json or [])
    for r in rules:
        if not isinstance(r, dict):
            continue
        if r.get("alert_type") != alert_type:
            continue
        enabled = bool(r.get("enabled", True))
        sev = r.get("severity")
        if isinstance(sev, str) and sev in ("WARNING", "CRITICAL", "INFO"):
            severity = sev
        break
    return enabled, severity


def _in_cooldown(
    db: Session,
    *,
    fingerprint: str,
    cooldown_seconds: int,
    now: datetime,
) -> bool:
    if cooldown_seconds <= 0:
        return False
    cutoff = now - timedelta(seconds=int(cooldown_seconds))
    q = (
        select(func.count(PlatformAlertHistory.id))
        .where(
            PlatformAlertHistory.fingerprint == fingerprint,
            PlatformAlertHistory.delivery_status == "sent",
            PlatformAlertHistory.created_at >= cutoff,
        )
    )
    return int(db.scalar(q) or 0) > 0


def build_payload(event: AlertEvent, *, severity: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema": _PAYLOAD_SCHEMA,
        "alert_type": event.alert_type,
        "severity": severity,
        "stream_id": event.stream_id,
        "stream_name": event.stream_name,
        "route_id": event.route_id,
        "destination_id": event.destination_id,
        "message": event.message,
        "timestamp": _now_utc().isoformat(),
        "trigger_source": event.trigger_source,
        "environment": settings.APP_ENV,
    }
    if event.extra:
        payload["extra"] = dict(event.extra)
    return payload


def _post_webhook(
    url: str,
    payload: dict[str, Any],
) -> tuple[bool, int | None, int, str | None]:
    """Synchronously POST the payload with retry/backoff.

    Returns ``(delivered, http_status, duration_ms, error_message)``.
    """

    last_error: str | None = None
    last_status: int | None = None
    start = time.monotonic()
    backoffs = (0.0, *_DEFAULT_RETRY_BACKOFFS)
    for attempt, delay in enumerate(backoffs):
        if delay > 0:
            time.sleep(delay)
        try:
            with httpx.Client(timeout=_HTTP_TIMEOUT_SEC) as client:
                r = client.post(url, json=payload, headers={"Content-Type": "application/json"})
                last_status = int(r.status_code)
                if 200 <= r.status_code < 300:
                    duration_ms = int((time.monotonic() - start) * 1000)
                    return True, last_status, duration_ms, None
                last_error = f"HTTP {r.status_code}"
        except httpx.HTTPError as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # pragma: no cover - very defensive
            last_error = f"{type(exc).__name__}: {exc}"
        logger.warning(
            "%s",
            {
                "stage": "platform_alert_webhook_attempt_failed",
                "attempt": attempt,
                "url": mask_webhook_url(url),
                "error": last_error,
                "status": last_status,
            },
        )
    duration_ms = int((time.monotonic() - start) * 1000)
    return False, last_status, duration_ms, last_error


def _email_recipients(settings_row: PlatformAlertSettings) -> list[str]:
    raw = (settings_row.email_to or "").strip()
    if not raw:
        return []
    parts = raw.replace(";", ",")
    return [item.strip() for item in parts.split(",") if item.strip()]


def _alert_email_subject(event: AlertEvent, *, severity: str) -> str:
    return f"[Data Relay] {event.alert_type.replace('_', ' ')} ({severity})"


def _alert_email_body(event: AlertEvent, *, severity: str, payload: dict[str, Any]) -> str:
    lines = [
        f"Alert: {event.alert_type}",
        f"Severity: {severity}",
        f"Message: {event.message}",
        f"Stream ID: {event.stream_id}",
        f"Route ID: {event.route_id}",
        f"Destination ID: {event.destination_id}",
    ]
    extra = payload.get("extra") if isinstance(payload.get("extra"), dict) else None
    if extra:
        for key, value in extra.items():
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def _deliver_alert_email(
    db: Session,
    *,
    event: AlertEvent,
    severity: str,
    fingerprint: str,
    payload: dict[str, Any],
    recipients: list[str],
) -> None:
    """Best-effort SMTP send for operational alerts. Never raises."""

    from app.governance_notifications.email_sender import get_email_sender, smtp_delivery_enabled

    if not recipients or not smtp_delivery_enabled():
        return
    start = time.monotonic()
    err: str | None = None
    delivered = False
    try:
        delivered = bool(
            get_email_sender().send_email(
                recipients=recipients,
                subject=_alert_email_subject(event, severity=severity),
                body=_alert_email_body(event, severity=severity, payload=payload),
            )
        )
        if not delivered:
            err = "smtp_send_failed"
    except Exception as exc:
        delivered = False
        err = f"{type(exc).__name__}: {exc}"
        logger.exception(
            "%s",
            {"stage": "platform_alert_email_unexpected", "error_type": type(exc).__name__},
        )
    duration_ms = int((time.monotonic() - start) * 1000)
    try:
        _persist_history(
            db,
            event=event,
            severity=severity,
            fingerprint=fingerprint,
            delivery_status="sent" if delivered else "failed",
            http_status=None,
            error_message=err,
            duration_ms=duration_ms,
            webhook_url_masked=None,
            payload=payload,
            channel="email",
        )
    except Exception:
        logger.exception("%s", {"stage": "platform_alert_email_history_failed"})


def _persist_history(
    db: Session,
    *,
    event: AlertEvent,
    severity: str,
    fingerprint: str,
    delivery_status: str,
    http_status: int | None,
    error_message: str | None,
    duration_ms: int | None,
    webhook_url_masked: str | None,
    payload: dict[str, Any],
    channel: str = "webhook",
) -> PlatformAlertHistory:
    row = PlatformAlertHistory(
        alert_type=event.alert_type,
        severity=severity,
        stream_id=event.stream_id,
        stream_name=event.stream_name,
        route_id=event.route_id,
        destination_id=event.destination_id,
        message=(event.message or "")[:1024],
        fingerprint=fingerprint,
        channel=channel,
        delivery_status=delivery_status,
        http_status=http_status,
        error_message=(error_message or None) if error_message else None,
        webhook_url_masked=webhook_url_masked,
        duration_ms=duration_ms,
        payload_json=payload,
        trigger_source=event.trigger_source,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def deliver_alert(
    db: Session,
    event: AlertEvent,
    *,
    force: bool = False,
) -> AlertDeliveryResult:
    """Deliver a webhook alert (and optional SMTP email) and persist the attempt.

    The function does **not** raise.  Cooldown skips and disabled rules return a
    persisted history row tagged ``cooldown_skipped`` / ``rule_disabled``.
    SMTP failures are recorded on an email history row and never fail the caller.

    Args:
        force: bypass rule.enabled and cooldown gating.  Used by the manual
            ``alert-settings/test`` endpoint so the operator can validate the
            configured webhook regardless of current rule state.
    """

    settings_row = get_alert_settings_row(db)
    rule_enabled, default_severity = _resolve_rule(settings_row, event.alert_type)
    severity = event.severity or default_severity
    fingerprint = _fingerprint(event)
    now = _now_utc()
    payload = build_payload(event, severity=severity)
    webhook_url = (settings_row.webhook_url or "").strip()
    webhook_url_masked = mask_webhook_url(webhook_url) if webhook_url else None

    if not force:
        if not rule_enabled:
            row = _persist_history(
                db,
                event=event,
                severity=severity,
                fingerprint=fingerprint,
                delivery_status="rule_disabled",
                http_status=None,
                error_message=None,
                duration_ms=0,
                webhook_url_masked=webhook_url_masked,
                payload=payload,
            )
            return AlertDeliveryResult(
                delivered=False,
                delivery_status="rule_disabled",
                history_id=int(row.id),
                webhook_url_masked=webhook_url_masked,
                rule_disabled=True,
            )

        cooldown = int(settings_row.cooldown_seconds or 0)
        if _in_cooldown(db, fingerprint=fingerprint, cooldown_seconds=cooldown, now=now):
            row = _persist_history(
                db,
                event=event,
                severity=severity,
                fingerprint=fingerprint,
                delivery_status="cooldown_skipped",
                http_status=None,
                error_message=None,
                duration_ms=0,
                webhook_url_masked=webhook_url_masked,
                payload=payload,
            )
            return AlertDeliveryResult(
                delivered=False,
                delivery_status="cooldown_skipped",
                history_id=int(row.id),
                webhook_url_masked=webhook_url_masked,
                cooldown_skipped=True,
            )

    if not webhook_url:
        row = _persist_history(
            db,
            event=event,
            severity=severity,
            fingerprint=fingerprint,
            delivery_status="not_configured",
            http_status=None,
            error_message="Webhook URL is not configured.",
            duration_ms=0,
            webhook_url_masked=None,
            payload=payload,
        )
        _deliver_alert_email(
            db,
            event=event,
            severity=severity,
            fingerprint=fingerprint,
            payload=payload,
            recipients=_email_recipients(settings_row),
        )
        return AlertDeliveryResult(
            delivered=False,
            delivery_status="not_configured",
            history_id=int(row.id),
            error_message="Webhook URL is not configured.",
        )

    try:
        delivered, http_status, duration_ms, err = _post_webhook(webhook_url, payload)
    except Exception as exc:  # pragma: no cover - safety net
        delivered = False
        http_status = None
        duration_ms = None
        err = f"{type(exc).__name__}: {exc}"
        logger.exception(
            "%s",
            {"stage": "platform_alert_webhook_unexpected", "error_type": type(exc).__name__},
        )

    delivery_status = "sent" if delivered else "failed"
    row = _persist_history(
        db,
        event=event,
        severity=severity,
        fingerprint=fingerprint,
        delivery_status=delivery_status,
        http_status=http_status,
        error_message=err,
        duration_ms=duration_ms,
        webhook_url_masked=webhook_url_masked,
        payload=payload,
    )
    _deliver_alert_email(
        db,
        event=event,
        severity=severity,
        fingerprint=fingerprint,
        payload=payload,
        recipients=_email_recipients(settings_row),
    )
    return AlertDeliveryResult(
        delivered=delivered,
        delivery_status=delivery_status,
        history_id=int(row.id),
        http_status=http_status,
        duration_ms=duration_ms,
        error_message=err,
        webhook_url_masked=webhook_url_masked,
    )


def deliver_alert_async(event: AlertEvent, *, force: bool = False) -> threading.Thread:
    """Schedule ``deliver_alert`` on a daemon thread; never blocks the caller."""

    def _run() -> None:
        db = SessionLocal()
        try:
            deliver_alert(db, event, force=force)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception(
                "%s",
                {
                    "stage": "platform_alert_async_unexpected",
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                },
            )
        finally:
            db.close()

    t = threading.Thread(target=_run, name="platform-alert-deliver", daemon=True)
    t.start()
    return t


def list_alert_history(
    db: Session,
    *,
    limit: int = 50,
    offset: int = 0,
    alert_type: str | None = None,
    stream_id: int | None = None,
) -> tuple[int, list[PlatformAlertHistory]]:
    q_total = select(func.count(PlatformAlertHistory.id))
    q = select(PlatformAlertHistory).order_by(desc(PlatformAlertHistory.created_at))
    if alert_type:
        q = q.where(PlatformAlertHistory.alert_type == alert_type)
        q_total = q_total.where(PlatformAlertHistory.alert_type == alert_type)
    if stream_id is not None:
        q = q.where(PlatformAlertHistory.stream_id == stream_id)
        q_total = q_total.where(PlatformAlertHistory.stream_id == stream_id)
    total = int(db.scalar(q_total) or 0)
    rows = list(
        db.scalars(q.offset(max(0, int(offset))).limit(min(500, max(1, int(limit)))))
    )
    return total, rows


__all__ = [
    "ALERT_TYPES",
    "AlertDeliveryResult",
    "AlertEvent",
    "build_payload",
    "deliver_alert",
    "deliver_alert_async",
    "list_alert_history",
    "mask_webhook_url",
]
