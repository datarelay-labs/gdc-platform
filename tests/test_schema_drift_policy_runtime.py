"""Schema Drift Policy runtime — Phase 2 (Auto Protect ephemeral masking)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.mappings.models import Mapping
from app.protection.policy_engine import PolicyBatchResult
from app.quarantine.models import StreamQuarantineEvent
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.protection.models import PROTECTION_MODE_HASH, StreamProtectionRule
from app.schema_drift_policy.orchestrator import (
    apply_schema_drift_policy_to_batch,
    auto_protect_mode_for_class,
    merge_schema_drift_quarantine,
)
from app.schema_drift_policy.path_resolve import (
    build_protection_path_alias_map,
    resolve_protection_field_path,
)
from app.schema_drift_policy.schemas import load_schema_drift_policy
from app.schema_observation.models import (
    DRIFT_CATEGORY_FIELD_ADDED,
    DRIFT_STATUS_OPEN,
    StreamSchemaFieldDrift,
)
from app.sensitive_detection.context import build_sensitive_detection_context
from app.streams.models import Stream
from tests.test_stream_runner_e2e import _FakePoller, _FakeWebhookSender, _build_runner, _seed_stream_runtime


def _set_schema_drift_policy(
    db: Session,
    stream_id: int,
    *,
    normal: str,
    sensitive: str,
) -> None:
    stream = db.query(Stream).filter(Stream.id == stream_id).one()
    config = dict(stream.config_json or {})
    governance = dict(config.get("governance") or {})
    governance["schema_drift_policy"] = {
        "unknown_normal_field_policy": normal,
        "unknown_sensitive_field_policy": sensitive,
    }
    config["governance"] = governance
    stream.config_json = config
    db.commit()


def _add_open_drift(db: Session, stream_id: int, field_path: str) -> StreamSchemaFieldDrift:
    now = datetime.now(timezone.utc)
    row = StreamSchemaFieldDrift(
        stream_id=stream_id,
        field_path=field_path,
        category=DRIFT_CATEGORY_FIELD_ADDED,
        status=DRIFT_STATUS_OPEN,
        first_detected_at=now,
        last_confirmed_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _configure_nickname_mapping(db: Session, stream_id: int) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "nickname": "$.user.nickname",
        "event_id": "$.id",
        "message": "$.message",
    }
    db.commit()


def _configure_email_mapping(db: Session, stream_id: int) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "email": "$.user.email",
        "event_id": "$.id",
        "message": "$.message",
    }
    db.commit()


def _run_batch(
    db: Session,
    stream_id: int,
    *,
    payload: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[StreamRunner, _FakeWebhookSender]:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    poller = _FakePoller(response=payload)
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)
    return runner, sender


class _CaptureLogRunner(StreamRunner):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.captured_logs: list[dict[str, Any]] = []

    def _log(self, payload: dict[str, Any]) -> None:
        self.captured_logs.append(payload)
        super()._log(payload)


def test_load_defaults_when_policy_absent() -> None:
    policy = load_schema_drift_policy({})
    assert policy.unknown_normal_field_policy == "pass_through"
    assert policy.unknown_sensitive_field_policy == "auto_protect"


def test_path_resolve_mapping_alias() -> None:
    alias_map = build_protection_path_alias_map(
        field_mappings={"email": "$.user.email"},
        enrichment_json={},
    )
    result = resolve_protection_field_path("$.user.email", ["$.email", "$.message"], alias_map)
    assert result.ok is True
    assert result.resolved_path == "$.email"


def test_path_resolve_prefers_mapping_alias_on_extracted_event() -> None:
    alias_map = build_protection_path_alias_map(
        field_mappings={"email": "$.user.email"},
        enrichment_json={},
    )
    result = resolve_protection_field_path(
        "$.user.email",
        ["$.user.email", "$.user.id", "$.message"],
        alias_map,
    )
    assert result.ok is True
    assert result.resolved_path == "$.email"


def test_path_resolve_failure_does_not_block_orchestrator(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _set_schema_drift_policy(db_session, stream_id, normal="quarantine", sensitive="quarantine")
    _add_open_drift(db_session, stream_id, "$.missing.path")

    logs: list[dict[str, Any]] = []

    def _log(payload: dict[str, Any]) -> None:
        logs.append(payload)

    result = apply_schema_drift_policy_to_batch(
        db_session,
        stream_id=stream_id,
        stream_config_json={"governance": {"schema_drift_policy": {"unknown_normal_field_policy": "quarantine"}}},
        field_mappings={"event_id": "$.id"},
        enrichment_json={},
        enriched_events=[{"event_id": "1", "message": "hi"}],
        detection_context=None,
        log_fn=_log,
    )
    assert result.should_quarantine is False
    assert result.unresolved_paths == ["$.missing.path"]
    assert any(log.get("stage") == "schema_drift_policy_path_resolution_failed" for log in logs)


def test_unknown_normal_pass_through_delivers(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_nickname_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.nickname")

    _, sender = _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"nickname": "alice"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )
    assert len(sender.calls) == 1


def test_unknown_normal_require_review_blocks_delivery_with_review_log(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_nickname_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="require_review", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.nickname")

    cp_before = {"marker": "before"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    poller = _FakePoller(
        response={"items": [{"id": "evt-1", "user": {"nickname": "alice"}, "message": "hello"}]}
    )
    sender = _FakeWebhookSender()
    runner = _CaptureLogRunner(poller=poller, webhook_sender=sender)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 0
    review_logs = [
        log
        for log in runner.captured_logs
        if log.get("stage") == "schema_drift_policy_review_required"
    ]
    assert review_logs
    assert review_logs[0]["field_path"] == "$.nickname"
    assert review_logs[0]["policy_type"] == "unknown_normal"
    assert review_logs[0]["sensitive"] is False

    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json == cp_before


def test_unknown_normal_quarantine_blocks_delivery_and_checkpoint(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.governance_quarantine.service import _row_to_entry
    from app.governance_violations.service import _humanize_quarantine_reason
    from app.quarantine.policy_integration import build_quarantine_reason
    from app.protection.policy_engine import PolicyBatchResult

    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_nickname_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="quarantine", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.nickname")

    cp_before = {"marker": "before"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    _, sender = _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"nickname": "alice"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )
    assert len(sender.calls) == 0
    quarantine_row = (
        db_session.query(StreamQuarantineEvent).filter(StreamQuarantineEvent.stream_id == stream_id).one()
    )
    assert quarantine_row.metadata_json["policy_names"] == ["schema_drift:unknown_normal"]
    reason = _humanize_quarantine_reason(str(quarantine_row.quarantine_reason))
    assert "Schema Drift Policy" in reason
    entry = _row_to_entry(
        db_session,
        quarantine_row,
        stream_names={stream_id: fixture["stream_name"]},
        stream_policies={},
        replayed_streams=set(),
        until=quarantine_row.created_at,
    )
    assert entry.policy_name == "Schema Drift Policy — Unknown Normal Field"
    merged = merge_schema_drift_quarantine(
        PolicyBatchResult(),
        policy_type="unknown_normal",
        field_paths=["$.nickname"],
    )
    assert build_quarantine_reason(merged) == "policy:schema_drift:unknown_normal"
    assert db_session.query(StreamQuarantineEvent).filter(StreamQuarantineEvent.stream_id == stream_id).count() == 1
    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json == cp_before


def test_schema_drift_quarantine_persists_when_process_routes_db_none(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """process_routes(db=None) must still persist the route-policy quarantine row."""
    monkeypatch.setattr("app.config.settings.GDC_ROUTE_PROCESSING_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_nickname_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="quarantine", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.nickname")

    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    poller = _FakePoller(
        response={"items": [{"id": "evt-1", "user": {"nickname": "alice"}, "message": "hello"}]}
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=None)

    assert len(sender.calls) == 0
    db_session.expire_all()
    quarantine_row = (
        db_session.query(StreamQuarantineEvent).filter(StreamQuarantineEvent.stream_id == stream_id).one()
    )
    assert quarantine_row.metadata_json["policy_names"] == ["schema_drift:unknown_normal"]


def test_unknown_sensitive_require_review_blocks_delivery_with_review_log(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="require_review")
    _add_open_drift(db_session, stream_id, "$.user.email")

    poller = _FakePoller(
        response={"items": [{"id": "evt-1", "user": {"email": "user@example.com"}, "message": "hello"}]}
    )
    sender = _FakeWebhookSender()
    runner = _CaptureLogRunner(poller=poller, webhook_sender=sender)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 0
    review_logs = [
        log
        for log in runner.captured_logs
        if log.get("stage") == "schema_drift_policy_review_required"
    ]
    assert review_logs
    assert review_logs[0]["policy_type"] == "unknown_sensitive"
    assert review_logs[0]["sensitive"] is True


def test_unknown_sensitive_quarantine_blocks_delivery_and_checkpoint(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="quarantine")
    _add_open_drift(db_session, stream_id, "$.user.email")

    cp_before = {"marker": "before"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    _, sender = _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"email": "user@example.com"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )
    assert len(sender.calls) == 0
    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json == cp_before


def test_auto_protect_mode_for_class_mapping() -> None:
    assert auto_protect_mode_for_class("secret") == "full_mask"
    assert auto_protect_mode_for_class("pii") == "partial_mask"
    assert auto_protect_mode_for_class("security_metadata") == "partial_mask"
    assert auto_protect_mode_for_class("other") == "partial_mask"


def test_auto_protect_email_partial_mask(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 1: Unknown Sensitive + Auto Protect → partial mask on email."""
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.email")

    rules_before = db_session.query(StreamProtectionRule).filter(StreamProtectionRule.stream_id == stream_id).count()

    poller = _FakePoller(
        response={"items": [{"id": "evt-1", "user": {"email": "user@test.com"}, "message": "hello"}]}
    )
    sender = _FakeWebhookSender()
    runner = _CaptureLogRunner(poller=poller, webhook_sender=sender)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 1
    delivered = sender.calls[0]["events"][0]
    assert delivered.get("email") == "u***@t***.com"
    assert delivered.get("email") != "user@test.com"

    auto_protect_logs = [
        log
        for log in runner.captured_logs
        if log.get("stage") == "schema_drift_policy_auto_protect_applied"
    ]
    assert auto_protect_logs
    assert auto_protect_logs[0]["field_path"] == "$.email"
    assert auto_protect_logs[0]["protection_mode"] == "partial_mask"
    assert not any(
        log.get("stage") == "schema_drift_policy_review_required"
        for log in runner.captured_logs
    )

    rules_after = db_session.query(StreamProtectionRule).filter(StreamProtectionRule.stream_id == stream_id).count()
    assert rules_after == rules_before


