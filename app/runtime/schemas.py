"""Pydantic schemas for runtime read-only APIs."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, StrictBool, field_validator, model_validator

from app.runtime.analytics_schemas import MetricMetaMap
from app.validation.schemas import ValidationOperationalSummaryResponse

VisualizationMetaMap = dict[str, dict[str, Any]]
BucketMetaMap = dict[str, Any]


class CheckpointStatsPayload(BaseModel):
    """Checkpoint snapshot for runtime stats (read-only)."""

    type: str
    value: dict[str, Any] = Field(default_factory=dict)


class StreamRuntimeSummary(BaseModel):
    """Stage counts within the recent delivery_logs window."""

    total_logs: int = 0
    route_send_success: int = 0
    route_send_failed: int = 0
    route_retry_success: int = 0
    route_retry_failed: int = 0
    route_skip: int = 0
    source_rate_limited: int = 0
    destination_rate_limited: int = 0
    route_unknown_failure_policy: int = 0
    run_complete: int = 0
    processed_events: int = Field(
        default=0,
        description="Sum of payload_sample.input_events on run_complete rows; not delivery_logs row count.",
    )


class StreamRuntimeLastSeen(BaseModel):
    """Most recent timestamps by outcome within the recent logs window."""

    success_at: datetime | None = None
    failure_at: datetime | None = None
    rate_limited_at: datetime | None = None


class RouteRuntimeCounts(BaseModel):
    """Per-route stage counts within the recent delivery_logs window."""

    route_send_success: int = 0
    route_send_failed: int = 0
    route_retry_success: int = 0
    route_retry_failed: int = 0
    destination_rate_limited: int = 0
    route_skip: int = 0
    route_unknown_failure_policy: int = 0


class RouteRuntimeStatsItem(BaseModel):
    """One route row with destination context and log-derived stats."""

    route_id: int
    destination_id: int
    destination_type: str
    enabled: bool
    failure_policy: str
    status: str
    counts: RouteRuntimeCounts
    last_success_at: datetime | None = None
    last_failure_at: datetime | None = None


class RecentDeliveryLogItem(BaseModel):
    """Subset of delivery_logs for UI (no payload_sample)."""

    id: int
    stage: str
    level: str
    status: str | None = None
    message: str
    route_id: int | None = None
    destination_id: int | None = None
    error_code: str | None = None
    created_at: datetime


class StreamRuntimeStatsResponse(BaseModel):
    """GET /runtime/stats/stream/{stream_id} response body."""

    stream_id: int
    stream_status: str
    checkpoint: CheckpointStatsPayload | None = None
    summary: StreamRuntimeSummary
    last_seen: StreamRuntimeLastSeen
    routes: list[RouteRuntimeStatsItem]
    recent_logs: list[RecentDeliveryLogItem]


class WebhookIngestRecentResult(BaseModel):
    """Latest pipeline ingest outcome from committed delivery_logs (if any)."""

    at: datetime | None = None
    outcome: Literal["success", "partial", "failed", "none"] = "none"
    stage: str | None = None
    message: str | None = None
    run_id: str | None = None


class WebhookIngestObservabilityResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/webhook-ingest — delivery_logs aggregation for push ingest."""

    stream_id: int
    stream_status: str
    source_enabled: bool
    stream_enabled: bool
    receiver_key: str | None = None
    receiver_path: str | None = None
    webhook_auth_mode: str = "no_auth"
    window: str
    window_start: datetime
    window_end: datetime
    ingest_attempts: int = Field(
        default=0,
        description="run_started rows in window (pipeline entries after auth/parse).",
    )
    successful_deliveries: int = 0
    failed_deliveries: int = 0
    auth_failures: int = Field(
        default=0,
        description="delivery_logs rows with WEBHOOK_AUTH_* error_code when logged.",
    )
    malformed_payload_count: int = Field(
        default=0,
        description="delivery_logs rows with WEBHOOK_INVALID_PAYLOAD or WEBHOOK_PAYLOAD_TOO_LARGE when logged.",
    )
    recent_ingest: WebhookIngestRecentResult
    recent_logs: list[RecentDeliveryLogItem]


StreamHealthState = Literal["HEALTHY", "DEGRADED", "UNHEALTHY", "IDLE"]
RouteHealthState = Literal["DISABLED", "HEALTHY", "DEGRADED", "UNHEALTHY", "IDLE"]


class StreamHealthSummary(BaseModel):
    """Route health bucket counts for dashboard."""

    total_routes: int = 0
    healthy_routes: int = 0
    degraded_routes: int = 0
    unhealthy_routes: int = 0
    disabled_routes: int = 0
    idle_routes: int = 0


class RouteHealthItem(BaseModel):
    """Per-route delivery health derived from recent delivery_logs."""

    route_id: int
    destination_id: int
    destination_type: str
    route_enabled: bool
    destination_enabled: bool
    failure_policy: str
    route_status: str
    health: RouteHealthState
    success_count: int = 0
    failure_count: int = 0
    rate_limited_count: int = 0
    consecutive_failure_count: int = 0
    last_success_at: datetime | None = None
    last_failure_at: datetime | None = None
    last_rate_limited_at: datetime | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None


class StreamHealthResponse(BaseModel):
    """GET /runtime/health/stream/{stream_id} response body."""

    stream_id: int
    stream_status: str
    health: StreamHealthState
    limit: int
    summary: StreamHealthSummary
    routes: list[RouteHealthItem]


class StreamRuntimeStatsHealthBundleResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/stats-health — stats + health with one delivery_logs scan."""

    stats: StreamRuntimeStatsResponse
    health: StreamHealthResponse


class StreamStatsHealthBulkEntry(BaseModel):
    """One stream row in GET /runtime/streams/stats-health/bulk."""

    events_per_second: float = 0.0
    events_1h: int = 0
    events_24h: int | None = None
    health: str = "idle"
    last_event_at: datetime | None = None
    issue: str | None = None
    stats: StreamRuntimeStatsResponse
    health_detail: StreamHealthResponse


class BulkStreamStatsHealthResponse(BaseModel):
    """GET /runtime/streams/stats-health/bulk — bulk stats-health for Streams Console."""

    window: str
    snapshot_id: str | None = None
    streams: dict[str, StreamStatsHealthBulkEntry]


class StreamMetricsCheckpoint(BaseModel):
    """Checkpoint block embedded in stream runtime metrics."""

    type: str
    value: dict[str, Any] = Field(default_factory=dict)


class StreamMetricsStreamBlock(BaseModel):
    """Stream identity + runtime timestamps for metrics panel."""

    id: int
    name: str
    status: str
    last_run_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error_at: datetime | None = None
    last_checkpoint: StreamMetricsCheckpoint | None = None


class StreamRuntimeKpis(BaseModel):
    """Rolling KPI window (default: last 1 hour, aligned server-side)."""

    events_last_hour: int = 0
    delivered_last_hour: int = 0
    failed_last_hour: int = 0
    delivery_success_rate: float | None = None
    avg_latency_ms: float = 0.0
    max_latency_ms: float = 0.0
    error_rate: float = 0.0
    metric_meta: MetricMetaMap = Field(default_factory=dict)


class StreamMetricsTimeBucket(BaseModel):
    """One time bucket for throughput visualization."""

    timestamp: datetime
    events: int = 0
    delivered: int = 0
    failed: int = 0


class ThroughputTimePoint(BaseModel):
    """Delivered throughput estimate per bucket."""

    timestamp: datetime
    events_per_sec: float = 0.0


class LatencyTimePoint(BaseModel):
    """Average delivery latency per bucket (successful sends only)."""

    timestamp: datetime
    avg_latency_ms: float = 0.0


class StreamMetricsRouteHealthRow(BaseModel):
    """Per-route delivery metrics for runtime dashboard."""

    route_id: int
    destination_name: str
    destination_type: str
    enabled: bool
    success_count: int = 0
    failed_count: int = 0
    last_success_at: datetime | None = None
    last_failure_at: datetime | None = None
    avg_latency_ms: float = 0.0
    failure_policy: str
    last_error_message: str | None = None


class StreamMetricsCheckpointHistoryItem(BaseModel):
    """Checkpoint history derived from checkpoints.updated_at (no separate audit table)."""

    updated_at: datetime
    checkpoint_preview: str


class StreamMetricsRecentRun(BaseModel):
    """One committed run_complete row (approximates a runner cycle)."""

    run_id: str
    started_at: datetime
    duration_ms: int = 0
    status: Literal["SUCCESS", "PARTIAL", "FAILED", "NO_EVENTS"]
    events: int = 0
    delivered: int = 0
    failed: int = 0


class RouteRuntimeLatencyTrendPoint(BaseModel):
    timestamp: datetime
    avg_latency_ms: float


class RouteRuntimeSuccessRateTrendPoint(BaseModel):
    timestamp: datetime
    success_rate: float


class RouteRuntimeMetricsRow(BaseModel):
    """Per-route operational metrics (1h window + trends + connectivity)."""

    route_id: int
    destination_id: int
    destination_name: str
    destination_type: str
    enabled: bool
    route_status: str
    success_rate: float
    events_last_hour: int
    delivered_last_hour: int
    failed_last_hour: int
    avg_latency_ms: float
    p95_latency_ms: float
    max_latency_ms: float
    eps_current: float
    retry_count_last_hour: int
    last_success_at: datetime | None = None
    last_failure_at: datetime | None = None
    last_error_message: str | None = None
    last_error_code: str | None = None
    failure_policy: str
    connectivity_state: Literal["HEALTHY", "DEGRADED", "ERROR", "DISABLED"]
    disable_reason: str | None = None
    latency_trend: list[RouteRuntimeLatencyTrendPoint]
    success_rate_trend: list[RouteRuntimeSuccessRateTrendPoint]


class RecentRouteErrorItem(BaseModel):
    """One recent committed route-scoped failure row for the operational panel."""

    created_at: datetime
    route_id: int
    destination_id: int | None = None
    destination_name: str
    error_code: str | None = None
    message: str


class StreamRuntimeMetricsResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/metrics — Datadog-style runtime metrics."""

    snapshot_id: str | None = None
    generated_at: datetime | None = None
    stream: StreamMetricsStreamBlock
    kpis: StreamRuntimeKpis
    metrics_window_seconds: int = 3600
    window_start: datetime | None = None
    window_end: datetime | None = None
    metric_meta: MetricMetaMap = Field(default_factory=dict)
    visualization_meta: VisualizationMetaMap = Field(default_factory=dict)
    bucket_size_seconds: int | None = None
    bucket_count: int | None = None
    bucket_alignment: str | None = None
    bucket_timezone: str | None = None
    bucket_mode: str | None = None
    events_over_time: list[StreamMetricsTimeBucket]
    throughput_over_time: list[ThroughputTimePoint] = Field(default_factory=list)
    latency_over_time: list[LatencyTimePoint] = Field(default_factory=list)
    route_health: list[StreamMetricsRouteHealthRow]
    checkpoint_history: list[StreamMetricsCheckpointHistoryItem]
    recent_runs: list[StreamMetricsRecentRun]
    route_runtime: list[RouteRuntimeMetricsRow] = Field(default_factory=list)
    recent_route_errors: list[RecentRouteErrorItem] = Field(default_factory=list)


