"""Bulk PostgreSQL loaders for the virtual operational snapshot (no per-entity loops)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import Integer, case, cast, func, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.routes.models import Route
from app.streams.models import Stream

SUCCESS_STAGES = frozenset({"route_send_success", "route_retry_success"})
POLICY_DISPOSITION_STAGES = frozenset(
    {
        "delivery_disposition",
        "policy_blocked",
        "policy_review_required",
        "policy_quarantine",
    }
)
FAILURE_STAGES = frozenset(
    {"route_send_failed", "route_retry_failed", "route_unknown_failure_policy"}
)
RETRY_STAGES = frozenset({"route_retry_success", "route_retry_failed"})
OUTCOME_STAGES = SUCCESS_STAGES | FAILURE_STAGES

UTC = timezone.utc
_WINDOW_1M = timedelta(minutes=1)
_WINDOW_5M = timedelta(minutes=5)
_MAX_LAST_OUTCOME_WINDOW = timedelta(hours=24)
_LAST_OUTCOME_STATEMENT_TIMEOUT_MS = 5000

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WindowAggregateRow:
    group_id: int
    success_count: int
    failure_count: int
    retry_count: int
    avg_latency_ms: float | None


@dataclass(frozen=True)
class LastOutcomeRow:
    group_id: int
    last_success_at: datetime | None
    last_failure_at: datetime | None
    last_error_message: str | None


@dataclass(frozen=True)
class StreamEntityRow:
    id: int
    name: str
    connector_id: int
    source_id: int
    enabled: bool
    status: str


@dataclass(frozen=True)
class RouteEntityRow:
    id: int
    stream_id: int
    stream_name: str
    destination_id: int
    destination_name: str
    destination_type: str
    enabled: bool
    failure_policy: str


@dataclass(frozen=True)
class DestinationEntityRow:
    id: int
    name: str
    destination_type: str
    enabled: bool
    last_connectivity_test_success: bool | None = None


def snapshot_now() -> datetime:
    return datetime.now(UTC)


def is_success_stage(stage: str | None) -> bool:
    return stage in SUCCESS_STAGES


def is_failure_stage(stage: str | None) -> bool:
    return stage in FAILURE_STAGES


def is_retry_stage(stage: str | None) -> bool:
    return stage in RETRY_STAGES


def _event_count_expr():
    return func.greatest(
        1,
        func.coalesce(cast(DeliveryLog.payload_sample.op("->>")("event_count"), Integer), 1),
    )


def _window_clauses(since: datetime, until: datetime) -> list:
    return [
        DeliveryLog.created_at >= since,
        DeliveryLog.created_at < until,
        DeliveryLog.stage.in_(OUTCOME_STAGES),
        func.upper(func.coalesce(DeliveryLog.level, "")) != "DEBUG",
    ]


def _window_aggregate_exprs(group_col):
    ec = _event_count_expr()
    success_expr = case((DeliveryLog.stage.in_(SUCCESS_STAGES), ec), else_=0)
    failure_expr = case((DeliveryLog.stage.in_(FAILURE_STAGES), ec), else_=0)
    retry_expr = case((DeliveryLog.stage.in_(RETRY_STAGES), 1), else_=0)
    latency_expr = case((DeliveryLog.stage.in_(OUTCOME_STAGES), DeliveryLog.latency_ms))
    return [
        group_col.label("group_id"),
        func.coalesce(func.sum(success_expr), 0).label("success_count"),
        func.coalesce(func.sum(failure_expr), 0).label("failure_count"),
        func.coalesce(func.sum(retry_expr), 0).label("retry_count"),
        func.avg(latency_expr).label("avg_latency_ms"),
    ]


def _row_to_window_aggregate(row) -> WindowAggregateRow:
    lat = row.avg_latency_ms
    avg: float | None
    if lat is None:
        avg = None
    else:
        try:
            avg = float(lat)
        except (TypeError, ValueError):
            avg = None
    return WindowAggregateRow(
        group_id=int(row.group_id),
        success_count=int(row.success_count or 0),
        failure_count=int(row.failure_count or 0),
        retry_count=int(row.retry_count or 0),
        avg_latency_ms=avg,
    )


def fetch_stream_window_aggregates(
    db: Session, *, since: datetime, until: datetime
) -> dict[int, WindowAggregateRow]:
    rows = (
        db.query(*_window_aggregate_exprs(DeliveryLog.stream_id))
        .filter(*_window_clauses(since, until))
        .filter(DeliveryLog.stream_id.isnot(None))
        .group_by(DeliveryLog.stream_id)
        .all()
    )
    return {int(r.group_id): _row_to_window_aggregate(r) for r in rows}


def fetch_route_window_aggregates(
    db: Session, *, since: datetime, until: datetime
) -> dict[int, WindowAggregateRow]:
    rows = (
        db.query(*_window_aggregate_exprs(DeliveryLog.route_id))
        .filter(*_window_clauses(since, until))
        .filter(DeliveryLog.route_id.isnot(None))
        .group_by(DeliveryLog.route_id)
        .all()
    )
    return {int(r.group_id): _row_to_window_aggregate(r) for r in rows}


def fetch_destination_window_aggregates(
    db: Session, *, since: datetime, until: datetime
) -> dict[int, WindowAggregateRow]:
    rows = (
        db.query(*_window_aggregate_exprs(DeliveryLog.destination_id))
        .filter(*_window_clauses(since, until))
        .filter(DeliveryLog.destination_id.isnot(None))
        .group_by(DeliveryLog.destination_id)
        .all()
    )
    return {int(r.group_id): _row_to_window_aggregate(r) for r in rows}


def _last_outcome_since(*, now: datetime | None = None) -> datetime:
    ref = now if now is not None else snapshot_now()
    return ref - _MAX_LAST_OUTCOME_WINDOW


def _rows_to_last_outcomes(rows) -> dict[int, LastOutcomeRow]:
    out: dict[int, LastOutcomeRow] = {}
    for r in rows:
        if r[0] is None:
            continue
        gid = int(r[0])
        out[gid] = LastOutcomeRow(
            group_id=gid,
            last_success_at=r[1],
            last_failure_at=r[2],
            last_error_message=str(r[3]) if r[3] else None,
        )
    return out


def _fetch_last_outcomes(
    db: Session,
    *,
    group_column: str,
    group_ids: list[int],
    failure_stages: tuple[str, ...],
    since: datetime | None = None,
) -> dict[int, LastOutcomeRow]:
    """Bulk last success/failure timestamps and latest failure message per group.

    Scoped to ``group_ids`` and at most the last 24 hours of ``delivery_logs`` (or
  ``since`` when provided for incremental snapshot refresh). Uses index-friendly
    ``GROUP BY`` + ``MAX`` aggregates instead of wide CTE scans.
    """

    ids = sorted({int(g) for g in group_ids})
    if not ids:
        return {}

    since_bound = since if since is not None else _last_outcome_since()
    params = {
        "group_ids": ids,
        "since": since_bound,
        "outcome_stages": list(OUTCOME_STAGES),
        "success_stages": list(SUCCESS_STAGES),
        "failure_stages": list(failure_stages),
    }
    time_sql = text(
        f"""
        SELECT
            delivery_logs.{group_column} AS group_id,
            MAX(delivery_logs.created_at) FILTER (
                WHERE delivery_logs.stage = ANY(:success_stages)
            ) AS last_success_at,
            MAX(delivery_logs.created_at) FILTER (
                WHERE delivery_logs.stage = ANY(:failure_stages)
            ) AS last_failure_at
        FROM delivery_logs
        WHERE delivery_logs.{group_column} = ANY(:group_ids)
          AND delivery_logs.created_at >= :since
          AND delivery_logs.stage = ANY(:outcome_stages)
          AND UPPER(COALESCE(delivery_logs.level, '')) <> 'DEBUG'
        GROUP BY delivery_logs.{group_column}
        """
    )
    message_sql = text(
        f"""
        SELECT DISTINCT ON (delivery_logs.{group_column})
            delivery_logs.{group_column} AS group_id,
            delivery_logs.message AS last_error_message
        FROM delivery_logs
        WHERE delivery_logs.{group_column} = ANY(:group_ids)
          AND delivery_logs.created_at >= :since
          AND delivery_logs.stage = ANY(:failure_stages)
          AND UPPER(COALESCE(delivery_logs.level, '')) <> 'DEBUG'
        ORDER BY delivery_logs.{group_column} ASC, delivery_logs.created_at DESC
        """
    )
    time_rows: tuple = ()
    message_rows: tuple = ()
    try:
        db.execute(text(f"SET LOCAL statement_timeout = '{int(_LAST_OUTCOME_STATEMENT_TIMEOUT_MS)}ms'"))
        time_rows = db.execute(time_sql, params).fetchall()
        message_rows = db.execute(message_sql, params).fetchall()
    except OperationalError:
        db.rollback()
        logger.warning(
            "last_outcomes_degraded",
            extra={"stage": "last_outcomes_degraded", "group_column": group_column},
        )
        return {}
    finally:
        try:
            db.execute(text("SET LOCAL statement_timeout = '0'"))
        except OperationalError:
            db.rollback()

    messages_by_group = {
        int(r[0]): str(r[1]) if r[1] else None for r in message_rows if r[0] is not None
    }
    out: dict[int, LastOutcomeRow] = {}
    for r in time_rows:
        if r[0] is None:
            continue
        gid = int(r[0])
        out[gid] = LastOutcomeRow(
            group_id=gid,
            last_success_at=r[1],
            last_failure_at=r[2],
            last_error_message=messages_by_group.get(gid),
        )
    return out


def fetch_stream_last_outcomes(
    db: Session, *, group_ids: list[int] | None = None
) -> dict[int, LastOutcomeRow]:
    ids = group_ids
    if ids is None:
        ids = [int(r[0]) for r in db.query(Stream.id).order_by(Stream.id.asc()).all()]
    return _fetch_last_outcomes(
        db,
        group_column="stream_id",
        group_ids=ids,
        failure_stages=tuple(FAILURE_STAGES),
    )


def fetch_route_last_outcomes(
    db: Session, *, group_ids: list[int] | None = None
) -> dict[int, LastOutcomeRow]:
    ids = group_ids
    if ids is None:
        ids = [int(r[0]) for r in db.query(Route.id).order_by(Route.id.asc()).all()]
    return _fetch_last_outcomes(
        db,
        group_column="route_id",
        group_ids=ids,
        failure_stages=tuple(FAILURE_STAGES),
    )


def fetch_destination_last_outcomes(
    db: Session, *, group_ids: list[int] | None = None
) -> dict[int, LastOutcomeRow]:
    ids = group_ids
    if ids is None:
        ids = [int(r[0]) for r in db.query(Destination.id).order_by(Destination.id.asc()).all()]
    return _fetch_last_outcomes(
        db,
        group_column="destination_id",
        group_ids=ids,
        failure_stages=tuple(FAILURE_STAGES),
    )


def load_all_streams(db: Session) -> list[StreamEntityRow]:
    rows = db.query(
        Stream.id,
        Stream.name,
        Stream.connector_id,
        Stream.source_id,
        Stream.enabled,
        Stream.status,
    ).order_by(Stream.id.asc())
    return [
        StreamEntityRow(
            id=int(r[0]),
            name=str(r[1]),
            connector_id=int(r[2]),
            source_id=int(r[3]),
            enabled=bool(r[4]),
            status=str(r[5] or ""),
        )
        for r in rows.all()
    ]


def load_all_routes(db: Session) -> list[RouteEntityRow]:
    rows = (
        db.query(
            Route.id,
            Route.stream_id,
            Stream.name,
            Route.destination_id,
            Destination.name,
            Destination.destination_type,
            Route.enabled,
            Route.failure_policy,
        )
        .join(Stream, Stream.id == Route.stream_id)
        .join(Destination, Destination.id == Route.destination_id)
        .order_by(Route.id.asc())
        .all()
    )
    return [
        RouteEntityRow(
            id=int(r[0]),
            stream_id=int(r[1]),
            stream_name=str(r[2]),
            destination_id=int(r[3]),
            destination_name=str(r[4]),
            destination_type=str(r[5] or ""),
            enabled=bool(r[6]),
            failure_policy=str(r[7] or ""),
        )
        for r in rows
    ]


def load_all_destinations(db: Session) -> list[DestinationEntityRow]:
    rows = db.query(
        Destination.id,
        Destination.name,
        Destination.destination_type,
        Destination.enabled,
        Destination.last_connectivity_test_success,
    ).order_by(Destination.id.asc())
    return [
        DestinationEntityRow(
            id=int(r[0]),
            name=str(r[1]),
            destination_type=str(r[2] or ""),
            enabled=bool(r[3]),
            last_connectivity_test_success=r[4],
        )
        for r in rows.all()
    ]


def load_checkpoints_by_stream(db: Session) -> dict[int, Checkpoint]:
    rows = db.query(Checkpoint).all()
    return {int(cp.stream_id): cp for cp in rows}


def load_open_schema_field_drift_counts(db: Session) -> dict[int, int]:
    """Count confirmed open StreamSchemaFieldDrift rows per stream (single GROUP BY)."""

    from app.schema_observation.models import DRIFT_STATUS_OPEN, StreamSchemaFieldDrift

    rows = (
        db.query(StreamSchemaFieldDrift.stream_id, func.count(StreamSchemaFieldDrift.id))
        .filter(StreamSchemaFieldDrift.status == DRIFT_STATUS_OPEN)
        .group_by(StreamSchemaFieldDrift.stream_id)
        .all()
    )
    return {int(sid): int(cnt) for sid, cnt in rows}


def count_routes_per_stream(db: Session) -> dict[int, int]:
    rows = (
        db.query(Route.stream_id, func.count(Route.id))
        .group_by(Route.stream_id)
        .all()
    )
    return {int(sid): int(cnt) for sid, cnt in rows}


def count_routes_per_destination(db: Session) -> dict[int, int]:
    rows = (
        db.query(Route.destination_id, func.count(Route.id))
        .group_by(Route.destination_id)
        .all()
    )
    return {int(did): int(cnt) for did, cnt in rows}


@dataclass(frozen=True)
class PhysicalOperationalRows:
    """Entity metadata plus denormalized runtime_*_snapshot rows for API assembly."""

    now: datetime
    streams: list[StreamEntityRow]
    routes: list[RouteEntityRow]
    destinations: list[DestinationEntityRow]
    stream_snapshots: dict[int, object]
    route_snapshots: dict[int, object]
    destination_snapshots: dict[int, object]
    checkpoints: dict[int, Checkpoint]
    routes_per_stream: dict[int, int]
    routes_per_destination: dict[int, int]


def load_physical_operational_rows(db: Session) -> PhysicalOperationalRows | None:
    """Load physical read model when populated; None triggers virtual aggregate fallback."""

    from app.config import settings
    from app.runtime.models import (
        RuntimeDestinationSnapshot,
        RuntimeRouteSnapshot,
        RuntimeStreamSnapshot,
    )
    from app.runtime.runtime_snapshot_repository import read_model_is_populated

    if not bool(getattr(settings, "GDC_RUNTIME_OPERATIONAL_SNAPSHOT_READ_MODEL_ENABLED", True)):
        return None
    if not read_model_is_populated(db):
        return None

    now = snapshot_now()
    streams = load_all_streams(db)
    routes = load_all_routes(db)
    destinations = load_all_destinations(db)
    return PhysicalOperationalRows(
        now=now,
        streams=streams,
        routes=routes,
        destinations=destinations,
        stream_snapshots={int(r.stream_id): r for r in db.query(RuntimeStreamSnapshot).all()},
        route_snapshots={int(r.route_id): r for r in db.query(RuntimeRouteSnapshot).all()},
        destination_snapshots={
            int(r.destination_id): r for r in db.query(RuntimeDestinationSnapshot).all()
        },
        checkpoints=load_checkpoints_by_stream(db),
        routes_per_stream=count_routes_per_stream(db),
        routes_per_destination=count_routes_per_destination(db),
    )


@dataclass(frozen=True)
class OperationalSnapshotBulkData:
    now: datetime
    since_1m: datetime
    since_5m: datetime
    streams: list[StreamEntityRow]
    routes: list[RouteEntityRow]
    destinations: list[DestinationEntityRow]
    checkpoints: dict[int, Checkpoint]
    routes_per_stream: dict[int, int]
    routes_per_destination: dict[int, int]
    stream_agg_1m: dict[int, WindowAggregateRow]
    stream_agg_5m: dict[int, WindowAggregateRow]
    route_agg_1m: dict[int, WindowAggregateRow]
    route_agg_5m: dict[int, WindowAggregateRow]
    destination_agg_1m: dict[int, WindowAggregateRow]
    destination_agg_5m: dict[int, WindowAggregateRow]
    stream_last: dict[int, LastOutcomeRow]
    route_last: dict[int, LastOutcomeRow]
    destination_last: dict[int, LastOutcomeRow]


def load_operational_snapshot_bulk_data(db: Session) -> OperationalSnapshotBulkData:
    """Single entry point: fixed query count regardless of entity cardinality."""

    now = snapshot_now()
    since_1m = now - _WINDOW_1M
    since_5m = now - _WINDOW_5M
    streams = load_all_streams(db)
    routes = load_all_routes(db)
    destinations = load_all_destinations(db)
    stream_ids = [s.id for s in streams]
    route_ids = [r.id for r in routes]
    destination_ids = [d.id for d in destinations]
    return OperationalSnapshotBulkData(
        now=now,
        since_1m=since_1m,
        since_5m=since_5m,
        streams=streams,
        routes=routes,
        destinations=destinations,
        checkpoints=load_checkpoints_by_stream(db),
        routes_per_stream=count_routes_per_stream(db),
        routes_per_destination=count_routes_per_destination(db),
        stream_agg_1m=fetch_stream_window_aggregates(db, since=since_1m, until=now),
        stream_agg_5m=fetch_stream_window_aggregates(db, since=since_5m, until=now),
        route_agg_1m=fetch_route_window_aggregates(db, since=since_1m, until=now),
        route_agg_5m=fetch_route_window_aggregates(db, since=since_5m, until=now),
        destination_agg_1m=fetch_destination_window_aggregates(db, since=since_1m, until=now),
        destination_agg_5m=fetch_destination_window_aggregates(db, since=since_5m, until=now),
        stream_last=fetch_stream_last_outcomes(db, group_ids=stream_ids),
        route_last=fetch_route_last_outcomes(db, group_ids=route_ids),
        destination_last=fetch_destination_last_outcomes(db, group_ids=destination_ids),
    )