def test_auto_protect_secret_full_mask(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 2: Secret field → full mask."""
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    mapping = db_session.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
        "event_id": "$.id",
        "message": "$.message",
    }
    db_session.commit()
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.api_key")

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-1",
                    "api_key": "sk-live-super-secret-value",
                    "message": "hello",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _CaptureLogRunner(poller=poller, webhook_sender=sender)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 1
    delivered = sender.calls[0]["events"][0]
    assert delivered.get("api_key") == "********"

    auto_protect_logs = [
        log
        for log in runner.captured_logs
        if log.get("stage") == "schema_drift_policy_auto_protect_applied"
    ]
    assert auto_protect_logs
    assert auto_protect_logs[0]["protection_mode"] == "full_mask"


def test_auto_protect_skips_when_operator_rule_exists(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 3: Existing operator rule (hash) takes priority over Auto Protect."""
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_HASH_SALT", "test-salt")
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.email")

    db_session.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class="pii",
            protection_mode=PROTECTION_MODE_HASH,
            enabled=True,
            created_by="operator",
        )
    )
    db_session.commit()

    poller = _FakePoller(
        response={"items": [{"id": "evt-1", "user": {"email": "user@test.com"}, "message": "hello"}]}
    )
    sender = _FakeWebhookSender()
    runner = _CaptureLogRunner(poller=poller, webhook_sender=sender)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 1
    delivered = sender.calls[0]["events"][0]
    email_value = delivered.get("email")
    assert isinstance(email_value, str)
    assert email_value.startswith("sha256:")
    assert not any(
        log.get("stage") == "schema_drift_policy_auto_protect_applied"
        for log in runner.captured_logs
    )


