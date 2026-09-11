"""M13.2/M13.3 — Route processing pipeline (transform + protection active)."""

from __future__ import annotations

import time
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

from sqlalchemy.orm import Session

from app.enrichers.enrichment_engine import apply_enrichments_batch
from app.mappers.mapper import apply_mappings_with_results
from app.classification.engine import classification_enabled
from app.route_protection.stage import route_protection_stage
from app.route_protection.metrics import (
    RouteProtectionResult,
    apply_protection_metrics,
    count_protection_operations,
    has_effective_protection,
    protection_result_log_fields,
)
from app.route_classification.metrics import (
    RouteClassificationMetricsResult,
    apply_classification_metrics,
    classification_result_log_fields,
)
from app.route_classification.stage import route_classification_stage
from app.route_policy.stage import route_policy_stage
from app.route_delivery.stage import route_delivery_stage
from app.route_delivery.config import RouteSendOutcome
from app.route_transform.metrics import (
    RouteTransformResult,
    apply_transform_metrics,
    count_enrichment_operations,
    count_mapping_operations,
    has_effective_transform,
    transform_result_log_fields,
)
from app.runners.route_context import (
    RoutePipelineResult,
    RouteProcessingMetrics,
    RouteRuntimeContext,
    RouteStageResult,
    RouteTransformConfig,
    SharedBatchContext,
)
from app.runners.route_transform_config import transform_config_cache_key
from app.runners.stream_dedup import propagate_dedup_metadata
from app.runtime.copy_utils import copy_events
from app.runtime.errors import EnrichmentError, MappingError


LogFn = Callable[[dict[str, Any]], None]


def _copy_transport_metadata(raw_events: list[dict[str, Any]], transformed: list[dict[str, Any]]) -> None:
    if len(raw_events) != len(transformed):
        return
    s3_meta_keys = ("s3_bucket", "s3_key", "s3_last_modified", "s3_etag", "s3_size")
    db_meta_keys = ("gdc_db_watermark", "gdc_db_order_value")
    remote_meta_keys = (
        "remote_path",
        "remote_mtime",
        "remote_size",
        "gdc_remote_path",
        "gdc_remote_mtime",
        "gdc_remote_size",
        "gdc_remote_offset",
        "gdc_remote_hash",
        "gdc_remote_protocol",
        "gdc_remote_host",
    )
    for idx, enriched in enumerate(transformed):
        raw_ev = raw_events[idx]
        if not isinstance(raw_ev, dict) or not isinstance(enriched, dict):
            continue
        for mk in s3_meta_keys + db_meta_keys + remote_meta_keys:
            if mk in raw_ev and mk not in enriched:
                enriched[mk] = raw_ev[mk]
        # Preserve stream dedup registry keys through route transform so
        # last_n_hours / checkpoint_window scopes work after route-on delivery.
        propagate_dedup_metadata(raw_ev, enriched)


