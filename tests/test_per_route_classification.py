"""M13.4 Per Route Classification tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.classification.engine import classify_batch
from app.classification.field_keys import read_classification_level
from app.classification.models import StreamClassificationRule
from app.config import settings
from app.route_classification.config import RouteClassificationConfig
from app.route_classification.models import RouteClassificationRule
from app.route_classification.resolver import resolve_route_classification_config
from app.route_protection.config import RouteProtectionConfig
from app.runners.route_context import RouteEffectiveConfig, RouteRuntimeContext, RouteTransformConfig, SharedBatchContext
from app.runners.route_context_builder import build_route_runtime_contexts
from app.runners.route_stage import process_route_pipeline, process_routes
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII, SENSITIVITY_CLASS_SECRET
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def _stream_rule(stream_id: int, name: str, sensitivity: str, level: str) -> StreamClassificationRule:
    return StreamClassificationRule(
        stream_id=stream_id,
        name=name,
        enabled=True,
        condition_json={"sensitivity_class": sensitivity},
        classification_level=level,
    )


def _route_rule(route_id: int, name: str, sensitivity: str, level: str) -> RouteClassificationRule:
    return RouteClassificationRule(
        route_id=route_id,
        name=name,
        enabled=True,
        condition_json={"sensitivity_class": sensitivity},
        classification_level=level,
    )


def _minimal_route_ctx(*, route_id: int = 1, stream_id: int = 10) -> RouteRuntimeContext:
    transform = RouteTransformConfig(
        field_mappings={"message": "$.message"},
        enrichment={},
        override_policy="KEEP_EXISTING",
        mapping_source="stream",
        enrichment_source="stream",
    )
    return RouteRuntimeContext(
        route_id=route_id,
        stream_id=stream_id,
        destination_id=20,
        route_name="webhook",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata={"_route_protection_rules": [], "_route_classification_rules": []},
        effective_config=RouteEffectiveConfig(transform=transform),
    )


def _minimal_shared(*, findings: list[dict[str, Any]] | None = None) -> SharedBatchContext:
    detection_ctx = None
    if findings is not None:
        from datetime import datetime, timezone

        from app.sensitive_detection.context import SensitiveDetectionContext

        finding_classes = {str(f["sensitivity_class"]) for f in findings if isinstance(f, dict)}
        detection_ctx = SensitiveDetectionContext(
            stream_id=10,
            events=[{"message": "hello"}],
            findings=findings,
            findings_by_event={0: list(findings)},
            finding_classes=finding_classes,
            field_hits=list(findings),
            detected_at=datetime.now(timezone.utc),
        )
    return SharedBatchContext(
        stream_id=10,
        batch_id="b1",
        event_root=None,
        union_schema=[],
        extracted_events=[{"message": "hello"}],
        schema_observation={},
        sensitive_detection_result=detection_ctx,
        checkpoint_cursor_before=None,
        shared_runtime_data={
            "stream_protection_rules": [],
            "stream_classification_rules": [],
            "route_overrides": [],
        },
    )


@pytest.fixture
def classification_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", True)


def test_resolve_route_classification_stream_fallback() -> None:
    stream_rules = [_stream_rule(1, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")]
    config = resolve_route_classification_config(
        route_id=10,
        stream_id=1,
        stream_classification_rules=stream_rules,
    )
    assert config.resolution.persisted_source == "stream"
    assert config.resolution.fallback_used is True
    assert len(config.rules) == 1
    assert config.rules[0].source == "stream"


def test_resolve_route_classification_route_rules_replace_stream() -> None:
    stream_rules = [_stream_rule(1, "stream-pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")]
    route_rules = [_route_rule(10, "route-secret", SENSITIVITY_CLASS_SECRET, "RESTRICTED")]
    config = resolve_route_classification_config(
        route_id=10,
        stream_id=1,
        route_classification_rules=route_rules,
        stream_classification_rules=stream_rules,
    )
    assert config.resolution.persisted_source == "route"
    assert len(config.rules) == 1
    assert config.rules[0].classification_level == "RESTRICTED"


def test_resolve_route_classification_empty_config() -> None:
    config = resolve_route_classification_config(route_id=10, stream_id=1)
    assert config.resolution.persisted_source == "empty"
    assert config.empty is True
    assert config.rules == ()


def test_resolve_route_classification_override_floor() -> None:
    overrides = [{"route_id": 10, "enabled": True, "classification_level": "RESTRICTED"}]
    config = resolve_route_classification_config(
        route_id=10,
        stream_id=1,
        route_overrides=overrides,
    )
    assert config.override_levels == ("RESTRICTED",)
    assert config.resolution.override_count == 1


def test_override_floor_not_field_path_protection() -> None:
    """Classification override has no field_path — distinct from protection override."""
    overrides = [
        {
            "route_id": 10,
            "enabled": True,
            "classification_level": "RESTRICTED",
            "protection_action": "full_mask",
            "field_path": "$.email",
        }
    ]
    cls_config = resolve_route_classification_config(
        route_id=10,
        stream_id=1,
        route_overrides=overrides,
    )
    assert cls_config.override_levels == ("RESTRICTED",)
    assert "field_path" not in (cls_config.rules[0].condition_json if cls_config.rules else {})


def test_route_stage_attaches_classification_result(classification_enabled: None) -> None:
    shared = _minimal_shared(findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    shared.shared_runtime_data["stream_classification_rules"] = [
        _stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")
    ]
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared)
    assert result.classification_result is not None
    assert result.classification_result.effective_level == "CONFIDENTIAL"
    assert read_classification_level(result.events[0]) == "CONFIDENTIAL"


def test_route_stage_override_floor_raises_level(classification_enabled: None) -> None:
    shared = _minimal_shared(findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    shared.shared_runtime_data["stream_classification_rules"] = [
        _stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")
    ]
    shared.shared_runtime_data["route_overrides"] = [
        {"route_id": 1, "enabled": True, "classification_level": "RESTRICTED"}
    ]
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared)
    assert result.classification_result is not None
    assert result.classification_result.effective_level == "RESTRICTED"
    assert result.classification_result.override_applied is True


def test_stamped_events_passed_to_policy_stage(classification_enabled: None) -> None:
    shared = _minimal_shared()
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared)
    assert any(entry.get("stage") == "policy" for entry in result.stage_timeline)
    assert any(entry.get("stage") == "classification" for entry in result.stage_timeline)
    assert result.delivery_allowed is True


def test_flag_on_stage_order(classification_enabled: None) -> None:
    shared = _minimal_shared()
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared)
    stages = [entry.get("stage") for entry in result.stage_timeline if entry.get("stage")]
    transform_idx = stages.index("transform")
    protection_idx = stages.index("protection")
    classification_idx = stages.index("classification")
    policy_idx = stages.index("policy")
    delivery_idx = stages.index("delivery")
    assert transform_idx < protection_idx < classification_idx < policy_idx < delivery_idx


def test_classify_batch_reused_not_evaluate_batch(classification_enabled: None) -> None:
    shared = _minimal_shared()
    route_ctx = _minimal_route_ctx()
    with patch("app.route_classification.stage.classify_batch", wraps=classify_batch) as mock_cls:
        process_route_pipeline(route_ctx, shared)
        mock_cls.assert_called_once()


def test_effective_config_classification_typed(db_session: Session) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamClassificationRule(
            stream_id=stream_id,
            name="default",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            classification_level="CONFIDENTIAL",
        )
    )
    db.commit()
    ctx = load_stream_context(db, stream_id)
    contexts, _ = build_route_runtime_contexts(ctx.stream)
    assert contexts[0].effective_config.classification is not None
    assert isinstance(contexts[0].effective_config.classification, RouteClassificationConfig)


def test_fan_out_receives_classified_events(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    classification_enabled: None,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    ctx = load_stream_context(db, stream_id)
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(ctx, db=db)
    assert summary.get("route_delivery_success_count", 0) >= 1
    assert summary.get("route_delivery_attempt_count", 0) >= 1


def test_route_classification_metrics(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    classification_enabled: None,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    ctx = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(ctx, db=db)
    assert summary.get("route_classification_count") == 0
    assert summary.get("route_classification_attempt_count") == 0
    assert summary.get("route_classification_success_count") == 0
    assert summary.get("route_classification_failure_count") == 0
    assert summary.get("route_classification_skipped_count") == 1
    assert summary.get("route_classification_duration_ms") is not None


def test_feature_flag_off_legacy_unchanged(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    db = db_session
    fixture = _seed_stream_runtime(db)
    ctx = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    with patch("app.runners.route_stage.process_routes") as route_mock:
        runner.run(ctx, db=db)
        route_mock.assert_not_called()


def test_process_routes_classification_metrics(classification_enabled: None) -> None:
    shared = _minimal_shared()
    route_ctx = _minimal_route_ctx()
    pipeline = process_routes([route_ctx], shared)
    assert pipeline.metrics.route_classification_count == 0
    assert pipeline.metrics.route_classification_attempt_count == 0
    assert pipeline.metrics.route_classification_success_count == 0
    assert pipeline.metrics.route_classification_failure_count == 0
    assert pipeline.metrics.route_classification_skipped_count == 1
    assert pipeline.metrics.route_classification_duration_ms >= 0
    assert pipeline.metrics.route_classification_operations_applied == 0
    metrics_result = pipeline.stage_results[0].classification_metrics
    assert metrics_result is not None
    assert metrics_result.outcome == "skipped"
    assert metrics_result.skip_reason == "no_effective_classification"


def test_has_active_classification_route_overrides() -> None:
    from app.route_classification.legacy_payloads import has_active_classification_route_overrides

    assert has_active_classification_route_overrides([]) is False
    assert has_active_classification_route_overrides(
        [{"route_id": 1, "classification_level": "RESTRICTED", "enabled": True}]
    ) is True
    assert has_active_classification_route_overrides(
        [{"route_id": 1, "classification_level": "RESTRICTED", "enabled": False}]
    ) is False
    assert has_active_classification_route_overrides(
        [{"route_id": 1, "enabled": True}]
    ) is False


def test_legacy_classification_floor_max_level() -> None:
    from app.route_classification.legacy_payloads import build_legacy_route_classification_payloads

    runtime_stream = {
        "id": 1,
        "route_overrides": [
            {"route_id": 10, "classification_level": "INTERNAL", "enabled": True},
            {"route_id": 20, "classification_level": "RESTRICTED", "enabled": True},
        ],
        "routes": [
            {"id": 10, "enabled": True, "destination": {"id": 1, "enabled": True}},
            {"id": 20, "enabled": True, "destination": {"id": 2, "enabled": True}},
        ],
    }
    base_events = [{"message": "hello", "classification_level": "CONFIDENTIAL"}]
    payloads = build_legacy_route_classification_payloads(
        runtime_stream=runtime_stream,
        base_events=base_events,
    )
    assert read_classification_level(payloads[10][0]) == "CONFIDENTIAL"
    assert read_classification_level(payloads[20][0]) == "RESTRICTED"


def test_legacy_fanout_classification_route_overrides_internal_and_restricted(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    classification_enabled: None,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]

    stream = db.query(Stream).filter_by(id=stream_id).one()
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {"route_id": route_a, "classification_level": "INTERNAL", "enabled": True},
            {"route_id": route_b, "classification_level": "RESTRICTED", "enabled": True},
        ]
    }
    stream.config_json = config
    db.commit()

    webhook = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=webhook,
    )
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)

    by_url = {call["config"]["url"]: call["events"][0] for call in webhook.calls}
    route_a_event = by_url["https://receiver-0.example.com/events"]
    route_b_event = by_url["https://receiver-1.example.com/events"]
    assert read_classification_level(route_a_event) == "INTERNAL"
    assert read_classification_level(route_b_event) == "RESTRICTED"


def test_legacy_fanout_no_classification_overrides_unchanged(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    classification_enabled: None,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]

    webhook = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=webhook,
    )
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)

    levels = {read_classification_level(call["events"][0]) for call in webhook.calls}
    assert levels == {"INTERNAL"}