def test_auto_protect_path_alias_resolution(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 4: $.user.email drift resolves to $.email and is protected."""
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.email")

    _, sender = _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"email": "user@test.com"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )
    assert len(sender.calls) == 1
    assert sender.calls[0]["events"][0].get("email") == "u***@t***.com"


def test_auto_protect_path_resolution_failure_continues_runtime(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 5: Path resolution failure → warning log, runtime continues."""
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.missing.path")

    poller = _FakePoller(
        response={"items": [{"id": "evt-1", "user": {"email": "user@test.com"}, "message": "hello"}]}
    )
    sender = _FakeWebhookSender()
    runner = _CaptureLogRunner(poller=poller, webhook_sender=sender)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 1
    assert sender.calls[0]["events"][0].get("email") == "user@test.com"
    assert any(
        log.get("stage") == "schema_drift_policy_path_resolution_failed"
        for log in runner.captured_logs
    )


def test_auto_protect_checkpoint_updated_on_success(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 7: Successful delivery updates checkpoint."""
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.email")

    cp_before = {"marker": "before"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"email": "user@test.com"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )

    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json != cp_before


def test_orchestrator_auto_protect_builds_ephemeral_rules(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _add_open_drift(db_session, stream_id, "$.email")

    context = build_sensitive_detection_context(
        stream_id=stream_id,
        events=[{"email": "user@test.com"}],
        findings=[
            {
                "field_path": "$.email",
                "sensitivity_class": "pii",
                "detection_method": "pattern",
            }
        ],
    )
    result = apply_schema_drift_policy_to_batch(
        db_session,
        stream_id=stream_id,
        stream_config_json={
            "governance": {
                "schema_drift_policy": {
                    "unknown_normal_field_policy": "pass_through",
                    "unknown_sensitive_field_policy": "auto_protect",
                }
            }
        },
        field_mappings={},
        enrichment_json={},
        enriched_events=[{"email": "user@test.com"}],
        detection_context=context,
        log_fn=None,
    )
    assert result.batch_action == "auto_protect"
    assert len(result.ephemeral_protection_rules) == 1
    assert result.ephemeral_protection_rules[0].field_path == "$.email"
    assert result.ephemeral_protection_rules[0].protection_mode == "partial_mask"


def test_governance_quarantine_labels_schema_drift_policy() -> None:
    from app.governance_violations.service import _humanize_quarantine_reason, _resolve_policy_context

    reason = _humanize_quarantine_reason("policy:schema_drift:unknown_normal")
    assert "Schema Drift Policy" in reason
    assert "Unknown Normal" in reason

    ctx = _resolve_policy_context(
        None,
        stream_id=1,
        stream_policies={},
        runtime_policy_names=["schema_drift:unknown_sensitive"],
    )
    assert ctx.policy_name == "Schema Drift Policy — Unknown Sensitive Field"


def test_merge_schema_drift_quarantine_marks_policy_batch() -> None:
    result = merge_schema_drift_quarantine(
        PolicyBatchResult(),
        policy_type="unknown_normal",
        field_paths=["$.email"],
    )
    assert result.matched_policy_count == 1
    assert result.evaluations[0].action_type == "quarantine"


def test_policy_disabled_is_noop(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", False)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="quarantine", sensitive="quarantine")
    _add_open_drift(db_session, stream_id, "$.user.email")

    result = apply_schema_drift_policy_to_batch(
        db_session,
        stream_id=stream_id,
        stream_config_json={"governance": {"schema_drift_policy": {"unknown_normal_field_policy": "quarantine"}}},
        field_mappings={"email": "$.user.email"},
        enrichment_json={},
        enriched_events=[{"email": "user@example.com"}],
        detection_context=build_sensitive_detection_context(
            stream_id=stream_id,
            events=[{"email": "user@example.com"}],
        ),
        log_fn=None,
    )
    assert result.should_quarantine is False


def test_orchestrator_sensitive_classification_uses_detection_context(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_POLICY_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _add_open_drift(db_session, stream_id, "$.secret_token")

    context = build_sensitive_detection_context(
        stream_id=stream_id,
        events=[{"secret_token": "abc"}],
        findings=[
            {
                "field_path": "$.secret_token",
                "sensitivity_class": "secret",
                "detection_method": "pattern",
            }
        ],
    )
    result = apply_schema_drift_policy_to_batch(
        db_session,
        stream_id=stream_id,
        stream_config_json={
            "governance": {
                "schema_drift_policy": {
                    "unknown_normal_field_policy": "pass_through",
                    "unknown_sensitive_field_policy": "require_review",
                }
            }
        },
        field_mappings={},
        enrichment_json={},
        enriched_events=[{"secret_token": "abc"}],
        detection_context=context,
        log_fn=None,
    )
    assert result.batch_action == "require_review"
    assert result.unknown_fields[0].is_sensitive is True


def test_auto_protect_persists_schema_drift_delivery_logs(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 3: Auto Protect emits schema_drift_policy* delivery_logs rows."""
    from app.logs.models import DeliveryLog

    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.email")

    _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"email": "user@test.com"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )

    auto_rows = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "schema_drift_policy_auto_protect_applied",
        )
        .all()
    )
    assert auto_rows
    assert auto_rows[0].message.startswith("Auto protect applied:")
    assert auto_rows[0].payload_sample.get("field_path") == "$.email"
    assert auto_rows[0].payload_sample.get("protection_mode") == "partial_mask"

    summary_rows = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "schema_drift_policy",
        )
        .all()
    )
    assert summary_rows
    assert summary_rows[0].payload_sample.get("action") == "auto_protect"