class DashboardSummaryNumbers(BaseModel):
    """Aggregate counts for the runtime dashboard (DB + recent logs window)."""

    total_streams: int = 0
    running_streams: int = 0
    paused_streams: int = 0
    error_streams: int = 0
    stopped_streams: int = 0
    rate_limited_source_streams: int = 0
    rate_limited_destination_streams: int = 0
    total_routes: int = 0
    enabled_routes: int = 0
    disabled_routes: int = 0
    total_destinations: int = 0
    enabled_destinations: int = 0
    disabled_destinations: int = 0
    recent_logs: int = 0
    recent_successes: int = 0
    recent_failures: int = 0
    recent_rate_limited: int = 0
    processed_events: int = 0
    delivery_outcome_events: int = 0
    delivery_success_events: int = 0
    delivery_failure_events: int = 0
    current_runtime_streams_healthy: int = 0
    current_runtime_streams_degraded: int = 0
    current_runtime_streams_unhealthy: int = 0
    current_runtime_streams_critical: int = 0


class RecentProblemRouteItem(BaseModel):
    """One recent failure log row tied to a route."""

    stream_id: int
    route_id: int
    destination_id: int | None = None
    stage: str
    error_code: str | None = None
    message: str
    created_at: datetime


class RecentRateLimitedRouteItem(BaseModel):
    """One recent destination_rate_limited log tied to a route."""

    stream_id: int
    route_id: int
    destination_id: int | None = None
    stage: str
    error_code: str | None = None
    message: str
    created_at: datetime


class RecentUnhealthyStreamItem(BaseModel):
    """Latest problem signal per stream within the recent logs window."""

    stream_id: int
    stream_status: str
    last_problem_stage: str
    last_error_code: str | None = None
    last_error_message: str | None = None
    last_problem_at: datetime


class DashboardSummaryResponse(BaseModel):
    """GET /runtime/dashboard/summary response body."""

    snapshot_id: str | None = None
    generated_at: datetime | None = None
    summary: DashboardSummaryNumbers
    recent_problem_routes: list[RecentProblemRouteItem]
    recent_rate_limited_routes: list[RecentRateLimitedRouteItem]
    recent_unhealthy_streams: list[RecentUnhealthyStreamItem]
    scheduler_started_at: datetime | None = None
    scheduler_uptime_seconds: float | None = None
    runtime_engine_status: Literal["RUNNING", "STOPPED", "DEGRADED"] = "STOPPED"
    active_worker_count: int | None = None
    metrics_window_seconds: int = 3600
    window_start: datetime | None = None
    window_end: datetime | None = None
    metric_meta: MetricMetaMap = Field(default_factory=dict)
    visualization_meta: VisualizationMetaMap = Field(default_factory=dict)
    validation_operational: ValidationOperationalSummaryResponse | None = None
    read_status: Literal["ok", "degraded", "partial", "stale"] = "ok"
    warnings: list[str] = Field(default_factory=list)


class DashboardOutcomeBucket(BaseModel):
    """One aligned bucket for cross-stream success / failed / rate-limited counts."""

    bucket_start: datetime
    success: int = 0
    failed: int = 0
    rate_limited: int = 0


class DashboardOutcomeTimeseriesResponse(BaseModel):
    """GET /runtime/dashboard/outcome-timeseries response body (read-only)."""

    snapshot_id: str | None = None
    generated_at: datetime | None = None
    metrics_window_seconds: int
    window_start: datetime | None = None
    window_end: datetime | None = None
    metric_meta: MetricMetaMap = Field(default_factory=dict)
    visualization_meta: VisualizationMetaMap = Field(default_factory=dict)
    bucket_size_seconds: int | None = None
    bucket_count: int | None = None
    bucket_alignment: str | None = None
    bucket_timezone: str | None = None
    bucket_mode: str | None = None
    buckets: list[DashboardOutcomeBucket] = Field(default_factory=list)


class ObservabilitySummaryTotals(BaseModel):
    """Canonical top-level observability totals shared by runtime/operations pages."""

    streams_total: int = 0
    streams_running: int = 0
    routes_total: int = 0
    routes_enabled: int = 0
    healthy_routes: int = 0
    idle_routes: int = 0
    unhealthy_routes: int = 0
    critical_routes: int = 0
    delivery_success_events: int = 0
    delivery_failed_events: int = 0
    retry_success_events: int = 0
    retry_failed_events: int = 0
    runtime_telemetry_rows: int = 0
    lifecycle_rows: int = 0
    processed_events: int = 0
    throughput_eps: float = 0.0
    p95_latency_ms: float | None = None


class ObservabilitySummaryResponse(BaseModel):
    """GET /runtime/observability/summary canonical metric snapshot."""

    snapshot_id: str
    generated_at: datetime
    window: str
    window_start: datetime
    window_end: datetime
    metric_contract_version: str
    totals: ObservabilitySummaryTotals
    metric_contract: dict[str, Any] = Field(default_factory=dict)
    metric_meta: MetricMetaMap = Field(default_factory=dict)


class RuntimeAlertSummaryItem(BaseModel):
    """One grouped WARN/ERROR summary row."""

    stream_id: int
    stream_name: str
    connector_name: str
    severity: Literal["WARN", "ERROR"]
    count: int
    latest_occurrence: datetime


class RuntimeAlertSummaryResponse(BaseModel):
    """GET /runtime/logs/alerts/summary — grouped delivery_logs WARN/ERROR totals."""

    metrics_window_seconds: int
    items: list[RuntimeAlertSummaryItem]


class RuntimeSystemResourcesResponse(BaseModel):
    """GET /runtime/system/resources — local host metrics."""

    cpu_percent: float
    memory_percent: float
    memory_used_bytes: int
    memory_total_bytes: int
    disk_percent: float
    disk_used_bytes: int
    disk_total_bytes: int
    network_in_bytes_per_sec: float
    network_out_bytes_per_sec: float


class RuntimeLogSearchFilters(BaseModel):
    """Echo of query filters used for GET /runtime/logs/search."""

    stream_id: int | None = None
    route_id: int | None = None
    destination_id: int | None = None
    run_id: str | None = None
    stage: str | None = None
    level: str | None = None
    status: str | None = None
    error_code: str | None = None
    partial_success: bool | None = None
    limit: int = 100
    metrics_window_seconds: int | None = None
    window_start_at: datetime | None = None


class RuntimeLogSearchItem(BaseModel):
    """delivery_logs row without payload_sample."""

    id: int
    connector_id: int | None = None
    stream_id: int | None = None
    route_id: int | None = None
    destination_id: int | None = None
    run_id: str | None = None
    stage: str
    level: str
    status: str | None = None
    message: str
    retry_count: int = 0
    http_status: int | None = None
    latency_ms: int | None = None
    error_code: str | None = None
    created_at: datetime


class RuntimeLogSearchResponse(BaseModel):
    """GET /runtime/logs/search response body."""

    snapshot_id: str | None = None
    generated_at: datetime | None = None
    metrics_window_seconds: int | None = None
    window_start: datetime | None = None
    window_end: datetime | None = None
    bucket_size_seconds: int | None = None
    bucket_count: int | None = None
    bucket_alignment: str | None = None
    bucket_timezone: str | None = None
    bucket_mode: str | None = None
    total_returned: int
    filters: RuntimeLogSearchFilters
    metric_meta: MetricMetaMap = Field(default_factory=dict)
    visualization_meta: VisualizationMetaMap = Field(default_factory=dict)
    logs: list[RuntimeLogSearchItem]


