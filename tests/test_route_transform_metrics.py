"""P2 Route Transform metrics — attempt/success/failure/ops/latency isolation."""

from __future__ import annotations

from typing import Any

import pytest

from app.runners.route_context import (
    RouteEffectiveConfig,
    RouteRuntimeContext,
    RouteTransformConfig,
    SharedBatchContext,
)
from app.runners.route_stage import process_route_pipeline, process_routes
from app.route_transform.metrics import (
    apply_transform_metrics,
    count_enrichment_operations,
    count_mapping_operations,
    has_effective_transform,
)
from app.runtime.errors import MappingError
from types import SimpleNamespace


def _shared(events: list[dict[str, Any]] | None = None) -> SharedBatchContext:
    return SharedBatchContext(
        stream_id=10,
        batch_id="batch-metrics",
        event_root=None,
        union_schema=[],
        extracted_events=list(events or [{"message": "hello", "vendor": "acme"}]),
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={},
    )


def _transform(
    *,
    field_mappings: dict[str, Any] | None = None,
    enrichment: dict[str, Any] | None = None,
    mapping_source: str = "stream",
    enrichment_source: str = "stream",
) -> RouteTransformConfig:
    return RouteTransformConfig(
        field_mappings=dict(field_mappings if field_mappings is not None else {"message": "$.message"}),
        enrichment=dict(enrichment if enrichment is not None else {"product": "GDC"}),
        override_policy="KEEP_EXISTING",
        mapping_source=mapping_source,  # type: ignore[arg-type]
        enrichment_source=enrichment_source,  # type: ignore[arg-type]
    )


def _route(
    route_id: int,
    transform: RouteTransformConfig | None,
    *,
    stream_id: int = 10,
) -> RouteRuntimeContext:
    return RouteRuntimeContext(
        route_id=route_id,
        stream_id=stream_id,
        destination_id=100 + route_id,
        route_name=f"route-{route_id}",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata={},
        effective_config=RouteEffectiveConfig(transform=transform),
        enabled=True,
    )


def test_count_operations_no_field_path_labels() -> None:
    assert count_mapping_operations({"a": "$.a", "b": "$.b", "mapping_mode": "x"}) == 2
    assert count_enrichment_operations({"product": "GDC", "__rules": [{"type": "static"}]}) == 2
    assert has_effective_transform(_transform(field_mappings={}, enrichment={})) is False
    assert has_effective_transform(_transform()) is True


def test_scenario_a_inherit_attempt_success() -> None:
    """Shared / inherited transform: attempt=1 success=1 failure=0."""

    logs: list[dict[str, Any]] = []
    inherited = _transform(mapping_source="stream", enrichment_source="stream")
    pipeline = process_routes([_route(1, inherited)], _shared(), log_fn=logs.append)
    m = pipeline.metrics
    assert m.route_transform_attempt_count == 1
    assert m.route_transform_success_count == 1
    assert m.route_transform_failure_count == 0
    assert m.route_transform_skipped_count == 0
    assert m.route_transform_count == 1
    assert m.route_mapping_operations_applied == 1
    assert m.route_enrichment_operations_applied == 1
    assert m.route_transform_duration_ms >= 0
    metric_logs = [e for e in logs if e.get("stage") == "route_transform_metrics"]
    assert len(metric_logs) == 1
    assert metric_logs[0]["route_id"] == 1
    assert metric_logs[0]["stream_id"] == 10
    assert metric_logs[0]["outcome"] == "success"


def test_scenario_b_override_metrics_only_for_route() -> None:
    override = _transform(
        field_mappings={"only_message": "$.message", "vendor": "$.vendor"},
        enrichment={"route_tag": "route-2"},
        mapping_source="route",
        enrichment_source="route",
    )
    pipeline = process_routes([_route(2, override)], _shared())
    m = pipeline.metrics
    assert m.route_transform_attempt_count == 1
    assert m.route_transform_success_count == 1
    assert m.route_mapping_operations_applied == 2
    assert m.route_enrichment_operations_applied == 1
    tr = pipeline.stage_results[0].transform_result
    assert tr is not None
    assert tr.mapping_source == "route"
    assert tr.route_id == 2


