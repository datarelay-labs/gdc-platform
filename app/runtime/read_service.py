"""Read-only aggregation for runtime stats, health, dashboard, and log search (no DB writes)."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Literal, cast as type_cast

logger = logging.getLogger(__name__)

from sqlalchemy import Integer, cast as sql_cast, func
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, joinedload

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from app.logs.aggregates import aggregate_warn_error_summaries
from app.logs.aggregates import (
    aggregate_platform_outcome_buckets,
    dense_platform_outcome_buckets,
)
from app.logs.repository import (
    aggregate_failure_trend_buckets,
    list_checkpoint_update_logs_for_stream,
    list_delivery_logs_by_run_id,
    list_recent_delivery_logs_for_stream,
    list_recent_delivery_logs_global,
    list_recent_delivery_logs_global_since,
    list_timeline_delivery_logs_for_stream,
    page_delivery_logs,
    search_delivery_logs,
)
from app.mappings.models import Mapping
from app.enrichments.models import Enrichment
from app.routes.models import Route
from app.security.secrets import mask_secrets
from app.sources.models import Source
from app.formatters.config_resolver import resolve_formatter_config
from app.formatters.message_prefix import effective_message_prefix_enabled, effective_message_prefix_template
from app.runtime.metrics_window import bucket_seconds_for_window, max_buckets_for_window, normalize_metrics_window_token, parse_metrics_window
from app.runtime.health_repository import clamp_health_aggregate_window
from app.runtime.metric_contract import metric_meta_map
from app.runtime.visualization_contract import bucket_meta, visualization_meta_map
from app.runtime.aggregate_summaries import (
    summarize_delivery_outcomes,
    summarize_log_rows,
    summarize_processed_events,
    summarize_runtime_current,
)
from app.runtime.schemas import (
    CheckpointHistoryItem,
    CheckpointHistoryResponse,
    CheckpointStatsPayload,
    CheckpointTraceResponse,
    CheckpointTraceRouteFailureRef,
    CheckpointTraceTimelineNode,
    ConnectorUIConfigConnector,
    ConnectorUIConfigResponse,
    ConnectorUIConfigSourceSummary,
    ConnectorUIConfigStreamSummary,
    ConnectorUIConfigSummary,
    DashboardOutcomeBucket,
    DashboardOutcomeTimeseriesResponse,
    DashboardSummaryNumbers,
    DashboardSummaryResponse,
    DestinationUIConfigDestination,
    DestinationUIConfigResponse,
    DestinationUIConfigRouteItem,
    RecentDeliveryLogItem,
    RecentProblemRouteItem,
    RecentRateLimitedRouteItem,
    RecentUnhealthyStreamItem,
    RouteHealthItem,
    RouteHealthState,
    RouteRuntimeCounts,
    RouteRuntimeStatsItem,
    RuntimeLogSearchFilters,
    RuntimeLogSearchItem,
    RuntimeFailureTrendBucket,
    RuntimeFailureTrendResponse,
    RuntimeLogsPageItem,
    RuntimeLogsPageResponse,
    RuntimeLogsTotalsResponse,
    RuntimeLogSearchResponse,
    RuntimeTraceCheckpointEvent,
    RuntimeTraceConnectorRef,
    RuntimeTraceDestinationRef,
    RuntimeTraceResponse,
    RuntimeTraceRouteRef,
    RuntimeTraceStreamRef,
    RuntimeTraceTimelineEntry,
    RuntimeTimelineItem,
    RuntimeTimelineResponse,
    RouteUIConfigResponse,
    RouteUIConfigRoute,
    RouteUIConfigDestination,
    SourceUIConfigResponse,
    SourceUIConfigSource,
    SourceUIConfigStreamItem,
    StreamHealthResponse,
    StreamHealthState,
    StreamHealthSummary,
    StreamUIConfigEnrichmentSummary,
    StreamUIConfigMappingSummary,
    StreamUIConfigResponse,
    StreamUIConfigRouteSummary,
    StreamUIConfigSourceSummary,
    StreamUIConfigStream,
    MappingUIConfigEnrichment,
    MappingUIConfigMapping,
    MappingUIConfigResponse,
    MappingUIConfigRouteItem,
    StreamRuntimeLastSeen,
    StreamRuntimeStatsHealthBundleResponse,
    StreamRuntimeStatsResponse,
    StreamRuntimeSummary,
    WebhookIngestObservabilityResponse,
    WebhookIngestRecentResult,
    RuntimeAlertSummaryItem,
    RuntimeAlertSummaryResponse,
)
from app.scheduler.runtime_state import active_worker_count, scheduler_started_at, scheduler_uptime_seconds
from app.startup_readiness import get_startup_snapshot
from app.streams.models import Stream
from app.validation.schemas import ValidationOperationalSummaryResponse


class StreamNotFoundError(Exception):
    """Raised when stream_id is missing; router maps this to HTTP 404 STREAM_NOT_FOUND."""

    def __init__(self, stream_id: int) -> None:
        super().__init__(stream_id)
        self.stream_id = stream_id


class StreamNotWebhookReceiverError(Exception):
    """Raised when webhook-ingest observability is requested for a non-push source stream."""

    def __init__(self, stream_id: int) -> None:
        super().__init__(stream_id)
        self.stream_id = stream_id


_WEBHOOK_SOURCE_TYPES = frozenset({"WEBHOOK_RECEIVER", "WEBHOOK", "WEBHOOK_PUSH"})
_WEBHOOK_AUTH_ERROR_CODES = frozenset({"WEBHOOK_AUTH_FAILED", "WEBHOOK_AUTH_MODE_INVALID"})
_WEBHOOK_MALFORMED_ERROR_CODES = frozenset({"WEBHOOK_INVALID_PAYLOAD", "WEBHOOK_PAYLOAD_TOO_LARGE"})


class RouteNotFoundError(Exception):
    """Raised when route_id is missing; router maps this to HTTP 404 ROUTE_NOT_FOUND."""

    def __init__(self, route_id: int) -> None:
        super().__init__(route_id)
        self.route_id = route_id


class DestinationNotFoundError(Exception):
    """Raised when destination_id is missing; router maps this to HTTP 404 DESTINATION_NOT_FOUND."""

    def __init__(self, destination_id: int) -> None:
        super().__init__(destination_id)
        self.destination_id = destination_id


class SourceNotFoundError(Exception):
    """Raised when source_id is missing; router maps this to HTTP 404 SOURCE_NOT_FOUND."""

    def __init__(self, source_id: int) -> None:
        super().__init__(source_id)
        self.source_id = source_id


class ConnectorNotFoundError(Exception):
    """Raised when connector_id is missing; router maps this to HTTP 404 CONNECTOR_NOT_FOUND."""

    def __init__(self, connector_id: int) -> None:
        super().__init__(connector_id)
        self.connector_id = connector_id


class DeliveryLogNotFoundError(Exception):
    """Raised when delivery_logs.id is missing; router maps to HTTP 404."""

    def __init__(self, log_id: int) -> None:
        super().__init__(log_id)
        self.log_id = log_id


class RunTraceNotFoundError(Exception):
    """Raised when no delivery_logs rows exist for a run_id."""

    def __init__(self, run_id: str) -> None:
        super().__init__(run_id)
        self.run_id = run_id


_SUMMARY_STAGE_FIELDS = (
    "route_send_success",
    "route_send_failed",
    "route_retry_success",
    "route_retry_failed",
    "route_skip",
    "source_rate_limited",
    "destination_rate_limited",
    "route_unknown_failure_policy",
    "run_complete",
)

_ROUTE_COUNT_FIELDS = (
    "route_send_success",
    "route_send_failed",
    "route_retry_success",
    "route_retry_failed",
    "destination_rate_limited",
    "route_skip",
    "route_unknown_failure_policy",
)

_SUCCESS_STAGES = frozenset({"route_send_success", "route_retry_success"})
_FAILURE_STAGES = frozenset({"route_send_failed", "route_retry_failed"})
_RL_STAGES = frozenset({"source_rate_limited", "destination_rate_limited"})

_HEALTH_SUCCESS_STAGES = frozenset({"route_send_success", "route_retry_success"})
_HEALTH_FAILURE_STAGES = frozenset({"route_send_failed", "route_retry_failed", "route_unknown_failure_policy"})
_HEALTH_DEST_RATE_LIMIT_STAGES = frozenset({"destination_rate_limited"})
_STREAM_HEALTH_BAD_STAGES = _HEALTH_FAILURE_STAGES | _HEALTH_DEST_RATE_LIMIT_STAGES
_CONSEC_BAD_STAGES = _STREAM_HEALTH_BAD_STAGES

_DASHBOARD_SUCCESS_STAGES = _HEALTH_SUCCESS_STAGES
_DASHBOARD_FAILURE_STAGES = _HEALTH_FAILURE_STAGES
_DASHBOARD_RATE_LIMIT_STAGES = frozenset({"source_rate_limited", "destination_rate_limited"})
_DASHBOARD_UNHEALTHY_STREAM_STAGES = _DASHBOARD_FAILURE_STAGES | _DASHBOARD_RATE_LIMIT_STAGES

_STREAM_STATUS_RUNNING = "RUNNING"
_STREAM_STATUS_PAUSED = "PAUSED"
_STREAM_STATUS_ERROR = "ERROR"
_STREAM_STATUS_STOPPED = "STOPPED"
_STREAM_STATUS_RL_SOURCE = "RATE_LIMITED_SOURCE"
_STREAM_STATUS_RL_DEST = "RATE_LIMITED_DESTINATION"


def _dashboard_snapshot_time(snapshot_id: str | None) -> datetime:
    if not snapshot_id:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(snapshot_id.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("snapshot_id must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _dashboard_snapshot_id(generated_at: datetime) -> str:
    return generated_at.astimezone(timezone.utc).isoformat()


def _max_created_at(rows: list[DeliveryLog], stages: frozenset[str]) -> datetime | None:
    best: datetime | None = None
    for row in rows:
        if row.stage in stages:
            ts = row.created_at
            if best is None or ts > best:
                best = ts
    return best


def _compute_summary(logs: list[DeliveryLog]) -> StreamRuntimeSummary:
    acc = {k: 0 for k in _SUMMARY_STAGE_FIELDS}
    processed_events = 0
    for row in logs:
        if row.stage in acc:
            acc[row.stage] += 1
        if row.stage == "run_complete":
            payload = row.payload_sample if isinstance(row.payload_sample, dict) else {}
            raw = payload.get("input_events")
            if isinstance(raw, bool):
                continue
            try:
                processed_events += max(0, int(raw or 0))
            except (TypeError, ValueError):
                continue
    return StreamRuntimeSummary(total_logs=len(logs), processed_events=processed_events, **acc)


def _compute_summary_for_window(
    db: Session,
    stream_id: int,
    *,
    start_at: datetime,
    end_at: datetime,
) -> StreamRuntimeSummary:
    """Bounded SQL aggregates for windowed stats (avoids loading full delivery_logs windows)."""

    start_at, end_at = clamp_health_aggregate_window(start_at, end_at)
    acc = {k: 0 for k in _SUMMARY_STAGE_FIELDS}
    try:
        rows = (
            db.query(DeliveryLog.stage, func.count(DeliveryLog.id))
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.created_at >= start_at,
                DeliveryLog.created_at < end_at,
                DeliveryLog.stage.in_(_SUMMARY_STAGE_FIELDS),
            )
            .group_by(DeliveryLog.stage)
            .all()
        )
    except OperationalError:
        db.rollback()
        logger.warning("stream_summary_for_window_degraded stream_id=%s", stream_id)
        return StreamRuntimeSummary(total_logs=0, processed_events=0, **acc)
    total_logs = 0
    for stage, count in rows:
        key = str(stage)
        if key in acc:
            acc[key] = int(count or 0)
        total_logs += int(count or 0)
    try:
        processed = int(
            db.query(
                func.coalesce(
                    func.sum(
                        func.greatest(
                            0,
                            func.coalesce(
                                sql_cast(DeliveryLog.payload_sample.op("->>")("input_events"), Integer),
                                0,
                            ),
                        )
                    ),
                    0,
                )
            )
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.created_at >= start_at,
                DeliveryLog.created_at < end_at,
                DeliveryLog.stage == "run_complete",
                func.upper(func.coalesce(DeliveryLog.level, "")) != "DEBUG",
            )
            .scalar()
            or 0
        )
    except OperationalError:
        db.rollback()
        processed = 0
    return StreamRuntimeSummary(total_logs=total_logs, processed_events=processed, **acc)


def _route_counts_map_for_window(
    db: Session,
    stream_id: int,
    *,
    start_at: datetime,
    end_at: datetime,
) -> dict[int, dict[str, int]]:
    out: dict[int, dict[str, int]] = {}
    rows = (
        db.query(DeliveryLog.route_id, DeliveryLog.stage, func.count(DeliveryLog.id))
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.created_at >= start_at,
            DeliveryLog.created_at < end_at,
            DeliveryLog.route_id.isnot(None),
            DeliveryLog.stage.in_(_ROUTE_COUNT_FIELDS),
        )
        .group_by(DeliveryLog.route_id, DeliveryLog.stage)
        .all()
    )
    for route_id, stage, count in rows:
        rid = int(route_id)
        bucket = out.setdefault(rid, {k: 0 for k in _ROUTE_COUNT_FIELDS})
        key = str(stage)
        if key in bucket:
            bucket[key] = int(count or 0)
    return out


def _build_route_stats_items_for_window(
    db: Session,
    routes: list[Route],
    *,
    stream_id: int,
    start_at: datetime,
    end_at: datetime,
    log_sample: list[DeliveryLog],
) -> list[RouteRuntimeStatsItem]:
    counts_map = _route_counts_map_for_window(db, stream_id, start_at=start_at, end_at=end_at)
    items: list[RouteRuntimeStatsItem] = []
    for route in routes:
        dest = route.destination
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        rid = int(route.id)
        acc = counts_map.get(rid, {k: 0 for k in _ROUTE_COUNT_FIELDS})
        items.append(
            RouteRuntimeStatsItem(
                route_id=rid,
                destination_id=int(route.destination_id),
                destination_type=dest_type,
                enabled=bool(route.enabled),
                failure_policy=str(route.failure_policy),
                status=str(route.status),
                counts=RouteRuntimeCounts(**acc),
                last_success_at=_route_last_success(rid, log_sample),
                last_failure_at=_route_last_failure(rid, log_sample),
            )
        )
    return items


def _compute_last_seen(logs: list[DeliveryLog]) -> StreamRuntimeLastSeen:
    return StreamRuntimeLastSeen(
        success_at=_max_created_at(logs, _SUCCESS_STAGES),
        failure_at=_max_created_at(logs, _FAILURE_STAGES),
        rate_limited_at=_max_created_at(logs, _RL_STAGES),
    )


def _route_counts_for(route_id: int, logs: list[DeliveryLog]) -> RouteRuntimeCounts:
    acc = {k: 0 for k in _ROUTE_COUNT_FIELDS}
    for row in logs:
        if row.route_id != route_id:
            continue
        if row.stage in acc:
            acc[row.stage] += 1
    return RouteRuntimeCounts(**acc)


def _route_last_success(route_id: int, logs: list[DeliveryLog]) -> datetime | None:
    scoped = [r for r in logs if r.route_id == route_id]
    return _max_created_at(scoped, _SUCCESS_STAGES)


def _route_last_failure(route_id: int, logs: list[DeliveryLog]) -> datetime | None:
    scoped = [r for r in logs if r.route_id == route_id]
    return _max_created_at(scoped, _FAILURE_STAGES)


def _build_route_stats_items(routes: list[Route], logs: list[DeliveryLog]) -> list[RouteRuntimeStatsItem]:
    items: list[RouteRuntimeStatsItem] = []
    for route in routes:
        dest = route.destination
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        rid = int(route.id)
        items.append(
            RouteRuntimeStatsItem(
                route_id=rid,
                destination_id=int(route.destination_id),
                destination_type=dest_type,
                enabled=bool(route.enabled),
                failure_policy=str(route.failure_policy),
                status=str(route.status),
                counts=_route_counts_for(rid, logs),
                last_success_at=_route_last_success(rid, logs),
                last_failure_at=_route_last_failure(rid, logs),
            )
        )
    return items


def _recent_log_items(logs: list[DeliveryLog]) -> list[RecentDeliveryLogItem]:
    return [
        RecentDeliveryLogItem(
            id=int(row.id),
            stage=row.stage,
            level=row.level,
            status=row.status,
            message=row.message,
            route_id=row.route_id,
            destination_id=row.destination_id,
            error_code=row.error_code,
            created_at=row.created_at,
        )
        for row in logs
    ]


def _to_runtime_log_search_item(row: DeliveryLog) -> RuntimeLogSearchItem:
    return RuntimeLogSearchItem(
        id=int(row.id),
        connector_id=row.connector_id,
        stream_id=row.stream_id,
        route_id=row.route_id,
        destination_id=row.destination_id,
        run_id=row.run_id,
        stage=row.stage,
        level=row.level,
        status=row.status,
        message=row.message,
        retry_count=int(row.retry_count),
        http_status=row.http_status,
        latency_ms=row.latency_ms,
        error_code=row.error_code,
        created_at=row.created_at,
    )


def _to_logs_page_item(row: DeliveryLog) -> RuntimeLogsPageItem:
    return RuntimeLogsPageItem(
        id=int(row.id),
        created_at=row.created_at,
        connector_id=row.connector_id,
        stream_id=row.stream_id,
        route_id=row.route_id,
        destination_id=row.destination_id,
        run_id=row.run_id,
        stage=row.stage,
        level=row.level,
        status=row.status,
        message=row.message,
        error_code=row.error_code,
        retry_count=int(row.retry_count),
        http_status=row.http_status,
        latency_ms=row.latency_ms,
    )


def _to_timeline_item(row: DeliveryLog) -> RuntimeTimelineItem:
    return RuntimeTimelineItem(
        id=int(row.id),
        created_at=row.created_at,
        stream_id=int(row.stream_id) if row.stream_id is not None else None,
        route_id=int(row.route_id) if row.route_id is not None else None,
        destination_id=int(row.destination_id) if row.destination_id is not None else None,
        run_id=row.run_id,
        stage=row.stage,
        level=row.level,
        status=row.status,
        message=row.message,
        error_code=row.error_code,
        retry_count=int(row.retry_count),
        http_status=row.http_status,
        latency_ms=row.latency_ms,
    )


def _count_dashboard_log_categories(logs: list[DeliveryLog]) -> tuple[int, int, int]:
    successes = failures = rate_limited = 0
    for row in logs:
        if row.stage in _DASHBOARD_SUCCESS_STAGES:
            successes += 1
        elif row.stage in _DASHBOARD_FAILURE_STAGES:
            failures += 1
        elif row.stage in _DASHBOARD_RATE_LIMIT_STAGES:
            rate_limited += 1
    return successes, failures, rate_limited


def _dedupe_recent_problem_routes(logs: list[DeliveryLog]) -> list[RecentProblemRouteItem]:
    seen_route: set[int] = set()
    out: list[RecentProblemRouteItem] = []
    for row in logs:
        if row.route_id is None or row.stream_id is None:
            continue
        if row.stage not in _DASHBOARD_FAILURE_STAGES:
            continue
        rid = int(row.route_id)
        if rid in seen_route:
            continue
        seen_route.add(rid)
        out.append(
            RecentProblemRouteItem(
                stream_id=int(row.stream_id),
                route_id=rid,
                destination_id=int(row.destination_id) if row.destination_id is not None else None,
                stage=row.stage,
                error_code=row.error_code,
                message=row.message,
                created_at=row.created_at,
            )
        )
        if len(out) >= 10:
            break
    return out


def _dedupe_recent_rate_limited_routes(logs: list[DeliveryLog]) -> list[RecentRateLimitedRouteItem]:
    seen_route: set[int] = set()
    out: list[RecentRateLimitedRouteItem] = []
    for row in logs:
        if row.route_id is None or row.stream_id is None:
            continue
        if row.stage != "destination_rate_limited":
            continue
        rid = int(row.route_id)
        if rid in seen_route:
            continue
        seen_route.add(rid)
        out.append(
            RecentRateLimitedRouteItem(
                stream_id=int(row.stream_id),
                route_id=rid,
                destination_id=int(row.destination_id) if row.destination_id is not None else None,
                stage=row.stage,
                error_code=row.error_code,
                message=row.message,
                created_at=row.created_at,
            )
        )
        if len(out) >= 10:
            break
    return out


def _dedupe_recent_unhealthy_streams(
    logs: list[DeliveryLog],
    stream_status_by_id: dict[int, str],
) -> list[RecentUnhealthyStreamItem]:
    seen_stream: set[int] = set()
    out: list[RecentUnhealthyStreamItem] = []
    for row in logs:
        if row.stream_id is None:
            continue
        if row.stage not in _DASHBOARD_UNHEALTHY_STREAM_STAGES:
            continue
        sid = int(row.stream_id)
        if sid in seen_stream:
            continue
        seen_stream.add(sid)
        out.append(
            RecentUnhealthyStreamItem(
                stream_id=sid,
                stream_status=str(stream_status_by_id.get(sid, "")),
                last_problem_stage=row.stage,
                last_error_code=row.error_code,
                last_error_message=row.message,
                last_problem_at=row.created_at,
            )
        )
        if len(out) >= 10:
            break
    return out


def _logs_for_route(logs: list[DeliveryLog], route_id: int) -> list[DeliveryLog]:
    return [row for row in logs if row.route_id == route_id]


def _logs_newest_first(logs: list[DeliveryLog]) -> list[DeliveryLog]:
    return sorted(logs, key=lambda r: r.created_at, reverse=True)


def _route_success_failure_rl_counts(route_logs: list[DeliveryLog]) -> tuple[int, int, int]:
    success = sum(1 for row in route_logs if row.stage in _HEALTH_SUCCESS_STAGES)
    failure = sum(1 for row in route_logs if row.stage in _HEALTH_FAILURE_STAGES)
    rate_limited = sum(1 for row in route_logs if row.stage in _HEALTH_DEST_RATE_LIMIT_STAGES)
    return success, failure, rate_limited


def _last_ts_for_stages(route_logs: list[DeliveryLog], stages: frozenset[str]) -> datetime | None:
    scoped = [row.created_at for row in route_logs if row.stage in stages]
    return max(scoped) if scoped else None


def _last_error_fields(route_logs: list[DeliveryLog]) -> tuple[str | None, str | None]:
    bad_rows = [row for row in route_logs if row.stage in _CONSEC_BAD_STAGES]
    if not bad_rows:
        return None, None
    newest = max(bad_rows, key=lambda r: r.created_at)
    return newest.error_code, newest.message


def _consecutive_failure_count(route_logs_newest_first: list[DeliveryLog]) -> int:
    count = 0
    for row in route_logs_newest_first:
        if row.stage in _HEALTH_SUCCESS_STAGES:
            break
        if row.stage in _CONSEC_BAD_STAGES:
            count += 1
    return count


def _classify_enabled_route_health(route_logs: list[DeliveryLog]) -> str:
    if not route_logs:
        return "IDLE"
    has_success = any(row.stage in _HEALTH_SUCCESS_STAGES for row in route_logs)
    has_bad = any(row.stage in _STREAM_HEALTH_BAD_STAGES for row in route_logs)
    if has_bad and not has_success:
        return "UNHEALTHY"
    if has_success and has_bad:
        return "DEGRADED"
    if has_success and not has_bad:
        return "HEALTHY"
    return "IDLE"


def _compute_stream_health(logs: list[DeliveryLog], routes: list[Route]) -> str:
    if not logs:
        return "IDLE"
    if routes and all(not bool(r.enabled) for r in routes):
        return "IDLE"

    disabled_ids = {int(r.id) for r in routes if not bool(r.enabled)}
    scoped = [
        row
        for row in logs
        if row.route_id is None or int(row.route_id) not in disabled_ids
    ]
    if not scoped:
        return "IDLE"

    has_success = any(row.stage in _HEALTH_SUCCESS_STAGES for row in scoped)
    has_bad = any(row.stage in _STREAM_HEALTH_BAD_STAGES for row in scoped)
    if has_bad and not has_success:
        return "UNHEALTHY"
    if has_success and has_bad:
        return "DEGRADED"
    if has_success and not has_bad:
        return "HEALTHY"
    return "IDLE"


def _build_route_health_items(logs: list[DeliveryLog], routes: list[Route]) -> tuple[list[RouteHealthItem], StreamHealthSummary]:
    bucket = {"HEALTHY": 0, "DEGRADED": 0, "UNHEALTHY": 0, "DISABLED": 0, "IDLE": 0}
    items: list[RouteHealthItem] = []

    for route in routes:
        rid = int(route.id)
        route_logs = _logs_for_route(logs, rid)
        route_logs_nf = _logs_newest_first(route_logs)
        success_c, failure_c, rl_c = _route_success_failure_rl_counts(route_logs)
        last_err_code, last_err_msg = _last_error_fields(route_logs)
        consec = _consecutive_failure_count(route_logs_nf)

        dest = route.destination
        dest_type = str(dest.destination_type or "").strip().upper() if dest is not None else ""
        dest_enabled = bool(dest.enabled) if dest is not None else False

        if not bool(route.enabled):
            health_key = "DISABLED"
        else:
            health_key = _classify_enabled_route_health(route_logs)

        bucket[health_key] += 1

        items.append(
            RouteHealthItem(
                route_id=rid,
                destination_id=int(route.destination_id),
                destination_type=dest_type,
                route_enabled=bool(route.enabled),
                destination_enabled=dest_enabled,
                failure_policy=str(route.failure_policy),
                route_status=str(route.status),
                health=type_cast(RouteHealthState, health_key),
                success_count=success_c,
                failure_count=failure_c,
                rate_limited_count=rl_c,
                consecutive_failure_count=consec,
                last_success_at=_last_ts_for_stages(route_logs, _HEALTH_SUCCESS_STAGES),
                last_failure_at=_last_ts_for_stages(route_logs, _HEALTH_FAILURE_STAGES),
                last_rate_limited_at=_last_ts_for_stages(route_logs, _HEALTH_DEST_RATE_LIMIT_STAGES),
                last_error_code=last_err_code,
                last_error_message=last_err_msg,
            )
        )

    summary = StreamHealthSummary(
        total_routes=len(routes),
        healthy_routes=bucket["HEALTHY"],
        degraded_routes=bucket["DEGRADED"],
        unhealthy_routes=bucket["UNHEALTHY"],
        disabled_routes=bucket["DISABLED"],
        idle_routes=bucket["IDLE"],
    )
    return items, summary


def _load_stream_recent_logs_and_routes(
    db: Session,
    stream_id: int,
    limit: int,
    *,
    window: str | None = None,
    snapshot_id: str | None = None,
) -> tuple[Stream, list[DeliveryLog], list[Route]]:
    """Single stream lookup plus one delivery_logs scan and route list (shared by stats/health)."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)
    if window is not None:
        token_td = parse_metrics_window(window)
        until = _dashboard_snapshot_time(snapshot_id)
        since = until - token_td
        since, until = clamp_health_aggregate_window(since, until)
        sample_limit = min(max(int(limit), 50), 150)
        logs = (
            db.query(DeliveryLog)
            .filter(
                DeliveryLog.stream_id == stream_id,
                DeliveryLog.created_at >= since,
                DeliveryLog.created_at < until,
            )
            .order_by(DeliveryLog.created_at.desc(), DeliveryLog.id.desc())
            .limit(sample_limit)
            .all()
        )
        logs = list(reversed(logs))
    else:
        logs = list_recent_delivery_logs_for_stream(db, stream_id, limit=limit)
    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == stream_id)
        .order_by(Route.id.asc())
        .all()
    )
    return stream, logs, routes