class RuntimeLogsPageItem(BaseModel):
    """One delivery_logs row for cursor pagination (no payload_sample)."""

    id: int
    created_at: datetime
    connector_id: int | None = None
    stream_id: int | None = None
    route_id: int | None = None
    destination_id: int | None = None
    run_id: str | None = None
    stage: str
    level: str
    status: str | None = None
    message: str
    error_code: str | None = None
    retry_count: int = 0
    http_status: int | None = None
    latency_ms: int | None = None


class RuntimeLogsPageResponse(BaseModel):
    """GET /runtime/logs/page response body."""

    snapshot_id: str | None = None
    generated_at: datetime | None = None
    metrics_window_seconds: int | None = None
    window_start: datetime | None = None
    window_end: datetime | None = None
    bucket_size_seconds: int | None = None
    bucket_count: int | None = None
    bucket_alignment: str | None = None
    bucket_timezone: str | None = None
    bucket_mode: str | None = None
    total_returned: int
    has_next: bool
    next_cursor_created_at: datetime | None = None
    next_cursor_id: int | None = None
    metric_meta: MetricMetaMap = Field(default_factory=dict)
    visualization_meta: VisualizationMetaMap = Field(default_factory=dict)
    items: list[RuntimeLogsPageItem]


class RuntimeLogsTotalsResponse(BaseModel):
    """GET /runtime/logs/totals full-window telemetry row totals."""

    snapshot_id: str | None = None
    generated_at: datetime | None = None
    metrics_window_seconds: int
    window_start: datetime
    window_end: datetime
    total_rows: int = 0
    error_rows: int = 0
    warning_rows: int = 0
    info_rows: int = 0
    debug_rows: int = 0
    metric_meta: MetricMetaMap = Field(default_factory=dict)


class RuntimeTraceConnectorRef(BaseModel):
    id: int
    name: str


class RuntimeTraceStreamRef(BaseModel):
    id: int
    name: str


class RuntimeTraceRouteRef(BaseModel):
    id: int
    destination_id: int | None = None
    label: str


class RuntimeTraceDestinationRef(BaseModel):
    id: int
    name: str


class RuntimeTraceCheckpointEvent(BaseModel):
    checkpoint_type: str | None = None
    message: str | None = None
    checkpoint_before: dict[str, Any] | None = None
    checkpoint_after: dict[str, Any] | None = None
    processed_events: int | None = None
    delivered_events: int | None = None
    failed_events: int | None = None
    partial_success: bool | None = None
    update_reason: str | None = None
    correlated_route_failures: list[dict[str, Any]] = Field(default_factory=list)


class CheckpointTraceRouteFailureRef(BaseModel):
    """Route-level delivery failure correlated with a checkpoint trace."""

    route_id: int
    destination_id: int | None = None
    stage: str
    message: str
    error_code: str | None = None
    created_at: datetime


class CheckpointTraceTimelineNode(BaseModel):
    """Compact operational timeline entry for checkpoint debugging."""

    kind: str
    title: str
    detail: str | None = None
    tone: Literal["success", "warning", "error", "neutral"] = "neutral"
    created_at: datetime | None = None
    log_id: int | None = None


class CheckpointTraceResponse(BaseModel):
    """Checkpoint trace for one StreamRunner execution (run_id)."""

    run_id: str
    stream_id: int | None = None
    stream_name: str | None = None
    connector_name: str | None = None
    checkpoint_type: str | None = None
    checkpoint_before: dict[str, Any] | None = None
    checkpoint_after: dict[str, Any] | None = None
    processed_events: int | None = None
    delivered_events: int | None = None
    failed_events: int | None = None
    partial_success: bool | None = None
    update_reason: str | None = None
    retry_pending: bool | None = None
    correlated_route_failures: list[CheckpointTraceRouteFailureRef] = Field(default_factory=list)
    timeline_events: list[CheckpointTraceTimelineNode] = Field(default_factory=list)


class CheckpointHistoryItem(BaseModel):
    """One checkpoint_update row summary for stream history."""

    log_id: int
    run_id: str | None = None
    created_at: datetime
    checkpoint_type: str | None = None
    update_reason: str | None = None
    partial_success: bool | None = None
    checkpoint_after_preview: str | None = None


class CheckpointHistoryResponse(BaseModel):
    """GET /runtime/checkpoints/streams/{stream_id}/history"""

    stream_id: int
    items: list[CheckpointHistoryItem]


class RuntimeTraceTimelineEntry(BaseModel):
    id: int
    created_at: datetime
    stage: str
    level: str
    status: str | None = None
    message: str
    route_id: int | None = None
    destination_id: int | None = None
    latency_ms: int | None = None
    retry_count: int = 0
    http_status: int | None = None
    error_code: str | None = None


class RuntimeTraceResponse(BaseModel):
    """GET /runtime/logs/{id}/trace or GET /runtime/runs/{run_id}/trace."""

    run_id: str | None = None
    anchor_log_id: int | None = None
    stream_id: int | None = None
    connector: RuntimeTraceConnectorRef | None = None
    stream: RuntimeTraceStreamRef | None = None
    routes: list[RuntimeTraceRouteRef] = Field(default_factory=list)
    destinations: list[RuntimeTraceDestinationRef] = Field(default_factory=list)
    timeline: list[RuntimeTraceTimelineEntry]
    checkpoint: RuntimeTraceCheckpointEvent | None = None


class RuntimeTimelineItem(BaseModel):
    """One delivery_logs row for stream timeline (no payload_sample)."""

    id: int
    created_at: datetime
    stream_id: int | None = None
    route_id: int | None = None
    destination_id: int | None = None
    run_id: str | None = None
    stage: str
    level: str
    status: str | None = None
    message: str
    error_code: str | None = None
    retry_count: int = 0
    http_status: int | None = None
    latency_ms: int | None = None


class RuntimeTimelineResponse(BaseModel):
    """GET /runtime/timeline/stream/{stream_id} response body."""

    stream_id: int
    total: int
    items: list[RuntimeTimelineItem]


class RuntimeFailureTrendBucket(BaseModel):
    """One aggregated bucket for failure / rate-limit delivery_logs (no payload_sample)."""

    stage: str
    count: int
    latest_created_at: datetime
    stream_id: int | None = None
    route_id: int | None = None
    destination_id: int | None = None
    error_code: str | None = None


class RuntimeFailureTrendResponse(BaseModel):
    """GET /runtime/failures/trend response body."""

    snapshot_id: str | None = None
    generated_at: datetime | None = None
    metrics_window_seconds: int | None = None
    window_start: datetime | None = None
    window_end: datetime | None = None
    metric_meta: MetricMetaMap = Field(default_factory=dict)
    visualization_meta: VisualizationMetaMap = Field(default_factory=dict)
    bucket_size_seconds: int | None = None
    bucket_count: int | None = None
    bucket_alignment: str | None = None
    bucket_timezone: str | None = None
    bucket_mode: str | None = None
    total: int
    buckets: list[RuntimeFailureTrendBucket]


class RuntimeStreamControlResponse(BaseModel):
    """POST /runtime/streams/{stream_id}/start|stop response body."""

    stream_id: int
    enabled: bool
    status: str
    action: str
    message: str
    stop_phase: str | None = None
    terminal: bool = True


class RuntimeStreamRunOnceResponse(BaseModel):
    """POST /runtime/streams/{stream_id}/run-once — single StreamRunner cycle with DB commit.

    ``skipped_lock`` is never returned as HTTP 2xx; the endpoint raises 409 instead.
    Successful 2xx responses always include a ``runtime_run_id`` when Runtime entered.
    """

    stream_id: int
    outcome: Literal["completed", "no_events"]
    message: str | None = None
    extracted_event_count: int | None = None
    mapped_event_count: int | None = None
    enriched_event_count: int | None = None
    delivered_batch_event_count: int | None = None
    checkpoint_updated: bool = False
    transaction_committed: bool = False
    runtime_run_id: str | None = None


class MappingUIConfigMapping(BaseModel):
    exists: bool
    event_array_path: str | None
    event_root_path: str | None
    field_mappings: dict[str, Any]
    raw_payload_mode: str | None


class MappingUIConfigEnrichment(BaseModel):
    exists: bool
    enabled: bool
    enrichment: dict[str, Any]
    override_policy: str | None


class MappingUIConfigRouteItem(BaseModel):
    route_id: int
    destination_id: int
    destination_name: str | None
    destination_type: str | None
    route_enabled: bool
    destination_enabled: bool
    formatter_config: dict[str, Any]
    route_rate_limit: dict[str, Any]
    failure_policy: str


class MappingUIConfigResponse(BaseModel):
    stream_id: int
    stream_name: str
    stream_enabled: bool
    stream_status: str
    source_id: int
    source_type: str
    source_config: dict[str, Any]
    mapping: MappingUIConfigMapping
    enrichment: MappingUIConfigEnrichment
    routes: list[MappingUIConfigRouteItem]
    message: str


class MappingUISaveMappingPayload(BaseModel):
    event_array_path: str | None = None
    event_root_path: str | None = None
    field_mappings: dict[str, Any]
    raw_payload_mode: str | None = None

    @field_validator("field_mappings")
    @classmethod
    def field_mappings_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("field_mappings must contain at least one entry")
        return v


class MappingUISaveEnrichmentPayload(BaseModel):
    enabled: bool = True
    enrichment: dict[str, Any] = Field(default_factory=dict)
    override_policy: Literal["KEEP_EXISTING", "OVERRIDE", "ERROR_ON_CONFLICT"] = "KEEP_EXISTING"


