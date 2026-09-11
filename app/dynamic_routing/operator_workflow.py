"""M9 dynamic routing — operator workflow (CRUD + summary)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.destinations.models import Destination
from app.classification.levels import normalize_level
from app.classification.models import CLASSIFICATION_LEVELS
from app.dynamic_routing.models import StreamDynamicRoute
from app.dynamic_routing.route_binding import (
    AmbiguousDynamicRouteBindingError,
    UnresolvedDynamicRouteBindingError,
    resolve_existing_route,
)
from app.routes.models import Route
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


class DynamicRouteNotFoundError(Exception):
    def __init__(self, route_id: int) -> None:
        self.route_id = route_id
        super().__init__(f"dynamic route not found: {route_id}")


class DynamicRouteValidationError(Exception):
    pass


def _rule_entry(
    rule: StreamDynamicRoute,
    *,
    destination_name: str | None = None,
    route_name: str | None = None,
) -> dict[str, Any]:
    bound_route_id = int(rule.route_id) if rule.route_id is not None else None
    return {
        "id": rule.id,
        "stream_id": rule.stream_id,
        "name": rule.name,
        "enabled": bool(rule.enabled),
        "condition_json": dict(rule.condition_json) if isinstance(rule.condition_json, dict) else {},
        "route_id": bound_route_id,
        "route_name": route_name
        if route_name is not None
        else (f"Route #{bound_route_id}" if bound_route_id else None),
        "destination_id": int(rule.destination_id),
        "destination_name": destination_name,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
    }


def _validate_condition_json(condition_json: dict[str, Any]) -> None:
    if not isinstance(condition_json, dict):
        raise DynamicRouteValidationError("condition_json must be an object")
    sensitivity = condition_json.get("sensitivity_class")
    classification = condition_json.get("classification_level")
    if sensitivity is None and classification is None:
        raise DynamicRouteValidationError(
            "condition_json requires sensitivity_class or classification_level"
        )
    if sensitivity is not None and str(sensitivity) not in _SUPPORTED_CONDITION_CLASSES:
        raise DynamicRouteValidationError(f"unsupported sensitivity_class: {sensitivity!r}")
    if classification is not None:
        normalized = normalize_level(str(classification))
        if normalized is None or normalized not in CLASSIFICATION_LEVELS:
            raise DynamicRouteValidationError(f"unsupported classification_level: {classification!r}")


def _validate_destination(db: Session, destination_id: int) -> Destination:
    dest = db.get(Destination, int(destination_id))
    if dest is None:
        raise DynamicRouteValidationError(f"destination not found: {destination_id}")
    return dest


def _bind_existing_route(
    db: Session,
    *,
    stream_id: int,
    route_id: int | None = None,
    destination_id: int | None = None,
) -> Route:
    try:
        return resolve_existing_route(
            db,
            stream_id=stream_id,
            route_id=route_id,
            destination_id=destination_id,
        )
    except UnresolvedDynamicRouteBindingError as exc:
        raise DynamicRouteValidationError(str(exc)) from exc
    except AmbiguousDynamicRouteBindingError as exc:
        raise DynamicRouteValidationError(str(exc)) from exc


def list_dynamic_routes(
    db: Session,
    stream_id: int,
    *,
    enabled_only: bool = False,
) -> list[dict[str, Any]]:
    stmt = select(StreamDynamicRoute).where(StreamDynamicRoute.stream_id == stream_id)
    if enabled_only:
        stmt = stmt.where(StreamDynamicRoute.enabled.is_(True))
    stmt = stmt.order_by(StreamDynamicRoute.name, StreamDynamicRoute.id)
    rules = list(db.execute(stmt).scalars())
    out: list[dict[str, Any]] = []
    for rule in rules:
        dest = db.get(Destination, int(rule.destination_id))
        dest_name = str(dest.name) if dest is not None else None
        bound_route = db.get(Route, int(rule.route_id)) if rule.route_id is not None else None
        route_name = f"Route #{int(bound_route.id)}" if bound_route is not None else None
        out.append(_rule_entry(rule, destination_name=dest_name, route_name=route_name))
    return out


def build_dynamic_routing_summary(db: Session, stream_id: int) -> dict[str, Any]:
    from app.dynamic_routing.dynamic_routing_metrics import load_dynamic_routing_runtime_metrics

    rows = list(
        db.execute(select(StreamDynamicRoute).where(StreamDynamicRoute.stream_id == stream_id)).scalars()
    )
    runtime_metrics = load_dynamic_routing_runtime_metrics(db, stream_id, total_dynamic_routes=len(rows))
    return {
        "stream_id": stream_id,
        "total_dynamic_routes": len(rows),
        "matched_dynamic_routes": int(runtime_metrics["matched_dynamic_routes"]),
        "dynamic_deliveries": int(runtime_metrics["dynamic_deliveries"]),
        "last_evaluated_at": runtime_metrics.get("last_evaluated_at"),
    }


def create_dynamic_route(
    db: Session,
    *,
    stream_id: int,
    name: str,
    enabled: bool,
    condition_json: dict[str, Any],
    destination_id: int | None = None,
    route_id: int | None = None,
) -> StreamDynamicRoute:
    label = name.strip()
    if not label:
        raise DynamicRouteValidationError("name is required")
    _validate_condition_json(condition_json)
    bound = _bind_existing_route(
        db,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
    )
    _validate_destination(db, int(bound.destination_id))
    now = datetime.now(timezone.utc)
    rule = StreamDynamicRoute(
        stream_id=stream_id,
        name=label,
        enabled=enabled,
        condition_json=dict(condition_json),
        route_id=int(bound.id),
        destination_id=int(bound.destination_id),
        created_at=now,
        updated_at=now,
    )
    db.add(rule)
    db.flush()
    return rule


def patch_dynamic_route(
    db: Session,
    *,
    stream_id: int,
    route_id: int,
    name: str | None = None,
    enabled: bool | None = None,
    condition_json: dict[str, Any] | None = None,
    destination_id: int | None = None,
    target_route_id: int | None = None,
) -> StreamDynamicRoute:
    rule = db.get(StreamDynamicRoute, int(route_id))
    if rule is None or int(rule.stream_id) != int(stream_id):
        raise DynamicRouteNotFoundError(route_id)
    if name is not None:
        label = name.strip()
        if not label:
            raise DynamicRouteValidationError("name is required")
        rule.name = label
    if enabled is not None:
        rule.enabled = bool(enabled)
    if condition_json is not None:
        _validate_condition_json(condition_json)
        rule.condition_json = dict(condition_json)
    if destination_id is not None or target_route_id is not None:
        bound = _bind_existing_route(
            db,
            stream_id=stream_id,
            route_id=target_route_id if target_route_id is not None else None,
            destination_id=destination_id if destination_id is not None else None,
        )
        _validate_destination(db, int(bound.destination_id))
        rule.route_id = int(bound.id)
        rule.destination_id = int(bound.destination_id)
    rule.updated_at = datetime.now(timezone.utc)
    db.flush()
    return rule
