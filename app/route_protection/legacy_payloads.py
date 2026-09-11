"""Legacy fan-out per-route protection payloads (flag OFF, override-only)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.route_protection.stage import route_protection_stage
from app.runners.route_context import RouteEffectiveConfig, RouteRuntimeContext, SharedBatchContext
from app.runners.route_context_builder import build_shared_batch_context

LogFn = Callable[[dict[str, Any]], None]


def _get(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


def has_active_protection_route_overrides(route_overrides: list[dict[str, Any]] | None) -> bool:
    """True when at least one enabled override carries a protection_action."""

    for item in route_overrides or []:
        if not isinstance(item, dict):
            continue
        if not bool(item.get("enabled", True)):
            continue
        action = item.get("protection_action")
        if action is None:
            continue
        normalized = str(action).strip().lower()
        if not normalized or normalized == "inherit":
            continue
        return True
    return False


def _route_is_actionable(route: dict[str, Any]) -> bool:
    if not bool(_get(route, "enabled", True)):
        return False
    destination = _get(route, "destination", {}) or {}
    return bool(_get(destination, "enabled", True))


def build_legacy_route_protection_payloads(
    *,
    runtime_stream: Any,
    enriched_events: list[dict[str, Any]],
    db: Session | None = None,
    use_short_db: bool = False,
    log_fn: LogFn | None = None,
    schema_drift_policy_result: Any = None,
    sensitive_detection_result: Any = None,
    batch_id: str = "",
) -> dict[int, list[dict[str, Any]]]:
    """Build per-route protected copies for legacy fan-out using route_protection_stage."""

    if not enriched_events:
        return {}

    stream_id = int(_get(runtime_stream, "id"))
    route_overrides = list(_get(runtime_stream, "route_overrides", []) or [])
    stream_protection_rules = list(_get(runtime_stream, "stream_protection_rules", []) or [])

    shared_batch = build_shared_batch_context(
        stream_id=stream_id,
        batch_id=batch_id or "legacy-protection",
        runtime_stream=runtime_stream,
        extracted_events=enriched_events,
        shared_runtime_data={
            "stream_protection_rules": stream_protection_rules,
            "route_overrides": route_overrides,
        },
        sensitive_detection_result=sensitive_detection_result,
        schema_drift_policy_result=schema_drift_policy_result,
    )

    payloads: dict[int, list[dict[str, Any]]] = {}
    for route in list(_get(runtime_stream, "routes", []) or []):
        if not _route_is_actionable(route):
            continue
        route_id = int(_get(route, "id"))
        destination = _get(route, "destination", {}) or {}
        route_ctx = RouteRuntimeContext(
            route_id=route_id,
            stream_id=stream_id,
            destination_id=int(_get(destination, "id", 0)),
            route_name=str(_get(destination, "name", f"route-{route_id}")),
            route_type=str(_get(destination, "destination_type", "")),
            formatter={},
            delivery_policy=str(_get(route, "failure_policy", "LOG_AND_CONTINUE")),
            rate_limit={},
            metadata={},
            effective_config=RouteEffectiveConfig(),
            enabled=True,
        )
        route_ctx.processing_state.current_events = list(enriched_events)
        protected_events, _, _ = route_protection_stage(
            route_ctx,
            shared_batch,
            db=db,
            use_short_db=use_short_db,
            log_fn=log_fn,
            stream_protection_rules=stream_protection_rules,
            route_protection_rules=[],
            route_overrides=route_overrides,
        )
        payloads[route_id] = protected_events

    return payloads