class MappingUISaveRouteFormatterPayload(BaseModel):
    route_id: int
    formatter_config: dict[str, Any]

    @field_validator("formatter_config")
    @classmethod
    def formatter_config_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("formatter_config must contain at least one entry")
        return v


class MappingUISaveRequest(BaseModel):
    mapping: MappingUISaveMappingPayload | None = None
    enrichment: MappingUISaveEnrichmentPayload | None = None
    route_formatters: list[MappingUISaveRouteFormatterPayload] = Field(default_factory=list)


class MappingUISaveResponse(BaseModel):
    stream_id: int
    mapping_saved: bool
    enrichment_saved: bool
    route_formatter_saved_count: int
    route_formatter_route_ids: list[int]
    message: str


class RouteMappingUIConfigResponse(BaseModel):
    route_id: int
    stream_id: int
    inherit_stream_mapping: bool
    mapping: MappingUIConfigMapping
    stream_mapping: MappingUIConfigMapping
    message: str


class RouteEnrichmentUIConfigResponse(BaseModel):
    route_id: int
    stream_id: int
    inherit_stream_enrichment: bool
    enrichment: MappingUIConfigEnrichment
    stream_enrichment: MappingUIConfigEnrichment
    message: str


class RouteMappingUISaveRequest(BaseModel):
    inherit: bool = False
    mapping: MappingUISaveMappingPayload | None = None


class RouteMappingUISaveResponse(BaseModel):
    route_id: int
    stream_id: int
    mapping_saved: bool
    inherit_stream_mapping: bool
    message: str


class RouteEnrichmentUISaveRequest(BaseModel):
    inherit: bool = False
    enrichment: MappingUISaveEnrichmentPayload | None = None


class RouteEnrichmentUISaveResponse(BaseModel):
    route_id: int
    stream_id: int
    enrichment_saved: bool
    inherit_stream_enrichment: bool
    message: str


class RouteTransformEffectiveResponse(BaseModel):
    route_id: int
    stream_id: int
    persisted_source: Literal["route", "stream", "mixed"]
    mapping_source: Literal["route", "stream"]
    enrichment_source: Literal["route", "stream"]
    fallback_used: bool
    mapping_count: int
    enrichment_count: int
    processing_status: Literal["Inherited", "Overridden", "Mixed"]
    message: str


class RouteUIConfigRoute(BaseModel):
    id: int
    stream_id: int
    destination_id: int
    enabled: bool
    failure_policy: str
    formatter_config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]


class RouteUIConfigDestination(BaseModel):
    id: int | None
    name: str | None
    destination_type: str | None
    enabled: bool
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]


class RouteUIConfigResponse(BaseModel):
    route: RouteUIConfigRoute
    destination: RouteUIConfigDestination
    effective_formatter_config: dict[str, Any]
    effective_rate_limit: dict[str, Any]
    message: str


class RouteUISaveRequest(BaseModel):
    route_enabled: bool | None = None
    route_formatter_config: dict[str, Any] | None = None
    route_rate_limit: dict[str, Any] | None = None
    failure_policy: Literal[
        "LOG_AND_CONTINUE",
        "PAUSE_STREAM_ON_FAILURE",
        "RETRY_AND_BACKOFF",
        "DISABLE_ROUTE_ON_FAILURE",
    ] | None = None
    destination_enabled: bool | None = None

    @field_validator("route_formatter_config")
    @classmethod
    def route_formatter_config_non_empty(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        if v is not None and not v:
            raise ValueError("route_formatter_config must contain at least one entry")
        return v

    @field_validator("route_rate_limit")
    @classmethod
    def route_rate_limit_non_empty(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        if v is not None and not v:
            raise ValueError("route_rate_limit must contain at least one entry")
        return v


class RouteUISaveResponse(BaseModel):
    route_id: int
    destination_id: int
    route_enabled: bool
    destination_enabled: bool
    failure_policy: str
    formatter_config: dict[str, Any]
    route_rate_limit: dict[str, Any]
    message: str


class DestinationUIConfigDestination(BaseModel):
    id: int
    name: str
    destination_type: str
    enabled: bool
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]


class DestinationUIConfigRouteItem(BaseModel):
    id: int
    stream_id: int
    stream_name: str | None
    enabled: bool
    failure_policy: str
    formatter_config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]


class DestinationUIConfigResponse(BaseModel):
    destination: DestinationUIConfigDestination
    routes: list[DestinationUIConfigRouteItem]
    message: str


class DestinationUISaveRequest(BaseModel):
    name: str
    enabled: bool
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]


class DestinationUISaveResponse(BaseModel):
    destination_id: int
    name: str
    enabled: bool
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]
    message: str


class StreamUIConfigStream(BaseModel):
    id: int
    connector_id: int
    source_id: int
    name: str
    stream_type: str
    enabled: bool
    status: str
    polling_interval: int
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]


class StreamUIConfigSourceSummary(BaseModel):
    id: int | None
    source_type: str | None
    enabled: bool
    config_json: dict[str, Any]


class StreamUIConfigMappingSummary(BaseModel):
    exists: bool
    event_array_path: str | None
    event_root_path: str | None
    raw_payload_mode: str | None


class StreamUIConfigEnrichmentSummary(BaseModel):
    exists: bool
    enabled: bool
    override_policy: str | None


class StreamUIConfigRouteSummary(BaseModel):
    id: int
    destination_id: int
    destination_name: str | None
    destination_type: str | None
    enabled: bool
    destination_enabled: bool
    failure_policy: str


class StreamUIConfigResponse(BaseModel):
    stream: StreamUIConfigStream
    source: StreamUIConfigSourceSummary
    mapping: StreamUIConfigMappingSummary
    enrichment: StreamUIConfigEnrichmentSummary
    routes: list[StreamUIConfigRouteSummary]
    message: str


class StreamUISaveRequest(BaseModel):
    name: str
    enabled: bool
    polling_interval: int
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]


class StreamUISaveResponse(BaseModel):
    stream_id: int
    name: str
    enabled: bool
    polling_interval: int
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]
    message: str


class SourceUIConfigSource(BaseModel):
    id: int
    connector_id: int
    source_type: str
    enabled: bool
    config_json: dict[str, Any]
    auth_json: dict[str, Any]


class SourceUIConfigStreamItem(BaseModel):
    id: int
    name: str
    stream_type: str
    enabled: bool
    status: str
    polling_interval: int
    config_json: dict[str, Any]
    rate_limit_json: dict[str, Any]
    route_count: int


class SourceUIConfigResponse(BaseModel):
    source: SourceUIConfigSource
    streams: list[SourceUIConfigStreamItem]
    message: str


class SourceUISaveRequest(BaseModel):
    enabled: bool
    config_json: dict[str, Any]
    auth_json: dict[str, Any]
    source_type: str | None = Field(
        default=None,
        description="When set, updates Source.source_type (e.g. S3_OBJECT_POLLING).",
    )


class SourceUISaveResponse(BaseModel):
    source_id: int
    enabled: bool
    config_json: dict[str, Any]
    auth_json: dict[str, Any]
    message: str


class ConnectorUIConfigConnector(BaseModel):
    id: int
    name: str
    description: str | None
    status: str


class ConnectorUIConfigSourceSummary(BaseModel):
    id: int
    source_type: str
    enabled: bool
    stream_count: int


class ConnectorUIConfigStreamSummary(BaseModel):
    id: int
    source_id: int
    name: str
    stream_type: str
    enabled: bool
    status: str
    polling_interval: int
    route_count: int


class ConnectorUIConfigSummary(BaseModel):
    source_count: int
    stream_count: int
    enabled_stream_count: int
    route_count: int


class ConnectorUIConfigResponse(BaseModel):
    connector: ConnectorUIConfigConnector
    sources: list[ConnectorUIConfigSourceSummary]
    streams: list[ConnectorUIConfigStreamSummary]
    summary: ConnectorUIConfigSummary
    message: str


class ConnectorUISaveRequest(BaseModel):
    name: str
    description: str | None = None
    status: str


class ConnectorUISaveResponse(BaseModel):
    connector_id: int
    name: str
    description: str | None
    status: str
    message: str


class RuntimeMappingSaveRequest(BaseModel):
    """POST /runtime/mappings/stream/{stream_id}/save request body."""

    event_array_path: str | None = None
    event_root_path: str | None = None
    field_mappings: dict[str, Any]

    @field_validator("field_mappings")
    @classmethod
    def field_mappings_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("field_mappings must contain at least one entry")
        return v


class RuntimeMappingSaveResponse(BaseModel):
    """POST /runtime/mappings/stream/{stream_id}/save response body."""

    stream_id: int
    mapping_id: int
    event_array_path: str | None
    event_root_path: str | None
    field_count: int
    message: str


RuntimeEnrichmentOverridePolicy = Literal["fill_missing", "override"]


class RuntimeEnrichmentSaveRequest(BaseModel):
    """POST /runtime/enrichments/stream/{stream_id}/save request body."""

    enrichment: dict[str, Any]
    override_policy: RuntimeEnrichmentOverridePolicy = "fill_missing"
    enabled: bool = True

    @field_validator("enrichment")
    @classmethod
    def enrichment_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("enrichment must contain at least one entry")
        return v


class RuntimeEnrichmentSaveResponse(BaseModel):
    """POST /runtime/enrichments/stream/{stream_id}/save response body."""

    stream_id: int
    enrichment_id: int
    field_count: int
    override_policy: str
    enabled: bool
    message: str


