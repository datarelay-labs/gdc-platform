"""M13.1 — classification engine hardening (parity, distribution, bounded summary, regression)."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.classification.engine import ClassificationBatchResult, classify_batch, evaluate_batch
from app.classification.field_keys import (
    CLASSIFICATION_LEVEL_FIELD,
    CLASSIFICATION_LEVEL_GDC_FIELD,
    read_classification_level,
)
from app.classification.metrics import (
    CLASSIFICATION_COMPLETE_STAGE,
    build_classification_complete_payload,
    build_platform_classification_summary,
    build_stream_classification_summary,
    load_cumulative_classification_distribution,
)
from app.classification.models import StreamClassificationRule
from app.classification.service import classify_events_for_delivery, classify_events_for_preview
from app.destinations.models import Destination
from app.dynamic_routing.dynamic_routing_service import evaluate_dynamic_routes_for_preview
from app.dynamic_routing.operator_workflow import create_dynamic_route
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.protection.policy_engine import evaluate_batch as evaluate_policy_batch
from app.protection.policy_operator_workflow import create_policy_rule
from app.quarantine.models import StreamQuarantineEvent
from app.quarantine.policy_integration import should_quarantine_batch
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest
from app.sensitive_detection.models import (
    SENSITIVITY_CLASS_PII,
    SENSITIVITY_CLASS_SECRET,
    SENSITIVITY_CLASS_SECURITY_METADATA,
)
from tests.test_classification_engine_m13 import _classification_test_app
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _add_enabled_route_for_destination,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context
from app.database import get_db, get_db_read_bounded
from fastapi.testclient import TestClient

_REQUIRED_LOG_KEYS = frozenset(
    {
        "stream_id",
        "classification_level",
        "matched_rule_count",
        "processing_time_ms",
    }
)


@pytest.fixture
def classification_runtime_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_CLASSIFICATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)


@pytest.fixture
def classification_api_client(db_session: Session) -> TestClient:
    app = _classification_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def _seed_mapping(db: Session, stream_id: int, *, fields: dict[str, str] | None = None) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        **(fields or {}),
    }


def _preview_level(
    db: Session,
    stream_id: int,
    *,
    payload: dict[str, Any],
    field_mappings: dict[str, str],
) -> str | None:
    resp = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            stream_id=stream_id,
            payload=payload,
            event_array_path="$.items",
            field_mappings=field_mappings,
            enrichment={},
            max_events=1,
        ),
        db=db,
    )
    return resp.classification_level


def _runtime_level(
    db: Session,
    stream_id: int,
    *,
    events: list[dict[str, Any]],
    findings: list[dict[str, Any]] | None = None,
) -> str:
    copied = copy.deepcopy(events)
    result = evaluate_batch(db, stream_id=stream_id, events=copied, findings=findings)
    return str(result.classification_level)


@pytest.mark.parametrize(
    ("events", "findings", "expected"),
    [
        ([{"message": "hello"}], [], "INTERNAL"),
        ([{"api_key": "secret-value"}], [{"sensitivity_class": SENSITIVITY_CLASS_SECRET}], "RESTRICTED"),
        ([{"email": "a@b.c"}], [{"sensitivity_class": SENSITIVITY_CLASS_PII}], "CONFIDENTIAL"),
        (
            [{"host": "10.0.0.1"}],
            [{"sensitivity_class": SENSITIVITY_CLASS_SECURITY_METADATA}],
            "INTERNAL",
        ),
    ],
)
def test_preview_runtime_classification_parity(
    db_session: Session,
    classification_runtime_settings: None,
    events: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    expected: str,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    field_mappings = {k: f"$.{k}" for k in events[0]}
    _seed_mapping(db_session, stream_id, fields=field_mappings)
    db_session.commit()

    payload = {"items": events}
    preview_level = _preview_level(
        db_session,
        stream_id,
        payload=payload,
        field_mappings=field_mappings,
    )
    runtime_level = _runtime_level(
        db_session,
        stream_id,
        events=events,
        findings=findings or None,
    )
    assert preview_level == expected
    assert runtime_level == expected


def test_preview_runtime_explicit_rule_parity(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    db_session.add(
        StreamClassificationRule(
            stream_id=stream_id,
            name="PII public override",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            classification_level="PUBLIC",
        )
    )
    _seed_mapping(db_session, stream_id, fields={"email": "$.email"})
    db_session.commit()

    events = [{"email": "a@b.c"}]
    payload = {"items": events}
    preview_level = _preview_level(
        db_session,
        stream_id,
        payload=payload,
        field_mappings={"email": "$.email"},
    )
    runtime_level = _runtime_level(
        db_session,
        stream_id,
        events=events,
        findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}],
    )
    assert preview_level == "PUBLIC"
    assert runtime_level == "PUBLIC"


def test_classification_level_gdc_collision_preserves_source() -> None:
    events = [{CLASSIFICATION_LEVEL_FIELD: "CUSTOM", "message": "x"}]
    result = classify_batch(events, stream_id=1, rules=[], findings=[])
    assert events[0][CLASSIFICATION_LEVEL_FIELD] == "CUSTOM"
    assert events[0][CLASSIFICATION_LEVEL_GDC_FIELD] == "INTERNAL"
    assert read_classification_level(events[0]) == "INTERNAL"
    assert result.classification_level == "INTERNAL"


def test_policy_restricted_quarantine_e2e(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Restricted quarantine",
        enabled=True,
        condition_json={"classification_level": "RESTRICTED"},
        action_type="quarantine",
    )
    db_session.commit()

    events = [{"api_key": "secret-value"}]
    classify_batch(
        events,
        stream_id=stream_id,
        rules=[],
        findings=[{"sensitivity_class": SENSITIVITY_CLASS_SECRET}],
    )
    result = evaluate_policy_batch(db_session, stream_id=stream_id, events=events)
    assert result.matched_policy_count == 1
    assert should_quarantine_batch(result)


def test_policy_confidential_audit_only_e2e(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Confidential audit",
        enabled=True,
        condition_json={"classification_level": "CONFIDENTIAL"},
        action_type="audit_only",
    )
    db_session.commit()

    events = [{"email": "a@b.c"}]
    classify_batch(
        events,
        stream_id=stream_id,
        rules=[],
        findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}],
    )
    result = evaluate_policy_batch(db_session, stream_id=stream_id, events=events)
    assert result.matched_policy_count == 1
    assert not should_quarantine_batch(result)
    assert result.audit_event_count == 1


def test_quarantine_classification_runtime_blocks_delivery_and_checkpoint(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    from app.checkpoints.models import Checkpoint

    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Restricted quarantine",
        enabled=True,
        condition_json={"classification_level": "RESTRICTED"},
        action_type="quarantine",
    )
    _seed_mapping(db_session, stream_id, fields={"api_key": "$.api_key"})
    db_session.commit()

    cp_before = {"marker": "before"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-1",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 0
    assert (
        db_session.query(StreamQuarantineEvent)
        .filter(StreamQuarantineEvent.stream_id == stream_id)
        .count()
        == 1
    )
    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json == cp_before


def test_quarantine_release_updates_checkpoint_after_classification(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    from app.checkpoints.models import Checkpoint
    from app.destinations.adapters.registry import DestinationAdapterRegistry
    from app.quarantine.service import execute_quarantine_release

    class _ReleaseSender:
        def send(
            self,
            events: list[dict[str, Any]],
            config: dict[str, Any],
            formatter_override: dict[str, Any] | None = None,
            **kwargs: Any,
        ) -> None:
            return None

    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Restricted quarantine",
        enabled=True,
        condition_json={"classification_level": "RESTRICTED"},
        action_type="quarantine",
    )
    _seed_mapping(db_session, stream_id, fields={"api_key": "$.api_key"})
    db_session.commit()

    cp_before = {"marker": "before"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    poller = _FakePoller(
        response={"items": [{"id": "evt-1", "api_key": "super-secret-token-value", "message": "hello"}]}
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    row = db_session.query(StreamQuarantineEvent).filter(StreamQuarantineEvent.stream_id == stream_id).one()
    registry = DestinationAdapterRegistry(webhook_sender=_ReleaseSender())
    result = execute_quarantine_release(
        db_session,
        int(row.id),
        destination_registry=registry,
        released_by="tester",
    )
    db_session.commit()
    assert result["checkpoint_updated"] is True
    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json != cp_before


def test_dynamic_routing_classification_preview_runtime_parity(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    dest_conf = Destination(
        name="Confidential Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://confidential.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    dest_rest = Destination(
        name="Restricted Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://restricted.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add(dest_conf)
    db_session.add(dest_rest)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(dest_conf.id))
    _add_enabled_route_for_destination(db_session, stream_id, int(dest_rest.id))
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Confidential route",
        enabled=True,
        condition_json={"classification_level": "CONFIDENTIAL"},
        destination_id=int(dest_conf.id),
    )
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Restricted route",
        enabled=True,
        condition_json={"classification_level": "RESTRICTED"},
        destination_id=int(dest_rest.id),
    )
    _seed_mapping(
        db_session,
        stream_id,
        fields={"email": "$.email", "api_key": "$.api_key"},
    )
    db_session.commit()

    confidential_events = [{"email": "a@b.c"}]
    classify_events_for_preview(db_session, stream_id=stream_id, enriched_events=confidential_events)
    preview_conf = evaluate_dynamic_routes_for_preview(
        db_session,
        stream_id=stream_id,
        enriched_events=confidential_events,
    )
    assert "Confidential Webhook" in preview_conf

    restricted_events = [{"api_key": "secret-value-12345"}]
    classify_events_for_preview(db_session, stream_id=stream_id, enriched_events=restricted_events)
    preview_rest = evaluate_dynamic_routes_for_preview(
        db_session,
        stream_id=stream_id,
        enriched_events=restricted_events,
    )
    assert "Restricted Webhook" in preview_rest


def test_disabled_classification_rule_not_evaluated(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    enabled_rule = StreamClassificationRule(
        stream_id=stream_id,
        name="Enabled",
        enabled=True,
        condition_json={"sensitivity_class": SENSITIVITY_CLASS_SECRET},
        classification_level="CONFIDENTIAL",
    )
    disabled_rule = StreamClassificationRule(
        stream_id=stream_id,
        name="Disabled",
        enabled=False,
        condition_json={"sensitivity_class": SENSITIVITY_CLASS_SECRET},
        classification_level="RESTRICTED",
    )
    db_session.add_all([enabled_rule, disabled_rule])
    db_session.commit()

    events = [{"api_key": "x"}]
    result = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=events,
        findings=[{"sensitivity_class": SENSITIVITY_CLASS_SECRET}],
    )
    assert result.classification_level == "CONFIDENTIAL"
    assert result.matched_rule_count == 1


def test_distribution_accuracy_from_classification_complete(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]

    def _persist_log(entry: dict[str, Any]) -> None:
        db_session.add(
            DeliveryLog(
                stream_id=stream_id,
                stage=CLASSIFICATION_COMPLETE_STAGE,
                level="INFO",
                status="OK",
                message=str(entry.get("message") or "classification complete"),
                payload_sample=dict(entry),
                retry_count=0,
            )
        )
        db_session.flush()

    classify_events_for_delivery(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"message": "hello"}],
        log_fn=_persist_log,
    )
    classify_events_for_delivery(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"api_key": "secret-value"}],
        log_fn=_persist_log,
    )
    db_session.commit()

    summary = build_stream_classification_summary(db_session, stream_id)
    assert summary["internal_count"] == 1
    assert summary["restricted_count"] == 1
    assert summary["public_count"] == 0
    assert summary["confidential_count"] == 0
    assert summary["last_classification_level"] == "RESTRICTED"


def test_summary_bounded_query_prefers_latest_complete(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    for idx in range(40):
        db_session.add(
            DeliveryLog(
                stream_id=stream_id,
                stage="route_send_success",
                level="INFO",
                status="OK",
                message="route ok",
                payload_sample={"idx": idx},
                retry_count=0,
            )
        )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=CLASSIFICATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="classification complete",
            payload_sample={
                "classification_level": "CONFIDENTIAL",
                "matched_rule_count": 0,
                "processing_time_ms": 3,
                "total_public_count": 0,
                "total_internal_count": 2,
                "total_confidential_count": 5,
                "total_restricted_count": 1,
            },
            retry_count=0,
        )
    )
    db_session.commit()

    query_count = {"n": 0}

    def _before_cursor_execute(_conn, _cursor, _statement, _parameters, _context, _executemany) -> None:
        query_count["n"] += 1

    event.listen(db_session.bind, "before_cursor_execute", _before_cursor_execute)
    try:
        summary = build_stream_classification_summary(db_session, stream_id)
    finally:
        event.remove(db_session.bind, "before_cursor_execute", _before_cursor_execute)

    assert summary["confidential_count"] == 5
    assert summary["internal_count"] == 2
    assert summary["restricted_count"] == 1
    assert query_count["n"] <= 3


def test_platform_summary_aggregates_latest_per_stream(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=CLASSIFICATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="classification complete",
            payload_sample={
                "classification_level": "RESTRICTED",
                "total_public_count": 0,
                "total_internal_count": 0,
                "total_confidential_count": 0,
                "total_restricted_count": 2,
            },
            retry_count=0,
        )
    )
    db_session.commit()
    platform = build_platform_classification_summary(db_session)
    assert platform["restricted_count"] == 2


def test_classification_complete_observability_payload_fields() -> None:
    payload = build_classification_complete_payload(
        stream_id=11,
        result=ClassificationBatchResult(
            classification_level="RESTRICTED",
            matched_rule_count=2,
            duration_ms=7,
        ),
        cumulative_distribution={
            "public_count": 1,
            "internal_count": 3,
            "confidential_count": 0,
            "restricted_count": 4,
        },
    )
    assert payload["stage"] == CLASSIFICATION_COMPLETE_STAGE
    assert _REQUIRED_LOG_KEYS <= frozenset(payload.keys())
    assert payload["classification_level"] == "RESTRICTED"
    assert payload["matched_rule_count"] == 2
    assert payload["processing_time_ms"] == 7
    assert payload["total_restricted_count"] == 5


def test_runtime_classification_complete_log_written(
    db_session: Session,
    classification_runtime_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _seed_mapping(db_session, stream_id, fields={"message": "$.message"})
    db_session.commit()

    poller = _FakePoller(response={"items": [{"id": "evt-1", "message": "hello"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    row = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == CLASSIFICATION_COMPLETE_STAGE,
        )
        .order_by(DeliveryLog.created_at.desc())
        .first()
    )
    assert row is not None
    sample = row.payload_sample if isinstance(row.payload_sample, dict) else {}
    assert _REQUIRED_LOG_KEYS <= frozenset(sample.keys())


def test_load_cumulative_classification_distribution_from_latest(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=CLASSIFICATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="classification complete",
            payload_sample={
                "total_public_count": 0,
                "total_internal_count": 4,
                "total_confidential_count": 1,
                "total_restricted_count": 2,
            },
            retry_count=0,
        )
    )
    db_session.commit()
    cumulative = load_cumulative_classification_distribution(db_session, stream_id)
    assert cumulative["internal_count"] == 4
    assert cumulative["restricted_count"] == 2


def test_summary_api_returns_runtime_distribution(
    db_session: Session,
    classification_api_client: TestClient,
    classification_runtime_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]

    def _persist_log(entry: dict[str, Any]) -> None:
        db_session.add(
            DeliveryLog(
                stream_id=stream_id,
                stage=CLASSIFICATION_COMPLETE_STAGE,
                level="INFO",
                status="OK",
                message=str(entry.get("message") or "classification complete"),
                payload_sample=dict(entry),
                retry_count=0,
            )
        )
        db_session.flush()

    classify_events_for_delivery(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"api_key": "secret-value"}],
        log_fn=_persist_log,
    )
    db_session.commit()

    resp = classification_api_client.get(f"/api/v1/runtime/streams/{stream_id}/classification/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body["restricted_count"] == 1
    assert body["last_classification_level"] == "RESTRICTED"