def get_stream_runtime_stats(
    db: Session,
    stream_id: int,
    limit: int,
    *,
    window: str | None = None,
    snapshot_id: str | None = None,
) -> StreamRuntimeStatsResponse:
    if window is not None:
        from app.runtime.stream_runtime_snapshot_read import build_stream_stats_health_from_snapshot

        bundle = build_stream_stats_health_from_snapshot(
            db,
            stream_id,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )
        if bundle is not None:
            return bundle.stats

    stream, logs, routes = _load_stream_recent_logs_and_routes(
        db,
        stream_id,
        limit,
        window=window,
        snapshot_id=snapshot_id,
    )

    checkpoint_row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    checkpoint_out: CheckpointStatsPayload | None = None
    if checkpoint_row is not None:
        checkpoint_out = CheckpointStatsPayload(
            type=checkpoint_row.checkpoint_type,
            value=checkpoint_row.checkpoint_value_json or {},
        )

    if window is not None:
        token_td = parse_metrics_window(window)
        until = _dashboard_snapshot_time(snapshot_id)
        since = until - token_td
        summary = _compute_summary_for_window(db, stream_id, start_at=since, end_at=until)
        route_stats = _build_route_stats_items_for_window(
            db,
            routes,
            stream_id=stream_id,
            start_at=since,
            end_at=until,
            log_sample=logs,
        )
    else:
        summary = _compute_summary(logs)
        route_stats = _build_route_stats_items(routes, logs)

    return StreamRuntimeStatsResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        checkpoint=checkpoint_out,
        summary=summary,
        last_seen=_compute_last_seen(logs),
        routes=route_stats,
        recent_logs=_recent_log_items(logs[-limit:] if len(logs) > limit else logs),
    )


