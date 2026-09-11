"""P0-3 — One Stream / three Routes end-to-end runtime acceptance.

Reuses the existing StreamRunner harness from test_stream_runner_e2e
(FakePoller + FakeWebhookSender + _seed_stream_runtime). Does not introduce
a new test framework or a parallel processing pipeline.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.classification.field_keys import read_classification_level
from app.config import settings
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.protection.models import (
    POLICY_ACTION_AUDIT_ONLY,
    POLICY_ACTION_BLOCK,
    PROTECTION_MODE_DROP_FIELD,
    PROTECTION_MODE_FULL_MASK,
    StreamPolicyRule,
)
from app.route_policy.models import RoutePolicyRule
from app.route_protection.models import RouteProtectionRule
from app.route_transform.models import RouteMapping
from app.runners import route_stage
from app.runners.route_context_builder import build_route_runtime_contexts
from app.runners.stream_loader import load_stream_context
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _checkpoint_value,
    _seed_stream_runtime,
)

SAMPLE_EVENT = {
    "id": "evt-p03-1",
    "user": "alice",
    "email": "alice@example.com",
    "severity": "high",
    "message": "test",
}

SHARED_MAPPINGS = {
    "event_id": "$.id",
    "user": "$.user",
    "email": "$.email",
    "severity": "$.severity",
    "message": "$.message",
}

ROUTE_B_MAPPINGS = {
    "event_id": "$.id",
    "user": "$.user",
    "email": "$.email",
    "severity": "$.severity",
    "normalized_message": "$.message",
    "unmapped_fields_policy": "drop_unmapped",
}

EMAIL_MASK = "********"


def _enable_route_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_SENSITIVE_DETECTION_ENABLED", True)


def _seed_one_stream_three_routes(db: Session) -> dict[str, Any]:
    fixture = _seed_stream_runtime(
        db,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = int(fixture["stream_id"])
    route_a, route_b, route_c = (int(rid) for rid in fixture["route_ids"])

    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = dict(SHARED_MAPPINGS)
    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).one()
    enrichment.enrichment_json = {}

    db.add(
        RouteMapping(
            route_id=route_b,
            field_mappings_json=dict(ROUTE_B_MAPPINGS),
        )
    )
    db.add(
        RouteProtectionRule(
            route_id=route_b,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="p0-3",
        )
    )
    db.add(
        StreamPolicyRule(
            stream_id=stream_id,
            name="Wizard: CONFIDENTIAL policy",
            enabled=True,
            condition_json={"classification_level": "CONFIDENTIAL"},
            action_type=POLICY_ACTION_AUDIT_ONLY,
        )
    )
    db.add(
        RoutePolicyRule(
            route_id=route_c,
            name="Wizard: RESTRICTED policy",
            enabled=True,
            condition_json={"classification_level": "RESTRICTED"},
            action_type=POLICY_ACTION_BLOCK,
        )
    )

    stream = db.get(Stream, stream_id)
    assert stream is not None
    config = dict(stream.config_json or {})
    config["governance"] = {
        "enabled": True,
        "rules": [],
        "route_overrides": [
            {
                "route_id": route_c,
                "classification_level": "RESTRICTED",
                "enabled": True,
            }
        ],
    }
    stream.config_json = config
    db.commit()

    fixture["route_a"] = route_a
    fixture["route_b"] = route_b
    fixture["route_c"] = route_c
    return fixture


def _run_once(
    db: Session,
    stream_id: int,
    monkeypatch: pytest.MonkeyPatch,
    *,
    sample: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], _FakeWebhookSender, dict[int, Any]]:
    captured: dict[int, Any] = {}
    original = route_stage.process_route_pipeline

    def _capture(route_ctx: Any, shared_batch: Any, **kwargs: Any) -> Any:
        result = original(route_ctx, shared_batch, **kwargs)
        captured[int(route_ctx.route_id)] = result
        return result

    monkeypatch.setattr(route_stage, "process_route_pipeline", _capture)

    webhook = _FakeWebhookSender()
    runner = _build_runner(
        poller=_FakePoller(response={"items": [dict(sample or SAMPLE_EVENT)]}),
        webhook_sender=webhook,
    )
    ctx = load_stream_context(db, stream_id)
    summary = runner.run(ctx, db=db)
    return summary, webhook, captured


def _events_by_url(webhook: _FakeWebhookSender) -> dict[str, dict[str, Any]]:
    return {call["config"]["url"]: call["events"][0] for call in webhook.calls}


def _effective_snapshot(db: Session, stream_id: int) -> dict[int, dict[str, Any]]:
    ctx = load_stream_context(db, stream_id)
    contexts, _ = build_route_runtime_contexts(ctx.stream)
    out: dict[int, dict[str, Any]] = {}
    for route_ctx in contexts:
        transform = route_ctx.effective_config.transform
        protection = route_ctx.effective_config.protection
        classification = route_ctx.effective_config.classification
        policy = route_ctx.effective_config.policy
        out[int(route_ctx.route_id)] = {
            "transform_source": transform.mapping_source if transform else None,
            "transform_fields": dict(transform.field_mappings) if transform else {},
            "protection_source": protection.resolution.persisted_source if protection else None,
            "protection_paths": [rule.field_path for rule in protection.rules] if protection else [],
            "classification_source": classification.resolution.persisted_source if classification else None,
            "classification_floors": list(classification.override_levels) if classification else [],
            "policy_source": policy.resolution.persisted_source if policy else None,
            "policy_actions": [rule.action_type for rule in policy.rules] if policy else [],
            "delivery_policy": route_ctx.delivery_policy,
            "destination_id": route_ctx.destination_id,
        }
    return out


def test_route_pipeline_reuses_existing_engines() -> None:
    src = inspect.getsource(route_stage)
    assert "apply_mappings_with_results" in src
    assert "apply_enrichments_batch" in src
    assert "route_protection_stage" in src
    assert "route_classification_stage" in src
    assert "route_policy_stage" in src
    assert "route_delivery_stage" in src
    assert "class RoutePipeline" not in src


def test_one_stream_three_routes_runtime_chain(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    db = db_session
    fixture = _seed_one_stream_three_routes(db)
    stream_id = fixture["stream_id"]
    route_a = fixture["route_a"]
    route_b = fixture["route_b"]
    route_c = fixture["route_c"]

    effective = _effective_snapshot(db, stream_id)
    assert len(effective) == 3
    assert effective[route_a]["transform_source"] == "stream"
    assert effective[route_a]["protection_source"] in ("stream", "empty")
    assert effective[route_a]["classification_floors"] == []
    assert "block" not in effective[route_a]["policy_actions"]

    assert effective[route_b]["transform_source"] == "route"
    assert "normalized_message" in effective[route_b]["transform_fields"]
    assert effective[route_b]["protection_source"] == "route"
    assert "$.email" in effective[route_b]["protection_paths"]

    assert effective[route_c]["classification_floors"] == ["RESTRICTED"]
    assert "block" in effective[route_c]["policy_actions"]
    assert effective[route_c]["transform_source"] == "stream"

    before_checkpoint = _checkpoint_value(db, stream_id)
    summary, webhook, captured = _run_once(db, stream_id, monkeypatch)

    assert summary["outcome"] == "completed"
    assert summary.get("checkpoint_updated") is True
    after_checkpoint = _checkpoint_value(db, stream_id)
    assert after_checkpoint != before_checkpoint

    by_url = _events_by_url(webhook)
    assert set(by_url) == {
        "https://receiver-0.example.com/events",
        "https://receiver-1.example.com/events",
    }
    assert "https://receiver-2.example.com/events" not in by_url

    route_a_out = by_url["https://receiver-0.example.com/events"]
    route_b_out = by_url["https://receiver-1.example.com/events"]
    assert route_a_out["message"] == "test"
    assert route_a_out["email"] == "alice@example.com"
    assert "normalized_message" not in route_a_out

    assert route_b_out["normalized_message"] == "test"
    assert "message" not in route_b_out
    assert route_b_out["email"] == EMAIL_MASK
    assert route_a_out["email"] != route_b_out["email"]

    route_a_level = read_classification_level(route_a_out)
    route_b_level = read_classification_level(route_b_out)
    assert route_a_level in ("INTERNAL", "CONFIDENTIAL")
    assert route_b_level in ("INTERNAL", "CONFIDENTIAL")
    assert route_a_level != "RESTRICTED"
    assert route_b_level != "RESTRICTED"

    route_c_result = captured[route_c]
    assert route_c_result.classification_result is not None
    assert route_c_result.classification_result.effective_level == "RESTRICTED"
    assert route_c_result.classification_result.override_applied is True
    assert route_c_result.policy_result is not None
    assert route_c_result.policy_result.decision == "block"
    assert route_c_result.delivery_result is not None
    assert route_c_result.delivery_result.delivery_disposition == "blocked"
    assert route_c_result.delivery_allowed is False

    assert captured[route_a].delivery_result.delivery_disposition == "delivered"
    assert captured[route_b].delivery_result.delivery_disposition == "delivered"
    assert int(summary.get("route_policy_block_count") or 0) >= 1
    assert int(summary.get("route_delivery_success_count") or 0) >= 2


def test_shared_change_applies_to_inherit_route_only(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    db = db_session
    fixture = _seed_one_stream_three_routes(db)
    stream_id = fixture["stream_id"]

    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    updated = dict(SHARED_MAPPINGS)
    updated["shared_tag"] = "$.severity"
    mapping.field_mappings_json = updated
    db.commit()

    _, webhook, _ = _run_once(db, stream_id, monkeypatch)
    by_url = _events_by_url(webhook)
    route_a_out = by_url["https://receiver-0.example.com/events"]
    route_b_out = by_url["https://receiver-1.example.com/events"]
    assert route_a_out["shared_tag"] == "high"
    assert "shared_tag" not in route_b_out
    assert route_b_out["normalized_message"] == "test"


def test_override_to_inherit_drops_stale_route_transform(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    db = db_session
    fixture = _seed_one_stream_three_routes(db)
    stream_id = fixture["stream_id"]
    route_b = fixture["route_b"]

    db.query(RouteMapping).filter(RouteMapping.route_id == route_b).delete()
    db.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_b).delete()
    db.commit()

    effective = _effective_snapshot(db, stream_id)
    assert effective[route_b]["transform_source"] == "stream"
    assert "normalized_message" not in effective[route_b]["transform_fields"]
    assert effective[route_b]["protection_source"] in ("stream", "empty")
    assert "$.email" not in effective[route_b]["protection_paths"]

    _, webhook, _ = _run_once(db, stream_id, monkeypatch)
    route_b_out = _events_by_url(webhook)["https://receiver-1.example.com/events"]
    assert route_b_out["message"] == "test"
    assert "normalized_message" not in route_b_out
    assert route_b_out["email"] == "alice@example.com"


def test_route_c_block_does_not_stop_other_routes_or_checkpoint(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    db = db_session
    fixture = _seed_one_stream_three_routes(db)
    stream_id = fixture["stream_id"]
    before = _checkpoint_value(db, stream_id)
    summary, webhook, captured = _run_once(db, stream_id, monkeypatch)

    assert len(webhook.calls) == 2
    assert captured[fixture["route_c"]].delivery_result.delivery_disposition == "blocked"
    assert captured[fixture["route_a"]].delivery_result.delivery_success is True
    assert captured[fixture["route_b"]].delivery_result.delivery_success is True
    assert _checkpoint_value(db, stream_id) != before
    assert summary.get("checkpoint_updated") is True


def _seed_create_wizard_protection_three_routes(db: Session) -> dict[str, Any]:
    """Create Wizard persist outcome: A inherit, B email mask, C api_key drop."""
    fixture = _seed_stream_runtime(
        db,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = int(fixture["stream_id"])
    route_a, route_b, route_c = (int(rid) for rid in fixture["route_ids"])

    mappings = dict(SHARED_MAPPINGS)
    mappings["api_key"] = "$.api_key"
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = mappings
    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).one()
    enrichment.enrichment_json = {}

    db.add(
        RouteProtectionRule(
            route_id=route_b,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="p0-6",
        )
    )
    db.add(
        RouteProtectionRule(
            route_id=route_c,
            field_path="$.api_key",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_DROP_FIELD,
            enabled=True,
            created_by="p0-6",
        )
    )
    db.commit()

    fixture["route_a"] = route_a
    fixture["route_b"] = route_b
    fixture["route_c"] = route_c
    return fixture


def test_create_wizard_route_protection_runtime_overrides(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    db = db_session
    fixture = _seed_create_wizard_protection_three_routes(db)
    stream_id = fixture["stream_id"]
    route_a = fixture["route_a"]
    route_b = fixture["route_b"]
    route_c = fixture["route_c"]

    rules_b = db.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_b).all()
    rules_a = db.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_a).all()
    rules_c = db.query(RouteProtectionRule).filter(RouteProtectionRule.route_id == route_c).all()
    assert rules_a == []
    assert [(r.field_path, r.protection_mode) for r in rules_b] == [("$.email", PROTECTION_MODE_FULL_MASK)]
    assert [(r.field_path, r.protection_mode) for r in rules_c] == [("$.api_key", PROTECTION_MODE_DROP_FIELD)]

    effective = _effective_snapshot(db, stream_id)
    assert effective[route_a]["protection_source"] in ("stream", "empty")
    assert "$.email" not in effective[route_a]["protection_paths"]
    assert effective[route_b]["protection_source"] == "route"
    assert "$.email" in effective[route_b]["protection_paths"]
    assert effective[route_c]["protection_source"] == "route"
    assert "$.api_key" in effective[route_c]["protection_paths"]

    summary, webhook, captured = _run_once(
        db,
        stream_id,
        monkeypatch,
        sample={**SAMPLE_EVENT, "api_key": "sk-live-example"},
    )
    assert summary["outcome"] == "completed"
    by_url = _events_by_url(webhook)
    route_a_out = by_url["https://receiver-0.example.com/events"]
    route_b_out = by_url["https://receiver-1.example.com/events"]
    route_c_out = by_url["https://receiver-2.example.com/events"]

    assert route_a_out["email"] == "alice@example.com"
    assert route_a_out["api_key"] == "sk-live-example"
    assert route_b_out["email"] == EMAIL_MASK
    assert route_b_out["api_key"] == "sk-live-example"
    assert route_c_out["email"] == "alice@example.com"
    assert "api_key" not in route_c_out

    assert captured[route_a].delivery_result.delivery_disposition == "delivered"
    assert captured[route_b].delivery_result.delivery_disposition == "delivered"
    assert captured[route_c].delivery_result.delivery_disposition == "delivered"
    src = inspect.getsource(route_stage)
    assert "route_protection_stage" in src