def _apply_route_transform(
    *,
    stream_id: int,
    route_id: int,
    raw_events: list[dict[str, Any]],
    transform_config: RouteTransformConfig,
    log_fn: LogFn | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Run existing mapping + enrichment engines for one route."""

    timeline: list[dict[str, Any]] = [{"stage": "transform", "status": "started"}]
    field_mappings = transform_config.field_mappings
    mapping_results = apply_mappings_with_results(raw_events, field_mappings)
    mapped_events: list[dict[str, Any]] = []
    for mapping_result in mapping_results:
        if mapping_result.event_error is not None:
            err = mapping_result.event_error
            if log_fn is not None:
                log_fn(
                    {
                        "stage": "mapping",
                        "stream_id": stream_id,
                        "route_id": route_id,
                        "message": err.error_message,
                        "error_code": err.error_code,
                        **err.to_delivery_log_fields(),
                    }
                )
            raise MappingError(err.error_message)
        mapped_events.append(mapping_result.mapped_event)
        for field_err in mapping_result.field_errors:
            if log_fn is not None:
                log_fn(
                    {
                        "stage": "mapping",
                        "stream_id": stream_id,
                        "route_id": route_id,
                        "message": field_err.error_message,
                        "status": "FIELD_TRANSFORM_WARNING",
                        **field_err.to_delivery_log_fields(),
                    }
                )

    batch_result = apply_enrichments_batch(
        mapped_events,
        transform_config.enrichment,
        override_policy=transform_config.override_policy,
    )
    enriched_events = batch_result.events
    _copy_transport_metadata(raw_events, enriched_events)
    for field_err in batch_result.field_errors:
        if log_fn is not None:
            log_fn(
                {
                    "stage": "enrichment",
                    "stream_id": stream_id,
                    "route_id": route_id,
                    "message": field_err.error_message,
                    "status": "FIELD_TRANSFORM_WARNING",
                    **field_err.to_delivery_log_fields(),
                }
            )

    timeline.append(
        {
            "stage": "transform",
            "status": "completed",
            "mapping_source": transform_config.mapping_source,
            "enrichment_source": transform_config.enrichment_source,
            "fallback_used": transform_config.fallback_used,
            "duration_ms": batch_result.duration_ms,
        }
    )
    return enriched_events, timeline


def _route_protection_rules_from_ctx(route_ctx: RouteRuntimeContext) -> list[Any]:
    raw = route_ctx.metadata.get("_route_protection_rules")
    return list(raw) if isinstance(raw, list) else []


def _route_classification_rules_from_ctx(route_ctx: RouteRuntimeContext) -> list[Any]:
    raw = route_ctx.metadata.get("_route_classification_rules")
    return list(raw) if isinstance(raw, list) else []


def _route_policy_rules_from_ctx(route_ctx: RouteRuntimeContext) -> list[Any]:
    raw = route_ctx.metadata.get("_route_policy_rules")
    return list(raw) if isinstance(raw, list) else []


def process_route_pipeline(
    route_ctx: RouteRuntimeContext,
    shared_batch: SharedBatchContext,
    *,
    log_fn: LogFn | None = None,
    db: Session | None = None,
    use_short_db: bool = False,
    send_fn: Callable[[RouteRuntimeContext, list[dict[str, Any]]], RouteSendOutcome] | None = None,
    run_id: str | None = None,
) -> RouteStageResult:
    """Execute per-route pipeline: Transform → Protection → Classification → Policy → Delivery."""

    route_ctx.shared_batch_ref = shared_batch
    timeline: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    current_events = list(shared_batch.extracted_events)
    route_ctx.processing_state.current_events = current_events

    transform_config = route_ctx.effective_config.transform
    modified = False
    transform_started = time.monotonic()
    transform_result: RouteTransformResult | None = None
    mapping_ops = count_mapping_operations(transform_config.field_mappings) if transform_config else 0
    enrichment_ops = count_enrichment_operations(transform_config.enrichment) if transform_config else 0

    if transform_config is None:
        timeline.append({"stage": "transform", "status": "skipped", "reason": "no_config"})
        transform_result = RouteTransformResult(
            route_id=route_ctx.route_id,
            stream_id=route_ctx.stream_id,
            outcome="skipped",
            skip_reason="no_config",
            duration_ms=0,
        )
    elif not has_effective_transform(transform_config):
        # Empty mapping+enrichment is identity: keep events as extracted (engine-equivalent).
        timeline.append(
            {
                "stage": "transform",
                "status": "skipped",
                "reason": "no_effective_transform",
            }
        )
        transform_result = RouteTransformResult(
            route_id=route_ctx.route_id,
            stream_id=route_ctx.stream_id,
            outcome="skipped",
            skip_reason="no_effective_transform",
            duration_ms=0,
            mapping_source=transform_config.mapping_source,
            enrichment_source=transform_config.enrichment_source,
            fallback_used=transform_config.fallback_used,
        )
    else:
        try:
            cache_key = transform_config_cache_key(transform_config)
            cached_events = shared_batch.transform_result_cache.get(cache_key)
            if cached_events is not None:
                # Reuse batch-local transformed events. Downstream protection always
                # copy_event_dict's before mutation, so routes stay isolated.
                current_events = list(cached_events)
                timeline.append({"stage": "transform", "status": "started"})
                timeline.append(
                    {
                        "stage": "transform",
                        "status": "completed",
                        "mapping_source": transform_config.mapping_source,
                        "enrichment_source": transform_config.enrichment_source,
                        "fallback_used": transform_config.fallback_used,
                        "reused": True,
                        "duration_ms": 0,
                        "mapping_operations_applied": mapping_ops,
                        "enrichment_operations_applied": enrichment_ops,
                    }
                )
                transform_duration_ms = 0
                reused = True
            else:
                current_events, transform_timeline = _apply_route_transform(
                    stream_id=route_ctx.stream_id,
                    route_id=route_ctx.route_id,
                    raw_events=shared_batch.extracted_events,
                    transform_config=transform_config,
                    log_fn=log_fn,
                )
                shared_batch.transform_result_cache[cache_key] = current_events
                shared_batch.transform_execution_count += 1
                timeline.extend(transform_timeline)
                transform_duration_ms = max(0, int((time.monotonic() - transform_started) * 1000))
                for entry in reversed(transform_timeline):
                    if entry.get("stage") == "transform" and entry.get("status") == "completed":
                        entry["mapping_operations_applied"] = mapping_ops
                        entry["enrichment_operations_applied"] = enrichment_ops
                        reported = entry.get("duration_ms")
                        if isinstance(reported, int) and reported >= 0:
                            transform_duration_ms = max(transform_duration_ms, reported)
                        break
                reused = False
            modified = True
            transform_result = RouteTransformResult(
                route_id=route_ctx.route_id,
                stream_id=route_ctx.stream_id,
                outcome="success",
                duration_ms=transform_duration_ms,
                mapping_operations_applied=mapping_ops,
                enrichment_operations_applied=enrichment_ops,
                reused=reused,
                mapping_source=transform_config.mapping_source,
                enrichment_source=transform_config.enrichment_source,
                fallback_used=transform_config.fallback_used,
            )
        except (MappingError, EnrichmentError) as err:
            transform_duration_ms = max(0, int((time.monotonic() - transform_started) * 1000))
            timeline.append(
                {
                    "stage": "transform",
                    "status": "failed",
                    "duration_ms": transform_duration_ms,
                    "error_message": str(err),
                    "mapping_operations_applied": mapping_ops,
                    "enrichment_operations_applied": enrichment_ops,
                }
            )
            transform_result = RouteTransformResult(
                route_id=route_ctx.route_id,
                stream_id=route_ctx.stream_id,
                outcome="failure",
                duration_ms=transform_duration_ms,
                mapping_operations_applied=mapping_ops,
                enrichment_operations_applied=enrichment_ops,
                mapping_source=transform_config.mapping_source,
                enrichment_source=transform_config.enrichment_source,
                fallback_used=transform_config.fallback_used,
                error_message=str(err),
            )
            route_ctx.processing_state.transform_result = transform_result
            route_ctx.processing_state.stage_timeline = timeline
            if log_fn is not None:
                log_fn(transform_result_log_fields(transform_result))
            raise

    if transform_result is not None:
        route_ctx.processing_state.transform_result = transform_result
        if log_fn is not None:
            log_fn(transform_result_log_fields(transform_result))
    transform_duration_ms = int(transform_result.duration_ms if transform_result else 0)
    timeline.append({"stage": "transform_timing", "duration_ms": transform_duration_ms})

    route_ctx.processing_state.current_events = current_events
    # Isolated snapshot for stream checkpoint (legacy enriched analogue).
    # Protection/classification/policy mutate only route-local delivery copies.
    checkpoint_source_events = copy_events(current_events)

    protection_started = time.monotonic()
    stream_protection_rules = list(shared_batch.shared_runtime_data.get("stream_protection_rules") or [])
    route_overrides = list(shared_batch.shared_runtime_data.get("route_overrides") or [])
    exec_before = shared_batch.protection_execution_count
    protection_metrics_result: RouteProtectionResult | None = None
    try:
        protected_events, protect_batch_result, protection_config = route_protection_stage(
            route_ctx,
            shared_batch,
            db=db,
            use_short_db=use_short_db,
            log_fn=log_fn,
            stream_protection_rules=stream_protection_rules,
            route_protection_rules=_route_protection_rules_from_ctx(route_ctx),
            route_overrides=route_overrides,
        )
    except Exception as err:
        protection_duration_ms = max(0, int((time.monotonic() - protection_started) * 1000))
        cfg = route_ctx.effective_config.protection
        operations_applied = count_protection_operations(
            rule_count=len(getattr(cfg, "rules", ()) or ()) if cfg is not None else 0
        )
        protection_metrics_result = RouteProtectionResult(
            route_id=route_ctx.route_id,
            stream_id=route_ctx.stream_id,
            outcome="failure",
            duration_ms=protection_duration_ms,
            protection_operations_applied=operations_applied,
            persisted_source=str(getattr(getattr(cfg, "resolution", None), "persisted_source", None) or "")
            or None,
            fallback_used=bool(getattr(getattr(cfg, "resolution", None), "fallback_used", False)),
            error_message=str(err),
        )
        timeline.append(
            {
                "stage": "protection",
                "status": "failed",
                "duration_ms": protection_duration_ms,
                "error_message": str(err),
                "protection_operations_applied": operations_applied,
            }
        )
        timeline.append({"stage": "protection_timing", "duration_ms": protection_duration_ms})
        route_ctx.processing_state.protection_result = protection_metrics_result
        route_ctx.processing_state.stage_timeline = timeline
        if log_fn is not None:
            log_fn(protection_result_log_fields(protection_metrics_result))
        raise

    protection_reused = shared_batch.protection_execution_count == exec_before
    operations_applied = count_protection_operations(
        rules_applied=int(getattr(protect_batch_result, "rules_applied", 0) or 0)
    )
    # Stage-only latency: protection engine duration (0 when reused). Does not
    # include classification/policy/delivery or cumulative-totals DB reads.
    engine_duration_ms = int(getattr(protect_batch_result, "duration_ms", 0) or 0)
    if has_effective_protection(protection_config, rules_applied=operations_applied):
        protection_duration_ms = engine_duration_ms
        protection_metrics_result = RouteProtectionResult(
            route_id=route_ctx.route_id,
            stream_id=route_ctx.stream_id,
            outcome="success",
            duration_ms=protection_duration_ms,
            protection_operations_applied=operations_applied,
            reused=protection_reused,
            persisted_source=protection_config.resolution.persisted_source,
            fallback_used=protection_config.resolution.fallback_used,
        )
    else:
        protection_duration_ms = 0
        protection_metrics_result = RouteProtectionResult(
            route_id=route_ctx.route_id,
            stream_id=route_ctx.stream_id,
            outcome="skipped",
            skip_reason="no_effective_protection",
            duration_ms=0,
            protection_operations_applied=0,
            reused=protection_reused,
            persisted_source=protection_config.resolution.persisted_source,
            fallback_used=protection_config.resolution.fallback_used,
        )
    current_events = protected_events
    route_ctx.processing_state.current_events = current_events
    route_ctx.processing_state.protection_result = protection_metrics_result
    if log_fn is not None:
        log_fn(protection_result_log_fields(protection_metrics_result))
    if protect_batch_result.rules_applied > 0 or protect_batch_result.masked_field_applications > 0:
        modified = True
    timeline.append(
        {
            "stage": "protection",
            "status": "completed",
            "modified": protect_batch_result.masked_field_applications > 0,
            "rules_applied": protect_batch_result.rules_applied,
            "masked_field_applications": protect_batch_result.masked_field_applications,
            "duration_ms": protection_duration_ms,
            "reused": protection_reused,
            "persisted_source": protection_config.resolution.persisted_source,
            "override_count": protection_config.resolution.override_count,
            "ephemeral_rule_count": protection_config.resolution.ephemeral_rule_count,
            "audit_only_count": len(protection_config.audit_only_paths),
            "protection_operations_applied": operations_applied
            if protection_metrics_result.outcome != "skipped"
            else 0,
        }
    )
    timeline.append({"stage": "protection_timing", "duration_ms": protection_duration_ms})

    classification_started = time.monotonic()
    stream_classification_rules = list(shared_batch.shared_runtime_data.get("stream_classification_rules") or [])
    try:
        classified_events, classification_result, classification_config = route_classification_stage(
            route_ctx,
            shared_batch,
            log_fn=log_fn,
            stream_classification_rules=stream_classification_rules,
            route_classification_rules=_route_classification_rules_from_ctx(route_ctx),
            route_overrides=route_overrides,
        )
    except Exception as err:
        classification_metrics = route_ctx.processing_state.classification_metrics
        if classification_metrics is None:
            classification_metrics = RouteClassificationMetricsResult(
                route_id=route_ctx.route_id,
                stream_id=route_ctx.stream_id,
                outcome="failure",
                duration_ms=max(0, int((time.monotonic() - classification_started) * 1000)),
                error_message=str(err),
            )
            route_ctx.processing_state.classification_metrics = classification_metrics
        classification_duration_ms = int(classification_metrics.duration_ms or 0)
        timeline.append(
            {
                "stage": "classification",
                "status": "failed",
                "duration_ms": classification_duration_ms,
                "error_message": str(err),
                "classification_operations_applied": classification_metrics.classification_operations_applied,
            }
        )
        timeline.append({"stage": "classification_timing", "duration_ms": classification_duration_ms})
        route_ctx.processing_state.stage_timeline = timeline
        if log_fn is not None:
            log_fn(classification_result_log_fields(classification_metrics))
        raise

    classification_metrics = route_ctx.processing_state.classification_metrics
    # Stage-only latency: classification engine duration. Does not include
    # transform/protection/policy/delivery or config resolution.
    classification_duration_ms = int(getattr(classification_metrics, "duration_ms", 0) or 0)
    current_events = classified_events
    route_ctx.processing_state.current_events = current_events
    if log_fn is not None and classification_metrics is not None:
        log_fn(classification_result_log_fields(classification_metrics))
    if classification_result is not None:
        modified = True
        timeline.append(
            {
                "stage": "classification",
                "status": "completed",
                "classification_level": classification_result.effective_level,
                "matched_rule_count": classification_result.matched_rule_count,
                "persisted_source": classification_result.persisted_source,
                "override_applied": classification_result.override_applied,
                "override_count": classification_config.resolution.override_count,
                "duration_ms": classification_duration_ms,
                "classification_operations_applied": (
                    classification_metrics.classification_operations_applied if classification_metrics else 0
                ),
            }
        )
    else:
        reason = (
            classification_metrics.skip_reason
            if classification_metrics is not None and classification_metrics.skip_reason
            else ("disabled" if not classification_enabled() else "skipped")
        )
        timeline.append({"stage": "classification", "status": "skipped", "reason": reason})
    timeline.append({"stage": "classification_timing", "duration_ms": classification_duration_ms})

    policy_started = time.monotonic()
    stream_policy_rules = list(shared_batch.shared_runtime_data.get("stream_policy_rules") or [])
    governance_rules = list(shared_batch.shared_runtime_data.get("governance_rules") or [])
    policy_events, policy_result, _policy_config = route_policy_stage(
        route_ctx,
        shared_batch,
        db=db,
        log_fn=log_fn,
        stream_policy_rules=stream_policy_rules,
        route_policy_rules=_route_policy_rules_from_ctx(route_ctx),
        route_overrides=route_overrides,
        governance_rules=governance_rules,
    )
    policy_duration_ms = max(0, int((time.monotonic() - policy_started) * 1000))
    current_events = policy_events
    route_ctx.processing_state.current_events = current_events
    delivery_allowed = policy_result.delivery_allowed
    timeline.append(
        {
            "stage": "policy",
            "status": "completed",
            "decision": policy_result.decision,
            "policy_action": policy_result.policy_action,
            "decision_reason": policy_result.decision_reason,
            "matched_policy_count": policy_result.matched_policy_count,
            "persisted_source": policy_result.persisted_source,
            "delivery_allowed": delivery_allowed,
            "quarantine_recorded": policy_result.quarantine_recorded,
            "duration_ms": policy_duration_ms,
        }
    )

    route_ctx.processing_state.policy_result = policy_result

    delivery_started = time.monotonic()
    delivery_result = route_delivery_stage(
        route_ctx,
        shared_batch,
        policy_result,
        current_events,
        send_fn=send_fn if delivery_allowed else None,
        log_fn=log_fn,
        run_id=run_id,
        quarantine_event_id=policy_result.quarantine_event_id,
    )
    delivery_duration_ms = max(0, int((time.monotonic() - delivery_started) * 1000))

    if delivery_result.delivery_success is True:
        output_events = current_events
        checkpoint_events = checkpoint_source_events
    else:
        output_events = []
        checkpoint_events = []

    timeline.append(
        {
            "stage": "delivery",
            "status": "completed",
            "delivery_disposition": delivery_result.delivery_disposition,
            "delivery_success": delivery_result.delivery_success,
            "skip_reason": delivery_result.skip_reason,
            "policy_action": delivery_result.policy_action,
            "decision_reason": delivery_result.decision_reason,
            "health_level": delivery_result.health_level,
            "event_count": delivery_result.event_count,
            "duration_ms": delivery_duration_ms,
        }
    )
    route_ctx.processing_state.stage_timeline = timeline
    route_ctx.processing_state.errors = errors

    return RouteStageResult(
        route_id=route_ctx.route_id,
        events=output_events,
        checkpoint_source_events=checkpoint_events,
        modified=modified,
        stage_timeline=timeline,
        transform_result=transform_result,
        transform_duration_ms=transform_duration_ms,
        protection_result=protection_metrics_result,
        protection_duration_ms=protection_duration_ms,
        auto_protect_count=len(shared_batch.ephemeral_auto_protect_rules),
        classification_result=classification_result,
        classification_metrics=classification_metrics,
        classification_duration_ms=classification_duration_ms,
        policy_result=policy_result,
        policy_duration_ms=policy_duration_ms,
        delivery_allowed=delivery_allowed,
        delivery_result=delivery_result,
        delivery_duration_ms=delivery_duration_ms,
    )


def process_route(
    route_ctx: RouteRuntimeContext,
    shared_batch: SharedBatchContext,
    *,
    log_fn: LogFn | None = None,
    db: Session | None = None,
) -> RouteStageResult:
    """Backward-compatible alias for route pipeline entry."""

    return process_route_pipeline(route_ctx, shared_batch, log_fn=log_fn, db=db)


def process_routes(
    route_contexts: list[RouteRuntimeContext],
    shared_batch: SharedBatchContext,
    *,
    log_fn: LogFn | None = None,
    db: Session | None = None,
    use_short_db: bool = False,
    base_metrics: RouteProcessingMetrics | None = None,
    send_fn: Callable[[RouteRuntimeContext, list[dict[str, Any]]], RouteSendOutcome] | None = None,
    run_id: str | None = None,
) -> RoutePipelineResult:
    """Iterate enabled routes through the route pipeline."""

    results: list[RouteStageResult] = []
    auto_protect_count = 0
    policy_count = 0
    policy_duration_ms = 0
    policy_allow_count = 0
    policy_audit_count = 0
    policy_block_count = 0
    policy_review_count = 0
    policy_quarantine_count = 0
    delivery_attempt_count = 0
    delivery_success_count = 0
    delivery_failure_count = 0
    delivery_blocked_count = 0
    delivery_review_count = 0
    delivery_quarantine_count = 0
    delivery_duration_ms = 0
    checkpoint_reference: list[dict[str, Any]] = []

    # Mutable rollup (RouteProcessingMetrics is frozen) so failures update before re-raise.
    rollup = SimpleNamespace(
        route_transform_count=0,
        route_transform_duration_ms=0,
        route_transform_attempt_count=0,
        route_transform_success_count=0,
        route_transform_failure_count=0,
        route_transform_skipped_count=0,
        route_mapping_operations_applied=0,
        route_enrichment_operations_applied=0,
        route_protection_count=0,
        route_protection_duration_ms=0,
        route_protection_attempt_count=0,
        route_protection_success_count=0,
        route_protection_failure_count=0,
        route_protection_skipped_count=0,
        route_protection_operations_applied=0,
        route_classification_count=0,
        route_classification_duration_ms=0,
        route_classification_override_count=0,
        route_classification_attempt_count=0,
        route_classification_success_count=0,
        route_classification_failure_count=0,
        route_classification_skipped_count=0,
        route_classification_operations_applied=0,
    )

    for route_ctx in route_contexts:
        if not route_ctx.enabled:
            if log_fn is not None:
                log_fn(
                    {
                        "stage": "route_skip",
                        "stream_id": route_ctx.stream_id,
                        "route_id": route_ctx.route_id,
                        "skip_reason": "route_disabled",
                        "message": "route_disabled",
                    }
                )
            continue
        try:
            stage_result = process_route_pipeline(
                route_ctx,
                shared_batch,
                log_fn=log_fn,
                db=db,
                use_short_db=use_short_db,
                send_fn=send_fn,
                run_id=run_id,
            )
        except (MappingError, EnrichmentError):
            failure_result = route_ctx.processing_state.transform_result
            if failure_result is not None:
                apply_transform_metrics(rollup, failure_result)
            raise
        except Exception:
            transform_failure = route_ctx.processing_state.transform_result
            if transform_failure is not None:
                apply_transform_metrics(rollup, transform_failure)
            protection_failure = route_ctx.processing_state.protection_result
            if protection_failure is not None:
                apply_protection_metrics(rollup, protection_failure)
            classification_failure = route_ctx.processing_state.classification_metrics
            if classification_failure is not None:
                apply_classification_metrics(rollup, classification_failure)
            raise
        results.append(stage_result)
        if stage_result.transform_result is not None:
            apply_transform_metrics(rollup, stage_result.transform_result)
        if stage_result.protection_result is not None:
            apply_protection_metrics(rollup, stage_result.protection_result)
        if stage_result.classification_metrics is not None:
            apply_classification_metrics(rollup, stage_result.classification_metrics)
        auto_protect_count += int(getattr(stage_result, "auto_protect_count", 0) or 0)
        policy_result = getattr(stage_result, "policy_result", None)
        if policy_result is not None:
            policy_count += 1
            policy_duration_ms += int(getattr(stage_result, "policy_duration_ms", 0) or 0)
            decision = str(getattr(policy_result, "decision", "allow"))
            if decision == "allow":
                policy_allow_count += 1
            elif decision == "audit":
                policy_audit_count += 1
            elif decision == "block":
                policy_block_count += 1
            elif decision == "require_review":
                policy_review_count += 1
            elif decision == "quarantine":
                policy_quarantine_count += 1
        delivery_result = getattr(stage_result, "delivery_result", None)
        if delivery_result is not None:
            delivery_attempt_count += 1
            if (
                delivery_result.delivery_disposition == "delivered"
                and delivery_result.delivery_success is True
            ):
                delivery_success_count += 1
            elif (
                delivery_result.delivery_disposition == "delivered"
                and delivery_result.delivery_success is False
            ):
                delivery_failure_count += 1
            elif delivery_result.delivery_disposition == "quarantined":
                delivery_quarantine_count += 1
            elif (
                delivery_result.delivery_disposition == "blocked"
                and delivery_result.policy_action == "require_review"
            ):
                delivery_review_count += 1
            elif delivery_result.delivery_disposition == "blocked":
                delivery_blocked_count += 1
            delivery_duration_ms += int(getattr(stage_result, "delivery_duration_ms", 0) or 0)
            checkpoint_events = stage_result.checkpoint_source_events or stage_result.events
            if (
                delivery_result.delivery_disposition == "delivered"
                and delivery_result.delivery_success is True
                and checkpoint_events
            ):
                checkpoint_reference = list(checkpoint_events)
        elif stage_result.delivery_allowed:
            checkpoint_events = stage_result.checkpoint_source_events or stage_result.events
            if checkpoint_events:
                checkpoint_reference = list(checkpoint_events)

    metrics = RouteProcessingMetrics(
        route_count=base_metrics.route_count if base_metrics else len(route_contexts),
        route_context_build_time_ms=base_metrics.route_context_build_time_ms if base_metrics else 0,
        route_transform_count=int(rollup.route_transform_count),
        route_transform_duration_ms=int(rollup.route_transform_duration_ms),
        route_transform_fallback_count=base_metrics.route_transform_fallback_count if base_metrics else 0,
        route_transform_attempt_count=int(rollup.route_transform_attempt_count),
        route_transform_success_count=int(rollup.route_transform_success_count),
        route_transform_failure_count=int(rollup.route_transform_failure_count),
        route_transform_skipped_count=int(rollup.route_transform_skipped_count),
        route_mapping_operations_applied=int(rollup.route_mapping_operations_applied),
        route_enrichment_operations_applied=int(rollup.route_enrichment_operations_applied),
        route_protection_count=int(rollup.route_protection_count),
        route_protection_duration_ms=int(rollup.route_protection_duration_ms),
        route_protection_attempt_count=int(rollup.route_protection_attempt_count),
        route_protection_success_count=int(rollup.route_protection_success_count),
        route_protection_failure_count=int(rollup.route_protection_failure_count),
        route_protection_skipped_count=int(rollup.route_protection_skipped_count),
        route_protection_operations_applied=int(rollup.route_protection_operations_applied),
        route_auto_protect_count=auto_protect_count,
        route_classification_count=int(rollup.route_classification_count),
        route_classification_duration_ms=int(rollup.route_classification_duration_ms),
        route_classification_override_count=int(rollup.route_classification_override_count),
        route_classification_attempt_count=int(rollup.route_classification_attempt_count),
        route_classification_success_count=int(rollup.route_classification_success_count),
        route_classification_failure_count=int(rollup.route_classification_failure_count),
        route_classification_skipped_count=int(rollup.route_classification_skipped_count),
        route_classification_operations_applied=int(rollup.route_classification_operations_applied),
        route_policy_count=policy_count,
        route_policy_duration_ms=policy_duration_ms,
        route_policy_allow_count=policy_allow_count,
        route_policy_audit_count=policy_audit_count,
        route_policy_block_count=policy_block_count,
        route_policy_review_count=policy_review_count,
        route_policy_quarantine_count=policy_quarantine_count,
        route_delivery_attempt_count=delivery_attempt_count,
        route_delivery_success_count=delivery_success_count,
        route_delivery_failure_count=delivery_failure_count,
        route_delivery_blocked_count=delivery_blocked_count,
        route_delivery_review_count=delivery_review_count,
        route_delivery_quarantine_count=delivery_quarantine_count,
        route_delivery_duration_ms=delivery_duration_ms,
    )
    return RoutePipelineResult(
        stage_results=results,
        metrics=metrics,
        checkpoint_reference_events=checkpoint_reference,
    )
