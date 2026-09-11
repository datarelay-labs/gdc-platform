"""M13.5 Per Route Policy tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.protection.models import (
    POLICY_ACTION_AUDIT_ONLY,
    POLICY_ACTION_BLOCK,
    POLICY_ACTION_QUARANTINE,
    POLICY_ACTION_REQUIRE_REVIEW,
    StreamPolicyRule,
)
from app.protection.policy_engine import (
    PolicyBatchResult,
    PolicyEvaluationItem,
    evaluate_injected_policy_batch,
    evaluate_batch,
)
from app.quarantine.models import StreamQuarantineEvent
from app.route_policy.config import RoutePolicyConfig
from app.route_policy.decision import delivery_allowed_for_decision, merge_route_policy_decision
from app.route_policy.legacy_gates import (
    build_legacy_route_delivery_gates,
    has_active_delivery_behavior_route_overrides,
)
from app.route_policy.models import RoutePolicyRule
from app.route_policy.resolver import resolve_route_policy_config
from app.route_protection.resolver import resolve_route_protection_config
from app.runners.route_context import RouteEffectiveConfig, RouteRuntimeContext, RouteTransformConfig, SharedBatchContext
from app.runners.route_context_builder import build_route_runtime_contexts
from app.runners.route_stage import process_route_pipeline, process_routes
from app.runners.stream_loader import load_stream_context
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def _stream_rule(stream_id: int, name: str, sensitivity: str, action: str) -> StreamPolicyRule:
    return StreamPolicyRule(
        stream_id=stream_id,
        name=name,
        enabled=True,
        condition_json={"sensitivity_class": sensitivity},
        action_type=action,
    )


def _route_rule(route_id: int, name: str, sensitivity: str, action: str) -> RoutePolicyRule:
    return RoutePolicyRule(
        route_id=route_id,
        name=name,
        enabled=True,
        condition_json={"sensitivity_class": sensitivity},
        action_type=action,
    )


def _minimal_route_ctx(*, route_id: int = 1, stream_id: int = 10) -> RouteRuntimeContext:
    transform = RouteTransformConfig(
        field_mappings={"message": "$.message"},
        enrichment={},
        override_policy="KEEP_EXISTING",
        mapping_source="stream",
        enrichment_source="stream",
    )
    protection = resolve_route_protection_config(route_id=route_id, stream_id=stream_id)
    return RouteRuntimeContext(
        route_id=route_id,
        stream_id=stream_id,
        destination_id=20,
        route_name="webhook",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata={"_route_protection_rules": [], "_route_classification_rules": [], "_route_policy_rules": []},
        effective_config=RouteEffectiveConfig(transform=transform, protection=protection),
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
            "stream_policy_rules": [],
            "route_overrides": [],
        },
    )


@pytest.fixture
def classification_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", True)


def test_resolve_route_policy_stream_fallback() -> None:
    stream_rules = [_stream_rule(1, "pii-audit", SENSITIVITY_CLASS_PII, POLICY_ACTION_AUDIT_ONLY)]
    config = resolve_route_policy_config(
        route_id=10,
        stream_id=1,
        stream_policy_rules=stream_rules,
    )
    assert config.resolution.persisted_source == "stream"
    assert config.resolution.fallback_used is True
    assert len(config.rules) == 1


def test_resolve_route_policy_route_override_rules() -> None:
    stream_rules = [_stream_rule(1, "stream", SENSITIVITY_CLASS_PII, POLICY_ACTION_AUDIT_ONLY)]
    route_rules = [_route_rule(10, "route", SENSITIVITY_CLASS_PII, POLICY_ACTION_QUARANTINE)]
    config = resolve_route_policy_config(
        route_id=10,
        stream_id=1,
        route_policy_rules=route_rules,
        stream_policy_rules=stream_rules,
    )
    assert config.resolution.persisted_source == "route"
    assert config.rules[0].action_type == POLICY_ACTION_QUARANTINE


def test_resolve_route_policy_partial_classification_overlay() -> None:
    stream_rules = [
        StreamPolicyRule(
            stream_id=1,
            name="restricted",
            enabled=True,
            condition_json={"classification_level": "RESTRICTED"},
            action_type=POLICY_ACTION_QUARANTINE,
        ),
        StreamPolicyRule(
            stream_id=1,
            name="confidential",
            enabled=True,
            condition_json={"classification_level": "CONFIDENTIAL"},
            action_type=POLICY_ACTION_AUDIT_ONLY,
        ),
    ]
    route_rules = [
        RoutePolicyRule(
            route_id=10,
            name="confidential-block",
            enabled=True,
            condition_json={"classification_level": "CONFIDENTIAL"},
            action_type=POLICY_ACTION_BLOCK,
        ),
    ]
    config = resolve_route_policy_config(
        route_id=10,
        stream_id=1,
        route_policy_rules=route_rules,
        stream_policy_rules=stream_rules,
    )
    by_level = {
        str((rule.condition_json or {}).get("classification_level")): rule.action_type
        for rule in config.rules
    }
    assert by_level["RESTRICTED"] == POLICY_ACTION_QUARANTINE
    assert by_level["CONFIDENTIAL"] == POLICY_ACTION_BLOCK
    assert len(config.rules) == 2


def test_merge_decision_policy_engine_block() -> None:
    batch = PolicyBatchResult(
        evaluations=[
            PolicyEvaluationItem(
                policy_id=1,
                matched=True,
                policy_name="confidential-block",
                action_type=POLICY_ACTION_BLOCK,
            ),
        ],
        matched_policies=[],
        policy_count=1,
        matched_policy_count=1,
    )
    config = resolve_route_policy_config(route_id=1, stream_id=1)
    decision, reason = merge_route_policy_decision(batch, config)
    assert decision == "block"
    assert "matched_policy_block" in reason


def test_merge_decision_policy_engine_require_review() -> None:
    batch = PolicyBatchResult(
        evaluations=[
            PolicyEvaluationItem(
                policy_id=1,
                matched=True,
                policy_name="confidential-review",
                action_type=POLICY_ACTION_REQUIRE_REVIEW,
            ),
        ],
        matched_policies=[],
        policy_count=1,
        matched_policy_count=1,
    )
    config = resolve_route_policy_config(route_id=1, stream_id=1)
    decision, reason = merge_route_policy_decision(batch, config)
    assert decision == "require_review"
    assert "matched_policy_require_review" in reason


def test_resolve_route_policy_delivery_behavior_override() -> None:
    overrides = [{"route_id": 10, "enabled": True, "delivery_behavior": "block"}]
    config = resolve_route_policy_config(route_id=10, stream_id=1, route_overrides=overrides)
    assert config.override_delivery_behavior == "block"
    assert config.resolution.override_count == 1


def test_merge_decision_precedence_quarantine_wins() -> None:
    batch = PolicyBatchResult(
        evaluations=[],
        matched_policies=[],
        policy_count=0,
        matched_policy_count=0,
    )
    config = resolve_route_policy_config(
        route_id=1,
        stream_id=1,
        route_overrides=[{"route_id": 1, "enabled": True, "delivery_behavior": "block"}],
        schema_drift_policy_result=type("Drift", (), {"should_quarantine": True, "batch_action": "noop", "review_fields": []})(),
    )
    decision, _ = merge_route_policy_decision(batch, config)
    assert decision == "quarantine"


def test_delivery_allowed_allow_and_audit() -> None:
    assert delivery_allowed_for_decision("allow") is True
    assert delivery_allowed_for_decision("audit") is True
    assert delivery_allowed_for_decision("block") is False
    assert delivery_allowed_for_decision("require_review") is False
    assert delivery_allowed_for_decision("quarantine") is False


def test_policy_adapter_no_stream_db_query() -> None:
    findings = [{"sensitivity_class": SENSITIVITY_CLASS_PII}]
    events = [{"message": "x", "classification_level": "INTERNAL"}]
    rules = _route_rule(1, "audit", SENSITIVITY_CLASS_PII, POLICY_ACTION_AUDIT_ONLY)
    adapted = resolve_route_policy_config(route_id=1, stream_id=1, route_policy_rules=[rules]).rules_as_engine_types()
    result = evaluate_injected_policy_batch(rules=adapted, events=events, findings=findings)
    assert result.matched_policy_count == 1


def test_evaluate_batch_delegates_to_injected(db_session: Session) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamPolicyRule(
            stream_id=stream_id,
            name="audit-pii",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            action_type=POLICY_ACTION_AUDIT_ONLY,
        )
    )
    db.commit()
    findings = [{"sensitivity_class": SENSITIVITY_CLASS_PII}]
    events = [{"message": "hello", "classification_level": "INTERNAL"}]
    result = evaluate_batch(db, stream_id=stream_id, events=events, findings=findings)
    assert result.matched_policy_count == 1


def test_route_policy_allow_delivers(classification_enabled: None) -> None:
    shared = _minimal_shared(findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared, db=None)
    assert result.delivery_allowed is True
    assert result.policy_result is not None
    assert result.policy_result.decision == "allow"
    assert len(result.events) == 1


def test_route_policy_audit_delivers(classification_enabled: None) -> None:
    shared = _minimal_shared(findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    shared.shared_runtime_data["stream_policy_rules"] = [
        _stream_rule(10, "audit", SENSITIVITY_CLASS_PII, POLICY_ACTION_AUDIT_ONLY)
    ]
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared, db=None)
    assert result.delivery_allowed is True
    assert result.policy_result is not None
    assert result.policy_result.decision == "audit"


def test_route_policy_block_prevents_delivery(classification_enabled: None) -> None:
    shared = _minimal_shared()
    shared.shared_runtime_data["route_overrides"] = [
        {"route_id": 1, "enabled": True, "delivery_behavior": "block"}
    ]
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared, db=None)
    assert result.delivery_allowed is False
    assert result.policy_result is not None
    assert result.policy_result.decision == "block"
    assert result.events == []


def test_route_policy_require_review_prevents_delivery(classification_enabled: None) -> None:
    shared = _minimal_shared()
    shared.shared_runtime_data["route_overrides"] = [
        {"route_id": 1, "enabled": True, "delivery_behavior": "require_review"}
    ]
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared, db=None)
    assert result.delivery_allowed is False
    assert result.policy_result is not None
    assert result.policy_result.decision == "require_review"


def test_route_policy_quarantine_prevents_delivery(classification_enabled: None) -> None:
    shared = _minimal_shared(findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    shared.shared_runtime_data["stream_policy_rules"] = [
        _stream_rule(10, "q", SENSITIVITY_CLASS_PII, POLICY_ACTION_QUARANTINE)
    ]
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared, db=None)
    assert result.delivery_allowed is False
    assert result.policy_result is not None
    assert result.policy_result.decision == "quarantine"
    assert result.events == []


def test_route_quarantine_records_route_id(
    db_session: Session,
    classification_enabled: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]
    db.add(
        StreamPolicyRule(
            stream_id=stream_id,
            name="q",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            action_type=POLICY_ACTION_QUARANTINE,
        )
    )
    db.commit()
    ctx = load_stream_context(db, stream_id)
    contexts, _ = build_route_runtime_contexts(ctx.stream)
    route_ctx = contexts[0]
    findings = [{"sensitivity_class": SENSITIVITY_CLASS_PII}]
    shared = _minimal_shared(findings=findings)
    shared.stream_id = stream_id
    shared.shared_runtime_data["stream_policy_rules"] = list(ctx.stream.get("stream_policy_rules") or [])
    result = process_route_pipeline(route_ctx, shared, db=db)
    assert result.policy_result is not None
    assert result.policy_result.quarantine_recorded is True
    row = db.query(StreamQuarantineEvent).filter(StreamQuarantineEvent.route_id == route_id).first()
    assert row is not None
    assert row.stream_id == stream_id


def test_route_policy_no_rerun_prior_stages(classification_enabled: None) -> None:
    shared = _minimal_shared(findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    shared.shared_runtime_data["stream_policy_rules"] = [
        _stream_rule(10, "audit", SENSITIVITY_CLASS_PII, POLICY_ACTION_AUDIT_ONLY)
    ]
    route_ctx = _minimal_route_ctx()
    with (
        patch("app.route_policy.stage.evaluate_injected_policy_batch", wraps=evaluate_injected_policy_batch) as mock_policy,
        patch("app.route_classification.stage.classify_batch") as mock_cls,
        patch("app.runners.route_stage.route_protection_stage") as mock_prot,
    ):
        from app.classification.engine import ClassificationBatchResult
        from app.protection.engine import ProtectBatchResult
        from app.route_protection.config import RouteProtectionConfig

        prot_cfg = resolve_route_protection_config(route_id=1, stream_id=10)
        mock_prot.return_value = (
            [{"message": "hello"}],
            ProtectBatchResult(events=[{"message": "hello"}], rules_applied=0, masked_field_applications=0),
            prot_cfg,
        )
        mock_cls.return_value = ClassificationBatchResult(
            classification_level="INTERNAL",
            matched_rule_count=0,
            events_classified=1,
        )
        mock_policy.return_value = PolicyBatchResult()
        process_route_pipeline(route_ctx, shared, db=None)
        mock_policy.assert_called_once()
        mock_cls.assert_called_once()
        mock_prot.assert_called_once()


def test_delivery_gate_fan_out(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    classification_enabled: None,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]
    stream = db.get(Stream, stream_id)
    assert stream is not None
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [{"route_id": route_id, "enabled": True, "delivery_behavior": "quarantine"}]
    }
    stream.config_json = config
    db.commit()
    ctx = load_stream_context(db, stream_id)
    delivered_routes: list[int] = []
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )

    original_deliver = runner._deliver_single_route

    def _capture(stream: Any, route_ctx: Any, events: list[dict[str, Any]]) -> Any:
        delivered_routes.append(int(route_ctx.route_id))
        return original_deliver(stream, route_ctx, events)

    runner._deliver_single_route = _capture  # type: ignore[method-assign]
    summary = runner.run(ctx, db=db)
    assert route_id not in delivered_routes
    assert summary.get("route_delivery_quarantine_count", 0) >= 1


def test_effective_config_policy_typed(db_session: Session) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamPolicyRule(
            stream_id=stream_id,
            name="default",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            action_type=POLICY_ACTION_AUDIT_ONLY,
        )
    )
    db.commit()
    ctx = load_stream_context(db, stream_id)
    contexts, _ = build_route_runtime_contexts(ctx.stream)
    assert contexts[0].effective_config.policy is not None
    assert isinstance(contexts[0].effective_config.policy, RoutePolicyConfig)


def test_route_policy_metrics(classification_enabled: None) -> None:
    shared = _minimal_shared()
    route_ctx = _minimal_route_ctx()
    pipeline = process_routes([route_ctx], shared)
    assert pipeline.metrics.route_policy_count == 1
    assert pipeline.metrics.route_policy_allow_count == 1


def test_feature_flag_off_legacy_unchanged(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
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


def test_flag_on_policy_stage_active(classification_enabled: None) -> None:
    shared = _minimal_shared()
    route_ctx = _minimal_route_ctx()
    result = process_route_pipeline(route_ctx, shared)
    stages = [entry.get("stage") for entry in result.stage_timeline if entry.get("stage")]
    assert "policy" in stages
    assert "policy_stub" not in stages


def test_has_active_delivery_behavior_route_overrides() -> None:
    assert has_active_delivery_behavior_route_overrides([]) is False
    assert has_active_delivery_behavior_route_overrides(
        [{"route_id": 1, "enabled": True, "delivery_behavior": "block"}]
    ) is True
    assert has_active_delivery_behavior_route_overrides(
        [{"route_id": 1, "enabled": True, "delivery_behavior": "continue"}]
    ) is True
    assert has_active_delivery_behavior_route_overrides(
        [{"route_id": 1, "enabled": False, "delivery_behavior": "block"}]
    ) is False
    assert has_active_delivery_behavior_route_overrides(
        [{"route_id": 1, "enabled": True}]
    ) is False


def test_legacy_fanout_delivery_behavior_block_skips_route(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]
    stream = db.get(Stream, stream_id)
    assert stream is not None
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_a,
                "field_path": "$.email",
                "delivery_behavior": "block",
                "enabled": True,
            },
            {
                "route_id": route_b,
                "field_path": "$.email",
                "delivery_behavior": "continue",
                "enabled": True,
            },
        ]
    }
    stream.config_json = config
    db.commit()

    webhook = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "email": "user@example.com", "vendor": "acme"}]}),
        webhook_sender=webhook,
    )
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)

    delivered_urls = {call["config"]["url"] for call in webhook.calls}
    assert "https://receiver-0.example.com/events" not in delivered_urls
    assert "https://receiver-1.example.com/events" in delivered_urls


def test_legacy_fanout_no_delivery_behavior_overrides_delivers_all(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
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
    assert len(webhook.calls) == 2


def test_build_legacy_route_delivery_gates_block_and_continue(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]
    stream = db.get(Stream, stream_id)
    assert stream is not None
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {"route_id": route_a, "enabled": True, "delivery_behavior": "block"},
            {"route_id": route_b, "enabled": True, "delivery_behavior": "continue"},
        ]
    }
    stream.config_json = config
    db.commit()

    ctx = load_stream_context(db, stream_id)
    gates = build_legacy_route_delivery_gates(runtime_stream=ctx.stream)
    assert gates[route_a] is False
    assert gates[route_b] is True
