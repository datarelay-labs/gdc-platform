"""M13.2 Per Route Transform tests."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.route_transform.models import RouteEnrichment, RouteMapping
from app.routes.models import Route
from app.runners.route_context import SharedBatchContext
from app.runners.route_context_builder import build_route_runtime_contexts, build_shared_batch_context
from app.runners.route_stage import process_route_pipeline, process_routes
from app.runners.route_transform_config import resolve_route_transform_config
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)


def _route_ctx_fields(**overrides: Any) -> dict[str, Any]:
    from app.runners.route_context import RouteEffectiveConfig, RouteRuntimeContext, RouteTransformConfig

    transform = RouteTransformConfig(
        field_mappings={"message": "$.message"},
        enrichment={},
        override_policy="KEEP_EXISTING",
        mapping_source="stream",
        enrichment_source="stream",
    )
    base = {
        "route_id": 1,
        "stream_id": 10,
        "destination_id": 20,
        "route_name": "webhook",
        "route_type": "WEBHOOK_POST",
        "formatter": {},
        "delivery_policy": "LOG_AND_CONTINUE",
        "rate_limit": {},
        "metadata": {},
        "effective_config": RouteEffectiveConfig(transform=transform),
    }
    base.update(overrides)
    return base


def test_shared_batch_context_spec_fields() -> None:
    ctx = build_shared_batch_context(
        stream_id=1,
        batch_id="batch-1",
        runtime_stream={"event_root_path": "$.event", "stream_config": {"union_schema": [{"path": "id"}]}},
        extracted_events=[{"id": "1"}],
        schema_observation={"observed_schema": {"fields": ["id"]}},
        sensitive_detection_result={"findings": []},
        checkpoint_cursor_before={"type": "NONE"},
        shared_runtime_data={"extracted_event_count": 1},
    )
    assert ctx.stream_id == 1
    assert ctx.batch_id == "batch-1"
    assert ctx.event_root == "$.event"
    assert ctx.extracted_events == [{"id": "1"}]
    assert ctx.events == ctx.extracted_events
    assert ctx.schema_observation["observed_schema"] == {"fields": ["id"]}
    assert ctx.sensitive_detection_result == {"findings": []}
    assert ctx.checkpoint_cursor_before == {"type": "NONE"}


def test_resolve_route_transform_config_dual_read_matrix() -> None:
    stream_mapping = {"field_mappings_json": {"a": "$.a"}}
    stream_enrichment = {"enrichment_json": {"x": "1"}, "override_policy": "KEEP_EXISTING"}

    both_absent = resolve_route_transform_config(
        route_mapping=None,
        route_enrichment=None,
        stream_mapping=stream_mapping,
        stream_enrichment=stream_enrichment,
        stream_field_mappings={"a": "$.a"},
        stream_enrichment_json={"x": "1"},
    )
    assert both_absent.mapping_source == "stream"
    assert both_absent.enrichment_source == "stream"
    assert both_absent.field_mappings == {"a": "$.a"}

    route_only_mapping = resolve_route_transform_config(
        route_mapping={"field_mappings_json": {"route_field": "$.route"}},
        route_enrichment=None,
        stream_mapping=stream_mapping,
        stream_enrichment=stream_enrichment,
        stream_field_mappings={"a": "$.a"},
        stream_enrichment_json={"x": "1"},
    )
    assert route_only_mapping.mapping_source == "route"
    assert route_only_mapping.enrichment_source == "stream"
    assert route_only_mapping.field_mappings == {"route_field": "$.route"}
    assert route_only_mapping.enrichment == {"x": "1"}

    route_only_enrichment = resolve_route_transform_config(
        route_mapping=None,
        route_enrichment={"enrichment_json": {"route_tag": "r1"}},
        stream_mapping=stream_mapping,
        stream_enrichment=stream_enrichment,
        stream_field_mappings={"a": "$.a"},
        stream_enrichment_json={"x": "1"},
    )
    assert route_only_enrichment.mapping_source == "stream"
    assert route_only_enrichment.enrichment_source == "route"
    assert route_only_enrichment.enrichment == {"route_tag": "r1"}


def test_process_route_pipeline_transform_and_stubs() -> None:
    from app.runners.route_context import RouteRuntimeContext

    shared = SharedBatchContext(
        stream_id=10,
        batch_id="b1",
        event_root="$.event",
        union_schema=[],
        extracted_events=[{"message": "hello", "vendor": "acme"}],
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={"stream_protection_rules": [], "route_overrides": []},
    )
    route_ctx = RouteRuntimeContext(**_route_ctx_fields())
    result = process_route_pipeline(route_ctx, shared)
    assert result.modified is True
    assert result.events[0]["message"] == "hello"
    assert any(entry.get("stage") == "protection" for entry in result.stage_timeline)
    assert any(entry.get("stage") in ("classification", "classification_stub") for entry in result.stage_timeline)
    assert any(entry.get("stage") == "policy" for entry in result.stage_timeline)


def test_route_payload_isolation() -> None:
    from app.runners.route_context import RouteEffectiveConfig, RouteRuntimeContext, RouteTransformConfig

    shared = SharedBatchContext(
        stream_id=10,
        batch_id="b1",
        event_root=None,
        union_schema=[],
        extracted_events=[{"message": "raw", "vendor": "acme"}],
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={},
    )
    route_a = RouteRuntimeContext(
        **_route_ctx_fields(
            route_id=1,
            effective_config=RouteEffectiveConfig(
                transform=RouteTransformConfig(
                    field_mappings={"message": "$.message", "vendor_tag": "$.vendor"},
                    enrichment={},
                    override_policy="KEEP_EXISTING",
                    mapping_source="route",
                    enrichment_source="stream",
                )
            ),
        )
    )
    route_b = RouteRuntimeContext(
        **_route_ctx_fields(
            route_id=2,
            effective_config=RouteEffectiveConfig(
                transform=RouteTransformConfig(
                    field_mappings={"only_message": "$.message"},
                    enrichment={},
                    override_policy="KEEP_EXISTING",
                    mapping_source="route",
                    enrichment_source="stream",
                )
            ),
        )
    )
    result_a = process_route_pipeline(route_a, shared)
    result_b = process_route_pipeline(route_b, shared)
    assert "vendor_tag" in result_a.events[0]
    assert "vendor_tag" not in result_b.events[0]
    assert "only_message" in result_b.events[0]


def test_fanout_uses_route_payloads(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    route_mapping = RouteMapping(route_id=route_id, field_mappings_json={"mapped_only": "$.message"})
    db.add(route_mapping)
    db.commit()
    ctx = load_stream_context(db, stream_id)
    contexts, _ = build_route_runtime_contexts(ctx.stream)
    assert contexts[0].effective_config.transform is not None
    assert contexts[0].effective_config.transform.mapping_source == "route"

    payload = {"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}
    webhook = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook)

    captured_payloads: dict[int, list[dict[str, Any]]] = {}

    original_deliver = runner._deliver_single_route

    def _capture_deliver(stream: Any, route_ctx: Any, events: list[dict[str, Any]]) -> Any:
        captured_payloads[int(route_ctx.route_id)] = [dict(e) for e in events]
        return original_deliver(stream, route_ctx, events)

    runner._deliver_single_route = _capture_deliver  # type: ignore[method-assign]
    summary = runner.run(ctx, db=db)

    assert summary["outcome"] == "completed"
    assert captured_payloads
    route_event = captured_payloads[route_id][0]
    assert "mapped_only" in route_event
    assert route_event["mapped_only"] == "hello"
    assert "event_id" not in route_event


def test_feature_flag_off_parity(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    ctx = load_stream_context(db, stream_id)
    payload = {"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}

    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    webhook_off = _FakeWebhookSender()
    runner_off = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook_off)
    runner_off.run(ctx, db=db)

    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    webhook_on = _FakeWebhookSender()
    runner_on = _build_runner(poller=_FakePoller(response=payload), webhook_sender=webhook_on)
    runner_on.run(ctx, db=db)

    off_event = webhook_off.calls[0]["events"][0]
    on_event = webhook_on.calls[0]["events"][0]
    for key in ("event_id", "message", "vendor", "product"):
        assert off_event.get(key) == on_event.get(key)


def test_flag_on_skips_stream_protection(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    ctx = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )

    with patch.object(runner, "_prepare_delivery_events", wraps=runner._prepare_delivery_events) as protection_mock:
        with patch.object(runner, "_evaluate_policies", wraps=runner._evaluate_policies) as policy_mock:
            runner.run(ctx, db=db)
            protection_mock.assert_not_called()
            policy_mock.assert_not_called()


def test_route_transform_metrics_emitted(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    ctx = load_stream_context(db, fixture["stream_id"])
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(ctx, db=db)
    assert summary.get("route_transform_count") == 1
    assert summary.get("route_transform_duration_ms") is not None
    assert summary.get("route_transform_fallback_count") == 1
    assert summary.get("route_transform_attempt_count") == 1
    assert summary.get("route_transform_success_count") == 1
    assert summary.get("route_transform_failure_count") == 0
    assert summary.get("route_mapping_operations_applied", 0) >= 1
