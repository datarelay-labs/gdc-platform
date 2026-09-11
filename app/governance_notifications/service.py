"""Governance notification service (M20.2)."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.governance_notifications.dispatcher import dispatch_notification_event
from app.governance_notifications.email_sender import EmailSender, get_email_sender
from app.governance_notifications.models import (
    EVENT_TYPE_TO_CATEGORY,
    GovernanceNotificationConfig,
    GovernanceNotificationEvent,
    NOTIFICATION_EVENT_TYPES,
    NOTIFICATION_STATUS_PENDING,
    NOTIFICATION_STATUS_SENT,
)
from app.governance_notifications.schemas import (
    GovernanceNotificationConfigResponse,
    GovernanceNotificationConfigUpdateRequest,
    GovernanceNotificationEventEntry,
    GovernanceNotificationEventsResponse,
    GovernanceNotificationHealthResponse,
    GovernanceNotificationTestResponse,
)
from app.governance_notifications.webhook_sender import WebhookSender, get_webhook_sender

logger = logging.getLogger(__name__)


class NotificationServiceError(Exception):
    pass


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _category_enabled(config: GovernanceNotificationConfig, category: str) -> bool:
    if category == "approval":
        return bool(config.approval_events)
    if category == "violation":
        return bool(config.violation_events)
    if category == "quarantine":
        return bool(config.quarantine_events)
    if category == "replay":
        return bool(config.replay_events)
    return False


class NotificationService:
    @staticmethod
    def get_or_create_config(db: Session) -> GovernanceNotificationConfig:
        row = db.execute(select(GovernanceNotificationConfig).order_by(GovernanceNotificationConfig.id.asc()).limit(1)).scalar_one_or_none()
        if row is not None:
            return row
        now = _utc_now()
        row = GovernanceNotificationConfig(
            approval_events=True,
            violation_events=True,
            quarantine_events=True,
            replay_events=True,
            email_enabled=False,
            email_recipients_json=[],
            webhook_enabled=False,
            webhook_url=None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.flush()
        return row

    @staticmethod
    def get_config(db: Session) -> GovernanceNotificationConfigResponse:
        row = NotificationService.get_or_create_config(db)
        recipients = row.email_recipients_json if isinstance(row.email_recipients_json, list) else []
        return GovernanceNotificationConfigResponse(
            approval_events=bool(row.approval_events),
            violation_events=bool(row.violation_events),
            quarantine_events=bool(row.quarantine_events),
            replay_events=bool(row.replay_events),
            email_enabled=bool(row.email_enabled),
            email_recipients=[str(r) for r in recipients if str(r).strip()],
            webhook_enabled=bool(row.webhook_enabled),
            webhook_url=row.webhook_url,
            updated_at=row.updated_at,
        )

    @staticmethod
    def update_config(db: Session, payload: GovernanceNotificationConfigUpdateRequest) -> GovernanceNotificationConfigResponse:
        row = NotificationService.get_or_create_config(db)
        data = payload.model_dump(exclude_unset=True)
        if "email_recipients" in data:
            row.email_recipients_json = [str(r).strip() for r in (data.pop("email_recipients") or []) if str(r).strip()]
        for key, value in data.items():
            setattr(row, key, value)
        row.updated_at = _utc_now()
        db.flush()
        return NotificationService.get_config(db)

    @staticmethod
    def record_event(
        db: Session,
        *,
        event_type: str,
        severity: str = "INFO",
        payload: dict | None = None,
    ) -> GovernanceNotificationEvent | None:
        event_type = str(event_type).strip().upper()
        if event_type not in NOTIFICATION_EVENT_TYPES:
            raise NotificationServiceError(f"unsupported notification event type: {event_type!r}")

        config = NotificationService.get_or_create_config(db)
        category = EVENT_TYPE_TO_CATEGORY[event_type]
        if not _category_enabled(config, category):
            return None
        if not config.email_enabled and not config.webhook_enabled:
            return None

        row = GovernanceNotificationEvent(
            event_type=event_type,
            event_category=category,
            severity=str(severity or "INFO").upper(),
            payload_json=dict(payload) if payload else {},
            status=NOTIFICATION_STATUS_PENDING,
            created_at=_utc_now(),
            sent_at=None,
        )
        db.add(row)
        db.flush()
        return row

    @staticmethod
    def dispatch_pending(
        db: Session,
        *,
        email_sender: EmailSender | None = None,
        webhook_sender: WebhookSender | None = None,
    ) -> int:
        config = NotificationService.get_or_create_config(db)
        pending = list(
            db.execute(
                select(GovernanceNotificationEvent)
                .where(GovernanceNotificationEvent.status == NOTIFICATION_STATUS_PENDING)
                .order_by(GovernanceNotificationEvent.id.asc())
            ).scalars()
        )
        dispatched = 0
        for event in pending:
            try:
                dispatch_notification_event(
                    event,
                    config,
                    email_sender=email_sender,
                    webhook_sender=webhook_sender,
                )
            except Exception:
                logger.exception(
                    "governance_notification_dispatch_failed event_id=%s",
                    getattr(event, "id", None),
                )
                try:
                    event.status = "FAILED"
                    event.sent_at = _utc_now()
                except Exception:
                    logger.exception("governance_notification_status_update_failed")
            db.flush()
            dispatched += 1
        return dispatched

    @staticmethod
    def test_notification(
        db: Session,
        *,
        channel: str,
        email_sender: EmailSender | None = None,
        webhook_sender: WebhookSender | None = None,
    ) -> GovernanceNotificationTestResponse:
        config = NotificationService.get_or_create_config(db)
        ch = str(channel).strip().lower()
        email = email_sender or get_email_sender()
        webhook = webhook_sender or get_webhook_sender()

        if ch == "email":
            if not config.email_enabled:
                return GovernanceNotificationTestResponse(
                    channel="email",
                    success=False,
                    message="Email channel is disabled.",
                )
            recipients_raw = config.email_recipients_json if isinstance(config.email_recipients_json, list) else []
            recipients = [str(r).strip() for r in recipients_raw if str(r).strip()]
            if not recipients:
                return GovernanceNotificationTestResponse(
                    channel="email",
                    success=False,
                    message="No email recipients configured.",
                )
            try:
                ok = email.send_email(
                    recipients=recipients,
                    subject="[Governance] Notification test",
                    body="This is a test notification from the Governance Notifications settings.",
                )
            except Exception:
                logger.exception("governance_notification_test_email_failed")
                ok = False
            return GovernanceNotificationTestResponse(
                channel="email",
                success=ok,
                message="Test email sent." if ok else "Test email delivery failed.",
            )

        if ch == "webhook":
            if not config.webhook_enabled or not config.webhook_url:
                return GovernanceNotificationTestResponse(
                    channel="webhook",
                    success=False,
                    message="Webhook channel is disabled or URL is missing.",
                )
            ok = webhook.send_webhook(
                url=str(config.webhook_url),
                payload={
                    "event_type": "NOTIFICATION_TEST",
                    "severity": "INFO",
                    "timestamp": _utc_now().isoformat(),
                    "payload": {"message": "Governance notification test"},
                },
            )
            return GovernanceNotificationTestResponse(
                channel="webhook",
                success=ok,
                message="Test webhook delivered." if ok else "Test webhook delivery failed.",
            )

        raise NotificationServiceError(f"unsupported channel: {channel!r}")

    @staticmethod
    def get_health(db: Session) -> GovernanceNotificationHealthResponse:
        pending = int(
            db.scalar(
                select(func.count())
                .select_from(GovernanceNotificationEvent)
                .where(GovernanceNotificationEvent.status == NOTIFICATION_STATUS_PENDING)
            )
            or 0
        )
        failed = int(
            db.scalar(
                select(func.count())
                .select_from(GovernanceNotificationEvent)
                .where(GovernanceNotificationEvent.status == "FAILED")
            )
            or 0
        )
        last_sent = db.scalar(
            select(func.max(GovernanceNotificationEvent.sent_at)).where(
                GovernanceNotificationEvent.status == NOTIFICATION_STATUS_SENT
            )
        )
        return GovernanceNotificationHealthResponse(
            pending_notifications=pending,
            failed_notifications=failed,
            last_delivery_time=last_sent,
        )

    @staticmethod
    def list_events(
        db: Session,
        *,
        status: str | None = None,
        limit: int = 50,
    ) -> GovernanceNotificationEventsResponse:
        lim = max(1, min(int(limit), 200))
        stmt = select(GovernanceNotificationEvent).order_by(
            GovernanceNotificationEvent.created_at.desc(),
            GovernanceNotificationEvent.id.desc(),
        )
        if status is not None:
            stmt = stmt.where(GovernanceNotificationEvent.status == str(status).upper())
        rows = list(db.execute(stmt.limit(lim)).scalars())
        events = [
            GovernanceNotificationEventEntry(
                id=int(row.id),
                event_type=row.event_type,
                event_category=row.event_category,
                severity=row.severity,
                status=row.status,  # type: ignore[arg-type]
                payload=row.payload_json if isinstance(row.payload_json, dict) else None,
                created_at=row.created_at,
                sent_at=row.sent_at,
            )
            for row in rows
        ]
        return GovernanceNotificationEventsResponse(total=len(events), events=events)
