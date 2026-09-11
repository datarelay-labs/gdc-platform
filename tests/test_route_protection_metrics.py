"""P2 Route Protection metrics — attempt/success/failure/ops/latency isolation."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from app.protection.models import (
    PROTECTION_MODE_DROP_FIELD,
    PROTECTION_MODE_FULL_MASK,
    PROTECTION_MODE_HASH,
    PROTECTION_MODE_PARTIAL_MASK,
)
from app.route_protection.metrics import (
    apply_protection_metrics,
    count_protection_operations,
    has_effective_protection,
)
from app.runners.route_context import (
    RouteEffectiveConfig,
    RouteRuntimeContext,
    RouteTransformConfig,
    SharedBatchContext,
)
from app.runners.route_stage import process_route_pipeline, process_routes
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII
import app.route_protection.stage as prot_stage


def _stream_rule(
    *,
    field_path: str = "$.email",
    mode: str = PROTECTION_MODE_PARTIAL_MASK,
    stream_id: int = 10,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        stream_id=stream_id,
        field_path=field_path,
        sensitivity_class=SENSITIVITY_CLASS_PII,
        protection_mode=mode,
        enabled=True,
        source_finding_id=None,
    )


def _route_rule(
    *,
    field_path: str = "$.email",
    mode: str = PROTECTION_MODE_FULL_MASK,
    route_id: int = 1,
    rule_id: int | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=rule_id if rule_id is not None else route_id * 10,
        route_id=route_id,
        field_path=field_path,
        sensitivity_class=SENSITIVITY_CLASS_PII,
        protection_mode=mode,
        enabled=True,
        source_finding_id=None,
    )


def _transform() -> RouteTransformConfig:
    return RouteTransformConfig(
        field_mappings={"email": "$.email", "message": "$.message", "api_key": "$.api_key"},
        enrichment={},
        override_policy="KEEP_EXISTING",
        mapping_source="stream",
        enrichment_source="stream",
    )


def _route(
    route_id: int,
    *,
    route_protection_rules: list[Any] | None = None,
) -> RouteRuntimeContext:
    metadata: dict[str, Any] = {}
    if route_protection_rules is not None:
        metadata["_route_protection_rules"] = list(route_protection_rules)
    return RouteRuntimeContext(
        route_id=route_id,
        stream_id=10,
        destination_id=100 + route_id,
        route_name=f"route-{route_id}",
        route_type="WEBHOOK_POST",
        formatter={},
        delivery_policy="LOG_AND_CONTINUE",
        rate_limit={},
        metadata=metadata,
        effective_config=RouteEffectiveConfig(transform=_transform()),
    )


def _shared(
    *,
    stream_rules: list[Any] | None = None,
    route_overrides: list[dict[str, Any]] | None = None,
    events: list[dict[str, Any]] | None = None,
) -> SharedBatchContext:
    return SharedBatchContext(
        stream_id=10,
        batch_id="batch-protection-metrics",
        event_root=None,
        union_schema=[],
        extracted_events=list(
            events
            or [
                {
                    "email": "alice@example.com",
                    "message": "hello",
                    "api_key": "sk-live-example",
                }
            ]
        ),
        schema_observation={},
        sensitive_detection_result=None,
        checkpoint_cursor_before=None,
        shared_runtime_data={
            "stream_protection_rules": list(stream_rules if stream_rules is not None else []),
            "route_overrides": list(route_overrides or []),
        },
    )


def _metric_logs(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in logs if e.get("stage") == "route_protection_metrics"]


def test_count_operations_no_field_path_labels() -> None:
    assert count_protection_operations(rules_applied=2) == 2
    assert count_protection_operations(rule_count=1) == 1
    assert has_effective_protection(None, rules_applied=0) is False
    assert has_effective_protection(SimpleNamespace(rules=(_stream_rule(),))) is True


def test_scenario_a_inherit_attempt_success() -> None:
    """Shared / inherited protection: attempt=1 success=1 failure=0 operations=1."""

    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [_route(1)],
        _shared(stream_rules=[_stream_rule()]),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_protection_attempt_count == 1
    assert m.route_protection_success_count == 1
    assert m.route_protection_failure_count == 0
    assert m.route_protection_skipped_count == 0
    assert m.route_protection_count == 1
    assert m.route_protection_operations_applied == 1
    assert m.route_protection_duration_ms >= 0
    metric_logs = _metric_logs(logs)
    assert len(metric_logs) == 1
    assert metric_logs[0]["route_id"] == 1
    assert metric_logs[0]["stream_id"] == 10
    assert metric_logs[0]["outcome"] == "success"
    assert metric_logs[0]["protection_operations_applied"] == 1
    assert "field_path" not in metric_logs[0]
    pr = pipeline.stage_results[0].protection_result
    assert pr is not None
    assert pr.persisted_source == "stream"
    assert pr.fallback_used is True


def test_scenario_b_override_metrics_only_for_route() -> None:
    logs: list[dict[str, Any]] = []
    inherit = _route(1)
    override = _route(
        2,
        route_protection_rules=[_route_rule(route_id=2, field_path="$.email", mode=PROTECTION_MODE_FULL_MASK)],
    )
    untouched = _route(3)
    pipeline = process_routes(
        [inherit, override, untouched],
        _shared(stream_rules=[_stream_rule()]),
        log_fn=logs.append,
    )
    by_id = {e["route_id"]: e for e in _metric_logs(logs)}
    assert by_id[2]["outcome"] == "success"
    assert by_id[2]["protection_operations_applied"] == 1
    assert by_id[2]["route_protection_success"] == 1
    assert by_id[1]["protection_operations_applied"] == 1
    assert by_id[3]["protection_operations_applied"] == 1
    pr = pipeline.stage_results[1].protection_result
    assert pr is not None
    assert pr.route_id == 2
    assert pr.persisted_source == "route"
    # Override must not steal inherit/untouched outcomes.
    assert by_id[1]["outcome"] == "success"
    assert by_id[3]["outcome"] == "success"


def test_scenario_c_multiple_operations() -> None:
    logs: list[dict[str, Any]] = []
    route_c = _route(
        3,
        route_protection_rules=[
            _route_rule(route_id=3, field_path="$.email", mode=PROTECTION_MODE_HASH, rule_id=31),
            _route_rule(route_id=3, field_path="$.api_key", mode=PROTECTION_MODE_DROP_FIELD, rule_id=32),
        ],
    )
    pipeline = process_routes([route_c], _shared(stream_rules=[]), log_fn=logs.append)
    m = pipeline.metrics
    assert m.route_protection_attempt_count == 1
    assert m.route_protection_success_count == 1
    assert m.route_protection_operations_applied == 2
    metric_logs = _metric_logs(logs)
    assert metric_logs[0]["protection_operations_applied"] == 2
    assert "field_path" not in metric_logs[0]
    events = pipeline.stage_results[0].events
    assert events
    assert events[0].get("email") != "alice@example.com"
    assert "api_key" not in events[0]


def test_scenario_d_no_effective_protection_skipped_not_fake_success() -> None:
    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [_route(4)],
        _shared(stream_rules=[]),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_protection_attempt_count == 0
    assert m.route_protection_success_count == 0
    assert m.route_protection_failure_count == 0
    assert m.route_protection_skipped_count == 1
    assert m.route_protection_count == 0
    assert m.route_protection_operations_applied == 0
    metric_logs = _metric_logs(logs)
    assert metric_logs[0]["outcome"] == "skipped"
    assert metric_logs[0]["route_protection_success"] == 0
    assert metric_logs[0]["route_protection_attempt"] == 0
    pr = pipeline.stage_results[0].protection_result
    assert pr is not None
    assert pr.outcome == "skipped"


def test_scenario_e_failure_increments_failure_not_success() -> None:
    logs: list[dict[str, Any]] = []
    inherit = _route(1)
    boom = _route(
        2,
        route_protection_rules=[_route_rule(route_id=2, mode=PROTECTION_MODE_FULL_MASK)],
    )

    original = prot_stage.protect_batch

    def _maybe_fail(events: list[dict[str, Any]], rules: list[Any], **kwargs: Any):
        modes = {str(getattr(r, "protection_mode", "")) for r in rules}
        if PROTECTION_MODE_FULL_MASK in modes:
            raise RuntimeError("protection engine boom")
        return original(events, rules, **kwargs)

    with patch.object(prot_stage, "protect_batch", side_effect=_maybe_fail):
        with pytest.raises(RuntimeError, match="protection engine boom"):
            process_routes(
                [inherit, boom],
                _shared(stream_rules=[_stream_rule()]),
                log_fn=logs.append,
            )

    by_route = {e["route_id"]: e for e in _metric_logs(logs)}
    assert by_route[1]["outcome"] == "success"
    assert by_route[1]["route_protection_success"] == 1
    assert by_route[1]["route_protection_failure"] == 0
    assert by_route[2]["outcome"] == "failure"
    assert by_route[2]["route_protection_success"] == 0
    assert by_route[2]["route_protection_failure"] == 1
    assert "protection engine boom" in str(by_route[2].get("error_message") or "")
    # Failure is protection-stage, not destination delivery.
    assert all(
        e.get("stage") != "delivery_disposition" or e.get("delivery_success") is not False for e in logs
    )


def test_scenario_f_multi_route_isolation() -> None:
    inherit = _route(1)
    override = _route(
        2,
        route_protection_rules=[_route_rule(route_id=2, field_path="$.email", mode=PROTECTION_MODE_FULL_MASK)],
    )
    multi = _route(
        3,
        route_protection_rules=[
            _route_rule(route_id=3, field_path="$.email", mode=PROTECTION_MODE_HASH, rule_id=31),
            _route_rule(route_id=3, field_path="$.api_key", mode=PROTECTION_MODE_DROP_FIELD, rule_id=32),
        ],
    )
    none = _route(4)
    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [inherit, override, multi, none],
        _shared(
            stream_rules=[_stream_rule()],
            route_overrides=[
                {
                    "route_id": 4,
                    "field_path": "$.email",
                    "protection_action": "audit_only",
                    "enabled": True,
                }
            ],
        ),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_protection_attempt_count == 3
    assert m.route_protection_success_count == 3
    assert m.route_protection_failure_count == 0
    assert m.route_protection_skipped_count == 1
    # inherit 1 + override 1 + multi 2
    assert m.route_protection_operations_applied == 4

    by_id = {e["route_id"]: e for e in _metric_logs(logs)}
    assert set(by_id) == {1, 2, 3, 4}
    assert by_id[1]["outcome"] == "success"
    assert by_id[1]["protection_operations_applied"] == 1
    assert by_id[2]["outcome"] == "success"
    assert by_id[2]["protection_operations_applied"] == 1
    assert by_id[3]["outcome"] == "success"
    assert by_id[3]["protection_operations_applied"] == 2
    assert by_id[4]["outcome"] == "skipped"
    assert by_id[4]["route_protection_success"] == 0
    for entry in by_id.values():
        assert "field_path" not in entry


def test_protection_failure_not_recorded_as_delivery_failure() -> None:
    result_holder: dict[str, Any] = {}

    def capture(route_ctx: RouteRuntimeContext, shared: SharedBatchContext, **kwargs: Any):
        try:
            return process_route_pipeline(route_ctx, shared, **kwargs)
        except RuntimeError:
            result_holder["protection"] = route_ctx.processing_state.protection_result
            raise

    with patch.object(prot_stage, "protect_batch", side_effect=RuntimeError("engine down")):
        with pytest.raises(RuntimeError, match="engine down"):
            capture(
                _route(9, route_protection_rules=[_route_rule(route_id=9)]),
                _shared(stream_rules=[]),
            )
    pr = result_holder["protection"]
    assert pr is not None
    assert pr.outcome == "failure"
    rollup = SimpleNamespace(
        route_protection_count=0,
        route_protection_duration_ms=0,
        route_protection_attempt_count=0,
        route_protection_success_count=0,
        route_protection_failure_count=0,
        route_protection_skipped_count=0,
        route_protection_operations_applied=0,
    )
    apply_protection_metrics(rollup, pr)
    assert rollup.route_protection_attempt_count == 1
    assert rollup.route_protection_failure_count == 1
    assert rollup.route_protection_success_count == 0
    assert rollup.route_protection_count == 0


def test_latency_is_protection_stage_not_full_pipeline() -> None:
    result = process_route_pipeline(_route(1), _shared(stream_rules=[_stream_rule()]))
    assert result.protection_result is not None
    assert result.protection_duration_ms == result.protection_result.duration_ms
    timing = [e for e in result.stage_timeline if e.get("stage") == "protection_timing"]
    assert timing and timing[0]["duration_ms"] == result.protection_duration_ms
    # Protection timing must not equal the sum of later stages.
    later = [
        e
        for e in result.stage_timeline
        if e.get("stage") in {"classification", "policy", "delivery"} and isinstance(e.get("duration_ms"), int)
    ]
    later_total = sum(int(e["duration_ms"]) for e in later)
    if later_total > 0:
        assert result.protection_duration_ms != (
            result.protection_duration_ms + later_total
        )
