"""Typed route delivery models (M13.6)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

DeliveryDisposition = Literal[
    "delivered",
    "delivered_review_required",
    "blocked",
    "quarantined",
]

RouteHealthLevel = Literal["healthy", "warning", "failed"]


@dataclass(frozen=True, slots=True)
class RouteSendOutcome:
    """Result of a single-route adapter send (shared StreamRunner delivery primitive)."""

    success: bool
    latency_ms: int
    adapter_stage: str | None = None
    error: str | None = None
    rate_limited: bool = False
    destination_disabled: bool = False
    # True when delivery failed but failure_policy absorbed it (e.g. LOG_AND_CONTINUE).
    # Distinct from success: actual delivery did not succeed.
    failure_absorbed: bool = False
    # Primary adapter raise before failover/policy recovery (OFF fan-out telemetry parity).
    primary_send_failed: bool = False
    failover_attempted: bool = False
    failover_succeeded: bool = False
    failover_secondary_send_attempted: bool = False


@dataclass(frozen=True, slots=True)
class RouteDeliveryResult:
    route_id: int
    stream_id: int
    destination_id: int
    batch_id: str
    run_id: str | None
    delivery_allowed: bool
    delivery_disposition: DeliveryDisposition
    delivery_success: bool | None
    delivery_error: str | None
    delivery_timestamp: datetime | None
    policy_action: str
    decision_reason: str
    skip_reason: str | None
    event_count: int
    latency_ms: int | None
    adapter_stage: str | None
    quarantine_event_id: int | None
    delivery_log_id: int | None
    health_level: RouteHealthLevel = "healthy"
    failure_absorbed: bool = False
    failover_attempted: bool = False
    failover_succeeded: bool = False
