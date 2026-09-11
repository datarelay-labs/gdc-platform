"""Route transform metrics rollup (reuse RouteProcessingMetrics; no new pipeline)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from app.mappers.full_event_mapping import (
    extract_basic_jsonpath_mappings,
    is_full_event_mapping,
)

TransformOutcome = Literal["success", "failure", "skipped"]

_ENRICHMENT_RESERVED = frozenset({"__rules", "__computed", "__preview", "__enrichment_meta"})


@dataclass(frozen=True, slots=True)
class RouteTransformResult:
    """Per-route transform stage outcome for metrics rollup and delivery_logs."""

    route_id: int
    stream_id: int
    outcome: TransformOutcome
    duration_ms: int = 0
    skip_reason: str | None = None
    mapping_operations_applied: int = 0
    enrichment_operations_applied: int = 0
    reused: bool = False
    mapping_source: str | None = None
    enrichment_source: str | None = None
    fallback_used: bool = False
    error_message: str | None = None


def count_mapping_operations(field_mappings: dict[str, Any] | None) -> int:
    """Count mapping operations without promoting field paths to metric labels."""

    fm = field_mappings if isinstance(field_mappings, dict) else {}
    if is_full_event_mapping(fm):
        mode = str(fm.get("mapping_mode") or "").strip().lower()
        if mode == "full_event_regex":
            rules = fm.get("regex_rules")
            return len(rules) if isinstance(rules, list) else 0
        # full_event_jsonata: one expression counts as one operation when present
        expr = fm.get("jsonata_expression")
        return 1 if isinstance(expr, str) and expr.strip() else 0
    return len(extract_basic_jsonpath_mappings(fm))


def count_enrichment_operations(enrichment: dict[str, Any] | None) -> int:
    """Count enrichment static fields + advanced rules (not field-path labels)."""

    if not isinstance(enrichment, dict) or not enrichment:
        return 0
    static = sum(1 for key in enrichment if key not in _ENRICHMENT_RESERVED and not str(key).startswith("_"))
    raw_rules = enrichment.get("__rules")
    rule_count = len(raw_rules) if isinstance(raw_rules, list) else 0
    return static + rule_count


def has_effective_transform(config: Any | None) -> bool:
    """True when mapping or enrichment declares at least one operation."""

    if config is None:
        return False
    field_mappings = getattr(config, "field_mappings", None)
    enrichment = getattr(config, "enrichment", None)
    return count_mapping_operations(field_mappings) > 0 or count_enrichment_operations(enrichment) > 0


def apply_transform_metrics(metrics: object, result: RouteTransformResult) -> None:
    """Increment route_transform_* counters on RouteProcessingMetrics."""

    if result.outcome == "skipped":
        metrics.route_transform_skipped_count = (
            int(getattr(metrics, "route_transform_skipped_count", 0) or 0) + 1
        )
        return

    metrics.route_transform_attempt_count = int(getattr(metrics, "route_transform_attempt_count", 0) or 0) + 1
    metrics.route_transform_duration_ms = int(getattr(metrics, "route_transform_duration_ms", 0) or 0) + int(
        result.duration_ms or 0
    )
    metrics.route_mapping_operations_applied = int(
        getattr(metrics, "route_mapping_operations_applied", 0) or 0
    ) + int(result.mapping_operations_applied or 0)
    metrics.route_enrichment_operations_applied = int(
        getattr(metrics, "route_enrichment_operations_applied", 0) or 0
    ) + int(result.enrichment_operations_applied or 0)

    if result.outcome == "success":
        metrics.route_transform_success_count = (
            int(getattr(metrics, "route_transform_success_count", 0) or 0) + 1
        )
        # Backward-compatible alias: successful transform applications this batch.
        metrics.route_transform_count = int(getattr(metrics, "route_transform_count", 0) or 0) + 1
    elif result.outcome == "failure":
        metrics.route_transform_failure_count = (
            int(getattr(metrics, "route_transform_failure_count", 0) or 0) + 1
        )


def transform_result_log_fields(result: RouteTransformResult) -> dict[str, Any]:
    """Structured fields for delivery_logs / obs (includes stream_id + route_id)."""

    return {
        "stage": "route_transform_metrics",
        "stream_id": result.stream_id,
        "route_id": result.route_id,
        "outcome": result.outcome,
        "skip_reason": result.skip_reason,
        "duration_ms": result.duration_ms,
        "mapping_operations_applied": result.mapping_operations_applied,
        "enrichment_operations_applied": result.enrichment_operations_applied,
        "reused": result.reused,
        "mapping_source": result.mapping_source,
        "enrichment_source": result.enrichment_source,
        "fallback_used": result.fallback_used,
        "error_message": result.error_message,
        # Explicit counters for this route event (not high-cardinality labels).
        "route_transform_attempt": 0 if result.outcome == "skipped" else 1,
        "route_transform_success": 1 if result.outcome == "success" else 0,
        "route_transform_failure": 1 if result.outcome == "failure" else 0,
    }
