"""Pydantic contracts for GET /runtime/operational-snapshot (Phase 1 virtual snapshot)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

OperationalHealthStatus = Literal["HEALTHY", "DEGRADED", "ERROR", "IDLE"]
ProblemSeverity = Literal["warning", "critical"]
ProblemScope = Literal["stream", "route", "destination", "global"]


class OperationalGlobalSnapshot(BaseModel):
    health_status: OperationalHealthStatus
    total_streams: int
    enabled_streams: int
    running_streams: int
    error_streams: int
    total_routes: int
    enabled_routes: int
    total_destinations: int
    enabled_destinations: int
    total_eps_1m: float
    total_eps_5m: float
    avg_latency_ms: float | None = None
    last_activity_at: datetime | None = None


class OperationalStreamSnapshot(BaseModel):
    stream_id: int
    stream_name: str
    connector_id: int | None = None
    source_id: int | None = None
    enabled: bool
    status: str | None = None
    health_status: OperationalHealthStatus
    eps_1m: float
    eps_5m: float
    success_rate_5m: float
    failure_rate_5m: float
    avg_latency_ms: float | None = None
    route_count: int
    healthy_route_count: int
    failed_route_count: int
    last_success_at: datetime | None = None
    last_error_at: datetime | None = None
    last_error_message: str | None = None
    checkpoint_updated_at: datetime | None = None
    checkpoint_lag_seconds: int | None = None
    open_schema_field_drift_count: int = 0


class OperationalRouteSnapshot(BaseModel):
    route_id: int
    stream_id: int
    stream_name: str | None = None
    destination_id: int | None = None
    destination_name: str | None = None
    destination_type: str | None = None
    enabled: bool
    failure_policy: str | None = None
    health_status: OperationalHealthStatus
    delivered_eps_1m: float
    failed_eps_1m: float
    success_rate_5m: float
    retry_rate_5m: float
    avg_latency_ms: float | None = None
    last_success_at: datetime | None = None
    last_error_at: datetime | None = None
    last_error_message: str | None = None


class OperationalDestinationSnapshot(BaseModel):
    destination_id: int
    destination_name: str
    destination_type: str | None = None
    enabled: bool
    health_status: OperationalHealthStatus
    inbound_eps_1m: float
    failed_eps_1m: float
    avg_latency_ms: float | None = None
    route_count: int
    last_success_at: datetime | None = None
    last_error_at: datetime | None = None
    last_error_message: str | None = None


class OperationalProblem(BaseModel):
    severity: ProblemSeverity
    scope: ProblemScope
    stream_id: int | None = None
    route_id: int | None = None
    destination_id: int | None = None
    title: str
    message: str
    last_seen_at: datetime | None = None


class OperationalSnapshotResponse(BaseModel):
    global_: OperationalGlobalSnapshot = Field(alias="global")
    streams: list[OperationalStreamSnapshot]
    routes: list[OperationalRouteSnapshot]
    destinations: list[OperationalDestinationSnapshot]
    problems: list[OperationalProblem]
    updated_at: datetime

    model_config = {"populate_by_name": True}
