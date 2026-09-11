"""M13.1/M13.2/M13.3 — Route and shared batch runtime context contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.protection.engine import ProtectBatchResult
from app.route_protection.config import RouteProtectionConfig
from app.route_classification.config import RouteClassificationConfig, RouteClassificationResult
from app.route_classification.metrics import RouteClassificationMetricsResult
from app.route_policy.config import RoutePolicyConfig, RoutePolicyResult
from app.route_delivery.config import RouteDeliveryResult
from app.route_protection.metrics import RouteProtectionResult
from app.route_transform.metrics import RouteTransformResult


def dual_read(route_value: Any, stream_value: Any) -> Any:
    """Route configuration first; fall back to stream configuration."""

    if route_value is None:
        return stream_value
    if isinstance(route_value, (dict, list, str, bytes)) and not route_value:
        return stream_value
    return route_value


TransformSource = Literal["route", "stream"]


@dataclass(frozen=True, slots=True)
class RouteTransformConfig:
    """Effective mapping + enrichment bundle for one route execution."""

    field_mappings: dict[str, Any]
    enrichment: dict[str, Any]
    override_policy: str
    mapping_source: TransformSource
    enrichment_source: TransformSource

    @property
    def fallback_used(self) -> bool:
        return self.mapping_source == "stream" or self.enrichment_source == "stream"


@dataclass(slots=True)
class RouteEffectiveConfig:
    """Dual-read resolved configuration attached to RouteRuntimeContext."""

    transform: RouteTransformConfig | None = None
    protection: RouteProtectionConfig | None = None
    classification: RouteClassificationConfig | None = None
    policy: RoutePolicyConfig | None = None


@dataclass(slots=True)
class RouteProcessingState:
    """Mutable per-batch route processing state."""

    current_events: list[dict[str, Any]] = field(default_factory=list)
    stage_timeline: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)
    transform_result: RouteTransformResult | None = None
    protection_result: RouteProtectionResult | None = None
    classification_result: RouteClassificationResult | None = None
    classification_metrics: RouteClassificationMetricsResult | None = None
    policy_result: RoutePolicyResult | None = None


@dataclass(slots=True)
class RouteRuntimeContext:
    """Per-route processing context (spec 091 §7)."""

    route_id: int
    stream_id: int
    destination_id: int
    route_name: str
    route_type: str
    formatter: dict[str, Any]
    delivery_policy: str
    rate_limit: dict[str, Any]
    metadata: dict[str, Any]
    effective_config: RouteEffectiveConfig
    enabled: bool = True
    processing_state: RouteProcessingState = field(default_factory=RouteProcessingState)
    shared_batch_ref: SharedBatchContext | None = None
    processing_ready: bool = True
    readiness_reasons: list[str] = field(default_factory=list)


@dataclass(slots=True)
class SharedBatchContext:
    """Stream-scoped shared phase output consumed by route processing (spec 091 §8)."""

    stream_id: int
    batch_id: str
    event_root: str | None
    union_schema: list[Any]
    extracted_events: list[dict[str, Any]]
    schema_observation: dict[str, Any]
    sensitive_detection_result: Any
    checkpoint_cursor_before: dict[str, Any] | None
    shared_runtime_data: dict[str, Any]
    fetch_metadata: dict[str, Any] | None = None
    schema_drift_policy_result: Any = None
    # Batch-local reuse of identical mapping+enrichment results across routes.
    # Lifetime is this SharedBatchContext only (never cross-run / cross-stream).
    transform_result_cache: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    transform_execution_count: int = 0
    # Batch-local reuse of identical protect_batch results across routes that share
    # the same transform input + effective protection config. Cached events are
    # canonical copies; each route must receive a route-local deep copy.
    protection_result_cache: dict[str, ProtectBatchResult] = field(default_factory=dict)
    protection_execution_count: int = 0

    @property
    def ephemeral_auto_protect_rules(self) -> list[Any]:
        drift = self.schema_drift_policy_result
        if drift is None:
            return []
        rules = getattr(drift, "ephemeral_protection_rules", None)
        return list(rules) if rules else []

    @property
    def events(self) -> list[dict[str, Any]]:
        """Backward-compatible alias for pre-M13.2 callers."""

        return self.extracted_events

    @property
    def observed_schema(self) -> dict[str, Any]:
        observed = self.schema_observation.get("observed_schema")
        return dict(observed) if isinstance(observed, dict) else {}


@dataclass(frozen=True, slots=True)
class RouteProcessingMetrics:
    """Route loop observability."""

    route_count: int
    route_context_build_time_ms: int
    route_transform_count: int = 0
    route_transform_duration_ms: int = 0
    route_transform_fallback_count: int = 0
    route_transform_attempt_count: int = 0
    route_transform_success_count: int = 0
    route_transform_failure_count: int = 0
    route_transform_skipped_count: int = 0
    route_mapping_operations_applied: int = 0
    route_enrichment_operations_applied: int = 0
    route_protection_count: int = 0
    route_protection_duration_ms: int = 0
    route_protection_attempt_count: int = 0
    route_protection_success_count: int = 0
    route_protection_failure_count: int = 0
    route_protection_skipped_count: int = 0
    route_protection_operations_applied: int = 0
    route_auto_protect_count: int = 0
    route_classification_count: int = 0
    route_classification_duration_ms: int = 0
    route_classification_override_count: int = 0
    route_classification_attempt_count: int = 0
    route_classification_success_count: int = 0
    route_classification_failure_count: int = 0
    route_classification_skipped_count: int = 0
    route_classification_operations_applied: int = 0
    route_policy_count: int = 0
    route_policy_duration_ms: int = 0
    route_policy_allow_count: int = 0
    route_policy_audit_count: int = 0
    route_policy_block_count: int = 0
    route_policy_review_count: int = 0
    route_policy_quarantine_count: int = 0
    route_delivery_attempt_count: int = 0
    route_delivery_success_count: int = 0
    route_delivery_failure_count: int = 0
    route_delivery_blocked_count: int = 0
    route_delivery_review_count: int = 0
    route_delivery_quarantine_count: int = 0
    route_delivery_duration_ms: int = 0


@dataclass(slots=True)
class RouteStageResult:
    """Result of a single route pipeline invocation."""

    route_id: int
    events: list[dict[str, Any]] = field(default_factory=list)
    # Post-transform / pre-protection processing state. Stream checkpoint must
    # persist this source state, never a route's protected delivery copy.
    checkpoint_source_events: list[dict[str, Any]] = field(default_factory=list)
    modified: bool = False
    stage_timeline: list[dict[str, Any]] = field(default_factory=list)
    transform_result: RouteTransformResult | None = None
    transform_duration_ms: int = 0
    protection_result: RouteProtectionResult | None = None
    protection_duration_ms: int = 0
    auto_protect_count: int = 0
    classification_result: RouteClassificationResult | None = None
    classification_metrics: RouteClassificationMetricsResult | None = None
    classification_duration_ms: int = 0
    policy_result: RoutePolicyResult | None = None
    policy_duration_ms: int = 0
    delivery_allowed: bool = True
    delivery_result: RouteDeliveryResult | None = None
    delivery_duration_ms: int = 0


@dataclass(slots=True)
class RoutePipelineResult:
    """Aggregate output from the per-route pipeline loop."""

    stage_results: list[RouteStageResult]
    metrics: RouteProcessingMetrics
    checkpoint_reference_events: list[dict[str, Any]] = field(default_factory=list)