def _count_delivery_logs_in_window(
    db: Session,
    *,
    stream_id: int,
    since: datetime,
    until: datetime,
    stage: str | None = None,
    error_codes: frozenset[str] | None = None,
) -> int:
    q = db.query(func.count(DeliveryLog.id)).filter(
        DeliveryLog.stream_id == stream_id,
        DeliveryLog.created_at >= since,
        DeliveryLog.created_at < until,
    )
    if stage is not None:
        q = q.filter(DeliveryLog.stage == stage)
    if error_codes is not None:
        q = q.filter(DeliveryLog.error_code.in_(sorted(error_codes)))
    return int(q.scalar() or 0)


def _webhook_recent_ingest_from_logs(logs: list[DeliveryLog]) -> WebhookIngestRecentResult:
    """Derive latest ingest outcome from recent delivery_logs (newest-first list)."""

    run_complete = next((r for r in logs if r.stage == "run_complete"), None)
    if run_complete is not None:
        payload = run_complete.payload_sample if isinstance(run_complete.payload_sample, dict) else {}
        partial = bool(payload.get("partial_success"))
        status = str(run_complete.status or "").lower()
        outcome: Literal["success", "partial", "failed", "none"] = "success"
        if partial or status == "partial":
            outcome = "partial"
        elif status in {"failed", "error"} or run_complete.level == "ERROR":
            outcome = "failed"
        return WebhookIngestRecentResult(
            at=run_complete.created_at,
            outcome=outcome,
            stage=run_complete.stage,
            message=run_complete.message,
            run_id=str(run_complete.run_id) if run_complete.run_id else None,
        )
    run_started = next((r for r in logs if r.stage == "run_started"), None)
    if run_started is not None:
        return WebhookIngestRecentResult(
            at=run_started.created_at,
            outcome="none",
            stage=run_started.stage,
            message=run_started.message,
            run_id=str(run_started.run_id) if run_started.run_id else None,
        )
    return WebhookIngestRecentResult()


def get_webhook_ingest_observability(
    db: Session,
    stream_id: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
    log_limit: int = 20,
) -> WebhookIngestObservabilityResponse:
    """Aggregate webhook push ingest health from delivery_logs (read-only)."""

    stream = (
        db.query(Stream)
        .options(joinedload(Stream.source))
        .filter(Stream.id == stream_id)
        .first()
    )
    if stream is None:
        raise StreamNotFoundError(stream_id)
    source_type = str(stream.stream_type or "").strip().upper()
    if source_type not in _WEBHOOK_SOURCE_TYPES:
        raise StreamNotWebhookReceiverError(stream_id)

    td = parse_metrics_window(window)
    until = _dashboard_snapshot_time(snapshot_id)
    since = until - td
    lim = max(1, min(int(log_limit), 100))

    source = stream.source
    config = dict(source.config_json or {}) if source is not None else {}
    auth = dict(source.auth_json or {}) if source is not None else {}
    receiver_key = str(config.get("receiver_key") or "").strip() or None
    receiver_path = f"/api/v1/ingest/webhook/{receiver_key}" if receiver_key else None
    auth_mode = str(auth.get("auth_mode") or config.get("webhook_auth_mode") or "no_auth")

    recent_rows = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.created_at >= since,
            DeliveryLog.created_at < until,
        )
        .order_by(DeliveryLog.created_at.desc(), DeliveryLog.id.desc())
        .limit(lim)
        .all()
    )

    return WebhookIngestObservabilityResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        source_enabled=bool(source.enabled) if source is not None else True,
        stream_enabled=bool(stream.enabled),
        receiver_key=receiver_key,
        receiver_path=receiver_path,
        webhook_auth_mode=auth_mode,
        window=window,
        window_start=since,
        window_end=until,
        ingest_attempts=_count_delivery_logs_in_window(
            db, stream_id=stream_id, since=since, until=until, stage="run_started"
        ),
        successful_deliveries=_count_delivery_logs_in_window(
            db, stream_id=stream_id, since=since, until=until, stage="route_send_success"
        ),
        failed_deliveries=(
            _count_delivery_logs_in_window(db, stream_id=stream_id, since=since, until=until, stage="route_send_failed")
            + _count_delivery_logs_in_window(db, stream_id=stream_id, since=since, until=until, stage="route_retry_failed")
        ),
        auth_failures=_count_delivery_logs_in_window(
            db,
            stream_id=stream_id,
            since=since,
            until=until,
            error_codes=_WEBHOOK_AUTH_ERROR_CODES,
        ),
        malformed_payload_count=_count_delivery_logs_in_window(
            db,
            stream_id=stream_id,
            since=since,
            until=until,
            error_codes=_WEBHOOK_MALFORMED_ERROR_CODES,
        ),
        recent_ingest=_webhook_recent_ingest_from_logs(recent_rows),
        recent_logs=_recent_log_items(recent_rows),
    )


