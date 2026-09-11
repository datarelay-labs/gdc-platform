"""Route protection metrics rollup (reuse RouteProcessingMetrics; no new pipeline)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

ProtectionOutcome = Literal["success", "failure", "skipped"]


@dataclass(frozen=True, slots=True)
class RouteProtectionResult:
    """Per-route protection stage outcome for metrics rollup and delivery_logs."""

    route_id: int
    stream_id: int
    outcome: ProtectionOutcome
    duration_ms: int = 0
    skip_reason: str | None = None
    protection_operations_applied: int = 0
    reused: bool = False
    persisted_source: str | None = None
    fallback_used: bool = False
    error_message: str | None = None


def count_protection_operations(*, rules_applied: int | None = None, rule_count: int | None = None) -> int:
    """Count protection operations without promoting field paths to metric labels."""

    if rules_applied is not None:
        return max(0, int(rules_applied or 0))
    return max(0, int(rule_count or 0))


def has_effective_protection(config: Any | None, *, rules_applied: int = 0) -> bool:
    """True when resolved rules or engine-applied rules declare at least one operation."""

    if int(rules_applied or 0) > 0:
        return True
    if config is None:
        return False
    rules = getattr(config, "rules", None) or ()
    return len(rules) > 0


def apply_protection_metrics(metrics: object, result: RouteProtectionResult) -> None:
    """Increment route_protection_* counters on RouteProcessingMetrics."""

    if result.outcome == "skipped":
        metrics.route_protection_skipped_count = (
            int(getattr(metrics, "route_protection_skipped_count", 0) or 0) + 1
        )
        return

    metrics.route_protection_attempt_count = int(getattr(metrics, "route_protection_attempt_count", 0) or 0) + 1
    metrics.route_protection_duration_ms = int(getattr(metrics, "route_protection_duration_ms", 0) or 0) + int(
        result.duration_ms or 0
    )
    metrics.route_protection_operations_applied = int(
        getattr(metrics, "route_protection_operations_applied", 0) or 0
    ) + int(result.protection_operations_applied or 0)

    if result.outcome == "success":
        metrics.route_protection_success_count = (
            int(getattr(metrics, "route_protection_success_count", 0) or 0) + 1
        )
        # Backward-compatible alias: successful protection applications this batch.
        metrics.route_protection_count = int(getattr(metrics, "route_protection_count", 0) or 0) + 1
    elif result.outcome == "failure":
        metrics.route_protection_failure_count = (
            int(getattr(metrics, "route_protection_failure_count", 0) or 0) + 1
        )


def protection_result_log_fields(result: RouteProtectionResult) -> dict[str, Any]:
    """Structured fields for delivery_logs / obs (includes stream_id + route_id)."""

    return {
        "stage": "route_protection_metrics",
        "stream_id": result.stream_id,
        "route_id": result.route_id,
        "outcome": result.outcome,
        "skip_reason": result.skip_reason,
        "duration_ms": result.duration_ms,
        "protection_operations_applied": result.protection_operations_applied,
        "reused": result.reused,
        "persisted_source": result.persisted_source,
        "fallback_used": result.fallback_used,
        "error_message": result.error_message,
        "route_protection_attempt": 0 if result.outcome == "skipped" else 1,
        "route_protection_success": 1 if result.outcome == "success" else 0,
        "route_protection_failure": 1 if result.outcome == "failure" else 0,
    }
