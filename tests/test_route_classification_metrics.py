"""P2 Route Classification metrics — attempt/success/failure/ops/latency isolation."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from app.classification.field_keys import read_classification_level
from app.classification.models import StreamClassificationRule
from app.config import settings
from app.route_classification.metrics import (
    apply_classification_metrics,
    count_classification_operations,
    has_effective_classification,
)
from app.route_classification.models import RouteClassificationRule
from app.runners.route_context import (
    RouteEffectiveConfig,
    RouteRuntimeContext,
    RouteTransformConfig,
    SharedBatchContext,
)
from app.runners.route_stage import process_route_pipeline, process_routes
from app.runners.stream_loader import load_stream_context
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII, SENSITIVITY_CLASS_SECRET
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)
import app.route_classification.stage as cls_stage


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


def _transform() -> RouteTransformConfig:
    return RouteTransformConfig(
        field_mappings={"message": "$.message"},
        enrichment={},
        override_policy="KEEP_EXISTING",
        mapping_source="stream",
        enrichment_source="stream",
    )


def _route(
    route_id: int,
    *,
    route_classification_rules: list[Any] | None = None,
) -> RouteRuntimeContext:
    metadata: dict[str, Any] = {
        "_route_protection_rules": [],
        "_route_classification_rules": list(route_classification_rules or []),
    }
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
    findings: list[dict[str, Any]] | None = None,
) -> SharedBatchContext:
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
        batch_id="batch-classification-metrics",
        event_root=None,
        union_schema=[],
        extracted_events=[{"message": "hello"}],
        schema_observation={},
        sensitive_detection_result=detection_ctx,
        checkpoint_cursor_before=None,
        shared_runtime_data={
            "stream_protection_rules": [],
            "stream_classification_rules": list(stream_rules if stream_rules is not None else []),
            "route_overrides": list(route_overrides or []),
        },
    )


def _pii_findings() -> list[dict[str, Any]]:
    return [{"sensitivity_class": SENSITIVITY_CLASS_PII}]


def _metric_logs(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in logs if e.get("stage") == "route_classification_metrics"]


@pytest.fixture
def classification_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", True)


def test_count_operations_no_field_path_labels() -> None:
    assert count_classification_operations(matched_rule_count=2) == 2
    assert count_classification_operations(matched_rule_count=0) == 0
    assert has_effective_classification(None) is False
    assert has_effective_classification(SimpleNamespace(empty=True, rules=(), override_levels=())) is False
    assert has_effective_classification(
        SimpleNamespace(empty=False, rules=(_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL"),), override_levels=())
    ) is True


def test_scenario_a_inherit_attempt_success(classification_enabled: None) -> None:
    """Shared / inherited classification: attempt=1 success=1 failure=0 operations=actual."""

    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [_route(1)],
        _shared(
            stream_rules=[_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
            findings=_pii_findings(),
        ),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_classification_attempt_count == 1
    assert m.route_classification_success_count == 1
    assert m.route_classification_failure_count == 0
    assert m.route_classification_skipped_count == 0
    assert m.route_classification_count == 1
    assert m.route_classification_operations_applied == 1
    assert m.route_classification_duration_ms >= 0
    metric_logs = _metric_logs(logs)
    assert len(metric_logs) == 1
    assert metric_logs[0]["route_id"] == 1
    assert metric_logs[0]["stream_id"] == 10
    assert metric_logs[0]["outcome"] == "success"
    assert metric_logs[0]["classification_operations_applied"] == 1
    assert metric_logs[0]["events_classified"] == 1
    assert "field_path" not in metric_logs[0]
    assert "classification_level" not in metric_logs[0] or metric_logs[0].get("classification_level") in {
        None,
        "PUBLIC",
        "INTERNAL",
        "CONFIDENTIAL",
        "RESTRICTED",
    }
    cr = pipeline.stage_results[0].classification_result
    assert cr is not None
    assert cr.effective_level == "CONFIDENTIAL"
    assert cr.persisted_source == "stream"
    cm = pipeline.stage_results[0].classification_metrics
    assert cm is not None
    assert cm.outcome == "success"
    assert cm.fallback_used is True
    assert read_classification_level(pipeline.stage_results[0].events[0]) == "CONFIDENTIAL"


def test_scenario_b_override_metrics_only_for_route(classification_enabled: None) -> None:
    logs: list[dict[str, Any]] = []
    inherit = _route(1)
    override = _route(2)
    untouched = _route(3)
    pipeline = process_routes(
        [inherit, override, untouched],
        _shared(
            stream_rules=[_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
            findings=_pii_findings(),
            route_overrides=[{"route_id": 2, "enabled": True, "classification_level": "RESTRICTED"}],
        ),
        log_fn=logs.append,
    )
    by_id = {e["route_id"]: e for e in _metric_logs(logs)}
    assert by_id[2]["outcome"] == "success"
    assert by_id[2]["override_applied"] is True
    assert by_id[2]["route_classification_success"] == 1
    assert by_id[1]["override_applied"] is False
    assert by_id[3]["override_applied"] is False
    assert by_id[1]["outcome"] == "success"
    assert by_id[3]["outcome"] == "success"
    results = {r.route_id: r for r in pipeline.stage_results}
    assert results[2].classification_result is not None
    assert results[2].classification_result.effective_level == "RESTRICTED"
    assert results[2].classification_result.override_applied is True
    assert results[1].classification_result is not None
    assert results[1].classification_result.effective_level == "CONFIDENTIAL"
    assert results[3].classification_result is not None
    assert results[3].classification_result.effective_level == "CONFIDENTIAL"
    assert pipeline.metrics.route_classification_override_count == 1
    assert read_classification_level(results[1].events[0]) == "CONFIDENTIAL"
    assert read_classification_level(results[2].events[0]) == "RESTRICTED"
    assert read_classification_level(results[3].events[0]) == "CONFIDENTIAL"


def test_scenario_b_route_rule_replace_stream(classification_enabled: None) -> None:
    logs: list[dict[str, Any]] = []
    inherit = _route(1)
    override = _route(
        2,
        route_classification_rules=[
            _route_rule(2, "route-secret", SENSITIVITY_CLASS_SECRET, "RESTRICTED"),
        ],
    )
    pipeline = process_routes(
        [inherit, override],
        _shared(
            stream_rules=[_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
            findings=_pii_findings() + [{"sensitivity_class": SENSITIVITY_CLASS_SECRET}],
        ),
        log_fn=logs.append,
    )
    by_id = {e["route_id"]: e for e in _metric_logs(logs)}
    assert by_id[1]["outcome"] == "success"
    assert by_id[2]["outcome"] == "success"
    results = {r.route_id: r for r in pipeline.stage_results}
    assert results[1].classification_result is not None
    assert results[1].classification_result.effective_level == "CONFIDENTIAL"
    assert results[1].classification_result.persisted_source == "stream"
    assert results[2].classification_result is not None
    assert results[2].classification_result.effective_level == "RESTRICTED"
    assert results[2].classification_result.persisted_source == "route"


def test_scenario_c_no_effective_classification_skipped_not_fake_success(
    classification_enabled: None,
) -> None:
    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [_route(4)],
        _shared(stream_rules=[], findings=_pii_findings()),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_classification_attempt_count == 0
    assert m.route_classification_success_count == 0
    assert m.route_classification_failure_count == 0
    assert m.route_classification_skipped_count == 1
    assert m.route_classification_count == 0
    assert m.route_classification_operations_applied == 0
    metric_logs = _metric_logs(logs)
    assert metric_logs[0]["outcome"] == "skipped"
    assert metric_logs[0]["route_classification_success"] == 0
    assert metric_logs[0]["route_classification_attempt"] == 0
    cm = pipeline.stage_results[0].classification_metrics
    assert cm is not None
    assert cm.outcome == "skipped"
    # Runtime stamp is preserved (engine still ran); metrics must not call it success.
    assert pipeline.stage_results[0].classification_result is not None


def test_scenario_d_failure_increments_failure_not_success(classification_enabled: None) -> None:
    logs: list[dict[str, Any]] = []
    inherit = _route(1)
    boom = _route(
        2,
        route_classification_rules=[_route_rule(2, "boom", SENSITIVITY_CLASS_PII, "RESTRICTED")],
    )

    original = cls_stage.classify_batch

    def _maybe_fail(events: list[dict[str, Any]], **kwargs: Any):
        rules = kwargs.get("rules") or []
        names = {str(getattr(r, "name", "")) for r in rules}
        if "boom" in names:
            raise RuntimeError("classification engine boom")
        return original(events, **kwargs)

    with patch.object(cls_stage, "classify_batch", side_effect=_maybe_fail):
        with pytest.raises(RuntimeError, match="classification engine boom"):
            process_routes(
                [inherit, boom],
                _shared(
                    stream_rules=[_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
                    findings=_pii_findings(),
                ),
                log_fn=logs.append,
            )

    by_route = {e["route_id"]: e for e in _metric_logs(logs)}
    assert by_route[1]["outcome"] == "success"
    assert by_route[1]["route_classification_success"] == 1
    assert by_route[1]["route_classification_failure"] == 0
    assert by_route[2]["outcome"] == "failure"
    assert by_route[2]["route_classification_success"] == 0
    assert by_route[2]["route_classification_failure"] == 1
    assert "classification engine boom" in str(by_route[2].get("error_message") or "")
    assert all(e.get("stage") != "delivery_disposition" or e.get("delivery_success") is not False for e in logs)
    assert all(e.get("stage") not in {"policy_blocked", "policy_quarantine"} or e.get("route_id") != 2 for e in logs)


def test_scenario_e_multi_route_isolation(classification_enabled: None) -> None:
    inherit = _route(1)
    override = _route(2)
    none = _route(4)
    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [inherit, override, none],
        _shared(
            stream_rules=[_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
            findings=_pii_findings(),
            route_overrides=[{"route_id": 2, "enabled": True, "classification_level": "RESTRICTED"}],
        ),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    # none still inherits stream rules — skip requires empty effective config (scenario C).
    assert m.route_classification_attempt_count == 3
    assert m.route_classification_success_count == 3
    assert m.route_classification_failure_count == 0
    assert m.route_classification_skipped_count == 0
    assert m.route_classification_override_count == 1
    by_id = {e["route_id"]: e for e in _metric_logs(logs)}
    assert set(by_id) == {1, 2, 4}
    assert by_id[1]["outcome"] == "success"
    assert by_id[1]["override_applied"] is False
    assert by_id[2]["outcome"] == "success"
    assert by_id[2]["override_applied"] is True
    assert by_id[4]["outcome"] == "success"
    assert by_id[4]["override_applied"] is False
    for entry in by_id.values():
        assert "field_path" not in entry
        assert "sensitive_value" not in entry


def test_scenario_e_multi_route_skip_and_override_without_shared_rules(
    classification_enabled: None,
) -> None:
    """On a stream with no shared rules: A route-rules, B floor, C skip."""

    route_a = _route(
        1,
        route_classification_rules=[_route_rule(1, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
    )
    route_b = _route(2)
    route_c = _route(3)
    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [route_a, route_b, route_c],
        _shared(
            stream_rules=[],
            findings=_pii_findings(),
            route_overrides=[{"route_id": 2, "enabled": True, "classification_level": "RESTRICTED"}],
        ),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_classification_attempt_count == 2
    assert m.route_classification_success_count == 2
    assert m.route_classification_failure_count == 0
    assert m.route_classification_skipped_count == 1
    by_id = {e["route_id"]: e for e in _metric_logs(logs)}
    assert by_id[1]["outcome"] == "success"
    assert by_id[2]["outcome"] == "success"
    assert by_id[2]["override_applied"] is True
    assert by_id[3]["outcome"] == "skipped"
    assert by_id[3]["route_classification_success"] == 0
    results = {r.route_id: r for r in pipeline.stage_results}
    assert read_classification_level(results[1].events[0]) == "CONFIDENTIAL"
    assert read_classification_level(results[2].events[0]) == "RESTRICTED"


def test_classification_failure_not_recorded_as_delivery_or_policy_failure(
    classification_enabled: None,
) -> None:
    result_holder: dict[str, Any] = {}

    def capture(route_ctx: RouteRuntimeContext, shared: SharedBatchContext, **kwargs: Any):
        try:
            return process_route_pipeline(route_ctx, shared, **kwargs)
        except RuntimeError:
            result_holder["classification"] = route_ctx.processing_state.classification_metrics
            raise

    with patch.object(cls_stage, "classify_batch", side_effect=RuntimeError("engine down")):
        with pytest.raises(RuntimeError, match="engine down"):
            capture(
                _route(
                    9,
                    route_classification_rules=[_route_rule(9, "boom", SENSITIVITY_CLASS_PII, "RESTRICTED")],
                ),
                _shared(
                    stream_rules=[],
                    findings=_pii_findings(),
                ),
            )
    cm = result_holder["classification"]
    assert cm is not None
    assert cm.outcome == "failure"
    rollup = SimpleNamespace(
        route_classification_count=0,
        route_classification_duration_ms=0,
        route_classification_override_count=0,
        route_classification_attempt_count=0,
        route_classification_success_count=0,
        route_classification_failure_count=0,
        route_classification_skipped_count=0,
        route_classification_operations_applied=0,
    )
    apply_classification_metrics(rollup, cm)
    assert rollup.route_classification_attempt_count == 1
    assert rollup.route_classification_failure_count == 1
    assert rollup.route_classification_success_count == 0
    assert rollup.route_classification_count == 0


def test_latency_is_classification_stage_not_full_pipeline(classification_enabled: None) -> None:
    result = process_route_pipeline(
        _route(1),
        _shared(
            stream_rules=[_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
            findings=_pii_findings(),
        ),
    )
    assert result.classification_metrics is not None
    assert result.classification_duration_ms == result.classification_metrics.duration_ms
    timing = [e for e in result.stage_timeline if e.get("stage") == "classification_timing"]
    assert timing and timing[0]["duration_ms"] == result.classification_duration_ms
    later = [
        e
        for e in result.stage_timeline
        if e.get("stage") in {"policy", "delivery"} and isinstance(e.get("duration_ms"), int)
    ]
    later_total = sum(int(e["duration_ms"]) for e in later)
    if later_total > 0:
        assert result.classification_duration_ms != (result.classification_duration_ms + later_total)
    if result.classification_result is not None:
        assert result.classification_duration_ms == result.classification_result.duration_ms


def test_disabled_flag_skipped_not_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", False)
    logs: list[dict[str, Any]] = []
    pipeline = process_routes(
        [_route(1)],
        _shared(
            stream_rules=[_stream_rule(10, "pii", SENSITIVITY_CLASS_PII, "CONFIDENTIAL")],
            findings=_pii_findings(),
        ),
        log_fn=logs.append,
    )
    m = pipeline.metrics
    assert m.route_classification_attempt_count == 0
    assert m.route_classification_success_count == 0
    assert m.route_classification_skipped_count == 1
    assert pipeline.stage_results[0].classification_result is None
    assert _metric_logs(logs)[0]["skip_reason"] == "disabled"


def test_stream_runner_inherit_classification_metrics(
    db_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    classification_enabled: None,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    db.add(
        StreamClassificationRule(
            stream_id=stream_id,
            name="pii",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
            classification_level="CONFIDENTIAL",
        )
    )
    db.commit()
    ctx = load_stream_context(db, stream_id)
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "e1", "message": "hello", "vendor": "acme"}]}),
        webhook_sender=_FakeWebhookSender(),
    )
    summary = runner.run(ctx, db=db)
    assert summary.get("route_classification_attempt_count") == 1
    assert summary.get("route_classification_success_count") == 1
    assert summary.get("route_classification_failure_count") == 0
    assert summary.get("route_classification_skipped_count") == 0
    assert summary.get("route_classification_count") == 1
    assert summary.get("route_classification_duration_ms") is not None
