"""Route protection stage — reuses existing Protection Engine (M13.3)."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.protection.engine import ProtectBatchResult, protect_batch
from app.protection.metrics import build_protection_complete_payload, load_cumulative_protection_totals
from app.route_protection.cache_key import protection_execution_cache_key
from app.route_protection.config import RouteProtectionConfig
from app.route_protection.resolver import merge_ephemeral_for_route, resolve_route_protection_config
from app.runners.route_context import RouteRuntimeContext, SharedBatchContext
from app.runners.route_transform_config import transform_config_cache_key
from app.runtime.copy_utils import copy_events


LogFn = Callable[[dict[str, Any]], None]


def _audit_only_log_entries(
    *,
    stream_id: int,
    route_id: int,
    audit_only_paths: tuple[str, ...],
) -> list[dict[str, Any]]:
    return [
        {
            "stage": "protection",
            "stream_id": stream_id,
            "route_id": route_id,
            "field_path": path,
            "protection_mode": "audit_only",
            "message": "audit only — field not mutated",
            "status": "AUDIT_ONLY",
        }
        for path in audit_only_paths
    ]


def _canonical_protect_result(result: ProtectBatchResult) -> ProtectBatchResult:
    """Deep-copy events so the batch cache never aliases route-local mutations."""

    return ProtectBatchResult(
        events=copy_events(result.events),
        masked_field_applications=result.masked_field_applications,
        rules_applied=result.rules_applied,
        warning_count=result.warning_count,
        warnings=list(result.warnings),
        duration_ms=result.duration_ms,
        tokenization_batch_items=result.tokenization_batch_items,
        tokenization_cache_hits=result.tokenization_cache_hits,
        tokenization_created=result.tokenization_created,
    )


def _route_local_protect_result(canonical: ProtectBatchResult) -> ProtectBatchResult:
    """Hand out a route-local event list; never share cached event object identities."""

    return ProtectBatchResult(
        events=copy_events(canonical.events),
        masked_field_applications=canonical.masked_field_applications,
        rules_applied=canonical.rules_applied,
        warning_count=canonical.warning_count,
        warnings=list(canonical.warnings),
        duration_ms=0,
        tokenization_batch_items=canonical.tokenization_batch_items,
        tokenization_cache_hits=canonical.tokenization_cache_hits,
        tokenization_created=canonical.tokenization_created,
    )


def route_protection_stage(
    route_ctx: RouteRuntimeContext,
    shared_batch: SharedBatchContext,
    *,
    db: Session | None = None,
    use_short_db: bool = False,
    log_fn: LogFn | None = None,
    stream_protection_rules: list[Any] | None = None,
    route_protection_rules: list[Any] | None = None,
    route_overrides: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], ProtectBatchResult, RouteProtectionConfig]:
    """Apply per-route protection using resolved config and shared ephemeral rules."""

    input_events = list(route_ctx.processing_state.current_events)
    protection_config = resolve_route_protection_config(
        route_id=route_ctx.route_id,
        stream_id=route_ctx.stream_id,
        route_protection_rules=route_protection_rules,
        stream_protection_rules=stream_protection_rules,
        route_overrides=route_overrides,
        ephemeral_auto_protect_rules=shared_batch.ephemeral_auto_protect_rules,
    )
    route_ctx.effective_config.protection = protection_config

    merged_ephemeral = merge_ephemeral_for_route(
        shared_batch.ephemeral_auto_protect_rules,
        protection_config,
    )

    transform = route_ctx.effective_config.transform
    transform_key = transform_config_cache_key(transform) if transform is not None else "__raw__"
    cache_key = protection_execution_cache_key(
        transform_key=transform_key,
        config=protection_config,
        merged_ephemeral=merged_ephemeral,
    )

    reused = False
    cached = shared_batch.protection_result_cache.get(cache_key)
    if cached is not None:
        result = _route_local_protect_result(cached)
        reused = True
        duration_ms = 0
    else:
        started = time.monotonic()

        def _protect(session: Session | None) -> ProtectBatchResult:
            return protect_batch(
                input_events,
                list(protection_config.rules),
                stream_id=route_ctx.stream_id,
                db=session,
                ephemeral_rules=merged_ephemeral or None,
            )

        from app.protection.models import PROTECTION_MODE_TOKENIZATION

        needs_tokenization = any(
            str(getattr(rule, "protection_mode", "")) == PROTECTION_MODE_TOKENIZATION
            for rule in list(protection_config.rules) + list(merged_ephemeral or [])
        )
        if db is not None:
            result = _protect(db)
        elif use_short_db and needs_tokenization:
            # Production StreamRunner path: short write session for vault tokenization.
            from app.runners.stream_runner_db import run_with_db

            result = run_with_db(_protect, commit=True)
        else:
            result = _protect(None)
        duration_ms = max(0, int((time.monotonic() - started) * 1000))
        result.duration_ms = duration_ms
        shared_batch.protection_result_cache[cache_key] = _canonical_protect_result(result)
        shared_batch.protection_execution_count += 1

    for warn in result.warnings:
        if log_fn is not None:
            log_fn(
                {
                    "stage": "protection",
                    "stream_id": route_ctx.stream_id,
                    "route_id": route_ctx.route_id,
                    "message": warn.error_message,
                    **warn.to_log_fields(),
                }
            )

    for audit_entry in _audit_only_log_entries(
        stream_id=route_ctx.stream_id,
        route_id=route_ctx.route_id,
        audit_only_paths=protection_config.audit_only_paths,
    ):
        if log_fn is not None:
            log_fn(audit_entry)

    if merged_ephemeral and log_fn is not None:
        for ephemeral in merged_ephemeral:
            log_fn(
                {
                    "stage": "schema_drift_policy_auto_protect_applied",
                    "stream_id": route_ctx.stream_id,
                    "route_id": route_ctx.route_id,
                    "field_path": str(getattr(ephemeral, "field_path", "")),
                    "protection_mode": str(getattr(ephemeral, "protection_mode", "")),
                    "message": "auto protect ephemeral rule applied",
                    "reused": reused,
                }
            )

    cumulative = {"total_protected_events": 0, "total_protected_fields": 0}
    if db is not None:
        cumulative = load_cumulative_protection_totals(db, route_ctx.stream_id)
    elif use_short_db:
        try:
            from app.runners.stream_runner_db import run_with_db

            cumulative = run_with_db(
                lambda session: load_cumulative_protection_totals(session, route_ctx.stream_id),
                commit=False,
            )
        except Exception:
            cumulative = {"total_protected_events": 0, "total_protected_fields": 0}

    complete_payload = build_protection_complete_payload(
        stream_id=route_ctx.stream_id,
        result=result,
        enriched_event_count=len(input_events),
        cumulative_totals=cumulative,
    )
    complete_payload["route_id"] = route_ctx.route_id
    complete_payload["protection_source"] = protection_config.resolution.persisted_source
    complete_payload["override_count"] = protection_config.resolution.override_count
    complete_payload["ephemeral_rule_count"] = protection_config.resolution.ephemeral_rule_count
    complete_payload["reused"] = reused
    if log_fn is not None:
        log_fn(complete_payload)

    return result.events, result, protection_config
