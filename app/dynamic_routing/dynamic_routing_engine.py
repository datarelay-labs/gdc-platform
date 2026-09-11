"""M9 dynamic routing engine — condition evaluation only (additive fan-out)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.classification.engine import classification_levels_from_events
from app.classification.levels import normalize_level
from app.classification.models import (
    CLASSIFICATION_CONFIDENTIAL,
    CLASSIFICATION_INTERNAL,
    CLASSIFICATION_PUBLIC,
    CLASSIFICATION_RESTRICTED,
)
from app.ai_providers.runtime_config import resolve_destination_runtime_config
from app.dynamic_routing.models import StreamDynamicRoute
from app.dynamic_routing.route_binding import (
    load_stream_routes_by_destination,
    try_resolve_existing_route,
)
from app.sensitive_detection.models import (
    SENSITIVITY_CLASS_PII,
    SENSITIVITY_CLASS_SECRET,
    SENSITIVITY_CLASS_SECURITY_METADATA,
)

_SUPPORTED_CONDITION_CLASSES = frozenset(
    {
        SENSITIVITY_CLASS_SECRET,
        SENSITIVITY_CLASS_PII,
        SENSITIVITY_CLASS_SECURITY_METADATA,
    }
)

_SUPPORTED_CLASSIFICATION_CONDITION_LEVELS = frozenset(
    {
        CLASSIFICATION_PUBLIC,
        CLASSIFICATION_INTERNAL,
        CLASSIFICATION_CONFIDENTIAL,
        CLASSIFICATION_RESTRICTED,
    }
)


@dataclass
class DynamicRouteMatch:
    dynamic_route_id: int
    dynamic_route_name: str
    route_id: int
    destination_id: int
    destination_name: str
    destination_type: str
    destination_config: dict[str, Any]
    rate_limit_json: dict[str, Any]
    destination_enabled: bool


@dataclass
class DynamicRoutingBatchResult:
    matches: list[DynamicRouteMatch] = field(default_factory=list)
    dynamic_route_count: int = 0
    matched_dynamic_route_count: int = 0
    selected_destination_count: int = 0
    selected_route_ids: list[int] = field(default_factory=list)
    duration_ms: int = 0


def _finding_classes(findings: list[dict[str, Any]]) -> set[str]:
    classes: set[str] = set()
    for item in findings:
        if not isinstance(item, dict):
            continue
        raw = item.get("sensitivity_class")
        if raw is not None:
            classes.add(str(raw))
    return classes


def condition_matches(
    condition_json: Any,
    *,
    finding_classes: set[str],
    classification_levels: set[str],
) -> bool:
    if not isinstance(condition_json, dict):
        return False
    required_level = condition_json.get("classification_level")
    if required_level is not None:
        normalized = normalize_level(str(required_level))
        if normalized is None or normalized not in _SUPPORTED_CLASSIFICATION_CONDITION_LEVELS:
            return False
        return normalized in classification_levels
    required = condition_json.get("sensitivity_class")
    if required is None:
        return False
    required_str = str(required)
    if required_str not in _SUPPORTED_CONDITION_CLASSES:
        return False
    return required_str in finding_classes


def evaluate_batch(
    db: Session | None,
    *,
    stream_id: int,
    events: list[dict[str, Any]],
    findings: list[dict[str, Any]] | None = None,
) -> DynamicRoutingBatchResult:
    """Evaluate enabled dynamic routes for one delivery batch (read-only)."""

    started = time.monotonic()
    if db is None or not events:
        return DynamicRoutingBatchResult(duration_ms=0)

    rules = list(
        db.execute(
            select(StreamDynamicRoute)
            .where(
                StreamDynamicRoute.stream_id == int(stream_id),
                StreamDynamicRoute.enabled.is_(True),
            )
            .order_by(StreamDynamicRoute.id)
        ).scalars()
    )
    if not rules:
        duration_ms = max(0, int((time.monotonic() - started) * 1000))
        return DynamicRoutingBatchResult(dynamic_route_count=0, duration_ms=duration_ms)

    if findings is None:
        from app.sensitive_detection.detection import detect_hits_for_batch

        findings = detect_hits_for_batch(events)

    finding_classes = _finding_classes(findings)
    classification_levels = classification_levels_from_events(events)
    matches: list[DynamicRouteMatch] = []
    seen_route_ids: set[int] = set()
    routes_by_destination = load_stream_routes_by_destination(db, stream_id)

    for rule in rules:
        if not condition_matches(
            rule.condition_json,
            finding_classes=finding_classes,
            classification_levels=classification_levels,
        ):
            continue
        bound = try_resolve_existing_route(
            db,
            stream_id=stream_id,
            route_id=int(rule.route_id) if rule.route_id is not None else None,
            destination_id=int(rule.destination_id),
            routes_by_destination=routes_by_destination,
        )
        if bound is None:
            continue
        dest = bound.destination
        if dest is None:
            continue
        bound_route_id = int(bound.id)
        if bound_route_id in seen_route_ids:
            continue
        seen_route_ids.add(bound_route_id)
        dest_type = str(dest.destination_type or "").strip().upper()
        dest_config = resolve_destination_runtime_config(
            db,
            dest_type,
            dict(dest.config_json or {}),
        )
        matches.append(
            DynamicRouteMatch(
                dynamic_route_id=int(rule.id),
                dynamic_route_name=str(rule.name),
                route_id=bound_route_id,
                destination_id=int(dest.id),
                destination_name=str(dest.name),
                destination_type=dest_type,
                destination_config=dest_config,
                rate_limit_json=dict(dest.rate_limit_json or {}),
                destination_enabled=bool(dest.enabled),
            )
        )

    duration_ms = max(0, int((time.monotonic() - started) * 1000))
    selected_route_ids = [int(match.route_id) for match in matches]
    return DynamicRoutingBatchResult(
        matches=matches,
        dynamic_route_count=len(rules),
        matched_dynamic_route_count=len(matches),
        selected_destination_count=len(matches),
        selected_route_ids=selected_route_ids,
        duration_ms=duration_ms,
    )
