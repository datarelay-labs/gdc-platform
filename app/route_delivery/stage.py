"""Route delivery stage — disposition, audit, and adapter send (M13.6)."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from app.route_delivery.config import DeliveryDisposition, RouteDeliveryResult, RouteSendOutcome
from app.route_delivery.health import classify_route_delivery_health
from app.route_policy.config import PolicyDecision, RoutePolicyResult
from app.runners.route_context import RouteRuntimeContext, SharedBatchContext


LogFn = Callable[[dict[str, Any]], None]
SendFn = Callable[[RouteRuntimeContext, list[dict[str, Any]]], RouteSendOutcome]


def _skip_reason_for_decision(decision: PolicyDecision) -> str | None:
    if decision == "block":
        return "policy_blocked"
    if decision == "require_review":
        return "policy_review"
    if decision == "quarantine":
        return "policy_quarantine"
    return None


def resolve_delivery_disposition(
    policy_result: RoutePolicyResult,
    *,
    delivery_success: bool | None,
    send_attempted: bool,
) -> DeliveryDisposition:
    decision = policy_result.decision
    if decision == "quarantine":
        return "quarantined"
    if decision in ("block", "require_review"):
        return "blocked"
    if send_attempted or policy_result.delivery_allowed:
        return "delivered"
    return "blocked"


def _emit_disposition_log(
    log_fn: LogFn | None,
    *,
    route_ctx: RouteRuntimeContext,
    shared_batch: SharedBatchContext,
    run_id: str | None,
    policy_result: RoutePolicyResult,
    delivery_result: RouteDeliveryResult,
) -> None:
    if log_fn is None:
        return
    log_fn(
        {
            "stage": "delivery_disposition",
            "stream_id": route_ctx.stream_id,
            "route_id": route_ctx.route_id,
            "destination_id": route_ctx.destination_id,
            "batch_id": shared_batch.batch_id,
            "run_id": run_id,
            "delivery_disposition": delivery_result.delivery_disposition,
            "delivery_success": delivery_result.delivery_success,
            "delivery_allowed": delivery_result.delivery_allowed,
            "policy_action": policy_result.policy_action,
            "decision_reason": policy_result.decision_reason,
            "skip_reason": delivery_result.skip_reason,
            "event_count": delivery_result.event_count,
            "quarantine_event_id": delivery_result.quarantine_event_id,
            "health_level": delivery_result.health_level,
        }
    )


def route_delivery_stage(
    route_ctx: RouteRuntimeContext,
    shared_batch: SharedBatchContext,
    policy_result: RoutePolicyResult,
    events: list[dict[str, Any]],
    *,
    send_fn: SendFn | None = None,
    log_fn: LogFn | None = None,
    run_id: str | None = None,
    quarantine_event_id: int | None = None,
) -> RouteDeliveryResult:
    """Resolve disposition, emit audit, and send when policy allows (spec 096 §7)."""

    started = time.monotonic()
    now = datetime.now(timezone.utc)
    delivery_allowed = policy_result.delivery_allowed
    skip_reason: str | None = None
    delivery_success: bool | None = None
    delivery_error: str | None = None
    latency_ms: int | None = None
    adapter_stage: str | None = None
    send_outcome: RouteSendOutcome | None = None
    failure_absorbed = False
    failover_attempted = False
    failover_succeeded = False
    event_count = len(events)

    if not route_ctx.enabled:
        skip_reason = "route_disabled"
        disposition: DeliveryDisposition = "blocked"
    elif not delivery_allowed:
        skip_reason = _skip_reason_for_decision(policy_result.decision)
        disposition = resolve_delivery_disposition(policy_result, delivery_success=None, send_attempted=False)
    elif event_count == 0:
        disposition = "delivered"
        delivery_success = True
        skip_reason = "no_events"
    elif send_fn is None:
        disposition = "delivered"
        delivery_success = True
        skip_reason = "no_send_fn"
    else:
        send_outcome = send_fn(route_ctx, events)
        disposition = "delivered"
        if send_outcome.rate_limited:
            skip_reason = "rate_limited"
            delivery_success = None
            delivery_error = "destination rate limited"
            adapter_stage = "destination_rate_limited"
            latency_ms = send_outcome.latency_ms
        elif send_outcome.destination_disabled:
            skip_reason = "destination_disabled"
            delivery_success = None
            delivery_error = "destination disabled"
            adapter_stage = "route_skip"
            latency_ms = send_outcome.latency_ms
        else:
            delivery_success = send_outcome.success
            delivery_error = send_outcome.error
            latency_ms = send_outcome.latency_ms
            adapter_stage = send_outcome.adapter_stage
            failure_absorbed = bool(send_outcome.failure_absorbed)
            failover_attempted = bool(send_outcome.failover_attempted)
            failover_succeeded = bool(send_outcome.failover_succeeded)

    health_level = classify_route_delivery_health(
        delivery_disposition=disposition,
        delivery_success=delivery_success,
        send_outcome=send_outcome,
    )

    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    if latency_ms is None:
        latency_ms = duration_ms

    result = RouteDeliveryResult(
        route_id=route_ctx.route_id,
        stream_id=route_ctx.stream_id,
        destination_id=route_ctx.destination_id,
        batch_id=shared_batch.batch_id,
        run_id=run_id,
        delivery_allowed=delivery_allowed,
        delivery_disposition=disposition,
        delivery_success=delivery_success,
        delivery_error=delivery_error,
        delivery_timestamp=now,
        policy_action=policy_result.policy_action,
        decision_reason=policy_result.decision_reason,
        skip_reason=skip_reason,
        event_count=event_count,
        latency_ms=latency_ms,
        adapter_stage=adapter_stage,
        quarantine_event_id=quarantine_event_id,
        delivery_log_id=None,
        health_level=health_level,
        failure_absorbed=failure_absorbed,
        failover_attempted=failover_attempted,
        failover_succeeded=failover_succeeded,
    )

    _emit_disposition_log(
        log_fn,
        route_ctx=route_ctx,
        shared_batch=shared_batch,
        run_id=run_id,
        policy_result=policy_result,
        delivery_result=result,
    )

    return result
