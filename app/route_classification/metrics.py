"""Route classification metrics rollup (reuse RouteProcessingMetrics; no new pipeline)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

ClassificationOutcome = Literal["success", "failure", "skipped"]


@dataclass(frozen=True, slots=True)
class RouteClassificationMetricsResult:
    """Per-route classification stage outcome for metrics rollup and delivery_logs."""

    route_id: int
    stream_id: int
    outcome: ClassificationOutcome
    duration_ms: int = 0
    skip_reason: str | None = None
    classification_operations_applied: int = 0
    events_classified: int = 0
    persisted_source: str | None = None
    fallback_used: bool = False
    override_applied: bool = False
    error_message: str | None = None


def count_classification_operations(*, matched_rule_count: int = 0) -> int:
    """Count classification operations from the engine contract (not field/value labels)."""

    return max(0, int(matched_rule_count or 0))


def has_effective_classification(config: Any | None) -> bool:
    """True when resolved rules or a persistable classification floor are present."""

    if config is None:
        return False
    if bool(getattr(config, "empty", True)):
        return False
    rules = getattr(config, "rules", None) or ()
    override_levels = getattr(config, "override_levels", None) or ()
    return len(rules) > 0 or len(override_levels) > 0


def apply_classification_metrics(metrics: object, result: RouteClassificationMetricsResult) -> None:
    """Increment route_classification_* counters on RouteProcessingMetrics."""

    if result.outcome == "skipped":
        metrics.route_classification_skipped_count = (
            int(getattr(metrics, "route_classification_skipped_count", 0) or 0) + 1
        )
        return

    metrics.route_classification_attempt_count = int(
        getattr(metrics, "route_classification_attempt_count", 0) or 0
    ) + 1
    metrics.route_classification_duration_ms = int(
        getattr(metrics, "route_classification_duration_ms", 0) or 0
    ) + int(result.duration_ms or 0)
    metrics.route_classification_operations_applied = int(
        getattr(metrics, "route_classification_operations_applied", 0) or 0
    ) + int(result.classification_operations_applied or 0)

    if result.outcome == "success":
        metrics.route_classification_success_count = (
            int(getattr(metrics, "route_classification_success_count", 0) or 0) + 1
        )
        # Backward-compatible alias: successful classification applications this batch.
        metrics.route_classification_count = int(getattr(metrics, "route_classification_count", 0) or 0) + 1
        if result.override_applied:
            metrics.route_classification_override_count = (
                int(getattr(metrics, "route_classification_override_count", 0) or 0) + 1
            )
    elif result.outcome == "failure":
        metrics.route_classification_failure_count = (
            int(getattr(metrics, "route_classification_failure_count", 0) or 0) + 1
        )


def classification_result_log_fields(result: RouteClassificationMetricsResult) -> dict[str, Any]:
    """Structured fields for delivery_logs / obs (includes stream_id + route_id)."""

    return {
        "stage": "route_classification_metrics",
        "stream_id": result.stream_id,
        "route_id": result.route_id,
        "outcome": result.outcome,
        "skip_reason": result.skip_reason,
        "duration_ms": result.duration_ms,
        "classification_operations_applied": result.classification_operations_applied,
        "events_classified": result.events_classified,
        "persisted_source": result.persisted_source,
        "fallback_used": result.fallback_used,
        "override_applied": result.override_applied,
        "error_message": result.error_message,
        "route_classification_attempt": 0 if result.outcome == "skipped" else 1,
        "route_classification_success": 1 if result.outcome == "success" else 0,
        "route_classification_failure": 1 if result.outcome == "failure" else 0,
    }