class RuntimeRouteFormatterSaveRequest(BaseModel):
    """POST /runtime/routes/{route_id}/formatter/save request body."""

    formatter_config: dict[str, Any]

    @field_validator("formatter_config")
    @classmethod
    def formatter_config_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("formatter_config must contain at least one entry")
        return v


class RuntimeRouteFormatterSaveResponse(BaseModel):
    """POST /runtime/routes/{route_id}/formatter/save response body."""

    route_id: int
    stream_id: int
    destination_id: int
    formatter_config: dict[str, Any]
    field_count: int
    message: str


class RuntimeRouteFailurePolicySaveRequest(BaseModel):
    """POST /runtime/routes/{route_id}/failure-policy/save request body."""

    failure_policy: Literal[
        "LOG_AND_CONTINUE",
        "PAUSE_STREAM_ON_FAILURE",
        "RETRY_AND_BACKOFF",
        "DISABLE_ROUTE_ON_FAILURE",
    ]


class RuntimeRouteFailurePolicySaveResponse(BaseModel):
    """POST /runtime/routes/{route_id}/failure-policy/save response body."""

    route_id: int
    stream_id: int
    destination_id: int
    failure_policy: str
    message: str


class RuntimeRouteEnabledSaveRequest(BaseModel):
    """POST /runtime/routes/{route_id}/enabled/save request body."""

    enabled: StrictBool
    disable_reason: str | None = None


class RuntimeRouteEnabledSaveResponse(BaseModel):
    """POST /runtime/routes/{route_id}/enabled/save response body."""

    route_id: int
    stream_id: int
    destination_id: int
    enabled: bool
    message: str


class RuntimeRouteRateLimitSaveRequest(BaseModel):
    """POST /runtime/routes/{route_id}/rate-limit/save request body."""

    rate_limit: dict[str, Any]

    @field_validator("rate_limit")
    @classmethod
    def rate_limit_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("rate_limit must contain at least one entry")
        return v


class RuntimeRouteRateLimitSaveResponse(BaseModel):
    """POST /runtime/routes/{route_id}/rate-limit/save response body."""

    route_id: int
    stream_id: int
    destination_id: int
    rate_limit: dict[str, Any]
    field_count: int
    message: str


class RuntimeStreamRateLimitSaveRequest(BaseModel):
    """POST /runtime/streams/{stream_id}/rate-limit/save request body."""

    rate_limit: dict[str, Any]

    @field_validator("rate_limit")
    @classmethod
    def rate_limit_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("rate_limit must contain at least one entry")
        return v


class RuntimeStreamRateLimitSaveResponse(BaseModel):
    """POST /runtime/streams/{stream_id}/rate-limit/save response body."""

    stream_id: int
    connector_id: int
    source_id: int
    rate_limit: dict[str, Any]
    field_count: int
    message: str