def get_stream_runtime_health(
    db: Session,
    stream_id: int,
    limit: int,
    *,
    window: str | None = "1h",
    snapshot_id: str | None = None,
) -> StreamHealthResponse:
    if window is not None:
        from app.runtime.stream_runtime_snapshot_read import build_stream_stats_health_from_snapshot

        bundle = build_stream_stats_health_from_snapshot(
            db,
            stream_id,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )
        if bundle is not None:
            return bundle.health

    stream, logs, routes = _load_stream_recent_logs_and_routes(db, stream_id, limit)
    route_items, summary = _build_route_health_items(logs, routes)
    stream_health = _compute_stream_health(logs, routes)

    return StreamHealthResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        health=type_cast(StreamHealthState, stream_health),
        limit=limit,
        summary=summary,
        routes=route_items,
    )


def get_stream_runtime_stats_and_health(
    db: Session,
    stream_id: int,
    limit: int,
    *,
    window: str | None = None,
    snapshot_id: str | None = None,
) -> StreamRuntimeStatsHealthBundleResponse:
    """Same payloads as separate stats + health endpoints, but one delivery_logs + routes read."""

    try:
        return _build_stream_runtime_stats_and_health(
            db,
            stream_id,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )
    except OperationalError:
        db.rollback()
        logger.warning("stream_runtime_stats_health_degraded stream_id=%s", stream_id)
        return get_degraded_stream_runtime_stats_and_health(db, stream_id, limit)


def _build_stream_runtime_stats_and_health(
    db: Session,
    stream_id: int,
    limit: int,
    *,
    window: str | None = None,
    snapshot_id: str | None = None,
) -> StreamRuntimeStatsHealthBundleResponse:
    if window is not None:
        from app.runtime.stream_runtime_snapshot_read import build_stream_stats_health_from_snapshot

        bundle = build_stream_stats_health_from_snapshot(
            db,
            stream_id,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )
        if bundle is not None:
            return bundle

    stream, logs, routes = _load_stream_recent_logs_and_routes(
        db,
        stream_id,
        limit,
        window=window,
        snapshot_id=snapshot_id,
    )

    checkpoint_row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    checkpoint_out: CheckpointStatsPayload | None = None
    if checkpoint_row is not None:
        checkpoint_out = CheckpointStatsPayload(
            type=checkpoint_row.checkpoint_type,
            value=checkpoint_row.checkpoint_value_json or {},
        )

    if window is not None:
        token_td = parse_metrics_window(window)
        until = _dashboard_snapshot_time(snapshot_id)
        since = until - token_td
        summary = _compute_summary_for_window(db, stream_id, start_at=since, end_at=until)
        route_stats = _build_route_stats_items_for_window(
            db,
            routes,
            stream_id=stream_id,
            start_at=since,
            end_at=until,
            log_sample=logs,
        )
    else:
        summary = _compute_summary(logs)
        route_stats = _build_route_stats_items(routes, logs)

    stats = StreamRuntimeStatsResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        checkpoint=checkpoint_out,
        summary=summary,
        last_seen=_compute_last_seen(logs),
        routes=route_stats,
        recent_logs=_recent_log_items(logs[-limit:] if len(logs) > limit else logs),
    )
    route_items, summary = _build_route_health_items(logs, routes)
    stream_health = _compute_stream_health(logs, routes)
    health = StreamHealthResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        health=type_cast(StreamHealthState, stream_health),
        limit=limit,
        summary=summary,
        routes=route_items,
    )
    return StreamRuntimeStatsHealthBundleResponse(stats=stats, health=health)