def test_scenario_c_no_effective_transform_skipped_not_fake_success() -> None:
    empty = _transform(field_mappings={}, enrichment={})
    none_cfg = None
    pipeline = process_routes(
        [_route(3, empty), _route(4, none_cfg)],
        _shared(),
    )
    m = pipeline.metrics
    assert m.route_transform_attempt_count == 0
    assert m.route_transform_success_count == 0
    assert m.route_transform_failure_count == 0
    assert m.route_transform_skipped_count == 2
    assert m.route_transform_count == 0
    outcomes = [r.transform_result.outcome for r in pipeline.stage_results if r.transform_result]
    assert outcomes == ["skipped", "skipped"]


def test_scenario_d_failure_increments_failure_not_success() -> None:
    bad = _transform(field_mappings={"x": "$.[invalid"})
    good = _transform()
    logs: list[dict[str, Any]] = []
    # Route A succeeds first; Route B fails — MappingError still raised (semantics unchanged).
    with pytest.raises(MappingError):
        process_routes([_route(1, good), _route(2, bad)], _shared(), log_fn=logs.append)

    by_route = {
        e["route_id"]: e
        for e in logs
        if e.get("stage") == "route_transform_metrics"
    }
    assert by_route[1]["outcome"] == "success"
    assert by_route[1]["route_transform_success"] == 1
    assert by_route[1]["route_transform_failure"] == 0
    assert by_route[2]["outcome"] == "failure"
    assert by_route[2]["route_transform_success"] == 0
    assert by_route[2]["route_transform_failure"] == 1
    # Failure is transform-stage, not delivery.
    assert all(e.get("stage") != "delivery_disposition" or e.get("delivery_success") is not False for e in logs)


def test_scenario_e_multi_route_isolation() -> None:
    inherit = _transform(mapping_source="stream", enrichment_source="stream")
    override = _transform(
        field_mappings={"only_message": "$.message"},
        enrichment={"route_tag": "B"},
        mapping_source="route",
        enrichment_source="route",
    )
    empty = _transform(field_mappings={}, enrichment={})
    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [_route(1, inherit), _route(2, override), _route(3, empty)],
        _shared(),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_transform_attempt_count == 2
    assert m.route_transform_success_count == 2
    assert m.route_transform_failure_count == 0
    assert m.route_transform_skipped_count == 1
    # Override route contributes 1 mapping + 1 enrichment; inherit contributes 1+1.
    assert m.route_mapping_operations_applied == 2  # message + only_message
    assert m.route_enrichment_operations_applied == 2  # product + route_tag

    metric_logs = [e for e in logs if e.get("stage") == "route_transform_metrics"]
    assert {e["route_id"] for e in metric_logs} == {1, 2, 3}
    by_id = {e["route_id"]: e for e in metric_logs}
    assert by_id[1]["outcome"] == "success"
    assert by_id[2]["outcome"] == "success"
    assert by_id[2]["mapping_operations_applied"] == 1
    assert by_id[3]["outcome"] == "skipped"
    assert by_id[3]["route_transform_success"] == 0


def test_transform_failure_not_recorded_as_delivery_failure() -> None:
    bad = _transform(field_mappings={"x": "$.[invalid"})
    result_holder: dict[str, Any] = {}

    def capture(route_ctx: RouteRuntimeContext, shared: SharedBatchContext, **kwargs: Any):
        try:
            return process_route_pipeline(route_ctx, shared, **kwargs)
        except MappingError:
            result_holder["transform"] = route_ctx.processing_state.transform_result
            raise

    with pytest.raises(MappingError):
        capture(_route(9, bad), _shared())
    tr = result_holder["transform"]
    assert tr is not None
    assert tr.outcome == "failure"
    rollup = SimpleNamespace(
        route_transform_count=0,
        route_transform_duration_ms=0,
        route_transform_attempt_count=0,
        route_transform_success_count=0,
        route_transform_failure_count=0,
        route_transform_skipped_count=0,
        route_mapping_operations_applied=0,
        route_enrichment_operations_applied=0,
    )
    apply_transform_metrics(rollup, tr)
    assert rollup.route_transform_attempt_count == 1
    assert rollup.route_transform_failure_count == 1
    assert rollup.route_transform_success_count == 0
    assert rollup.route_transform_count == 0


def test_latency_is_transform_stage_not_full_pipeline() -> None:
    result = process_route_pipeline(_route(1, _transform()), _shared())
    assert result.transform_result is not None
    assert result.transform_duration_ms == result.transform_result.duration_ms
    # transform_timing entry must match transform-stage duration, not protection+delivery.
    timing = [e for e in result.stage_timeline if e.get("stage") == "transform_timing"]
    assert timing and timing[0]["duration_ms"] == result.transform_duration_ms