class RuntimeDestinationRateLimitSaveRequest(BaseModel):
    """POST /runtime/destinations/{destination_id}/rate-limit/save request body."""

    rate_limit: dict[str, Any]

    @field_validator("rate_limit")
    @classmethod
    def rate_limit_non_empty(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not v:
            raise ValueError("rate_limit must contain at least one entry")
        return v


class RuntimeDestinationRateLimitSaveResponse(BaseModel):
    """POST /runtime/destinations/{destination_id}/rate-limit/save response body."""

    destination_id: int
    destination_type: str
    rate_limit: dict[str, Any]
    field_count: int
    message: str


class RuntimeLogsCleanupRequest(BaseModel):
    """POST /runtime/logs/cleanup request body."""

    older_than_days: int = Field(..., ge=1, le=3650)
    dry_run: bool = True


class RuntimeLogsCleanupResponse(BaseModel):
    """POST /runtime/logs/cleanup response body."""

    older_than_days: int
    dry_run: bool
    cutoff: datetime
    matched_count: int
    deleted_count: int
    message: str


class ReplayEventItem(BaseModel):
    """One stream_replay_events row for operator UI."""

    id: int
    stream_id: int
    destination_id: int
    route_id: int | None = None
    dynamic_route_id: int | None = None
    failover_route_id: int | None = None
    delivery_kind: str
    status: str
    error_type: str | None = None
    error_message: str | None = None
    retry_count: int
    event_count: int
    created_at: datetime
    updated_at: datetime
    last_replay_at: datetime | None = None


class StreamReplayEventsResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/replay-events response."""

    stream_id: int
    events: list[ReplayEventItem]
    event_count: int


class ReplayEventActionResponse(BaseModel):
    """POST replay/discard response."""

    id: int
    stream_id: int
    destination_id: int
    route_id: int | None = None
    status: str
    retry_count: int
    outcome: str
    message: str
    payload_hash: str | None = None
    event_count: int | None = None
    dynamic_route_id: int | None = None
    failover_route_id: int | None = None
    delivery_kind: str | None = None
    error_type: str | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    last_replay_at: datetime | None = None


class StreamReplaySummaryResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/replay/summary response."""

    stream_id: int
    pending_count: int
    replayed_count: int
    failed_count: int
    discarded_count: int
    total_count: int
    last_recorded_at: datetime | None = None


class PlatformReplaySummaryResponse(BaseModel):
    """GET /runtime/replay/summary response."""

    pending_count: int
    replayed_count: int
    failed_count: int
    discarded_count: int
    total_count: int
    streams_with_pending: list[dict[str, Any]]


class QuarantineEventItem(BaseModel):
    """One stream_quarantine_events row for operator UI."""

    id: int
    stream_id: int
    quarantine_reason: str
    quarantine_source: str
    status: str
    event_count: int = 0
    created_at: datetime
    updated_at: datetime
    released_at: datetime | None = None
    released_by: str | None = None


class StreamQuarantineEventsResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/quarantine-events response."""

    stream_id: int
    events: list[QuarantineEventItem]
    event_count: int


class QuarantineEventActionResponse(BaseModel):
    """POST release/discard response."""

    id: int
    stream_id: int
    status: str
    quarantine_reason: str
    quarantine_source: str
    outcome: str
    message: str
    checkpoint_updated: bool = False
    released_at: datetime | None = None
    released_by: str | None = None
    event_count: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class StreamQuarantineSummaryResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/quarantine/summary response."""

    stream_id: int
    quarantined_count: int
    released_count: int
    discarded_count: int
    total_count: int
    last_released_at: datetime | None = None


class PlatformQuarantineSummaryResponse(BaseModel):
    """GET /runtime/quarantine/summary response."""

    quarantined_count: int
    released_count: int
    discarded_count: int
    total_count: int
    last_released_at: datetime | None = None
    streams_with_quarantined: list[dict[str, Any]] = Field(default_factory=list)


class DeliveryLogReplayRequest(BaseModel):
    """POST /runtime/replay/delivery-log/{log_id} request body."""

    dry_run: bool = False


class DeliveryLogReplayResponse(BaseModel):
    """POST /runtime/replay/delivery-log/{log_id} response body."""

    log_id: int
    dry_run: bool
    outcome: Literal["dry_run_ok", "delivered", "failed"]
    message: str
    event_count: int
    route_id: int | None = None
    destination_id: int | None = None
    stream_id: int | None = None
    replay_run_id: str
    preview_message_count: int | None = None
    preview_messages: list[Any] | None = None
    error_type: str | None = None


# --- Preview / API-test (no DB writes; kept alongside runtime read schemas)


class HttpApiTestRequest(BaseModel):
    source_config: dict[str, Any] = Field(default_factory=dict)
    stream_config: dict[str, Any] = Field(default_factory=dict)
    checkpoint: dict[str, Any] | None = None
    connector_id: int | None = Field(
        default=None,
        description="Load base URL, shared headers, proxy, TLS, and auth secrets from this connector's Source row.",
    )
    fetch_sample: bool = Field(
        default=False,
        description="Reserved for sample-fetch UX; request URL and query params match stream_config as normalized (no automatic limit injection).",
    )


class ConnectorAuthTestRequest(BaseModel):
    connector_id: int | None = Field(
        default=None,
        ge=1,
        description="Saved Generic HTTP connector Source row. Omit when sending inline_flat_source.",
    )
    inline_flat_source: dict[str, Any] | None = Field(
        default=None,
        description="Unsaved connector: flattened Source config+auth (base_url, verify_ssl, http_proxy, headers, auth_type, secrets…).",
    )
    method: str = Field(default="GET", description="HTTP method for the auth probe request.")
    test_path: str | None = Field(
        default=None,
        description="Path relative to connector base_url (e.g. /api/v1/alerts). Ignored when test_url is set.",
    )
    test_url: str | None = Field(
        default=None,
        description="Optional absolute URL; must use the same host as the connector base_url (SSRF guard).",
    )
    extra_headers: dict[str, str] = Field(default_factory=dict, description="Additional request headers merged after connector common headers.")
    query_params: dict[str, Any] = Field(default_factory=dict, description="Query parameters for the probe request.")
    json_body: Any | None = Field(default=None, description="JSON body for POST/PUT/PATCH/DELETE.")
    remote_file_stream_config: dict[str, Any] | None = Field(
        default=None,
        description="REMOTE_FILE_POLLING probe: remote_directory, file_pattern, recursive (connector-auth test).",
    )

    @model_validator(mode="after")
    def _connector_id_xor_inline(self) -> ConnectorAuthTestRequest:
        has_id = self.connector_id is not None
        inl = self.inline_flat_source
        has_inline_http = isinstance(inl, dict) and str(inl.get("base_url") or "").strip() != ""
        has_inline_s3 = (
            isinstance(inl, dict)
            and str(inl.get("endpoint_url") or "").strip() != ""
            and str(inl.get("bucket") or "").strip() != ""
        )
        has_inline_db = (
            isinstance(inl, dict)
            and str(inl.get("source_type") or "").strip().upper() == "DATABASE_QUERY"
            and str(inl.get("host") or "").strip() != ""
            and str(inl.get("database") or "").strip() != ""
        )
        has_inline_rf = isinstance(inl, dict) and str(inl.get("host") or "").strip() != "" and (
            str(inl.get("source_type") or "").strip().upper() == "REMOTE_FILE_POLLING"
            or str(inl.get("connector_type") or "").strip().lower() == "remote_file"
        )
        has_inline = has_inline_http or has_inline_s3 or has_inline_db or has_inline_rf
        if has_id and has_inline:
            raise ValueError("Specify only one of connector_id or inline_flat_source")
        if not has_id and not has_inline:
            raise ValueError(
                "connector_id or inline_flat_source with base_url (HTTP), endpoint_url+bucket (S3), "
                "DATABASE_QUERY (host+database+db_type), or REMOTE_FILE_POLLING (host) is required"
            )
        return self


class ConnectorAuthTestResponse(BaseModel):
    ok: bool
    auth_type: str = Field(description="Normalized uppercase auth type from connector Source.")
    message: str | None = None
    error_type: str | None = None
    phase: str | None = Field(
        default=None,
        description="vendor_jwt_exchange: token_exchange | final_request on failure; omitted when ok.",
    )
    login_http_status: int | None = None
    login_final_url: str | None = None
    redirect_chain: list[str] = Field(default_factory=list)
    session_login_body_mode: str | None = None
    session_login_follow_redirects: bool | None = None
    login_failure_reason: str | None = None
    login_http_reason: str | None = None
    session_login_body_preview: str | None = Field(
        default=None,
        description="Masked preview of the login request body (session_login diagnostic).",
    )
    session_login_content_type: str | None = Field(
        default=None,
        description="Resolved Content-Type header on the login request.",
    )
    session_login_request_encoding: str | None = Field(
        default=None,
        description="httpx encoding: json | data | content | none.",
    )
    preflight_http_status: int | None = None
    preflight_final_url: str | None = None
    preflight_cookies: dict[str, str] | None = None
    extracted_variables: dict[str, str] | None = None
    template_render_preview: str | None = None
    computed_login_request_url: str | None = None
    login_url_resolution_warnings: list[str] = Field(default_factory=list)
    session_cookie_obtained: bool = False
    cookie_names: list[str] = Field(default_factory=list)
    probe_http_status: int | None = None
    probe_url: str | None = None
    request_method: str | None = None
    request_url: str | None = None
    request_headers_masked: dict[str, str] = Field(default_factory=dict)
    response_status_code: int | None = None
    response_headers_masked: dict[str, str] = Field(default_factory=dict)
    response_body: str | None = None
    token_request_method: str | None = None
    token_request_url: str | None = None
    token_request_headers_masked: dict[str, str] = Field(default_factory=dict)
    token_request_body_mode: str | None = Field(
        default=None,
        description="vendor_jwt token exchange body mode (e.g. empty, json, form).",
    )
    token_response_status_code: int | None = None
    token_response_headers_masked: dict[str, str] = Field(default_factory=dict)
    token_response_body: str | None = None
    token_response_body_masked: str | None = None
    final_request_method: str | None = None
    final_request_url: str | None = None
    final_request_headers_masked: dict[str, str] = Field(default_factory=dict)
    final_response_status_code: int | None = None
    final_response_headers_masked: dict[str, str] = Field(default_factory=dict)
    final_response_body: str | None = None
    s3_endpoint_reachable: bool | None = Field(default=None, description="S3 probe: TCP/client to endpoint.")
    s3_auth_ok: bool | None = Field(default=None, description="S3 probe: credentials accepted for HeadBucket.")
    s3_bucket_exists: bool | None = Field(default=None, description="S3 probe: HeadBucket succeeded.")
    s3_object_count_preview: int | None = Field(default=None, description="S3 probe: object count under prefix (capped).")
    s3_sample_keys: list[str] | None = Field(default=None, description="S3 probe: first object keys (no URLs).")
    db_reachable: bool | None = Field(default=None, description="DATABASE_QUERY probe: TCP/connect reached server.")
    db_auth_ok: bool | None = Field(default=None, description="DATABASE_QUERY probe: credentials accepted.")
    db_select_ok: bool | None = Field(default=None, description="DATABASE_QUERY probe: SELECT 1 succeeded.")
    ssh_reachable: bool | None = Field(default=None, description="REMOTE_FILE_POLLING probe: TCP/SSH reached host.")
    ssh_auth_ok: bool | None = Field(default=None, description="REMOTE_FILE_POLLING probe: SSH authentication succeeded.")
    sftp_available: bool | None = Field(default=None, description="REMOTE_FILE_POLLING probe: SFTP subsystem available.")
    remote_directory_accessible: bool | None = Field(
        default=None, description="REMOTE_FILE_POLLING probe: remote_directory is listable."
    )
    matched_file_count: int | None = Field(default=None, description="REMOTE_FILE_POLLING probe: files matching pattern.")
    sample_remote_paths: list[str] | None = Field(default=None, description="REMOTE_FILE_POLLING probe: sample paths.")
    host_key_status: str | None = Field(default=None, description="REMOTE_FILE_POLLING probe: host-key policy label.")


class HttpApiTestRequestMeta(BaseModel):
    method: str
    url: str
    headers_masked: dict[str, str] = Field(default_factory=dict)


class HttpApiTestActualRequestMeta(BaseModel):
    method: str
    url: str
    endpoint: str | None = None
    query_params: dict[str, Any] = Field(default_factory=dict)
    headers_masked: dict[str, str] = Field(default_factory=dict)
    json_body_masked: Any | None = None
    timeout_seconds: float


class HttpApiTestStep(BaseModel):
    name: str
    success: bool
    status_code: int | None = None
    message: str = ""


class ApiTestResponseSummary(BaseModel):
    root_type: str
    approx_size_bytes: int = 0
    top_level_keys: list[str] = Field(default_factory=list)
    item_count_root: int | None = None
    truncation: str | None = None


class DetectedArrayCandidate(BaseModel):
    path: str
    count: int
    confidence: float = Field(..., ge=0.0, le=1.0)
    reason: str
    sample_item_preview: Any | None = None


class DetectedCheckpointCandidate(BaseModel):
    field_path: str
    checkpoint_type: Literal["TIMESTAMP", "EVENT_ID", "CURSOR", "OFFSET"]
    confidence: float = Field(..., ge=0.0, le=1.0)
    sample_value: Any | None = None
    reason: str = ""


class HttpApiTestAnalysis(BaseModel):
    response_summary: ApiTestResponseSummary
    detected_arrays: list[DetectedArrayCandidate] = Field(default_factory=list)
    detected_checkpoint_candidates: list[DetectedCheckpointCandidate] = Field(default_factory=list)
    sample_event: Any | None = None
    selected_event_array_default: str | None = None
    flat_preview_fields: list[str] = Field(default_factory=list)
    preview_error: str | None = None


class HttpApiTestResponseMeta(BaseModel):
    status_code: int
    latency_ms: int
    headers: dict[str, str] = Field(default_factory=dict)
    raw_body: str
    parsed_json: Any | None = None
    content_type: str | None = None


class HttpApiTestResponse(BaseModel):
    ok: bool
    request: HttpApiTestRequestMeta
    actual_request_sent: HttpApiTestActualRequestMeta | None = None
    response: HttpApiTestResponseMeta | None = None
    error_type: str | None = None
    message: str | None = None
    target_status_code: int | None = None
    target_response_body: str | None = None
    hint: str | None = None
    error_code: str | None = None
    steps: list[HttpApiTestStep] = Field(default_factory=list)
    response_sample: Any | None = None
    analysis: HttpApiTestAnalysis | None = None
    database_query_row_count: int | None = Field(default=None, description="Row count from DATABASE_QUERY sample fetch.")
    database_query_sample_rows: list[dict[str, Any]] | None = Field(
        default=None,
        description="First rows from DATABASE_QUERY sample (capped); never includes passwords.",
    )
    remote_file_event_count: int | None = Field(
        default=None, description="REMOTE_FILE_POLLING sample fetch: extracted event count (capped)."
    )
    s3_event_count: int | None = Field(
        default=None, description="S3_OBJECT_POLLING sample fetch: parsed event count (capped)."
    )
    s3_sample_keys: list[str] | None = Field(
        default=None, description="S3_OBJECT_POLLING sample fetch: object keys that produced events."
    )


class MappingPreviewRequest(BaseModel):
    raw_response: Any
    event_array_path: str | None = None
    event_root_path: str | None = None
    field_mappings: dict[str, str] = Field(default_factory=dict)
    enrichment: dict[str, Any] = Field(default_factory=dict)
    override_policy: str = "KEEP_EXISTING"


class MappingPreviewResponse(BaseModel):
    input_event_count: int
    mapped_event_count: int
    preview_events: list[dict[str, Any]]


class MappingDraftPreviewRequest(BaseModel):
    payload: dict[str, Any] | list[Any]
    event_array_path: str | None = None
    event_root_path: str | None = None
    field_mappings: dict[str, str] = Field(default_factory=dict)
    max_events: int = Field(default=5, ge=1, le=100)


class MappingDraftPreviewMissingFieldItem(BaseModel):
    output_field: str
    json_path: str
    event_index: int


class MappingDraftPreviewResponse(BaseModel):
    input_event_count: int
    preview_event_count: int
    mapped_events: list[dict[str, Any]]
    missing_fields: list[MappingDraftPreviewMissingFieldItem]
    message: str


class FinalEventDraftPreviewRequest(BaseModel):
    payload: dict[str, Any] | list[Any]
    event_array_path: str | None = None
    event_root_path: str | None = None
    field_mappings: dict[str, str] = Field(default_factory=dict)
    enrichment: dict[str, Any] = Field(default_factory=dict)
    override_policy: Literal["KEEP_EXISTING", "OVERRIDE", "ERROR_ON_CONFLICT"] = "KEEP_EXISTING"
    max_events: int = Field(default=5, ge=1, le=100)
    stream_id: int | None = Field(
        default=None,
        description="When set, apply stream protection rules before returning final events.",
    )


class MatchedPolicyPreviewItem(BaseModel):
    name: str


class FailoverPlanPreviewItem(BaseModel):
    primary: str
    secondary: str


class FinalEventDraftPreviewResponse(BaseModel):
    input_event_count: int
    preview_event_count: int
    mapped_events: list[dict[str, Any]]
    final_events: list[dict[str, Any]]
    missing_fields: list[MappingDraftPreviewMissingFieldItem]
    classification_level: str | None = None
    matched_policies: list[MatchedPolicyPreviewItem] = Field(default_factory=list)
    selected_destinations: list[str] = Field(default_factory=list)
    failover_plan: list[FailoverPlanPreviewItem] = Field(default_factory=list)
    would_quarantine: bool = False
    message: str


class EnrichmentExecPreviewRequest(BaseModel):
    """POST /runtime/preview/enrichment-exec — mapped event + enrichment config."""

    mapped_event: dict[str, Any] = Field(default_factory=dict)
    enrichment: dict[str, Any] = Field(default_factory=dict)
    override_policy: Literal["KEEP_EXISTING", "OVERRIDE", "ERROR_ON_CONFLICT"] = "KEEP_EXISTING"


class EnrichmentExecPreviewWarning(BaseModel):
    code: str
    message: str
    rule_type: str | None = None
    target_field: str | None = None


class EnrichmentExecPreviewResponse(BaseModel):
    final_event: dict[str, Any] = Field(default_factory=dict)
    warnings: list[EnrichmentExecPreviewWarning] = Field(default_factory=list)
    duration_ms: int = 0
    message: str = ""


class EnrichmentValidationIssueItem(BaseModel):
    code: str
    severity: Literal["error", "warning"] = "warning"
    message: str
    rule_type: str | None = None
    target_field: str | None = None


class EnrichmentValidateRequest(BaseModel):
    enrichment: dict[str, Any] = Field(default_factory=dict)


class EnrichmentValidateResponse(BaseModel):
    ok: bool = True
    issues: list[EnrichmentValidationIssueItem] = Field(default_factory=list)


class TransformPreviewSampleSummary(BaseModel):
    is_object: bool = True
    top_level_keys: list[str] = Field(default_factory=list)
    top_level_key_count: int = 0
    keys_truncated: bool = False
    nested_key_estimate: int = 0
    value_preview: dict[str, Any] = Field(default_factory=dict)


class TransformPreviewFieldResultItem(BaseModel):
    success: bool = True
    value: Any = None
    error_code: str | None = None
    error_message: str | None = None
    rule_id: str | None = None
    output_field: str = ""
    mode: str = ""
    recovered_via_default: bool = False


class TransformPreviewIssueItem(BaseModel):
    level: Literal["field", "event"] = "field"
    output_field: str | None = None
    rule_id: str | None = None
    code: str | None = None
    message: str = ""
    error_code: str | None = None
    error_message: str | None = None
    sample_value: str | None = None
    rule_type: str | None = None


class TransformPreviewRequest(BaseModel):
    stage: Literal["mapping", "enrichment"] = "mapping"
    sample_event: dict[str, Any] = Field(default_factory=dict)
    rules: list[dict[str, Any]] = Field(default_factory=list)
    field_mappings: dict[str, Any] | None = None
    enrichment: dict[str, Any] | None = None


class TransformPreviewResponse(BaseModel):
    stage: Literal["mapping", "enrichment"] = "mapping"
    input_sample_summary: TransformPreviewSampleSummary = Field(
        default_factory=TransformPreviewSampleSummary
    )
    transformed_result: dict[str, Any] = Field(default_factory=dict)
    field_results: list[TransformPreviewFieldResultItem] = Field(default_factory=list)
    errors: list[TransformPreviewIssueItem] = Field(default_factory=list)
    warnings: list[TransformPreviewIssueItem] = Field(default_factory=list)
    save_blocked: bool = False
    duration_ms: int = 0
    message: str = ""


class SensitiveDetectionPreviewRequest(BaseModel):
    """POST /runtime/preview/sensitive-detection — suggestion-only, no persist."""

    events: list[dict[str, Any]] = Field(default_factory=list, max_length=500)


class SensitiveSuggestionEntry(BaseModel):
    field_path: str
    suggested_sensitive_type: str
    sensitivity_class: str
    detection_method: str
    matched_rule: str | None = None
    detection_source: str = "sensitive_detection_engine"
    confidence: str | None = None


class SensitiveDetectionPreviewResponse(BaseModel):
    suggestions: list[SensitiveSuggestionEntry] = Field(default_factory=list)
    suggestion_count: int = 0
    auto_protection_applied: bool = False


class DeliveryFormatDraftPreviewRequest(BaseModel):
    final_events: list[dict[str, Any]]
    destination_type: Literal["SYSLOG_UDP", "SYSLOG_TCP", "SYSLOG_TLS", "WEBHOOK_POST"]
    formatter_config: dict[str, Any] = Field(default_factory=dict)
    max_events: int = Field(default=5, ge=1, le=100)
    payload_mode: Literal["SINGLE_EVENT_OBJECT", "BATCH_JSON_ARRAY"] | None = None
    webhook_batch_size: int | None = Field(default=None, ge=1, le=10_000)


class DeliveryFormatDraftPreviewResponse(BaseModel):
    input_event_count: int
    preview_event_count: int
    destination_type: str
    preview_messages: list[Any]
    message: str


class E2EDraftPreviewRequest(BaseModel):
    payload: dict[str, Any] | list[Any]
    event_array_path: str | None = None
    event_root_path: str | None = None
    field_mappings: dict[str, str] = Field(default_factory=dict)
    enrichment: dict[str, Any] = Field(default_factory=dict)
    override_policy: Literal["KEEP_EXISTING", "OVERRIDE", "ERROR_ON_CONFLICT"] = "KEEP_EXISTING"
    destination_type: Literal["SYSLOG_UDP", "SYSLOG_TCP", "SYSLOG_TLS", "WEBHOOK_POST"]
    formatter_config: dict[str, Any] = Field(default_factory=dict)
    max_events: int = Field(default=5, ge=1, le=100)
    payload_mode: Literal["SINGLE_EVENT_OBJECT", "BATCH_JSON_ARRAY"] | None = None
    webhook_batch_size: int | None = Field(default=None, ge=1, le=10_000)
    stream_id: int | None = Field(
        default=None,
        description="When set, apply stream protection rules after enrichment in preview.",
    )


class E2EDraftPreviewResponse(BaseModel):
    input_event_count: int
    preview_event_count: int
    mapped_events: list[dict[str, Any]]
    final_events: list[dict[str, Any]]
    preview_messages: list[Any]
    missing_fields: list[MappingDraftPreviewMissingFieldItem]
    destination_type: str
    message: str


class FormatPreviewRequest(BaseModel):
    events: list[dict[str, Any]]
    destination_type: str
    formatter_config: dict[str, Any] = Field(default_factory=dict)
    payload_mode: Literal["SINGLE_EVENT_OBJECT", "BATCH_JSON_ARRAY"] | None = None
    webhook_batch_size: int | None = Field(default=None, ge=1, le=10_000)


class FormatPreviewResponse(BaseModel):
    destination_type: str
    message_count: int
    preview_messages: list[Any]


class RouteDeliveryPreviewRequest(BaseModel):
    route_id: int
    events: list[dict[str, Any]]


class RouteDeliveryPreviewResponse(BaseModel):
    route_id: int
    destination_id: int
    destination_type: str
    route_enabled: bool
    destination_enabled: bool
    message_count: int
    resolved_formatter_config: dict[str, Any]
    preview_messages: list[Any]


class DeliveryPrefixFormatPreviewRequest(BaseModel):
    """POST /runtime/format-preview — prefix resolution + final wire payload for UI."""

    formatter_config: dict[str, Any] = Field(default_factory=dict)
    sample_event: dict[str, Any] = Field(default_factory=dict)
    destination_type: str
    stream: dict[str, Any] = Field(default_factory=dict)
    destination: dict[str, Any] = Field(default_factory=dict)
    route: dict[str, Any] = Field(default_factory=dict)
    payload_mode: Literal["SINGLE_EVENT_OBJECT", "BATCH_JSON_ARRAY"] | None = None


class DeliveryPrefixFormatPreviewResponse(BaseModel):
    resolved_prefix: str
    final_payload: str
    message_prefix_enabled: bool


class MappingJsonPathsRequest(BaseModel):
    """POST /runtime/preview/json-paths request body (Mapping UI JSONPath discovery)."""

    payload: dict[str, Any] | list[Any]
    max_depth: int | None = Field(default=8, ge=1, le=20)
    max_paths: int | None = Field(default=500, ge=1, le=5000)
    scalars_only: bool = True


class MappingJsonPathItem(BaseModel):
    """One scalar JSONPath candidate for Mapping UI."""

    path: str
    value_type: str
    sample_value: Any | None = None
    is_array: bool
    depth: int


class MappingJsonPathsResponse(BaseModel):
    """POST /runtime/preview/json-paths response body."""

    total: int
    paths: list[MappingJsonPathItem]


class MappingValidationWarning(BaseModel):
    """Structured mapping validation issue for Mapping UI."""

    code: str
    severity: Literal["error", "warning"] = "warning"
    message: str
    output_field: str | None = None
    json_path: str | None = None
    event_index: int | None = None


class ExtractionValidationIssue(BaseModel):
    """Structured extraction validation issue for custom record-selection paths."""

    code: str
    severity: Literal["error", "warning"] = "warning"
    message: str


class ExtractionValidateRequest(BaseModel):
    """POST /runtime/preview/extraction-validate — read-only extraction checks."""

    payload: dict[str, Any] | list[Any]
    event_array_path: str | None = None
    event_root_path: str | None = None
    checkpoint_path: str | None = None
    max_preview_events: int = Field(default=5, ge=1, le=20)


class ExtractionValidateResponse(BaseModel):
    """POST /runtime/preview/extraction-validate response."""

    ok: bool
    normalized_event_array_path: str | None = None
    normalized_event_root_path: str | None = None
    normalized_checkpoint_path: str | None = None
    event_count: int = 0
    preview_events: list[dict[str, Any]] = Field(default_factory=list)
    checkpoint_values_preview: list[Any] = Field(default_factory=list)
    warnings: list[ExtractionValidationIssue] = Field(default_factory=list)
    errors: list[ExtractionValidationIssue] = Field(default_factory=list)


class MappingValidateRequest(BaseModel):
    """POST /runtime/preview/mapping-validate — read-only mapping checks."""

    payload: dict[str, Any] | list[Any] | None = None
    event_array_path: str | None = None
    event_root_path: str | None = None
    field_mappings: dict[str, str] = Field(default_factory=dict)


class MappingValidateResponse(BaseModel):
    """POST /runtime/preview/mapping-validate response."""

    ok: bool
    warnings: list[MappingValidationWarning] = Field(default_factory=list)


class PipelineDebugRequest(BaseModel):
    """POST /runtime/streams/{stream_id}/pipeline-debug — optional single-event sample."""

    raw_event: dict[str, Any] | list[Any] | None = None


class PipelineDebugRouteItem(BaseModel):
    route_id: int
    destination_id: int
    destination_type: str
    formatter_summary: dict[str, Any] = Field(default_factory=dict)
    delivery_preview: Any | None = None


class PipelineDebugResponse(BaseModel):
    """Pipeline debugger output for one sample event (read-only; no delivery or checkpoint writes)."""

    stream_id: int
    raw_event: dict[str, Any] | None = None
    mapped_event: dict[str, Any] | None = None
    enriched_event: dict[str, Any] | None = None
    formatted_payload: str | None = None
    routes: list[PipelineDebugRouteItem] = Field(default_factory=list)
    matched_policies: list[MatchedPolicyPreviewItem] = Field(default_factory=list)
    selected_destinations: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)