def get_degraded_stream_runtime_stats_and_health(db: Session, stream_id: int, limit: int) -> StreamRuntimeStatsHealthBundleResponse:
    """Empty stats/health when per-stream aggregation fails (list/summary APIs must stay 200)."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)
    empty_summary = StreamRuntimeSummary()
    stats = StreamRuntimeStatsResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        checkpoint=None,
        summary=empty_summary,
        last_seen=StreamRuntimeLastSeen(),
        routes=[],
        recent_logs=[],
    )
    health = StreamHealthResponse(
        stream_id=int(stream.id),
        stream_status=str(stream.status),
        health="DEGRADED",
        limit=limit,
        summary=StreamHealthSummary(),
        routes=[],
    )
    return StreamRuntimeStatsHealthBundleResponse(stats=stats, health=health)


def _runtime_engine_status(snap: Any) -> Literal["RUNNING", "STOPPED", "DEGRADED"]:
    if not snap.schema_ready or snap.connection_error:
        return "DEGRADED"
    started = scheduler_started_at()
    if started is not None and snap.scheduler_active:
        return "RUNNING"
    if not snap.scheduler_active:
        return "STOPPED"
    return "STOPPED"


def get_runtime_dashboard_summary(
    db: Session,
    limit: int,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> DashboardSummaryResponse:
    """Cross-stream dashboard summary.

    Uses ``runtime_*_snapshot`` when the physical read model is populated; otherwise
    falls back to legacy ``delivery_logs`` aggregates (not for operational overview).
    Historical windows (7d/30d) prefer analytics buckets; never full-scan delivery_logs.
    """

    from app.runtime import runtime_analytics_bucket_read_repository as bucket_read
    from app.runtime.metrics_window import OPERATIONAL_WINDOWS, normalize_metrics_window_token, parse_metrics_window
    from app.runtime.runtime_snapshot_analytics_repository import (
        load_runtime_dashboard_summary as _snapshot_dashboard_summary,
        snapshot_analytics_available,
    )

    token = normalize_metrics_window_token(window)
    td_seconds = int(parse_metrics_window(token).total_seconds())

    if snapshot_analytics_available(db) and token in OPERATIONAL_WINDOWS:
        try:
            return _snapshot_dashboard_summary(db, limit, window=token, snapshot_id=snapshot_id)
        except Exception:
            logger.exception("runtime_dashboard_summary_snapshot_degraded")

    if td_seconds > 24 * 3600:
        if bucket_read.historical_analytics_available(db):
            try:
                return _historical_dashboard_summary_from_buckets(
                    db, limit, window=token, snapshot_id=snapshot_id
                )
            except Exception:
                logger.exception("runtime_dashboard_summary_historical_buckets_degraded")
        if snapshot_analytics_available(db):
            try:
                proxy = _snapshot_dashboard_summary(db, limit, window="24h", snapshot_id=snapshot_id)
                return proxy.model_copy(
                    update={
                        "read_status": "degraded",
                        "warnings": [
                            f"{token} window served from 24h operational snapshot proxy "
                            "(historical analytics buckets unavailable)"
                        ],
                        "metrics_window_seconds": td_seconds,
                    }
                )
            except Exception:
                logger.exception("runtime_dashboard_summary_historical_proxy_degraded")
        return _degraded_runtime_dashboard_summary(window=token)

    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    current = summarize_runtime_current(db)
    td = parse_metrics_window(window)
    until = generated_at
    since = until - td
    logs = list_recent_delivery_logs_global_since(db, since=since, limit=limit)
    log_rows = summarize_log_rows(db, start_at=since, end_at=until)
    processed = summarize_processed_events(db, start_at=since, end_at=until)
    delivery = summarize_delivery_outcomes(
        db,
        start_at=since,
        end_at=until,
    )

    stream_ids_in_window = {int(r.stream_id) for r in logs if r.stream_id is not None}
    stream_status_by_id: dict[int, str] = {}
    if stream_ids_in_window:
        rows = db.query(Stream.id, Stream.status).filter(Stream.id.in_(stream_ids_in_window)).all()
        stream_status_by_id = {int(r[0]): str(r[1]) for r in rows}

    try:
        from app.runtime.health_service import get_health_overview

        live_health = get_health_overview(
            db,
            window=window,
            since=None,
            stream_id=None,
            route_id=None,
            destination_id=None,
            scoring_mode="current_runtime",
        )
        live_streams = live_health.streams
    except Exception:
        logger.exception("dashboard_current_runtime_stream_health_degraded")
        live_streams = None

    summary = DashboardSummaryNumbers(
        total_streams=current.total_streams,
        running_streams=current.running_streams,
        paused_streams=current.paused_streams,
        error_streams=current.error_streams,
        stopped_streams=current.stopped_streams,
        rate_limited_source_streams=current.rate_limited_source_streams,
        rate_limited_destination_streams=current.rate_limited_destination_streams,
        total_routes=current.total_routes,
        enabled_routes=current.enabled_routes,
        disabled_routes=current.disabled_routes,
        total_destinations=current.total_destinations,
        enabled_destinations=current.enabled_destinations,
        disabled_destinations=current.disabled_destinations,
        recent_logs=log_rows.total_rows,
        recent_successes=log_rows.success_rows,
        recent_failures=log_rows.failure_rows,
        recent_rate_limited=log_rows.rate_limited_rows,
        processed_events=processed.processed_events,
        delivery_outcome_events=delivery.total_events,
        delivery_success_events=delivery.success_events,
        delivery_failure_events=delivery.failure_events,
        current_runtime_streams_healthy=live_streams.healthy if live_streams is not None else 0,
        current_runtime_streams_degraded=live_streams.degraded if live_streams is not None else 0,
        current_runtime_streams_unhealthy=live_streams.unhealthy if live_streams is not None else 0,
        current_runtime_streams_critical=live_streams.critical if live_streams is not None else 0,
    )

    snap = get_startup_snapshot()
    started = scheduler_started_at()
    uptime = scheduler_uptime_seconds()
    workers = active_worker_count()
    engine = _runtime_engine_status(snap)

    try:
        from app.validation.ops_read import build_validation_operational_summary

        validation_operational = ValidationOperationalSummaryResponse.model_validate(
            build_validation_operational_summary(
                db,
                failures_limit=25,
                scoring_mode="current_runtime",
                window=window,
            )
        )
    except Exception:
        logger.exception("dashboard_validation_operational_degraded")
        validation_operational = degraded_validation_operational_summary(
            scoring_mode="current_runtime",
        )

    return DashboardSummaryResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        summary=summary,
        recent_problem_routes=_dedupe_recent_problem_routes(logs),
        recent_rate_limited_routes=_dedupe_recent_rate_limited_routes(logs),
        recent_unhealthy_streams=_dedupe_recent_unhealthy_streams(logs, stream_status_by_id),
        scheduler_started_at=started,
        scheduler_uptime_seconds=uptime,
        runtime_engine_status=engine,
        active_worker_count=workers,
        metrics_window_seconds=int(td.total_seconds()),
        window_start=since,
        window_end=until,
        metric_meta=metric_meta_map(
            "processed_events.window",
            "delivery_outcomes.window",
            "delivery_outcomes.success",
            "delivery_outcomes.failure",
            "runtime_telemetry_rows.window",
            "current_runtime.healthy_streams",
            "current_runtime.failed_routes",
            "route_config.total",
            "route_config.enabled",
            "route_config.disabled",
            "runtime.throughput.processed_events_per_second",
            window_start=since,
            window_end=until,
            generated_at=until,
        ),
        visualization_meta=visualization_meta_map(
            "runtime.throughput.window_avg_eps",
            "runtime.top_streams.throughput_share.window_avg_eps",
            snapshot_id=resolved_snapshot_id,
            generated_at=generated_at,
            window_start=since,
            window_end=until,
        ),
        validation_operational=validation_operational,
    )


def _degraded_runtime_dashboard_summary(*, window: str) -> DashboardSummaryResponse:
    """Empty dashboard summary when aggregation fails (HTTP 200 for operators)."""

    from app.runtime.schemas import DashboardSummaryNumbers

    td = parse_metrics_window(window)
    now = datetime.now(timezone.utc)
    return DashboardSummaryResponse(
        summary=DashboardSummaryNumbers(),
        recent_problem_routes=[],
        recent_rate_limited_routes=[],
        recent_unhealthy_streams=[],
        metrics_window_seconds=int(td.total_seconds()),
        window_start=now - td,
        window_end=now,
        read_status="degraded",
        warnings=[f"dashboard summary unavailable for window={window}"],
        validation_operational=degraded_validation_operational_summary(),
    )


def _historical_dashboard_summary_from_buckets(
    db: Session,
    limit: int,
    *,
    window: str,
    snapshot_id: str | None = None,
) -> DashboardSummaryResponse:
    """7d/30d dashboard summary from ``runtime_analytics_bucket_*`` (no delivery_logs scan)."""

    from app.runtime import runtime_analytics_bucket_read_repository as bucket_read
    from app.runtime.runtime_snapshot_analytics_repository import (
        load_runtime_dashboard_summary as _snapshot_dashboard_summary,
        snapshot_analytics_available,
    )

    token = normalize_metrics_window_token(window)
    td = parse_metrics_window(token)
    generated_at = _dashboard_snapshot_time(snapshot_id)
    since = generated_at - td

    if not snapshot_analytics_available(db):
        raise RuntimeError("snapshot read model required for historical dashboard shell")

    base = _snapshot_dashboard_summary(db, limit, window="24h", snapshot_id=snapshot_id)
    rows = bucket_read.fetch_platform_outcome_buckets(
        db, since=since, until=generated_at, window_seconds=int(td.total_seconds())
    )
    success = sum(int(r.success) for r in rows)
    failed = sum(int(r.failed) for r in rows)
    rate_limited = sum(int(r.rate_limited) for r in rows)
    summary = base.summary.model_copy(
        update={
            "recent_logs": success + failed + rate_limited,
            "recent_successes": success,
            "recent_failures": failed,
            "recent_rate_limited": rate_limited,
            "delivery_outcome_events": success + failed,
            "delivery_success_events": success,
            "delivery_failure_events": failed,
        }
    )
    warnings: list[str] = []
    read_status: Literal["ok", "partial", "degraded", "stale"] = "ok"
    if not rows:
        read_status = "partial"
        warnings.append(f"no analytics buckets for {token} window; stream/route posture from 24h snapshot")

    return base.model_copy(
        update={
            "summary": summary,
            "metrics_window_seconds": int(td.total_seconds()),
            "window_start": since,
            "window_end": generated_at,
            "read_status": read_status,
            "warnings": warnings,
        }
    )


def degraded_validation_operational_summary(
    *,
    scoring_mode: str = "current_runtime",
) -> ValidationOperationalSummaryResponse:
    """Zeroed operational summary when aggregation fails (HTTP 200 for operators)."""

    return ValidationOperationalSummaryResponse(
        failing_validations_count=0,
        degraded_validations_count=0,
        open_alerts_critical=0,
        open_alerts_warning=0,
        open_alerts_info=0,
        open_auth_failure_alerts=0,
        open_delivery_failure_alerts=0,
        open_checkpoint_drift_alerts=0,
        latest_open_alerts=[],
        latest_recoveries=[],
        outcome_trend_24h=[],
        scoring_mode=scoring_mode,
        degraded=True,
    )


def get_validation_operational_summary(
    db: Session,
    *,
    scoring_mode: str = "current_runtime",
    window: str | None = "1h",
) -> ValidationOperationalSummaryResponse:
    """Dedicated read-only endpoint for validation health (also embedded in dashboard summary)."""

    from app.validation.ops_read import build_validation_operational_summary

    try:
        payload = build_validation_operational_summary(
            db,
            failures_limit=50,
            scoring_mode=scoring_mode,  # type: ignore[arg-type]
            window=window,
        )
        out = ValidationOperationalSummaryResponse.model_validate(payload)
        if out.scoring_mode is None and isinstance(payload, dict):
            out = out.model_copy(update={"scoring_mode": payload.get("scoring_mode") or scoring_mode})
        return out
    except Exception:
        logger.exception("validation_operational_summary_degraded scoring_mode=%s", scoring_mode)
        return degraded_validation_operational_summary(scoring_mode=scoring_mode)


def get_dashboard_outcome_timeseries(
    db: Session,
    *,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> DashboardOutcomeTimeseriesResponse:
    """Dense time buckets for dashboard stacked volume chart (read-only).

    Short windows may be served from ``runtime_*_snapshot`` (operational bucket).
    Historical windows use ``runtime_analytics_bucket_*``; forensic fallback scans delivery_logs.
    """

    from app.runtime import runtime_analytics_bucket_read_repository as bucket_read
    from app.runtime.runtime_snapshot_analytics_repository import (
        load_operational_outcome_timeseries,
        snapshot_analytics_available,
    )

    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    td = parse_metrics_window(window)
    now = generated_at
    since = now - td
    bucket_sec = bucket_seconds_for_window(td)

    if snapshot_analytics_available(db) and int(td.total_seconds()) <= 3600:
        try:
            operational = load_operational_outcome_timeseries(
                db, window=window, snapshot_id=snapshot_id
            )
            if operational is not None:
                return operational
        except Exception:
            logger.exception("runtime_dashboard_outcome_timeseries_snapshot_degraded")

    if bucket_read.historical_analytics_available(db):
        try:
            src_resolution_seconds = 60 if int(td.total_seconds()) <= 24 * 3600 else 300
            raw = bucket_read.fetch_platform_outcome_buckets(
                db, since=since, until=now, window_seconds=int(td.total_seconds())
            )
            dense_rows = bucket_read.rebucket_platform_outcomes(
                raw,
                since=since,
                until=now,
                target_bucket_seconds=bucket_sec,
                source_bucket_seconds=src_resolution_seconds,
            )
            buckets = [
                DashboardOutcomeBucket(
                    bucket_start=r.bucket_start,
                    success=r.success,
                    failed=r.failed,
                    rate_limited=r.rate_limited,
                )
                for r in dense_rows
            ]
            bm = bucket_meta(bucket_sec, len(buckets))
            return DashboardOutcomeTimeseriesResponse(
                snapshot_id=resolved_snapshot_id,
                generated_at=generated_at,
                metrics_window_seconds=int(td.total_seconds()),
                window_start=since,
                window_end=now,
                metric_meta=metric_meta_map(
                    "delivery_outcomes.window", window_start=since, window_end=now, generated_at=now
                ),
                visualization_meta=visualization_meta_map(
                    "dashboard.delivery_outcomes.bucket_count",
                    bucket_size_seconds=bucket_sec,
                    bucket_count=len(buckets),
                    snapshot_id=resolved_snapshot_id,
                    generated_at=generated_at,
                    window_start=since,
                    window_end=now,
                ),
                bucket_size_seconds=bm["bucket_size_seconds"],
                bucket_count=bm["bucket_count"],
                bucket_alignment=bm["bucket_alignment"],
                bucket_timezone=bm["bucket_timezone"],
                bucket_mode=bm["bucket_mode"],
                buckets=buckets,
            )
        except Exception:
            logger.exception("runtime_dashboard_outcome_timeseries_bucket_degraded")

    sparse = aggregate_platform_outcome_buckets(
        db,
        start_at=since,
        end_at=now,
        bucket_seconds=bucket_sec,
    )
    mb = max_buckets_for_window(td, bucket_sec)
    dense_rows = dense_platform_outcome_buckets(
        sparse,
        start_at=since,
        end_at=now,
        bucket_seconds=bucket_sec,
        max_buckets=mb,
    )
    buckets = [
        DashboardOutcomeBucket(
            bucket_start=r.bucket_start,
            success=int(r.success),
            failed=int(r.failed),
            rate_limited=int(r.rate_limited),
        )
        for r in dense_rows
    ]
    bm = bucket_meta(bucket_sec, len(buckets))
    return DashboardOutcomeTimeseriesResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        metrics_window_seconds=int(td.total_seconds()),
        window_start=since,
        window_end=now,
        metric_meta=metric_meta_map("delivery_outcomes.window", window_start=since, window_end=now, generated_at=now),
        visualization_meta=visualization_meta_map(
            "dashboard.delivery_outcomes.bucket_count",
            bucket_size_seconds=bucket_sec,
            bucket_count=len(buckets),
            snapshot_id=resolved_snapshot_id,
            generated_at=generated_at,
            window_start=since,
            window_end=now,
        ),
        bucket_size_seconds=bm["bucket_size_seconds"],
        bucket_count=bm["bucket_count"],
        bucket_alignment=bm["bucket_alignment"],
        bucket_timezone=bm["bucket_timezone"],
        bucket_mode=bm["bucket_mode"],
        buckets=buckets,
    )


def get_stream_runtime_timeline(
    db: Session,
    stream_id: int,
    *,
    limit: int,
    stage: str | None = None,
    level: str | None = None,
    status: str | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
) -> RuntimeTimelineResponse:
    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    rows = list_timeline_delivery_logs_for_stream(
        db,
        stream_id,
        limit=limit,
        stage=stage,
        level=level,
        status=status,
        route_id=route_id,
        destination_id=destination_id,
    )
    items = [_to_timeline_item(r) for r in rows]
    return RuntimeTimelineResponse(stream_id=int(stream.id), total=len(items), items=items)


def get_runtime_failure_trend(
    db: Session,
    *,
    limit: int,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> RuntimeFailureTrendResponse:
    td = parse_metrics_window(window)
    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    since = generated_at - td
    rows = aggregate_failure_trend_buckets(
        db,
        limit=limit,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        created_at_since=since,
    )
    buckets = [
        RuntimeFailureTrendBucket(
            stage=str(r.stage),
            count=int(r.row_count),
            latest_created_at=r.latest_created_at,
            stream_id=int(r.stream_id) if r.stream_id is not None else None,
            route_id=int(r.route_id) if r.route_id is not None else None,
            destination_id=int(r.destination_id) if r.destination_id is not None else None,
            error_code=r.error_code,
        )
        for r in rows
    ]
    return RuntimeFailureTrendResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        metrics_window_seconds=int(td.total_seconds()),
        window_start=since,
        window_end=generated_at,
        metric_meta=metric_meta_map(
            "runtime_telemetry_rows.window",
            window_start=since,
            window_end=generated_at,
            generated_at=generated_at,
        ),
        visualization_meta=visualization_meta_map(
            "runtime_telemetry.rows.bucket_count",
            snapshot_id=resolved_snapshot_id,
            generated_at=generated_at,
            window_start=since,
            window_end=generated_at,
        ),
        total=len(buckets),
        buckets=buckets,
    )


def get_runtime_logs_page(
    db: Session,
    *,
    limit: int,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    run_id: str | None = None,
    stage: str | None = None,
    level: str | None = None,
    status: str | None = None,
    error_code: str | None = None,
    partial_success: bool | None = None,
    cursor_created_at: datetime | None = None,
    cursor_id: int | None = None,
    window: str | None = None,
    snapshot_id: str | None = None,
) -> RuntimeLogsPageResponse:
    since: datetime | None = None
    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    bucket_sec: int | None = None
    bucket_count: int | None = None
    if window is not None:
        td = parse_metrics_window(window)
        since = generated_at - td
        bucket_sec = bucket_seconds_for_window(td)
        bucket_count = max_buckets_for_window(td, bucket_sec)
    rows = page_delivery_logs(
        db,
        limit=limit,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        run_id=run_id,
        stage=stage,
        level=level,
        status=status,
        error_code=error_code,
        partial_success=partial_success,
        created_at_since=since,
        cursor_created_at=cursor_created_at,
        cursor_id=cursor_id,
    )
    has_next = len(rows) > limit
    page_rows = rows[:limit]
    items = [_to_logs_page_item(r) for r in page_rows]

    next_ca: datetime | None = None
    next_i: int | None = None
    if page_rows:
        last = page_rows[-1]
        next_ca = last.created_at
        next_i = int(last.id)

    bm = bucket_meta(bucket_sec, bucket_count) if bucket_sec is not None and bucket_count is not None else {}
    return RuntimeLogsPageResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        metrics_window_seconds=int(td.total_seconds()) if window is not None else None,
        window_start=since,
        window_end=generated_at if window is not None else None,
        bucket_size_seconds=bm.get("bucket_size_seconds"),
        bucket_count=bm.get("bucket_count"),
        bucket_alignment=bm.get("bucket_alignment"),
        bucket_timezone=bm.get("bucket_timezone"),
        bucket_mode=bm.get("bucket_mode"),
        total_returned=len(items),
        has_next=has_next,
        next_cursor_created_at=next_ca,
        next_cursor_id=next_i,
        metric_meta=metric_meta_map(
            "runtime_telemetry_rows.loaded",
            window_start=since,
            window_end=generated_at if window is not None else None,
            generated_at=generated_at,
        ),
        visualization_meta=visualization_meta_map(
            "runtime_telemetry.rows.bucket_count",
            bucket_size_seconds=bucket_sec,
            bucket_count=bucket_count,
            snapshot_id=resolved_snapshot_id,
            generated_at=generated_at,
            window_start=since,
            window_end=generated_at if window is not None else None,
        ),
        items=items,
    )


def get_runtime_logs_totals(
    db: Session,
    *,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    run_id: str | None = None,
    stage: str | None = None,
    level: str | None = None,
    status: str | None = None,
    error_code: str | None = None,
    partial_success: bool | None = None,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> RuntimeLogsTotalsResponse:
    td = parse_metrics_window(window)
    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    since = generated_at - td
    level_upper = func.upper(func.coalesce(DeliveryLog.level, ""))
    q = db.query(
        func.count(DeliveryLog.id).label("total_rows"),
        func.count(DeliveryLog.id).filter(level_upper == "ERROR").label("error_rows"),
        func.count(DeliveryLog.id).filter(level_upper.in_(("WARN", "WARNING"))).label("warning_rows"),
        func.count(DeliveryLog.id).filter(level_upper == "INFO").label("info_rows"),
        func.count(DeliveryLog.id).filter(level_upper == "DEBUG").label("debug_rows"),
    ).filter(
        DeliveryLog.created_at >= since,
        DeliveryLog.created_at < generated_at,
    )
    if stream_id is not None:
        q = q.filter(DeliveryLog.stream_id == stream_id)
    if route_id is not None:
        q = q.filter(DeliveryLog.route_id == route_id)
    if destination_id is not None:
        q = q.filter(DeliveryLog.destination_id == destination_id)
    if run_id is not None:
        q = q.filter(DeliveryLog.run_id == run_id)
    if stage is not None:
        q = q.filter(DeliveryLog.stage == stage)
    if level is not None:
        q = q.filter(DeliveryLog.level == level)
    if status is not None:
        q = q.filter(DeliveryLog.status == status)
    if error_code is not None:
        q = q.filter(DeliveryLog.error_code == error_code)
    if partial_success is not None:
        q = q.filter(DeliveryLog.stage == "run_complete")
        txt = DeliveryLog.payload_sample["partial_success"].astext
        q = q.filter(txt == "true") if partial_success else q.filter((txt == "false") | (txt.is_(None)))

    row = q.one()
    return RuntimeLogsTotalsResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        metrics_window_seconds=int(td.total_seconds()),
        window_start=since,
        window_end=generated_at,
        total_rows=int(row.total_rows or 0),
        error_rows=int(row.error_rows or 0),
        warning_rows=int(row.warning_rows or 0),
        info_rows=int(row.info_rows or 0),
        debug_rows=int(row.debug_rows or 0),
        metric_meta=metric_meta_map(
            "runtime_telemetry_rows.window",
            window_start=since,
            window_end=generated_at,
            generated_at=generated_at,
        ),
    )


def search_runtime_logs(
    db: Session,
    *,
    stream_id: int | None = None,
    route_id: int | None = None,
    destination_id: int | None = None,
    run_id: str | None = None,
    stage: str | None = None,
    level: str | None = None,
    status: str | None = None,
    error_code: str | None = None,
    partial_success: bool | None = None,
    limit: int = 100,
    window: str = "1h",
    snapshot_id: str | None = None,
) -> RuntimeLogSearchResponse:
    td = parse_metrics_window(window)
    generated_at = _dashboard_snapshot_time(snapshot_id)
    resolved_snapshot_id = _dashboard_snapshot_id(generated_at)
    since = generated_at - td
    bucket_sec = bucket_seconds_for_window(td)
    bucket_count = max_buckets_for_window(td, bucket_sec)
    rows = search_delivery_logs(
        db,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        run_id=run_id,
        stage=stage,
        level=level,
        status=status,
        error_code=error_code,
        partial_success=partial_success,
        created_at_since=since,
        limit=limit,
    )
    filters = RuntimeLogSearchFilters(
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        run_id=run_id,
        stage=stage,
        level=level,
        status=status,
        error_code=error_code,
        partial_success=partial_success,
        limit=limit,
        metrics_window_seconds=int(td.total_seconds()),
        window_start_at=since,
    )
    bm = bucket_meta(bucket_sec, bucket_count)
    return RuntimeLogSearchResponse(
        snapshot_id=resolved_snapshot_id,
        generated_at=generated_at,
        metrics_window_seconds=int(td.total_seconds()),
        window_start=since,
        window_end=generated_at,
        bucket_size_seconds=bm["bucket_size_seconds"],
        bucket_count=bm["bucket_count"],
        bucket_alignment=bm["bucket_alignment"],
        bucket_timezone=bm["bucket_timezone"],
        bucket_mode=bm["bucket_mode"],
        total_returned=len(rows),
        filters=filters,
        metric_meta=metric_meta_map(
            "runtime_telemetry_rows.loaded",
            "runtime_telemetry_rows.window",
            window_start=since,
            window_end=generated_at,
            generated_at=generated_at,
        ),
        visualization_meta=visualization_meta_map(
            "runtime_telemetry.rows.bucket_count",
            bucket_size_seconds=bucket_sec,
            bucket_count=bucket_count,
            snapshot_id=resolved_snapshot_id,
            generated_at=generated_at,
            window_start=since,
            window_end=generated_at,
        ),
        logs=[_to_runtime_log_search_item(r) for r in rows],
    )


def _row_payload(row: DeliveryLog | None) -> dict[str, Any]:
    if row is None:
        return {}
    raw = row.payload_sample
    return dict(raw) if isinstance(raw, dict) else {}


def _checkpoint_after_preview(val: Any) -> str | None:
    if val is None:
        return None
    if isinstance(val, dict):
        lse = val.get("last_success_event")
        if isinstance(lse, dict):
            for k in ("event_id", "id", "@timestamp", "timestamp"):
                if k in lse:
                    return str(lse[k])[:240]
        return str(val)[:240]
    return str(val)[:240]


def _runtime_checkpoint_event_from_row(r: DeliveryLog) -> RuntimeTraceCheckpointEvent:
    ps = _row_payload(r)
    corr_raw = ps.get("correlated_route_failures")
    corr_list: list[dict[str, Any]] = []
    if isinstance(corr_raw, list):
        corr_list = [c for c in corr_raw if isinstance(c, dict)]

    def _maybe_int(key: str) -> int | None:
        v = ps.get(key)
        return int(v) if isinstance(v, int) else None

    return RuntimeTraceCheckpointEvent(
        checkpoint_type=str(ps["checkpoint_type"]) if ps.get("checkpoint_type") is not None else None,
        message=r.message,
        checkpoint_before=ps.get("checkpoint_before") if isinstance(ps.get("checkpoint_before"), dict) else None,
        checkpoint_after=ps.get("checkpoint_after") if isinstance(ps.get("checkpoint_after"), dict) else None,
        processed_events=_maybe_int("processed_events"),
        delivered_events=_maybe_int("delivered_events"),
        failed_events=_maybe_int("failed_events"),
        partial_success=bool(ps["partial_success"]) if isinstance(ps.get("partial_success"), bool) else None,
        update_reason=str(ps["update_reason"]) if isinstance(ps.get("update_reason"), str) else None,
        correlated_route_failures=corr_list,
    )


def _build_checkpoint_trace_timeline(rows: list[DeliveryLog]) -> list[CheckpointTraceTimelineNode]:
    nodes: list[CheckpointTraceTimelineNode] = []
    for r in rows:
        ps = _row_payload(r)
        if r.stage == "run_started":
            nodes.append(
                CheckpointTraceTimelineNode(
                    kind="run_started",
                    title="Run started",
                    detail="Correlation established for this execution",
                    tone="neutral",
                    created_at=r.created_at,
                    log_id=int(r.id),
                )
            )
        elif r.stage == "parse":
            ec = ps.get("extracted_event_count")
            nodes.append(
                CheckpointTraceTimelineNode(
                    kind="extract",
                    title="Events extracted",
                    detail=f"{ec} events" if ec is not None else None,
                    tone="success",
                    created_at=r.created_at,
                    log_id=int(r.id),
                )
            )
        elif r.stage == "route_send_success":
            ec = ps.get("event_count")
            nodes.append(
                CheckpointTraceTimelineNode(
                    kind="route_delivery",
                    title="Delivered batch to destination",
                    detail=f"{ec} events via route #{r.route_id}" if ec is not None else f"route #{r.route_id}",
                    tone="success",
                    created_at=r.created_at,
                    log_id=int(r.id),
                )
            )
        elif r.stage == "route_send_failed":
            nodes.append(
                CheckpointTraceTimelineNode(
                    kind="route_failure",
                    title="Destination delivery failed",
                    detail=r.message[:280] if r.message else None,
                    tone="error",
                    created_at=r.created_at,
                    log_id=int(r.id),
                )
            )
        elif r.stage == "checkpoint_update":
            preview = _checkpoint_after_preview(ps.get("checkpoint_after"))
            ur = ps.get("update_reason")
            nodes.append(
                CheckpointTraceTimelineNode(
                    kind="checkpoint_update",
                    title="Checkpoint advanced",
                    detail=f"{ur}: {preview}" if ur and preview else (preview or str(ur) if ur else None),
                    tone="warning" if ps.get("partial_success") else "success",
                    created_at=r.created_at,
                    log_id=int(r.id),
                )
            )
        elif r.stage == "run_complete":
            proc = ps.get("processed_events")
            deliv = ps.get("delivered_events")
            pend = ps.get("retry_pending")
            nodes.append(
                CheckpointTraceTimelineNode(
                    kind="run_complete",
                    title="Run completed",
                    detail=f"processed={proc} delivered={deliv}" + (f"; retry_pending={pend}" if pend else ""),
                    tone="warning" if ps.get("partial_success") else "neutral",
                    created_at=r.created_at,
                    log_id=int(r.id),
                )
            )
    return nodes


def _build_checkpoint_trace_response(db: Session, rows: list[DeliveryLog], run_id: str) -> CheckpointTraceResponse:
    if not rows:
        raise RunTraceNotFoundError(run_id)

    ck_ps = _row_payload(next((r for r in rows if r.stage == "checkpoint_update"), None))
    rc_ps = _row_payload(next((r for r in reversed(rows) if r.stage == "run_complete"), None))
    rs_ps = _row_payload(next((r for r in rows if r.stage == "run_started"), None))

    stream_id = int(rows[0].stream_id) if rows[0].stream_id is not None else None
    stream_name: str | None = None
    connector_name: str | None = None
    if stream_id is not None:
        stream_row = db.query(Stream).filter(Stream.id == stream_id).first()
        if stream_row is not None:
            stream_name = str(stream_row.name or "")
            conn_row = db.query(Connector).filter(Connector.id == int(stream_row.connector_id)).first()
            if conn_row is not None:
                connector_name = str(conn_row.name or "")

    def _merge_field(key: str) -> Any:
        if ck_ps.get(key) is not None:
            return ck_ps.get(key)
        if rc_ps.get(key) is not None:
            return rc_ps.get(key)
        return rs_ps.get(key)

    ct_raw = _merge_field("checkpoint_type")
    checkpoint_type = str(ct_raw) if ct_raw is not None else None

    before = ck_ps.get("checkpoint_before")
    if not isinstance(before, dict):
        before = rs_ps.get("checkpoint_before") if isinstance(rs_ps.get("checkpoint_before"), dict) else None
    after = ck_ps.get("checkpoint_after") if isinstance(ck_ps.get("checkpoint_after"), dict) else None
    if after is None and isinstance(rc_ps.get("checkpoint_after"), dict):
        after = rc_ps.get("checkpoint_after")

    processed = rc_ps.get("processed_events")
    delivered = rc_ps.get("delivered_events")
    failed = rc_ps.get("failed_events")
    partial = rc_ps.get("partial_success") if isinstance(rc_ps.get("partial_success"), bool) else None
    update_reason = rc_ps.get("update_reason") if isinstance(rc_ps.get("update_reason"), str) else None
    retry_pending = rc_ps.get("retry_pending") if isinstance(rc_ps.get("retry_pending"), bool) else None

    failures = [
        CheckpointTraceRouteFailureRef(
            route_id=int(r.route_id),
            destination_id=int(r.destination_id) if r.destination_id is not None else None,
            stage=str(r.stage),
            message=str(r.message or ""),
            error_code=r.error_code,
            created_at=r.created_at,
        )
        for r in rows
        if r.stage in ("route_send_failed", "route_retry_failed") and r.route_id is not None
    ]

    timeline = _build_checkpoint_trace_timeline(rows)

    return CheckpointTraceResponse(
        run_id=run_id,
        stream_id=stream_id,
        stream_name=stream_name,
        connector_name=connector_name,
        checkpoint_type=checkpoint_type,
        checkpoint_before=before if isinstance(before, dict) else None,
        checkpoint_after=after,
        processed_events=int(processed) if isinstance(processed, int) else None,
        delivered_events=int(delivered) if isinstance(delivered, int) else None,
        failed_events=int(failed) if isinstance(failed, int) else None,
        partial_success=partial,
        update_reason=update_reason,
        retry_pending=retry_pending,
        correlated_route_failures=failures,
        timeline_events=timeline,
    )


def get_checkpoint_trace_for_run(db: Session, run_id: str, *, stream_id: int | None = None) -> CheckpointTraceResponse:
    rows = list_delivery_logs_by_run_id(db, run_id, stream_id=stream_id)
    return _build_checkpoint_trace_response(db, rows, run_id)


def get_stream_checkpoint_history(db: Session, stream_id: int, *, limit: int = 50) -> CheckpointHistoryResponse:
    stream_row = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream_row is None:
        raise StreamNotFoundError(stream_id)
    rows = list_checkpoint_update_logs_for_stream(db, stream_id, limit=limit)
    items: list[CheckpointHistoryItem] = []
    for r in rows:
        ps = _row_payload(r)
        prev = _checkpoint_after_preview(ps.get("checkpoint_after"))
        ps_bool = ps.get("partial_success")
        partial_opt: bool | None = bool(ps_bool) if isinstance(ps_bool, bool) else None
        ur = ps.get("update_reason")
        items.append(
            CheckpointHistoryItem(
                log_id=int(r.id),
                run_id=r.run_id,
                created_at=r.created_at,
                checkpoint_type=str(ps["checkpoint_type"]) if ps.get("checkpoint_type") is not None else None,
                update_reason=str(ur) if isinstance(ur, str) else None,
                partial_success=partial_opt,
                checkpoint_after_preview=prev,
            )
        )
    return CheckpointHistoryResponse(stream_id=stream_id, items=items)


def _assemble_runtime_trace(
    db: Session,
    *,
    timeline_rows: list[DeliveryLog],
    anchor_log_id: int | None,
    resolved_run_id: str | None,
) -> RuntimeTraceResponse:
    checkpoint_ev: RuntimeTraceCheckpointEvent | None = None
    for r in timeline_rows:
        if r.stage == "checkpoint_update":
            checkpoint_ev = _runtime_checkpoint_event_from_row(r)
            break

    timeline = [
        RuntimeTraceTimelineEntry(
            id=int(r.id),
            created_at=r.created_at,
            stage=r.stage,
            level=r.level,
            status=r.status,
            message=r.message,
            route_id=int(r.route_id) if r.route_id is not None else None,
            destination_id=int(r.destination_id) if r.destination_id is not None else None,
            latency_ms=r.latency_ms,
            retry_count=int(r.retry_count or 0),
            http_status=r.http_status,
            error_code=r.error_code,
        )
        for r in timeline_rows
    ]

    stream_id: int | None = None
    if timeline_rows:
        sid = timeline_rows[0].stream_id
        stream_id = int(sid) if sid is not None else None

    connector_ref: RuntimeTraceConnectorRef | None = None
    stream_ref: RuntimeTraceStreamRef | None = None
    routes_out: list[RuntimeTraceRouteRef] = []
    dest_out: list[RuntimeTraceDestinationRef] = []
    if stream_id is not None:
        stream_row = db.query(Stream).filter(Stream.id == stream_id).first()
        if stream_row is not None:
            stream_ref = RuntimeTraceStreamRef(id=int(stream_row.id), name=str(stream_row.name or ""))
            conn_row = db.query(Connector).filter(Connector.id == int(stream_row.connector_id)).first()
            if conn_row is not None:
                connector_ref = RuntimeTraceConnectorRef(id=int(conn_row.id), name=str(conn_row.name or ""))
            route_rows = db.query(Route).filter(Route.stream_id == stream_id).all()
            seen_dest: set[int] = set()
            for rr in route_rows:
                dest = (
                    db.query(Destination).filter(Destination.id == int(rr.destination_id)).first()
                    if rr.destination_id is not None
                    else None
                )
                dname = str(dest.name) if dest is not None and dest.name else ""
                label = f"Route #{rr.id} → {dname}" if dname else f"Route #{rr.id}"
                routes_out.append(
                    RuntimeTraceRouteRef(
                        id=int(rr.id),
                        destination_id=int(rr.destination_id) if rr.destination_id is not None else None,
                        label=label,
                    )
                )
                if dest is not None and int(dest.id) not in seen_dest:
                    seen_dest.add(int(dest.id))
                    dest_out.append(
                        RuntimeTraceDestinationRef(id=int(dest.id), name=str(dest.name or f"Destination #{dest.id}"))
                    )

    return RuntimeTraceResponse(
        run_id=resolved_run_id,
        anchor_log_id=anchor_log_id,
        stream_id=stream_id,
        connector=connector_ref,
        stream=stream_ref,
        routes=routes_out,
        destinations=dest_out,
        timeline=timeline,
        checkpoint=checkpoint_ev,
    )


def get_runtime_trace_for_delivery_log(db: Session, log_id: int) -> RuntimeTraceResponse:
    row = db.query(DeliveryLog).filter(DeliveryLog.id == log_id).first()
    if row is None:
        raise DeliveryLogNotFoundError(log_id)
    run_id = row.run_id
    stream_id = int(row.stream_id) if row.stream_id is not None else None
    if run_id:
        timeline_rows = list_delivery_logs_by_run_id(db, run_id, stream_id=stream_id)
    else:
        timeline_rows = [row]
    return _assemble_runtime_trace(
        db,
        timeline_rows=timeline_rows,
        anchor_log_id=log_id,
        resolved_run_id=run_id,
    )


def get_runtime_trace_for_run(db: Session, run_id: str) -> RuntimeTraceResponse:
    rows = list_delivery_logs_by_run_id(db, run_id, stream_id=None)
    if not rows:
        raise RunTraceNotFoundError(run_id)
    stream_id = int(rows[0].stream_id) if rows[0].stream_id is not None else None
    scoped = list_delivery_logs_by_run_id(db, run_id, stream_id=stream_id)
    return _assemble_runtime_trace(
        db,
        timeline_rows=scoped,
        anchor_log_id=None,
        resolved_run_id=run_id,
    )


def get_runtime_alert_summary(
    db: Session,
    *,
    window: str = "1h",
    limit: int = 100,
) -> RuntimeAlertSummaryResponse:
    td = parse_metrics_window(window)
    end_at = datetime.now(timezone.utc)
    start_at = end_at - td
    rows = aggregate_warn_error_summaries(db, start_at=start_at, end_at=end_at, limit=limit)
    items: list[RuntimeAlertSummaryItem] = []
    for r in rows:
        sev: Literal["WARN", "ERROR"] = "ERROR" if r.severity == "ERROR" else "WARN"
        items.append(
            RuntimeAlertSummaryItem(
                stream_id=r.stream_id,
                stream_name=r.stream_name,
                connector_name=r.connector_name,
                severity=sev,
                count=r.count,
                latest_occurrence=r.latest_occurrence,
            )
        )
    return RuntimeAlertSummaryResponse(metrics_window_seconds=int(td.total_seconds()), items=items)


def get_mapping_ui_config(db: Session, stream_id: int) -> MappingUIConfigResponse:
    stream = db.query(Stream).options(joinedload(Stream.source)).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    source = stream.source
    source_id = int(source.id) if source is not None else int(stream.source_id)
    source_type = str(source.source_type) if source is not None else ""
    source_config = dict(source.config_json or {}) if source is not None else {}

    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    if mapping is None:
        mapping_out = MappingUIConfigMapping(
            exists=False,
            event_array_path=None,
            event_root_path=None,
            field_mappings={},
            raw_payload_mode=None,
        )
    else:
        mapping_out = MappingUIConfigMapping(
            exists=True,
            event_array_path=mapping.event_array_path,
            event_root_path=mapping.event_root_path,
            field_mappings=dict(mapping.field_mappings_json or {}),
            raw_payload_mode=mapping.raw_payload_mode,
        )

    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
    if enrichment is None:
        enrichment_out = MappingUIConfigEnrichment(
            exists=False,
            enabled=False,
            enrichment={},
            override_policy=None,
        )
    else:
        enrichment_out = MappingUIConfigEnrichment(
            exists=True,
            enabled=bool(enrichment.enabled),
            enrichment=dict(enrichment.enrichment_json or {}),
            override_policy=str(enrichment.override_policy),
        )

    routes = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == stream_id)
        .order_by(Route.id.asc())
        .all()
    )
    route_items: list[MappingUIConfigRouteItem] = []
    for route in routes:
        destination = route.destination
        route_items.append(
            MappingUIConfigRouteItem(
                route_id=int(route.id),
                destination_id=int(route.destination_id),
                destination_name=str(destination.name) if destination is not None else None,
                destination_type=str(destination.destination_type) if destination is not None else None,
                route_enabled=bool(route.enabled),
                destination_enabled=bool(destination.enabled) if destination is not None else False,
                formatter_config=dict(route.formatter_config_json or {}),
                route_rate_limit=dict(route.rate_limit_json or {}),
                failure_policy=str(route.failure_policy),
            )
        )

    return MappingUIConfigResponse(
        stream_id=int(stream.id),
        stream_name=str(stream.name),
        stream_enabled=bool(stream.enabled),
        stream_status=str(stream.status),
        source_id=source_id,
        source_type=source_type,
        source_config=mask_secrets(source_config),
        mapping=mapping_out,
        enrichment=enrichment_out,
        routes=route_items,
        message="Mapping UI config loaded successfully",
    )


def get_route_ui_config(db: Session, route_id: int) -> RouteUIConfigResponse:
    route = db.query(Route).options(joinedload(Route.destination)).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)

    destination = route.destination
    destination_config = dict(destination.config_json or {}) if destination is not None else {}
    route_formatter = dict(route.formatter_config_json or {})
    dest_type = str(destination.destination_type or "").strip().upper() if destination is not None else ""
    effective_formatter = (
        resolve_formatter_config(destination_config, route_formatter or None)
        if destination is not None
        else dict(route_formatter)
    )
    effective_formatter = {
        **effective_formatter,
        "message_prefix_enabled": effective_message_prefix_enabled(route_formatter, dest_type),
        "message_prefix_template": effective_message_prefix_template(route_formatter),
    }
    route_rate_limit = dict(route.rate_limit_json or {})
    effective_rate_limit = route_rate_limit if route_rate_limit else dict(destination.rate_limit_json or {}) if destination is not None else {}

    return RouteUIConfigResponse(
        route=RouteUIConfigRoute(
            id=int(route.id),
            stream_id=int(route.stream_id),
            destination_id=int(route.destination_id),
            enabled=bool(route.enabled),
            failure_policy=str(route.failure_policy),
            formatter_config_json=route_formatter,
            rate_limit_json=route_rate_limit,
        ),
        destination=RouteUIConfigDestination(
            id=int(destination.id) if destination is not None else None,
            name=str(destination.name) if destination is not None else None,
            destination_type=str(destination.destination_type) if destination is not None else None,
            enabled=bool(destination.enabled) if destination is not None else False,
            config_json=destination_config,
            rate_limit_json=dict(destination.rate_limit_json or {}) if destination is not None else {},
        ),
        effective_formatter_config=effective_formatter,
        effective_rate_limit=effective_rate_limit,
        message="Route UI config loaded successfully",
    )


def get_destination_ui_config(db: Session, destination_id: int) -> DestinationUIConfigResponse:
    destination = db.query(Destination).filter(Destination.id == destination_id).first()
    if destination is None:
        raise DestinationNotFoundError(destination_id)

    routes = (
        db.query(Route)
        .options(joinedload(Route.stream))
        .filter(Route.destination_id == destination_id)
        .order_by(Route.id.asc())
        .all()
    )
    route_items: list[DestinationUIConfigRouteItem] = []
    for route in routes:
        stream = route.stream
        route_items.append(
            DestinationUIConfigRouteItem(
                id=int(route.id),
                stream_id=int(route.stream_id),
                stream_name=str(stream.name) if stream is not None else None,
                enabled=bool(route.enabled),
                failure_policy=str(route.failure_policy),
                formatter_config_json=dict(route.formatter_config_json or {}),
                rate_limit_json=dict(route.rate_limit_json or {}),
            )
        )

    return DestinationUIConfigResponse(
        destination=DestinationUIConfigDestination(
            id=int(destination.id),
            name=str(destination.name),
            destination_type=str(destination.destination_type),
            enabled=bool(destination.enabled),
            config_json=mask_secrets(dict(destination.config_json or {})),
            rate_limit_json=dict(destination.rate_limit_json or {}),
        ),
        routes=route_items,
        message="Destination UI config loaded successfully",
    )


def get_stream_ui_config(db: Session, stream_id: int) -> StreamUIConfigResponse:
    stream = (
        db.query(Stream)
        .options(joinedload(Stream.source))
        .filter(Stream.id == stream_id)
        .first()
    )
    if stream is None:
        raise StreamNotFoundError(stream_id)

    source = stream.source
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
    route_rows = (
        db.query(Route)
        .options(joinedload(Route.destination))
        .filter(Route.stream_id == stream_id)
        .order_by(Route.id.asc())
        .all()
    )

    routes: list[StreamUIConfigRouteSummary] = []
    for route in route_rows:
        destination = route.destination
        routes.append(
            StreamUIConfigRouteSummary(
                id=int(route.id),
                destination_id=int(route.destination_id),
                destination_name=str(destination.name) if destination is not None else None,
                destination_type=str(destination.destination_type) if destination is not None else None,
                enabled=bool(route.enabled),
                destination_enabled=bool(destination.enabled) if destination is not None else False,
                failure_policy=str(route.failure_policy),
            )
        )

    return StreamUIConfigResponse(
        stream=StreamUIConfigStream(
            id=int(stream.id),
            connector_id=int(stream.connector_id),
            source_id=int(stream.source_id),
            name=str(stream.name),
            stream_type=str(stream.stream_type),
            enabled=bool(stream.enabled),
            status=str(stream.status),
            polling_interval=int(stream.polling_interval),
            config_json=dict(stream.config_json or {}),
            rate_limit_json=dict(stream.rate_limit_json or {}),
        ),
        source=StreamUIConfigSourceSummary(
            id=int(source.id) if source is not None else None,
            source_type=str(source.source_type) if source is not None else None,
            enabled=bool(source.enabled) if source is not None else False,
            config_json=dict(source.config_json or {}) if source is not None else {},
        ),
        mapping=StreamUIConfigMappingSummary(
            exists=mapping is not None,
            event_array_path=mapping.event_array_path if mapping is not None else None,
            event_root_path=mapping.event_root_path if mapping is not None else None,
            raw_payload_mode=mapping.raw_payload_mode if mapping is not None else None,
        ),
        enrichment=StreamUIConfigEnrichmentSummary(
            exists=enrichment is not None,
            enabled=bool(enrichment.enabled) if enrichment is not None else False,
            override_policy=str(enrichment.override_policy) if enrichment is not None else None,
        ),
        routes=routes,
        message="Stream UI config loaded successfully",
    )


def get_source_ui_config(db: Session, source_id: int) -> SourceUIConfigResponse:
    source = (
        db.query(Source)
        .options(joinedload(Source.streams))
        .filter(Source.id == source_id)
        .first()
    )
    if source is None:
        raise SourceNotFoundError(source_id)

    stream_rows = (
        db.query(Stream)
        .filter(Stream.source_id == source_id)
        .order_by(Stream.id.asc())
        .all()
    )
    route_counts_rows = (
        db.query(Route.stream_id, func.count(Route.id))
        .filter(Route.stream_id.in_([s.id for s in stream_rows]))
        .group_by(Route.stream_id)
        .all()
        if stream_rows
        else []
    )
    route_count_by_stream = {int(stream_id): int(cnt) for stream_id, cnt in route_counts_rows}

    streams: list[SourceUIConfigStreamItem] = []
    for stream in stream_rows:
        streams.append(
            SourceUIConfigStreamItem(
                id=int(stream.id),
                name=str(stream.name),
                stream_type=str(stream.stream_type),
                enabled=bool(stream.enabled),
                status=str(stream.status),
                polling_interval=int(stream.polling_interval),
                config_json=dict(stream.config_json or {}),
                rate_limit_json=dict(stream.rate_limit_json or {}),
                route_count=route_count_by_stream.get(int(stream.id), 0),
            )
        )

    return SourceUIConfigResponse(
        source=SourceUIConfigSource(
            id=int(source.id),
            connector_id=int(source.connector_id),
            source_type=str(source.source_type),
            enabled=bool(source.enabled),
            config_json=mask_secrets(dict(source.config_json or {})),
            auth_json=mask_secrets(dict(source.auth_json or {})),
        ),
        streams=streams,
        message="Source UI config loaded successfully",
    )


def get_connector_ui_config(db: Session, connector_id: int) -> ConnectorUIConfigResponse:
    connector = db.query(Connector).filter(Connector.id == connector_id).first()
    if connector is None:
        raise ConnectorNotFoundError(connector_id)

    source_rows = (
        db.query(Source)
        .filter(Source.connector_id == connector_id)
        .order_by(Source.id.asc())
        .all()
    )
    stream_rows = (
        db.query(Stream)
        .filter(Stream.connector_id == connector_id)
        .order_by(Stream.id.asc())
        .all()
    )

    stream_count_by_source: dict[int, int] = {}
    if source_rows:
        counts = (
            db.query(Stream.source_id, func.count(Stream.id))
            .filter(Stream.connector_id == connector_id)
            .group_by(Stream.source_id)
            .all()
        )
        stream_count_by_source = {int(source_id): int(cnt) for source_id, cnt in counts}

    route_count_by_stream: dict[int, int] = {}
    if stream_rows:
        counts = (
            db.query(Route.stream_id, func.count(Route.id))
            .filter(Route.stream_id.in_([stream.id for stream in stream_rows]))
            .group_by(Route.stream_id)
            .all()
        )
        route_count_by_stream = {int(stream_id): int(cnt) for stream_id, cnt in counts}

    sources: list[ConnectorUIConfigSourceSummary] = []
    for source in source_rows:
        sources.append(
            ConnectorUIConfigSourceSummary(
                id=int(source.id),
                source_type=str(source.source_type),
                enabled=bool(source.enabled),
                stream_count=stream_count_by_source.get(int(source.id), 0),
            )
        )

    streams: list[ConnectorUIConfigStreamSummary] = []
    for stream in stream_rows:
        streams.append(
            ConnectorUIConfigStreamSummary(
                id=int(stream.id),
                source_id=int(stream.source_id),
                name=str(stream.name),
                stream_type=str(stream.stream_type),
                enabled=bool(stream.enabled),
                status=str(stream.status),
                polling_interval=int(stream.polling_interval),
                route_count=route_count_by_stream.get(int(stream.id), 0),
            )
        )

    return ConnectorUIConfigResponse(
        connector=ConnectorUIConfigConnector(
            id=int(connector.id),
            name=str(connector.name),
            description=connector.description,
            status=str(connector.status),
        ),
        sources=sources,
        streams=streams,
        summary=ConnectorUIConfigSummary(
            source_count=len(sources),
            stream_count=len(streams),
            enabled_stream_count=sum(1 for stream in streams if stream.enabled),
            route_count=sum(stream.route_count for stream in streams),
        ),
        message="Connector UI config loaded successfully",
    )
