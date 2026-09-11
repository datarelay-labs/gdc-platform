"""Resolve Dynamic Routing rules onto existing Stream Routes (no hidden routes)."""

from __future__ import annotations

from sqlalchemy.orm import Session, joinedload

from app.routes.models import Route


class AmbiguousDynamicRouteBindingError(Exception):
    """More than one Route uses the same destination on the stream."""


class UnresolvedDynamicRouteBindingError(Exception):
    """No existing Route can be bound for the dynamic rule."""


def load_stream_routes_by_destination(db: Session, stream_id: int) -> dict[int, list[Route]]:
    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == int(stream_id))
        .order_by(Route.id.asc())
        .all()
    )
    by_dest: dict[int, list[Route]] = {}
    for route in routes:
        by_dest.setdefault(int(route.destination_id), []).append(route)
    return by_dest


def resolve_existing_route(
    db: Session,
    *,
    stream_id: int,
    route_id: int | None = None,
    destination_id: int | None = None,
    routes_by_destination: dict[int, list[Route]] | None = None,
) -> Route:
    """Return the unique existing Route this dynamic rule must use.

    Does not create Routes. Ambiguous destination bindings are rejected.
    """

    if route_id is not None:
        route = db.get(Route, int(route_id))
        if route is None or int(route.stream_id) != int(stream_id):
            raise UnresolvedDynamicRouteBindingError(
                f"route not found on stream {stream_id}: {route_id}"
            )
        return route

    if destination_id is None:
        raise UnresolvedDynamicRouteBindingError("route_id or destination_id is required")

    grouped = routes_by_destination
    if grouped is None:
        grouped = load_stream_routes_by_destination(db, stream_id)
    candidates = grouped.get(int(destination_id), [])
    if not candidates:
        raise UnresolvedDynamicRouteBindingError(
            f"no existing route for stream {stream_id} destination {destination_id}"
        )
    if len(candidates) > 1:
        raise AmbiguousDynamicRouteBindingError(
            f"ambiguous route for stream {stream_id} destination {destination_id}"
        )
    return candidates[0]


def try_resolve_existing_route(
    db: Session,
    *,
    stream_id: int,
    route_id: int | None = None,
    destination_id: int | None = None,
    routes_by_destination: dict[int, list[Route]] | None = None,
) -> Route | None:
    try:
        return resolve_existing_route(
            db,
            stream_id=stream_id,
            route_id=route_id,
            destination_id=destination_id,
            routes_by_destination=routes_by_destination,
        )
    except (AmbiguousDynamicRouteBindingError, UnresolvedDynamicRouteBindingError):
        return None
