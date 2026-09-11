"""SMTP notification delivery: enabled / disabled / failure isolation."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.governance_approval.service import submit_policy_approval
from app.governance_notifications.email_sender import (
    SmtpEmailSender,
    reset_email_sender,
    set_email_sender,
    smtp_delivery_enabled,
)
from app.governance_notifications.models import (
    EVENT_POLICY_SUBMITTED,
    NOTIFICATION_STATUS_FAILED,
    NOTIFICATION_STATUS_PENDING,
    NOTIFICATION_STATUS_SENT,
    GovernanceNotificationEvent,
)
from app.governance_notifications.schemas import GovernanceNotificationConfigUpdateRequest
from app.governance_notifications.service import NotificationService
from app.governance_policies.models import POLICY_STATUS_DRAFT, GovernancePolicy
from app.platform_admin.alert_service import AlertEvent, deliver_alert
from app.platform_admin.models import PlatformAlertHistory
from app.platform_admin.repository import get_alert_settings_row
from tests.smtp_test_server import MemorySmtpServer


@pytest.fixture(autouse=True)
def _reset_email_sender():
    reset_email_sender()
    yield
    reset_email_sender()


def _enable_governance_email(db_session: Session, recipient: str = "ops@example.com") -> None:
    NotificationService.update_config(
        db_session,
        GovernanceNotificationConfigUpdateRequest(
            email_enabled=True,
            email_recipients=[recipient],
            webhook_enabled=False,
            approval_events=True,
            violation_events=True,
            quarantine_events=True,
            replay_events=True,
        ),
    )
    db_session.commit()


def _patch_smtp(monkeypatch: pytest.MonkeyPatch, *, enabled: bool, host: str, port: int) -> None:
    monkeypatch.setattr(settings, "SMTP_ENABLED", enabled)
    monkeypatch.setattr(settings, "SMTP_HOST", host)
    monkeypatch.setattr(settings, "SMTP_PORT", port)
    monkeypatch.setattr(settings, "SMTP_FROM", "noreply@example.test")
    monkeypatch.setattr(settings, "SMTP_STARTTLS", False)
    monkeypatch.setattr(settings, "SMTP_SSL", False)
    monkeypatch.setattr(settings, "SMTP_USERNAME", "")
    monkeypatch.setattr(settings, "SMTP_PASSWORD", "")
    monkeypatch.setattr(settings, "SMTP_TIMEOUT", 3.0)
    set_email_sender(SmtpEmailSender())


def _create_draft_policy(db_session: Session) -> GovernancePolicy:
    now = datetime.now(timezone.utc)
    row = GovernancePolicy(
        name="smtp-notify-policy",
        description=None,
        category="DATA_PROTECTION",
        status=POLICY_STATUS_DRAFT,
        policy_json={"conditions": [], "actions": []},
        version=1,
        created_at=now,
        updated_at=now,
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_smtp_enabled_governance_event_delivers_email(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = MemorySmtpServer().start()
    try:
        _patch_smtp(monkeypatch, enabled=True, host="127.0.0.1", port=server.port)
        _enable_governance_email(db_session)

        policy = _create_draft_policy(db_session)
        submit_policy_approval(db_session, int(policy.id), actor="reviewer")
        db_session.commit()

        events = list(
            db_session.query(GovernanceNotificationEvent)
            .filter(GovernanceNotificationEvent.event_type == EVENT_POLICY_SUBMITTED)
            .all()
        )
        assert len(events) == 1
        assert events[0].status == NOTIFICATION_STATUS_SENT
        assert len(server.messages) == 1
        assert "ops@example.com" in server.messages[0]["rcpt_to"]
        assert "POLICY_SUBMITTED" in server.messages[0]["data"]
    finally:
        server.stop()


def test_smtp_disabled_skips_email_and_keeps_runtime(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = MemorySmtpServer().start()
    try:
        _patch_smtp(monkeypatch, enabled=False, host="127.0.0.1", port=server.port)
        assert smtp_delivery_enabled() is False
        _enable_governance_email(db_session)

        policy = _create_draft_policy(db_session)
        submit_policy_approval(db_session, int(policy.id), actor="reviewer")
        db_session.commit()

        events = list(
            db_session.query(GovernanceNotificationEvent)
            .filter(GovernanceNotificationEvent.event_type == EVENT_POLICY_SUBMITTED)
            .all()
        )
        assert len(events) == 1
        assert events[0].status == NOTIFICATION_STATUS_PENDING
        assert server.messages == []
        stored = db_session.get(GovernancePolicy, int(policy.id))
        assert stored is not None
        assert stored.status != POLICY_STATUS_DRAFT
    finally:
        server.stop()


def test_smtp_failure_marks_notification_failed_without_blocking_approval(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = MemorySmtpServer(reject_all=True).start()
    try:
        _patch_smtp(monkeypatch, enabled=True, host="127.0.0.1", port=server.port)
        _enable_governance_email(db_session)

        policy = _create_draft_policy(db_session)
        submit_policy_approval(db_session, int(policy.id), actor="reviewer")
        db_session.commit()

        events = list(
            db_session.query(GovernanceNotificationEvent)
            .filter(GovernanceNotificationEvent.event_type == EVENT_POLICY_SUBMITTED)
            .all()
        )
        assert len(events) == 1
        assert events[0].status == NOTIFICATION_STATUS_FAILED
        assert server.messages == []
        stored = db_session.get(GovernancePolicy, int(policy.id))
        assert stored is not None
        assert stored.status != POLICY_STATUS_DRAFT
    finally:
        server.stop()


def test_platform_alert_email_when_smtp_enabled(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = MemorySmtpServer().start()
    try:
        _patch_smtp(monkeypatch, enabled=True, host="127.0.0.1", port=server.port)
        row = get_alert_settings_row(db_session)
        row.email_to = "alerts@example.com"
        row.webhook_url = None
        db_session.commit()

        result = deliver_alert(
            db_session,
            AlertEvent(alert_type="destination_failed", message="route delivery failing", stream_id=9),
        )
        assert result.delivery_status == "not_configured"
        assert len(server.messages) == 1
        assert "alerts@example.com" in server.messages[0]["rcpt_to"]
        assert "destination_failed" in server.messages[0]["data"]

        email_rows = list(
            db_session.query(PlatformAlertHistory).filter(PlatformAlertHistory.channel == "email").all()
        )
        assert len(email_rows) == 1
        assert email_rows[0].delivery_status == "sent"
    finally:
        server.stop()


def test_platform_alert_skips_email_when_smtp_disabled(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = MemorySmtpServer().start()
    try:
        _patch_smtp(monkeypatch, enabled=False, host="127.0.0.1", port=server.port)
        row = get_alert_settings_row(db_session)
        row.email_to = "alerts@example.com"
        row.webhook_url = None
        db_session.commit()

        deliver_alert(
            db_session,
            AlertEvent(alert_type="stream_paused", message="paused"),
        )
        assert server.messages == []
        email_rows = list(
            db_session.query(PlatformAlertHistory).filter(PlatformAlertHistory.channel == "email").all()
        )
        assert email_rows == []
    finally:
        server.stop()
