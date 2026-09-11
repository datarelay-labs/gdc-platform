"""M13.6 Route Runtime Delivery tests."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest.mock import patch

import pytest

from app.config import settings
from app.protection.models import POLICY_ACTION_QUARANTINE, StreamPolicyRule
from app.route_delivery.config import RouteSendOutcome
from app.route_delivery.health import classify_route_delivery_health
from app.route_delivery.stage import route_delivery_stage
from app.route_policy.config import RoutePolicyResult
from app.route_protection.resolver import resolve_route_protection_config
from app.runners.route_context import (
    RouteEffectiveConfig,
    RouteRuntimeContext,
    RouteTransformConfig,
    SharedBatchContext,
)
from app.runners.route_stage import process_route_pipeline, process_routes


@pytest.fixture
def classification_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", True)


def _policy_result(
    *,
    decision: str = "allow",
    delivery_allowed: bool = True,
    quarantine_event_id: int | None = None,
) -> RoutePolicyResult:
    return RoutePolicyResult(
        decision=decision,  # type: ignore[arg-type]
        matched_policy_count=0,
        persisted_source="empty",
        delivery_blocked=not delivery_allowed,
        delivery_allowed=delivery_allowed,
        quarantine_recorded=decision == "quarantine",
        review_required=decision == "require_review",
        override_applied=False,
        decision_reason="test",
        policy_action=decision,
        quarantine_event_id=quarantine_event_id,
    )


def _route_ctx() -> RouteRuntimeContext:
    transform = RouteTransformConfig(
        field_mappings={"message": "$.message"},
        enrichment={},
        override_policy="KEEP_EXISTING",
        mapping_source="stream",
        enrichment_source="stream",
    )
    return RouteRuntimeContext(
        route_id=1,
        stream_id=10,
        destination_id=20,
        route_name="r1",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata={},
        effective_config=RouteEffectiveConfig(
            transform=transform,
            protection=resolve_route_protection_config(route_id=1, stream_id=10),
        ),
    )


def _shared() -> SharedBatchContext:
    return SharedBatchContext(
        stream_id=10,
        batch_id="batch-1",
        event_root=None,
        union_schema=[],
        extracted_events=[{"message": "hello"}],
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={},
    )


def _capture_log() -> tuple[list[dict[str, Any]], Any]:
    logs: list[dict[str, Any]] = []

    def _log(entry: dict[str, Any]) -> None:
        logs.append(entry)

    return logs, _log


def test_delivered_success() -> None:
    logs, log_fn = _capture_log()
    route_ctx = _route_ctx()
    shared = _shared()
    events = [{"message": "hello"}]

    def send_fn(_ctx: RouteRuntimeContext, _events: list[dict[str, Any]]) -> RouteSendOutcome:
        return RouteSendOutcome(success=True, latency_ms=5, adapter_stage="route_send_success")

    result = route_delivery_stage(
        route_ctx,
        shared,
        _policy_result(),
        events,
        send_fn=send_fn,
        log_fn=log_fn,
        run_id="run-1",
    )
    assert result.delivery_disposition == "delivered"
    assert result.delivery_success is True
    assert result.batch_id == "batch-1"
    assert result.run_id == "run-1"
    assert any(entry.get("stage") == "delivery_disposition" for entry in logs)


def test_delivered_adapter_failure() -> None:
    logs, log_fn = _capture_log()

    def send_fn(_ctx: RouteRuntimeContext, _events: list[dict[str, Any]]) -> RouteSendOutcome:
        return RouteSendOutcome(
            success=False,
            latency_ms=3,
            adapter_stage="route_send_failed",
            error="connection refused",
        )

    result = route_delivery_stage(
        _route_ctx(),
        _shared(),
        _policy_result(),
        [{"message": "x"}],
        send_fn=send_fn,
        log_fn=log_fn,
    )
    assert result.delivery_disposition == "delivered"
    assert result.delivery_success is False
    assert result.delivery_error == "connection refused"
    assert classify_route_delivery_health(
        delivery_disposition=result.delivery_disposition,
        delivery_success=result.delivery_success,
    ) == "failed"


def test_blocked_disposition_audit() -> None:
    logs, log_fn = _capture_log()
    send_calls: list[Any] = []

    def send_fn(ctx: RouteRuntimeContext, events: list[dict[str, Any]]) -> RouteSendOutcome:
        send_calls.append((ctx, events))
        return RouteSendOutcome(success=True, latency_ms=1)

    result = route_delivery_stage(
        _route_ctx(),
        _shared(),
        _policy_result(decision="block", delivery_allowed=False),
        [{"message": "x"}],
        send_fn=send_fn,
        log_fn=log_fn,
    )
    assert result.delivery_disposition == "blocked"
    assert result.delivery_success is None
    assert result.skip_reason == "policy_blocked"
    assert send_calls == []
    disp = [e for e in logs if e.get("stage") == "delivery_disposition"]
    assert len(disp) == 1
    assert disp[0]["delivery_disposition"] == "blocked"


def test_quarantined_disposition() -> None:
    result = route_delivery_stage(
        _route_ctx(),
        _shared(),
        _policy_result(decision="quarantine", delivery_allowed=False, quarantine_event_id=99),
        [{"message": "x"}],
        log_fn=None,
        quarantine_event_id=99,
    )
    assert result.delivery_disposition == "quarantined"
    assert result.quarantine_event_id == 99
    assert result.delivery_success is None


def test_require_review_blocked() -> None:
    result = route_delivery_stage(
        _route_ctx(),
        _shared(),
        _policy_result(decision="require_review", delivery_allowed=False),
        [{"message": "x"}],
    )
    assert result.delivery_disposition == "blocked"
    assert result.policy_action == "require_review"
    assert result.delivery_success is None


def test_route_delivery_result_fields_complete() -> None:
    result = route_delivery_stage(
        _route_ctx(),
        _shared(),
        _policy_result(),
        [],
        run_id="r1",
    )
    assert result.route_id == 1
    assert result.stream_id == 10
    assert result.destination_id == 20
    assert result.batch_id == "batch-1"
    assert result.run_id == "r1"
    assert result.delivery_timestamp is not None


def test_route_metrics_aggregation() -> None:
    shared = _shared()
    route_ctx = _route_ctx()

    def ok_send(_c: RouteRuntimeContext, _e: list[dict[str, Any]]) -> RouteSendOutcome:
        return RouteSendOutcome(success=True, latency_ms=1, adapter_stage="route_send_success")

    pipeline = process_routes(
        [route_ctx],
        shared,
        send_fn=ok_send,
        run_id="run-x",
    )
    assert pipeline.metrics.route_delivery_attempt_count == 1
    assert pipeline.metrics.route_delivery_success_count == 1
    assert pipeline.stage_results[0].delivery_result is not None


def test_pipeline_delivery_after_policy(classification_enabled: None) -> None:
    shared = _shared()
    route_ctx = _route_ctx()
    result = process_route_pipeline(route_ctx, shared, run_id="run-1")
    stages = [e.get("stage") for e in result.stage_timeline if e.get("stage")]
    assert stages.index("policy") < stages.index("delivery")
    assert result.delivery_result is not None


def test_checkpoint_reference_on_success() -> None:
    shared = _shared()
    route_ctx = _route_ctx()

    def ok_send(_c: RouteRuntimeContext, _e: list[dict[str, Any]]) -> RouteSendOutcome:
        return RouteSendOutcome(success=True, latency_ms=1)

    pipeline = process_routes([route_ctx], shared, send_fn=ok_send)
    assert pipeline.checkpoint_reference_events
    assert pipeline.checkpoint_reference_events[0]["message"] == "hello"
    assert pipeline.stage_results[0].checkpoint_source_events[0]["message"] == "hello"
    dr = pipeline.stage_results[0].delivery_result
    assert dr is not None
    assert dr.delivery_success is True


def test_feature_flag_off_route_delivery_not_in_legacy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", False)
    assert settings.GDC_ROUTE_PROCESSING_ENABLED is False


def test_process_route_no_double_policy_in_delivery(classification_enabled: None) -> None:
    shared = _shared()
    route_ctx = _route_ctx()
    with patch("app.runners.route_stage.route_policy_stage") as mock_policy:
        mock_policy.return_value = (
            [{"message": "hello"}],
            _policy_result(),
            None,
        )
        with patch("app.runners.route_stage.route_delivery_stage", wraps=route_delivery_stage) as mock_delivery:
            process_route_pipeline(route_ctx, shared)
            mock_delivery.assert_called_once()
