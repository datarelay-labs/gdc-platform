"""Assemble virtual operational snapshot from bulk repository data (no DB in loops)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.runtime.operational_snapshot_repository import (
    LastOutcomeRow,
    OperationalSnapshotBulkData,
    PhysicalOperationalRows,
    WindowAggregateRow,
    load_open_schema_field_drift_counts,
    load_operational_snapshot_bulk_data,
    load_physical_operational_rows,
)
from app.runtime.operational_snapshot_schemas import (
    OperationalDestinationSnapshot,
    OperationalGlobalSnapshot,
    OperationalHealthStatus,
    OperationalProblem,
    OperationalRouteSnapshot,
    OperationalSnapshotResponse,
    OperationalStreamSnapshot,
)

_CHECKPOINT_LAG_WARNING_SECONDS = 3600


def _eps(success_count: int, window_seconds: int) -> float:
    return round(success_count / max(1, window_seconds), 6)


def _rates(agg: WindowAggregateRow | None) -> tuple[float, float, float]:
    if agg is None:
        return 0.0, 0.0, 0.0
    total = agg.success_count + agg.failure_count
    if total <= 0:
        return 0.0, 0.0, 0.0
    success_rate = round(agg.success_count / total * 100.0, 4)
    failure_rate = round(agg.failure_count / total * 100.0, 4)
    retry_rate = round(agg.retry_count / total * 100.0, 4)
    return success_rate, failure_rate, retry_rate


def _last_fields(last: LastOutcomeRow | None) -> tuple[datetime | None, datetime | None, str | None]:
    if last is None:
        return None, None, None
    return last.last_success_at, last.last_failure_at, last.last_error_message


def classify_stream_health(
    *,
    enabled: bool,
    status: str,
    last_success_at: datetime | None,
    last_error_at: datetime | None,
    failure_rate_5m: float,
) -> OperationalHealthStatus:
    if not enabled:
        return "IDLE"
    status_upper = status.upper()
    if "ERROR" in status_upper:
        return "ERROR"
    if "PAUSED" in status_upper or "RATE_LIMITED" in status_upper:
        return "DEGRADED"
    if last_error_at is not None and last_success_at is None:
        return "ERROR"
    if last_error_at is not None and last_success_at is not None and last_error_at > last_success_at:
        return "DEGRADED"
    if failure_rate_5m >= 50.0:
        return "ERROR"
    if failure_rate_5m > 0.0:
        return "DEGRADED"
    if last_success_at is not None:
        return "HEALTHY"
    return "IDLE"


def classify_route_health(
    *,
    enabled: bool,
    last_success_at: datetime | None,
    last_error_at: datetime | None,
    failed_eps_1m: float,
    retry_rate_5m: float,
) -> OperationalHealthStatus:
    if not enabled:
        return "IDLE"
    if last_error_at is not None and last_success_at is None:
        return "ERROR"
    if last_error_at is not None and last_success_at is not None and last_error_at > last_success_at:
        return "ERROR"
    if failed_eps_1m > 0.0 or retry_rate_5m > 0.0:
        return "DEGRADED"
    if last_success_at is not None:
        return "HEALTHY"
    return "IDLE"


def classify_destination_health(
    *,
    enabled: bool,
    route_healths: list[OperationalHealthStatus],
    last_success_at: datetime | None,
    last_connectivity_test_success: bool | None = None,
) -> OperationalHealthStatus:
    if not enabled:
        return "IDLE"
    if any(h == "ERROR" for h in route_healths):
        return "ERROR"
    if any(h == "DEGRADED" for h in route_healths):
        return "DEGRADED"
    if last_success_at is not None:
        return "HEALTHY"
    if last_connectivity_test_success is True:
        return "HEALTHY"
    return "IDLE"


def classify_global_health(
    *,
    enabled_streams: int,
    problems: list[OperationalProblem],
) -> OperationalHealthStatus:
    if enabled_streams <= 0:
        return "IDLE"
    if any(p.severity == "critical" for p in problems):
        return "ERROR"
    if any(p.severity == "warning" for p in problems):
        return "DEGRADED"
    return "HEALTHY"


def _checkpoint_lag_seconds(now: datetime, checkpoint_updated_at: datetime | None) -> int | None:
    if checkpoint_updated_at is None:
        return None
    return max(0, int((now - checkpoint_updated_at).total_seconds()))


def should_flag_checkpoint_stale(stream: OperationalStreamSnapshot) -> bool:
    """Warn only when a stream is actively delivering but checkpoint has not advanced."""
    if not stream.enabled:
        return False
    lag = stream.checkpoint_lag_seconds
    if lag is None or lag < _CHECKPOINT_LAG_WARNING_SECONDS:
        return False
    if stream.eps_1m <= 0 and stream.eps_5m <= 0:
        return False
    if stream.last_success_at is None:
        return False
    cp_at = stream.checkpoint_updated_at
    if cp_at is None:
        return True
    return cp_at < stream.last_success_at


def _attach_open_schema_field_drift_counts(
    streams: list[OperationalStreamSnapshot],
    counts: dict[int, int],
) -> list[OperationalStreamSnapshot]:
    if not counts:
        return streams
    return [
        stream.model_copy(update={"open_schema_field_drift_count": int(counts.get(stream.stream_id, 0))})
        for stream in streams
    ]


def build_operational_snapshot(db: Session) -> OperationalSnapshotResponse:
    open_drift_counts = load_open_schema_field_drift_counts(db)
    physical = load_physical_operational_rows(db)
    if physical is not None:
        snapshot = _assemble_snapshot_from_physical(physical)
    else:
        snapshot = _assemble_snapshot(load_operational_snapshot_bulk_data(db))
    return snapshot.model_copy(
        update={"streams": _attach_open_schema_field_drift_counts(snapshot.streams, open_drift_counts)}
    )


def _assemble_snapshot_from_physical(rows: PhysicalOperationalRows) -> OperationalSnapshotResponse:
    """Assemble API contract from materialized runtime_*_snapshot tables."""

    route_snapshots: list[OperationalRouteSnapshot] = []
    route_health_by_id: dict[int, OperationalHealthStatus] = {}

    for route in rows.routes:
        snap = rows.route_snapshots.get(route.id)
        if snap is not None:
            health = snap.health_status  # type: ignore[union-attr]
            delivered_eps_1m = float(snap.delivered_eps_1m)  # type: ignore[union-attr]
            failed_eps_1m = float(snap.failed_eps_1m)  # type: ignore[union-attr]
            success_rate_5m = float(snap.success_rate_5m)  # type: ignore[union-attr]
            retry_rate_5m = float(snap.retry_rate_5m)  # type: ignore[union-attr]
            avg_latency_ms = snap.avg_latency_ms  # type: ignore[union-attr]
            last_success_at = snap.last_success_at  # type: ignore[union-attr]
            last_error_at = snap.last_error_at  # type: ignore[union-attr]
            last_error_message = snap.last_error_message  # type: ignore[union-attr]
        else:
            health = classify_route_health(
                enabled=route.enabled,
                last_success_at=None,
                last_error_at=None,
                failed_eps_1m=0.0,
                retry_rate_5m=0.0,
            )
            delivered_eps_1m = failed_eps_1m = success_rate_5m = retry_rate_5m = 0.0
            avg_latency_ms = last_success_at = last_error_at = last_error_message = None

        route_health_by_id[route.id] = health
        route_snapshots.append(
            OperationalRouteSnapshot(
                route_id=route.id,
                stream_id=route.stream_id,
                stream_name=route.stream_name,
                destination_id=route.destination_id,
                destination_name=route.destination_name,
                destination_type=route.destination_type,
                enabled=route.enabled,
                failure_policy=route.failure_policy,
                health_status=health,
                delivered_eps_1m=delivered_eps_1m,
                failed_eps_1m=failed_eps_1m,
                success_rate_5m=success_rate_5m,
                retry_rate_5m=retry_rate_5m,
                avg_latency_ms=avg_latency_ms,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    routes_by_stream: dict[int, list[int]] = {}
    routes_by_destination: dict[int, list[int]] = {}
    for route in rows.routes:
        routes_by_stream.setdefault(route.stream_id, []).append(route.id)
        routes_by_destination.setdefault(route.destination_id, []).append(route.id)

    stream_snapshots: list[OperationalStreamSnapshot] = []
    for stream in rows.streams:
        snap = rows.stream_snapshots.get(stream.id)
        if snap is not None:
            health = snap.health_status  # type: ignore[union-attr]
            eps_1m = float(snap.eps_1m)  # type: ignore[union-attr]
            eps_5m = float(snap.eps_5m)  # type: ignore[union-attr]
            success_rate_5m = float(snap.success_rate_5m)  # type: ignore[union-attr]
            failure_rate_5m = float(snap.failure_rate_5m)  # type: ignore[union-attr]
            avg_latency_ms = snap.avg_latency_ms  # type: ignore[union-attr]
            route_count = int(snap.route_count)  # type: ignore[union-attr]
            healthy_route_count = int(snap.healthy_route_count)  # type: ignore[union-attr]
            failed_route_count = int(snap.failed_route_count)  # type: ignore[union-attr]
            last_success_at = snap.last_success_at  # type: ignore[union-attr]
            last_error_at = snap.last_error_at  # type: ignore[union-attr]
            last_error_message = snap.last_error_message  # type: ignore[union-attr]
            checkpoint_updated_at = snap.checkpoint_updated_at  # type: ignore[union-attr]
            checkpoint_lag_seconds = snap.checkpoint_lag_seconds  # type: ignore[union-attr]
        else:
            health = classify_stream_health(
                enabled=stream.enabled,
                status=stream.status,
                last_success_at=None,
                last_error_at=None,
                failure_rate_5m=0.0,
            )
            eps_1m = eps_5m = success_rate_5m = failure_rate_5m = 0.0
            avg_latency_ms = last_success_at = last_error_at = last_error_message = None
            checkpoint_updated_at = checkpoint_lag_seconds = None
            route_ids = routes_by_stream.get(stream.id, [])
            route_count = rows.routes_per_stream.get(stream.id, len(route_ids))
            healthy_route_count = failed_route_count = 0

        stream_snapshots.append(
            OperationalStreamSnapshot(
                stream_id=stream.id,
                stream_name=stream.name,
                connector_id=stream.connector_id,
                source_id=stream.source_id,
                enabled=stream.enabled,
                status=stream.status,
                health_status=health,
                eps_1m=eps_1m,
                eps_5m=eps_5m,
                success_rate_5m=success_rate_5m,
                failure_rate_5m=failure_rate_5m,
                avg_latency_ms=avg_latency_ms,
                route_count=route_count,
                healthy_route_count=healthy_route_count,
                failed_route_count=failed_route_count,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
                checkpoint_updated_at=checkpoint_updated_at,
                checkpoint_lag_seconds=checkpoint_lag_seconds,
            )
        )

    destination_snapshots: list[OperationalDestinationSnapshot] = []
    for dest in rows.destinations:
        snap = rows.destination_snapshots.get(dest.id)
        if snap is not None:
            health = snap.health_status  # type: ignore[union-attr]
            inbound_eps_1m = float(snap.inbound_eps_1m)  # type: ignore[union-attr]
            failed_eps_1m = float(snap.failed_eps_1m)  # type: ignore[union-attr]
            avg_latency_ms = snap.avg_latency_ms  # type: ignore[union-attr]
            route_count = int(snap.route_count)  # type: ignore[union-attr]
            last_success_at = snap.last_success_at  # type: ignore[union-attr]
            last_error_at = snap.last_error_at  # type: ignore[union-attr]
            last_error_message = snap.last_error_message  # type: ignore[union-attr]
        else:
            route_ids = routes_by_destination.get(dest.id, [])
            route_healths = [route_health_by_id[rid] for rid in route_ids]
            health = classify_destination_health(
                enabled=dest.enabled,
                route_healths=route_healths,
                last_success_at=None,
                last_connectivity_test_success=dest.last_connectivity_test_success,
            )
            inbound_eps_1m = failed_eps_1m = 0.0
            avg_latency_ms = last_success_at = last_error_at = last_error_message = None
            route_count = rows.routes_per_destination.get(dest.id, len(route_ids))

        destination_snapshots.append(
            OperationalDestinationSnapshot(
                destination_id=dest.id,
                destination_name=dest.name,
                destination_type=dest.destination_type,
                enabled=dest.enabled,
                health_status=health,
                inbound_eps_1m=inbound_eps_1m,
                failed_eps_1m=failed_eps_1m,
                avg_latency_ms=avg_latency_ms,
                route_count=route_count,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    problems = _build_problems(
        stream_snapshots=stream_snapshots,
        route_snapshots=route_snapshots,
        destination_snapshots=destination_snapshots,
    )

    enabled_streams = sum(1 for s in rows.streams if s.enabled)
    running_streams = sum(1 for s in rows.streams if s.enabled and s.status.upper() == "RUNNING")
    error_streams = sum(1 for s in rows.streams if "ERROR" in s.status.upper())
    enabled_routes = sum(1 for r in rows.routes if r.enabled)
    enabled_destinations = sum(1 for d in rows.destinations if d.enabled)
    total_eps_1m = round(sum(s.eps_1m for s in stream_snapshots), 6)
    total_eps_5m = round(sum(s.eps_5m for s in stream_snapshots), 6)

    latency_values = [s.avg_latency_ms for s in stream_snapshots if s.avg_latency_ms is not None]
    avg_latency_ms = (
        round(sum(latency_values) / len(latency_values), 4) if latency_values else None
    )

    activity_times: list[datetime] = []
    for snap in stream_snapshots:
        if snap.last_success_at is not None:
            activity_times.append(snap.last_success_at)
        if snap.last_error_at is not None:
            activity_times.append(snap.last_error_at)
    last_activity_at = max(activity_times) if activity_times else None

    global_health = classify_global_health(
        enabled_streams=enabled_streams,
        problems=problems,
    )

    global_snapshot = OperationalGlobalSnapshot(
        health_status=global_health,
        total_streams=len(rows.streams),
        enabled_streams=enabled_streams,
        running_streams=running_streams,
        error_streams=error_streams,
        total_routes=len(rows.routes),
        enabled_routes=enabled_routes,
        total_destinations=len(rows.destinations),
        enabled_destinations=enabled_destinations,
        total_eps_1m=total_eps_1m,
        total_eps_5m=total_eps_5m,
        avg_latency_ms=avg_latency_ms,
        last_activity_at=last_activity_at,
    )

    return OperationalSnapshotResponse(
        global_=global_snapshot,
        streams=stream_snapshots,
        routes=route_snapshots,
        destinations=destination_snapshots,
        problems=problems,
        updated_at=rows.now,
    )


def _assemble_snapshot(bulk: OperationalSnapshotBulkData) -> OperationalSnapshotResponse:
    route_snapshots: list[OperationalRouteSnapshot] = []
    route_health_by_id: dict[int, OperationalHealthStatus] = {}

    for route in bulk.routes:
        agg_1m = bulk.route_agg_1m.get(route.id)
        agg_5m = bulk.route_agg_5m.get(route.id)
        success_rate_5m, _, retry_rate_5m = _rates(agg_5m)
        delivered_eps_1m = _eps(agg_1m.success_count if agg_1m else 0, 60)
        failed_eps_1m = _eps(agg_1m.failure_count if agg_1m else 0, 60)
        last_success_at, last_error_at, last_error_message = _last_fields(bulk.route_last.get(route.id))
        health = classify_route_health(
            enabled=route.enabled,
            last_success_at=last_success_at,
            last_error_at=last_error_at,
            failed_eps_1m=failed_eps_1m,
            retry_rate_5m=retry_rate_5m,
        )
        route_health_by_id[route.id] = health
        route_snapshots.append(
            OperationalRouteSnapshot(
                route_id=route.id,
                stream_id=route.stream_id,
                stream_name=route.stream_name,
                destination_id=route.destination_id,
                destination_name=route.destination_name,
                destination_type=route.destination_type,
                enabled=route.enabled,
                failure_policy=route.failure_policy,
                health_status=health,
                delivered_eps_1m=delivered_eps_1m,
                failed_eps_1m=failed_eps_1m,
                success_rate_5m=success_rate_5m,
                retry_rate_5m=retry_rate_5m,
                avg_latency_ms=agg_5m.avg_latency_ms if agg_5m else None,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    routes_by_stream: dict[int, list[int]] = {}
    routes_by_destination: dict[int, list[int]] = {}
    for route in bulk.routes:
        routes_by_stream.setdefault(route.stream_id, []).append(route.id)
        routes_by_destination.setdefault(route.destination_id, []).append(route.id)

    stream_snapshots: list[OperationalStreamSnapshot] = []
    for stream in bulk.streams:
        agg_1m = bulk.stream_agg_1m.get(stream.id)
        agg_5m = bulk.stream_agg_5m.get(stream.id)
        success_rate_5m, failure_rate_5m, _ = _rates(agg_5m)
        last_success_at, last_error_at, last_error_message = _last_fields(bulk.stream_last.get(stream.id))
        health = classify_stream_health(
            enabled=stream.enabled,
            status=stream.status,
            last_success_at=last_success_at,
            last_error_at=last_error_at,
            failure_rate_5m=failure_rate_5m,
        )
        route_ids = routes_by_stream.get(stream.id, [])
        route_healths = [route_health_by_id[rid] for rid in route_ids]
        healthy_route_count = sum(1 for h in route_healths if h == "HEALTHY")
        failed_route_count = sum(1 for h in route_healths if h in ("ERROR", "DEGRADED"))
        cp = bulk.checkpoints.get(stream.id)
        checkpoint_updated_at = cp.updated_at if cp is not None else None
        lag = _checkpoint_lag_seconds(bulk.now, checkpoint_updated_at)
        stream_snapshots.append(
            OperationalStreamSnapshot(
                stream_id=stream.id,
                stream_name=stream.name,
                connector_id=stream.connector_id,
                source_id=stream.source_id,
                enabled=stream.enabled,
                status=stream.status,
                health_status=health,
                eps_1m=_eps(agg_1m.success_count if agg_1m else 0, 60),
                eps_5m=_eps(agg_5m.success_count if agg_5m else 0, 300),
                success_rate_5m=success_rate_5m,
                failure_rate_5m=failure_rate_5m,
                avg_latency_ms=agg_5m.avg_latency_ms if agg_5m else None,
                route_count=bulk.routes_per_stream.get(stream.id, len(route_ids)),
                healthy_route_count=healthy_route_count,
                failed_route_count=failed_route_count,
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
                checkpoint_updated_at=checkpoint_updated_at,
                checkpoint_lag_seconds=lag,
            )
        )

    destination_snapshots: list[OperationalDestinationSnapshot] = []
    for dest in bulk.destinations:
        agg_1m = bulk.destination_agg_1m.get(dest.id)
        agg_5m = bulk.destination_agg_5m.get(dest.id)
        last_success_at, last_error_at, last_error_message = _last_fields(bulk.destination_last.get(dest.id))
        route_ids = routes_by_destination.get(dest.id, [])
        route_healths = [route_health_by_id[rid] for rid in route_ids]
        health = classify_destination_health(
            enabled=dest.enabled,
            route_healths=route_healths,
            last_success_at=last_success_at,
            last_connectivity_test_success=dest.last_connectivity_test_success,
        )
        destination_snapshots.append(
            OperationalDestinationSnapshot(
                destination_id=dest.id,
                destination_name=dest.name,
                destination_type=dest.destination_type,
                enabled=dest.enabled,
                health_status=health,
                inbound_eps_1m=_eps(agg_1m.success_count if agg_1m else 0, 60),
                failed_eps_1m=_eps(agg_1m.failure_count if agg_1m else 0, 60),
                avg_latency_ms=agg_5m.avg_latency_ms if agg_5m else None,
                route_count=bulk.routes_per_destination.get(dest.id, len(route_ids)),
                last_success_at=last_success_at,
                last_error_at=last_error_at,
                last_error_message=last_error_message,
            )
        )

    problems = _build_problems(
        stream_snapshots=stream_snapshots,
        route_snapshots=route_snapshots,
        destination_snapshots=destination_snapshots,
    )

    enabled_streams = sum(1 for s in bulk.streams if s.enabled)
    running_streams = sum(1 for s in bulk.streams if s.enabled and s.status.upper() == "RUNNING")
    error_streams = sum(1 for s in bulk.streams if "ERROR" in s.status.upper())
    enabled_routes = sum(1 for r in bulk.routes if r.enabled)
    enabled_destinations = sum(1 for d in bulk.destinations if d.enabled)
    total_eps_1m = round(sum(s.eps_1m for s in stream_snapshots), 6)
    total_eps_5m = round(sum(s.eps_5m for s in stream_snapshots), 6)

    latency_values = [s.avg_latency_ms for s in stream_snapshots if s.avg_latency_ms is not None]
    avg_latency_ms = (
        round(sum(latency_values) / len(latency_values), 4) if latency_values else None
    )

    activity_times: list[datetime] = []
    for snap in stream_snapshots:
        if snap.last_success_at is not None:
            activity_times.append(snap.last_success_at)
        if snap.last_error_at is not None:
            activity_times.append(snap.last_error_at)
    last_activity_at = max(activity_times) if activity_times else None

    global_health = classify_global_health(
        enabled_streams=enabled_streams,
        problems=problems,
    )

    global_snapshot = OperationalGlobalSnapshot(
        health_status=global_health,
        total_streams=len(bulk.streams),
        enabled_streams=enabled_streams,
        running_streams=running_streams,
        error_streams=error_streams,
        total_routes=len(bulk.routes),
        enabled_routes=enabled_routes,
        total_destinations=len(bulk.destinations),
        enabled_destinations=enabled_destinations,
        total_eps_1m=total_eps_1m,
        total_eps_5m=total_eps_5m,
        avg_latency_ms=avg_latency_ms,
        last_activity_at=last_activity_at,
    )

    return OperationalSnapshotResponse(
        global_=global_snapshot,
        streams=stream_snapshots,
        routes=route_snapshots,
        destinations=destination_snapshots,
        problems=problems,
        updated_at=bulk.now,
    )


def _build_problems(
    *,
    stream_snapshots: list[OperationalStreamSnapshot],
    route_snapshots: list[OperationalRouteSnapshot],
    destination_snapshots: list[OperationalDestinationSnapshot],
) -> list[OperationalProblem]:
    problems: list[OperationalProblem] = []

    for stream in stream_snapshots:
        if stream.health_status == "ERROR":
            problems.append(
                OperationalProblem(
                    severity="critical",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name} is in ERROR state",
                    message=stream.last_error_message or f"Stream status: {stream.status or 'unknown'}",
                    last_seen_at=stream.last_error_at or stream.last_success_at,
                )
            )
        elif stream.failure_rate_5m > 0.0:
            problems.append(
                OperationalProblem(
                    severity="warning",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name} has delivery failures",
                    message=f"Failure rate (5m): {stream.failure_rate_5m:.2f}%",
                    last_seen_at=stream.last_error_at,
                )
            )
        if should_flag_checkpoint_stale(stream):
            problems.append(
                OperationalProblem(
                    severity="warning",
                    scope="stream",
                    stream_id=stream.stream_id,
                    title=f"Stream {stream.stream_name} checkpoint is stale",
                    message=f"Checkpoint lag: {stream.checkpoint_lag_seconds}s",
                    last_seen_at=stream.checkpoint_updated_at,
                )
            )

    for route in route_snapshots:
        if route.health_status == "ERROR":
            problems.append(
                OperationalProblem(
                    severity="critical",
                    scope="route",
                    stream_id=route.stream_id,
                    route_id=route.route_id,
                    title=f"Route {route.route_id} delivery failing",
                    message=route.last_error_message or "Recent failures without recovery",
                    last_seen_at=route.last_error_at,
                )
            )

    for dest in destination_snapshots:
        if dest.health_status == "ERROR":
            problems.append(
                OperationalProblem(
                    severity="critical",
                    scope="destination",
                    destination_id=dest.destination_id,
                    title=f"Destination {dest.destination_name} is unhealthy",
                    message=dest.last_error_message or "Connected routes report errors",
                    last_seen_at=dest.last_error_at,
                )
            )

    return problems