def test_path_resolution_failed_persists_schema_drift_delivery_log(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Case 5: Path resolution failure is persisted to delivery_logs."""
    from app.logs.models import DeliveryLog

    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_email_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="pass_through", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.missing.path")

    _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"email": "user@test.com"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )

    rows = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "schema_drift_policy_path_resolution_failed",
        )
        .all()
    )
    assert rows
    assert rows[0].payload_sample.get("extracted_path") == "$.missing.path"


def test_require_review_persists_schema_drift_delivery_log(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Require review emits schema_drift_policy_review_required delivery_logs rows."""
    from app.logs.models import DeliveryLog

    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_nickname_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="require_review", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.nickname")

    _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"nickname": "alice"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )

    review_rows = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "schema_drift_policy_review_required",
        )
        .all()
    )
    assert review_rows
    assert review_rows[0].message.startswith("Schema drift policy review required:")
    assert review_rows[0].payload_sample.get("field_path") == "$.nickname"
    assert review_rows[0].payload_sample.get("policy_type") == "unknown_normal"
    assert review_rows[0].payload_sample.get("sensitive") is False


def test_quarantine_persists_schema_drift_delivery_log(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Quarantine emits schema_drift_policy summary delivery_logs row with action quarantine."""
    from app.logs.models import DeliveryLog

    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _configure_nickname_mapping(db_session, stream_id)
    _set_schema_drift_policy(db_session, stream_id, normal="quarantine", sensitive="auto_protect")
    _add_open_drift(db_session, stream_id, "$.user.nickname")

    _run_batch(
        db_session,
        stream_id,
        payload={"items": [{"id": "evt-1", "user": {"nickname": "alice"}, "message": "hello"}]},
        monkeypatch=monkeypatch,
    )

    summary_rows = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "schema_drift_policy",
        )
        .all()
    )
    assert summary_rows
    assert summary_rows[0].message == "Schema drift policy: quarantine"
    assert summary_rows[0].payload_sample.get("action") == "quarantine"
    assert summary_rows[0].payload_sample.get("policy_type") == "unknown_normal"
    assert "$.nickname" in summary_rows[0].payload_sample.get("field_paths", [])
