"""M13.3 Per Route Protection tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.protection.ephemeral import EphemeralProtectionRule
from app.protection.models import PROTECTION_MODE_FULL_MASK, PROTECTION_MODE_PARTIAL_MASK, PROTECTION_MODE_TOKENIZATION, StreamProtectionRule
from app.mappings.models import Mapping
from app.checkpoints.models import Checkpoint
from app.route_protection.legacy_payloads import has_active_protection_route_overrides
from app.route_protection.config import RouteProtectionConfig
from app.route_protection.models import RouteProtectionRule
from app.route_protection.resolver import merge_ephemeral_for_route, resolve_route_protection_config
from app.route_transform.models import RouteMapping
from app.runners.route_context import RouteEffectiveConfig, RouteRuntimeContext, RouteTransformConfig, SharedBatchContext
from app.runners.route_context_builder import build_shared_batch_context
from app.runners.route_stage import process_route_pipeline, process_routes
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def _stream_rule(stream_id: int, field_path: str, mode: str) -> StreamProtectionRule:
    return StreamProtectionRule(
        stream_id=stream_id,
        field_path=field_path,
        sensitivity_class=SENSITIVITY_CLASS_PII,
        protection_mode=mode,
        enabled=True,
        created_by="test",
    )


def _route_rule(route_id: int, field_path: str, mode: str) -> RouteProtectionRule:
    return RouteProtectionRule(
        route_id=route_id,
        field_path=field_path,
        sensitivity_class=SENSITIVITY_CLASS_PII,
        protection_mode=mode,
        enabled=True,
        created_by="test",
    )


def test_resolve_route_protection_stream_fallback() -> None:
    stream_rules = [_stream_rule(1, "$.email", PROTECTION_MODE_PARTIAL_MASK)]
    config = resolve_route_protection_config(
        route_id=10,
        stream_id=1,
        stream_protection_rules=stream_rules,
    )
    assert config.resolution.persisted_source == "stream"
    assert config.resolution.fallback_used is True
    assert len(config.rules) == 1
    assert config.rules[0].protection_mode == PROTECTION_MODE_PARTIAL_MASK


def test_resolve_route_protection_route_override_wins() -> None:
    stream_rules = [_stream_rule(1, "$.email", PROTECTION_MODE_PARTIAL_MASK)]
    overrides = [
        {
            "route_id": 10,
            "field_path": "$.email",
            "protection_action": "tokenize",
            "enabled": True,
        }
    ]
    config = resolve_route_protection_config(
        route_id=10,
        stream_id=1,
        stream_protection_rules=stream_rules,
        route_overrides=overrides,
    )
    assert config.rules[0].protection_mode == PROTECTION_MODE_TOKENIZATION
    assert config.rules[0].source == "route_override"
    assert config.resolution.override_count == 1


def test_resolve_route_protection_route_rules_replace_stream() -> None:
    stream_rules = [_stream_rule(1, "$.email", PROTECTION_MODE_PARTIAL_MASK)]
    route_rules = [_route_rule(10, "$.secret", PROTECTION_MODE_FULL_MASK)]
    config = resolve_route_protection_config(
        route_id=10,
        stream_id=1,
        route_protection_rules=route_rules,
        stream_protection_rules=stream_rules,
    )
    assert config.resolution.persisted_source == "route"
    assert len(config.rules) == 1
    assert config.rules[0].field_path == "$.secret"


def test_resolve_route_protection_audit_only_override() -> None:
    stream_rules = [_stream_rule(1, "$.email", PROTECTION_MODE_PARTIAL_MASK)]
    overrides = [
        {
            "route_id": 10,
            "field_path": "$.email",
            "protection_action": "audit_only",
            "enabled": True,
        }
    ]
    config = resolve_route_protection_config(
        route_id=10,
        stream_id=1,
        stream_protection_rules=stream_rules,
        route_overrides=overrides,
    )
    assert config.rules == ()
    assert config.audit_only_paths == ("$.email",)


def test_merge_ephemeral_for_route_skips_audit_and_persisted() -> None:
    config = RouteProtectionConfig(
        rules=(),
        audit_only_paths=("$.audit",),
        resolution=resolve_route_protection_config(route_id=1, stream_id=1).resolution,
        override_rules_by_path={
            "$.override": resolve_route_protection_config(
                route_id=1,
                stream_id=1,
                route_overrides=[
                    {
                        "route_id": 1,
                        "field_path": "$.override",
                        "protection_action": "full_mask",
                        "enabled": True,
                    }
                ],
            ).rules[0],
        },
    )
    ephemeral = [
        EphemeralProtectionRule(stream_id=1, field_path="$.audit", protection_mode=PROTECTION_MODE_PARTIAL_MASK),
        EphemeralProtectionRule(stream_id=1, field_path="$.new", protection_mode=PROTECTION_MODE_PARTIAL_MASK),
        EphemeralProtectionRule(stream_id=1, field_path="$.override", protection_mode=PROTECTION_MODE_PARTIAL_MASK),
    ]
    merged = merge_ephemeral_for_route(ephemeral, config)
    paths = [e.field_path for e in merged]
    assert "$.audit" not in paths
    assert "$.new" in paths
    assert merged[1].protection_mode == PROTECTION_MODE_FULL_MASK


def test_shared_batch_context_schema_drift_fields() -> None:
    from app.schema_drift_policy.orchestrator import SchemaDriftPolicyResult

    drift = SchemaDriftPolicyResult(
        ephemeral_protection_rules=[
            EphemeralProtectionRule(stream_id=1, field_path="$.new_field", protection_mode=PROTECTION_MODE_PARTIAL_MASK)
        ]
    )
    ctx = build_shared_batch_context(
        stream_id=1,
        batch_id="batch-1",
        runtime_stream={"stream_config": {}},
        extracted_events=[{"id": "1"}],
        schema_drift_policy_result=drift,
    )
    assert ctx.schema_drift_policy_result is drift
    assert len(ctx.ephemeral_auto_protect_rules) == 1


def test_route_payload_protection_applied(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    payload = {"items": [{"id": "e1", "message": "secret-text", "vendor": "acme"}]}
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook)
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)

    delivered = webhook.calls[0]["events"][0]
    assert delivered["message"] != "secret-text"
    assert delivered["message"].startswith("*")


def test_fanout_protected_payload_per_route(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]

    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_PARTIAL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    stream = db.query(Stream).filter_by(id=stream_id).one()
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_b,
                "field_path": "$.message",
                "protection_action": "audit_only",
                "enabled": True,
            }
        ]
    }
    stream.config_json = config
    db.commit()

    payload = {"items": [{"id": "e1", "message": "hello@example.com", "vendor": "acme"}]}
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook)
    captured: dict[int, list[dict[str, Any]]] = {}
    original_deliver = runner._deliver_single_route

    def _capture(stream: Any, route_ctx: Any, events: list[dict[str, Any]]) -> Any:
        captured[int(route_ctx.route_id)] = [dict(e) for e in events]
        return original_deliver(stream, route_ctx, events)

    runner._deliver_single_route = _capture  # type: ignore[method-assign]
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)

    assert captured[route_a][0]["message"] != "hello@example.com"
    assert captured[route_b][0]["message"] == "hello@example.com"
    last = (
        db.query(Checkpoint).filter_by(stream_id=stream_id).one().checkpoint_value_json or {}
    ).get("last_success_event") or {}
    assert last.get("message") == "hello@example.com"


def test_feature_flag_off_parity_with_protection_rules(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()
    ctx = load_stream_context(db, stream_id)
    payload = {"items": [{"id": "e1", "message": "secret", "vendor": "acme"}]}

    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    webhook_off = _FakeWebhookSender()
    _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook_off).run(ctx, db=db)

    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    webhook_on = _FakeWebhookSender()
    _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook_on).run(ctx, db=db)

    # Legacy OFF-path must apply stream protection via SessionLocal/run_with_db the
    # same way the route ON-path does — not silently passthrough plaintext.
    assert webhook_off.calls[0]["events"][0]["message"] == "********"
    assert webhook_on.calls[0]["events"][0]["message"] == "********"
    assert webhook_off.calls[0]["events"][0]["message"] == webhook_on.calls[0]["events"][0]["message"]


def test_feature_flag_on_protection_active(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    ctx = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "secret", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )

    with patch("app.route_protection.stage.protect_batch", wraps=__import__("app.protection.engine", fromlist=["protect_batch"]).protect_batch) as protect_mock:
        db.add(
            StreamProtectionRule(
                stream_id=fixture["stream_id"],
                field_path="$.message",
                sensitivity_class=SENSITIVITY_CLASS_PII,
                protection_mode=PROTECTION_MODE_FULL_MASK,
                enabled=True,
                created_by="test",
            )
        )
        db.commit()
        ctx = load_stream_context(db, fixture["stream_id"])
        summary = runner.run(ctx, db=db)
        assert protect_mock.call_count >= 1
        assert summary.get("route_protection_count") == 1


def test_route_protection_metrics(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    ctx = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(ctx, db=db)
    assert summary.get("route_protection_count") == 0
    assert summary.get("route_protection_attempt_count") == 0
    assert summary.get("route_protection_success_count") == 0
    assert summary.get("route_protection_failure_count") == 0
    assert summary.get("route_protection_skipped_count") == 1
    assert summary.get("route_protection_operations_applied") == 0
    assert summary.get("route_protection_duration_ms") is not None


def test_route_protection_metrics_runtime_inherit(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()
    ctx = load_stream_context(db, stream_id)
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "secret-text", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(ctx, db=db)
    assert summary.get("route_protection_attempt_count") == 1
    assert summary.get("route_protection_success_count") == 1
    assert summary.get("route_protection_failure_count") == 0
    assert summary.get("route_protection_skipped_count") == 0
    assert summary.get("route_protection_count") == 1
    assert summary.get("route_protection_operations_applied") == 1
    assert summary.get("route_protection_duration_ms") is not None


def test_policy_stage_runs_after_protection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", False)
    shared = SharedBatchContext(
        stream_id=10,
        batch_id="b1",
        event_root=None,
        union_schema=[],
        extracted_events=[{"message": "hello"}],
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={
            "stream_protection_rules": [],
            "stream_policy_rules": [],
            "route_overrides": [],
        },
    )
    transform = RouteTransformConfig(
        field_mappings={"message": "$.message"},
        enrichment={},
        override_policy="KEEP_EXISTING",
        mapping_source="stream",
        enrichment_source="stream",
    )
    route_ctx = RouteRuntimeContext(
        route_id=1,
        stream_id=10,
        destination_id=20,
        route_name="webhook",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata={"_route_protection_rules": []},
        effective_config=RouteEffectiveConfig(transform=transform),
    )
    result = process_route_pipeline(route_ctx, shared)
    assert any(entry.get("stage") == "classification" for entry in result.stage_timeline)
    assert any(
        entry.get("stage") == "classification" and entry.get("status") == "skipped"
        for entry in result.stage_timeline
    )
    assert any(entry.get("stage") == "policy" for entry in result.stage_timeline)
    assert any(entry.get("stage") == "protection" for entry in result.stage_timeline)
    assert result.delivery_allowed is True


def test_schema_drift_invoked_before_shared_batch(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    ctx = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    order: list[str] = []
    original_apply = runner._apply_schema_drift_policy
    original_build = __import__("app.runners.route_context_builder", fromlist=["build_shared_batch_context"]).build_shared_batch_context

    def _track_apply(**kwargs: Any) -> Any:
        order.append("schema_drift")
        return original_apply(**kwargs)

    def _track_build(**kwargs: Any) -> Any:
        order.append("shared_batch")
        return original_build(**kwargs)

    runner._apply_schema_drift_policy = _track_apply  # type: ignore[method-assign]
    with patch("app.runners.stream_runner.build_shared_batch_context", side_effect=_track_build):
        runner.run(ctx, db=db)
    assert order.index("schema_drift") < order.index("shared_batch")


def _add_email_mapping(db: Session, stream_id: int) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    field_mappings = dict(mapping.field_mappings_json or {})
    field_mappings["email"] = "$.email"
    mapping.field_mappings_json = field_mappings
    db.add(mapping)
    db.commit()


def test_has_active_protection_route_overrides() -> None:
    assert has_active_protection_route_overrides([]) is False
    assert has_active_protection_route_overrides(
        [{"route_id": 1, "field_path": "$.email", "protection_action": "tokenize", "enabled": True}]
    ) is True
    assert has_active_protection_route_overrides(
        [{"route_id": 1, "field_path": "$.email", "protection_action": "tokenize", "enabled": False}]
    ) is False
    assert has_active_protection_route_overrides(
        [{"route_id": 1, "field_path": "$.email", "enabled": True}]
    ) is False


def test_legacy_fanout_protection_route_overrides_tokenize_and_full_mask(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]
    _add_email_mapping(db, stream_id)

    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_PARTIAL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    stream = db.query(Stream).filter_by(id=stream_id).one()
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_a,
                "field_path": "$.email",
                "protection_action": "tokenize",
                "enabled": True,
            },
            {
                "route_id": route_b,
                "field_path": "$.email",
                "protection_action": "mask_full",
                "enabled": True,
            },
        ]
    }
    stream.config_json = config
    db.commit()

    payload = {"items": [{"id": "e1", "email": "user@example.com", "vendor": "acme"}]}
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook)
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)

    by_url = {call["config"]["url"]: call["events"][0] for call in webhook.calls}
    route_a_event = by_url["https://receiver-0.example.com/events"]
    route_b_event = by_url["https://receiver-1.example.com/events"]
    assert route_a_event["email"] != "user@example.com"
    assert route_a_event["email"] != "********"
    assert route_b_event["email"] == "********"
    assert route_a_event["vendor"] == "acme"


def test_legacy_fanout_no_overrides_matches_stream_protection(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.message",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db.commit()
    ctx = load_stream_context(db, stream_id)
    event_payload = {"items": [{"id": "e1", "message": "secret-text", "vendor": "acme"}]}

    webhook_a = _FakeWebhookSender()
    _build_runner(poller=_FakePoller(response=event_payload), webhook_sender=webhook_a).run(ctx, db=db)
    masked_a = webhook_a.calls[0]["events"][0]["message"]
    masked_b = webhook_a.calls[1]["events"][0]["message"]
    assert masked_a == "********"
    assert masked_a == masked_b
    assert masked_a != "secret-text"


def test_legacy_fanout_audit_only_override_route_plaintext(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]
    _add_email_mapping(db, stream_id)

    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_PARTIAL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    stream = db.query(Stream).filter_by(id=stream_id).one()
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_a,
                "field_path": "$.email",
                "protection_action": "audit_only",
                "enabled": True,
            }
        ]
    }
    stream.config_json = config
    db.commit()

    payload = {"items": [{"id": "e1", "email": "user@example.com", "vendor": "acme"}]}
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook)
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)

    by_url = {call["config"]["url"]: call["events"][0] for call in webhook.calls}
    assert by_url["https://receiver-0.example.com/events"]["email"] == "user@example.com"
    assert by_url["https://receiver-1.example.com/events"]["email"] != "user@example.com"


def test_legacy_protection_override_preserves_checkpoint_policy_classification(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]
    _add_email_mapping(db, stream_id)

    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    stream = db.query(Stream).filter_by(id=stream_id).one()
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_id,
                "field_path": "$.email",
                "protection_action": "tokenize",
                "enabled": True,
            }
        ]
    }
    stream.config_json = config
    db.commit()

    ctx = load_stream_context(db, stream_id)
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "email": "user@example.com", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    classify_calls: list[int] = []
    policy_calls: list[int] = []
    original_classify = runner._classify_events
    original_policy = runner._evaluate_policies

    def _track_classify(**kwargs: Any) -> None:
        classify_calls.append(int(kwargs["stream_id"]))
        original_classify(**kwargs)

    def _track_policy(**kwargs: Any) -> Any:
        policy_calls.append(int(kwargs["stream_id"]))
        return original_policy(**kwargs)

    runner._classify_events = _track_classify  # type: ignore[method-assign]
    runner._evaluate_policies = _track_policy  # type: ignore[method-assign]

    before = db.query(Checkpoint).filter_by(stream_id=stream_id).one().checkpoint_value_json
    summary = runner.run(ctx, db=db)
    after = db.query(Checkpoint).filter_by(stream_id=stream_id).one().checkpoint_value_json

    assert classify_calls == [stream_id]
    assert policy_calls == [stream_id]
    assert summary.get("checkpoint_updated") is True
    assert before != after