# --- stream configuration / dedup (attempt-012) ---

DedupDuplicateHandling = Literal["skip_duplicate", "keep_latest", "keep_first"]

DedupScope = Literal["current_run", "checkpoint_window", "last_n_hours"]

class StreamDeduplicationConfig(BaseModel):
    enabled: bool = False
    key_field: str = "event_id"
    custom_jsonpath: str | None = None
    duplicate_handling: DedupDuplicateHandling = "skip_duplicate"
    scope: DedupScope = "current_run"
    window_hours: int | None = None

class StreamDeduplicationSaveRequest(StreamDeduplicationConfig):
    pass

class StreamDedupRuntimeStatus(StreamDeduplicationConfig):
    """Dedup config plus last observed runtime counters."""

    last_runtime_duplicate_count: int = 0
    last_runtime_dedup_summary: dict[str, Any] | None = None
    last_runtime_stats_degraded: bool = False

class StreamConfigurationField(BaseModel):
    label: str
    value: str
    configured: bool = False
    sensitive: bool = False

class StreamConfigurationSection(BaseModel):
    title: str
    fields: list[StreamConfigurationField] = Field(default_factory=list)

class StreamConfigurationResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/configuration — human-readable stream setup."""

    stream_id: int
    stream_name: str
    sections: list[StreamConfigurationSection] = Field(default_factory=list)
    message: str

class StreamSampleDataResponse(BaseModel):
    """GET /runtime/streams/{stream_id}/sample-data — wizard sample artifacts."""

    stream_id: int
    has_sample_data: bool = False
    last_test_response: dict[str, Any] | None = None
    sample_events: list[dict[str, Any]] = Field(default_factory=list)
    sample_count: int = 0
    union_schema: dict[str, Any] | None = None
    event_root_path: str | None = None
    record_path: str | None = None
    checkpoint_test_result: dict[str, Any] | None = None
    incremental_test_result: dict[str, Any] | None = None
    saved_at: str | None = None
    message: str

class StreamSampleDataSaveRequest(BaseModel):
    last_test_response: dict[str, Any] | None = None
    sample_events: list[dict[str, Any]] | None = None
    union_schema: dict[str, Any] | None = None
    event_root_path: str | None = None
    record_path: str | None = None
    incremental_test_result: dict[str, Any] | None = None
    checkpoint_test_result: dict[str, Any] | None = None

class StreamIncrementalFetchConfig(BaseModel):
    strategy: IncrementalFetchStrategy | None = None
    watermark_field: str | None = None
    cursor_field: str | None = None
    tie_breaker_field: str | None = None
    stability_lag_seconds: int | None = None
    initial_lookback_seconds: int | None = None

class StreamIncrementalFetchSaveRequest(StreamIncrementalFetchConfig):
    pass

class StreamIncrementalFetchStatus(StreamIncrementalFetchConfig):
    """Incremental fetch config plus read-only runtime checkpoint state."""

    framework_enabled: bool = False
    fetch_watermark: Any | None = None
    connector_cursor: Any | None = None
    delivery_checkpoint: dict[str, Any] | None = None
    last_fetch_at: str | None = None
    last_delivery_at: str | None = None
    fetch_window: dict[str, str] | None = None
    last_runtime_summary: dict[str, Any] | None = None

class StreamIncrementalTestRequest(BaseModel):
    checkpoint_override: dict[str, Any] | None = None
    request_body: Any | None = None

class StreamIncrementalTestResponse(BaseModel):
    stream_id: int
    ok: bool
    http_status: int | None = None
    message: str
    preview_events: list[dict[str, Any]] = Field(default_factory=list)
    next_checkpoint_preview: dict[str, Any] | None = None
    checkpoint_unchanged: bool = True
    substituted_request_body: str | None = None
    event_root_path: str | None = None
    record_path: str | None = None
    fetched: int = 0
    inserted: int = 0
    duplicates: int = 0
    dedup_summary: dict[str, Any] | None = None
    strategy: str | None = None
    watermark_field: str | None = None
    cursor_field: str | None = None
    fetch_watermark: Any | None = None
    delivery_checkpoint: dict[str, Any] | None = None
    stability_lag_seconds: int | None = None
    fetch_window: dict[str, Any] | None = None
    query_preview: dict[str, Any] | None = None

class StreamReplayRequest(BaseModel):
    mode: StreamReplayMode
    dry_run: bool = False
    apply_dedup: bool = True
    start_time: datetime | None = None
    end_time: datetime | None = None
    last_n_minutes: int | None = Field(default=None, ge=1, le=10080)
    checkpoint_override: dict[str, Any] | None = None
    delivery_log_id: int | None = Field(default=None, ge=1)
    limit: int | None = Field(default=20, ge=1, le=200)
    requested_by: str | None = None

class StreamReplayResponse(BaseModel):
    stream_id: int
    mode: StreamReplayMode
    dry_run: bool
    apply_dedup: bool = True
    outcome: str
    message: str
    event_count: int | None = None
    checkpoint_unchanged: bool = True
    preview_message_count: int | None = None
    backfill_job_id: int | None = None
    dedup_summary: dict[str, Any] | None = None

class StreamCheckpointManageResponse(BaseModel):
    stream_id: int
    checkpoint_type: str | None = None
    checkpoint_value: dict[str, Any] | None = None
    framework_enabled: bool = False
    checkpoint_mode: str = "legacy"
    fetch_checkpoint: dict[str, Any] | None = None
    delivery_checkpoint: dict[str, Any] | None = None
    legacy_checkpoint: dict[str, Any] | None = None
    updated_at: datetime | None = None
    last_success_at: datetime | None = None
    last_failure_at: datetime | None = None
    last_collected_event_at: datetime | None = None

class StreamCheckpointUpdateRequest(BaseModel):
    checkpoint_type: str | None = "manual_edit"
    checkpoint_value: dict[str, Any] = Field(default_factory=dict)

class StreamCheckpointResetRequest(BaseModel):
    reason: str | None = None
    errors: list[str] = Field(default_factory=list)

