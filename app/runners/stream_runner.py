"""StreamRunner — coordinates pipeline for HTTP (and future DB/webhook) streams."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.checkpoints.service import CheckpointService
from app.delivery.syslog_sender import SyslogSender
from app.delivery.webhook_sender import WebhookSender
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.sources.adapters.registry import SourceAdapterRegistry
from app.formatters.message_prefix import MessagePrefixResolveContext, build_message_prefix_context
from app.enrichers.enrichment_engine import apply_enrichments_batch
from app.mappers.mapper import apply_mappings_with_results
from app.parsers.event_extractor import extract_events
from app.pollers.http_poller import HttpPoller
from app.rate_limit.destination_limiter import DestinationRateLimiter
from app.rate_limit.source_limiter import SourceRateLimiter
from app.logs.models import DeliveryLog
from app.logs.payload_sample import build_delivery_log_payload_sample
from app.schema_drift_policy.delivery_log_stages import (
    SCHEMA_DRIFT_POLICY_DELIVERY_LOG_STAGES,
    schema_drift_policy_delivery_log_message,
)
from app.http.shared_request_builder import build_runtime_checkpoint_template_context
from app.runtime.copy_utils import copy_event_dict, copy_events, copy_json_value, slim_checkpoint_for_log
from app.routes.repository import disable_route
from app.runtime.errors import MappingError
from app.runtime.stream_context import StreamContext
from app.streams.repository import update_stream_status
from app.runners.base import BaseRunner
from app.runners.route_context import RoutePipelineResult, RouteRuntimeContext
from app.runners.route_context_builder import build_route_runtime_contexts, build_shared_batch_context
from app.runners.route_stage import process_routes
from app.route_delivery.config import RouteSendOutcome
from app.runners.run_timing import PhaseTimer, RunTimingTrace
from app.runners.stream_dedup import (
    apply_stream_dedup,
    finalize_dedup_registry_summary,
    propagate_dedup_metadata,
    record_dedup_registry_for_route_success,
)
from app.runners.stream_runner_db import (
    ParkedCallerPending,
    merge_parked_caller_pending,
    release_caller_transaction,
    restore_parked_caller_pending,
    run_with_db,
    session_has_pending_changes,
    short_db_session,
)
from app.runners import stream_runtime_lock

logger = logging.getLogger(__name__)

_MAX_REPLAY_EVENTS_IN_LOG = 500


def _replay_iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _get(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


def _effective_destination_rate_limit_json(route: Any, destination: Any) -> dict[str, Any]:
    """Route.rate_limit_json overrides Destination.rate_limit_json when non-empty."""

    route_rl = _get(route, "rate_limit_json")
    dest_rl = _get(destination, "rate_limit_json")
    if isinstance(route_rl, dict) and route_rl:
        return dict(route_rl)
    if isinstance(dest_rl, dict) and dest_rl:
        return dict(dest_rl)
    return {}


@dataclass(slots=True)
class StreamRunOptions:
    """Per-invocation flags (do not store on the runner instance — concurrent streams may share one runner)."""

    persist_checkpoint: bool = True
    dry_run: bool = False
    replay_start: datetime | None = None
    replay_end: datetime | None = None
    apply_dedup: bool = True


@dataclass(frozen=True, slots=True)
class FailoverAttemptResult:
    attempted: bool = False
    succeeded: bool = False
    secondary_send_attempted: bool = False
    secondary_error: Exception | None = None


@dataclass
class FanOutOutcome:
    """Result of route fan-out for one batch — drives checkpoint trace semantics."""

    successful_events: list[dict[str, Any]]
    log_continue_failed_route_ids: tuple[int, ...] = field(default_factory=tuple)
    dynamic_deliveries_sent: int = 0
    failover_attempt_count: int = 0
    failover_success_count: int = 0
    failover_failure_count: int = 0
    failover_processing_time_ms: int = 0


class StreamRunner(BaseRunner):
    """Source -> extract -> mapping -> enrichment -> fan-out -> checkpoint update."""

    _locks: dict[int, threading.Lock] = {}
    _locks_guard = threading.Lock()

    def __init__(
        self,
        *,
        poller: HttpPoller | None = None,
        source_limiter: SourceRateLimiter | None = None,
        destination_limiter: DestinationRateLimiter | None = None,
        checkpoint_service: CheckpointService | None = None,
        syslog_sender: SyslogSender | None = None,
        webhook_sender: WebhookSender | None = None,
    ) -> None:
        self.poller = poller or HttpPoller()
        self.source_registry = SourceAdapterRegistry(http_poller=self.poller)
        _syslog = syslog_sender or SyslogSender()
        _webhook = webhook_sender or WebhookSender()
        self.syslog_sender = _syslog
        self.webhook_sender = _webhook
        self.destination_registry = DestinationAdapterRegistry(syslog_sender=_syslog, webhook_sender=_webhook)
        self.source_limiter = source_limiter or SourceRateLimiter()
        self.destination_limiter = destination_limiter or DestinationRateLimiter()
        self.checkpoint_service = checkpoint_service or CheckpointService()
        self._active_db: Session | None = None
        self._run_id: str | None = None
        self._last_run_id: str | None = None
        self._connector_id: int | None = None
        self._run_opts: StreamRunOptions = StreamRunOptions()
        self._sensitive_detection_context: Any = None
        self._schema_drift_policy_result: Any = None
        self._run_timing: RunTimingTrace | None = None
        self._pending_delivery_log_rows: list[DeliveryLog] = []
        self._pending_log_payloads: list[dict[str, Any]] = []
        self._pending_stream_status: dict[int, str] = {}
        self._pending_disabled_routes: set[int] = set()
        self._pending_checkpoint: dict[str, Any] | None = None
        self._dedup_summary: Any = None

    @staticmethod
    def _db_read(fn: Any) -> Any:
        return run_with_db(fn, commit=False)

    @staticmethod
    def _db_write(fn: Any) -> Any:
        return run_with_db(fn, commit=True)

    def run(self, stream: Any, db: Session | None = None) -> dict[str, Any]:
        """Execute one stream cycle.

        The argument may be a stream object or dict that contains at least:
        ``id``, ``source_config``, ``stream_config``, ``routes``.

        Transaction boundary when ``db`` is provided:
        - After source/transform work and before destination send, any open caller
          transaction is ended without ``commit`` (pending caller units are parked,
          then restored after I/O) so destination network I/O never runs
          idle-in-transaction and unrelated caller changes are not auto-committed.
        - ``run_started`` is committed immediately via an isolated short session.
        - Route/protection/policy/dedup DB work uses short-lived sessions only.
        - Remaining delivery logs / checkpoint commit via a short write session at run end.
        - Exception path persists ``run_failed`` in a separate transaction, then re-raises.
        - Lock acquisition failure returns ``skipped_lock`` with ``error_code`` (HTTP layer must not 2xx).

        Returns a summary dict (API / observability); raises on exception path after failure telemetry.
        """

        runtime_stream = stream.stream if isinstance(stream, StreamContext) else stream
        runtime_checkpoint = stream.checkpoint if isinstance(stream, StreamContext) else None
        # Never hold a caller session across external I/O — short sessions only.
        # Caller db reference is ownership-preserving only (never committed by runner).
        self._active_db = None
        self._runtime_stream = runtime_stream if isinstance(runtime_stream, dict) else None
        self._sensitive_detection_context = None
        self._schema_drift_policy_result = None
        self._pending_delivery_log_rows = []
        self._pending_log_payloads = []
        self._pending_stream_status = {}
        self._pending_disabled_routes = set()
        self._pending_checkpoint = None
        self._dedup_summary = None
        should_commit = False
        persist_to_db = True
        run_started_committed = False
        # Keep reference for compatibility; runtime persistence uses short sessions only.
        # Caller session txn is released (rollback after parking) before network I/O.
        self._flush_db: Session | None = None
        self._caller_db: Session | None = db
        self._caller_txn_released = False
        self._parked_caller_pending: ParkedCallerPending | None = None

        stream_id = int(_get(runtime_stream, "id"))
        lock = self._get_lock(stream_id)
        lock_acquired = lock.acquire(blocking=False)
        cross_lock_acquired = False
        if lock_acquired:
            # Same-host cross-process ownership so sibling API workers / stop can observe runs.
            cross_lock_acquired = stream_runtime_lock.try_acquire("run", stream_id)
            if not cross_lock_acquired:
                lock.release()
                lock_acquired = False

        if isinstance(stream, StreamContext):
            run_opts = StreamRunOptions(
                persist_checkpoint=stream.persist_checkpoint,
                dry_run=stream.dry_run,
                replay_start=stream.replay_start,
                replay_end=stream.replay_end,
                apply_dedup=bool(getattr(stream, "apply_dedup", True)),
            )
        else:
            run_opts = StreamRunOptions()

        self._run_opts = run_opts

        summary: dict[str, Any] = {
            "stream_id": stream_id,
            "outcome": "completed",
            "extracted_event_count": None,
            "mapped_event_count": None,
            "enriched_event_count": None,
            "delivered_batch_event_count": None,
            "checkpoint_updated": False,
            "transaction_committed": False,
            "message": None,
            "run_id": None,
            "error_code": None,
            "dry_run": run_opts.dry_run,
            "skipped_delivery_count": None,
        }

        try:
            if not lock_acquired:
                self._emit_obs(
                    {
                        "stage": "run_skip",
                        "stream_id": stream_id,
                        "skip_reason": "lock_held",
                        "error_code": "RUN_ALREADY_ACTIVE",
                        "message": "stream already running",
                    }
                )
                summary["outcome"] = "skipped_lock"
                summary["message"] = "stream already running"
                summary["error_code"] = "RUN_ALREADY_ACTIVE"
                summary["run_id"] = None
                return summary

            self._run_id = str(uuid.uuid4())
            summary["run_id"] = self._run_id
            self._run_timing = RunTimingTrace()
            conn_raw = _get(runtime_stream, "connector_id")
            self._connector_id = int(conn_raw) if conn_raw is not None else None

            # Lifecycle entry marker must land before source fetch / empty-delivery / early returns.
            checkpoint_type, checkpoint = self._resolve_checkpoint(
                runtime_checkpoint=runtime_checkpoint,
                stream_id=stream_id,
            )
            checkpoint_before_snapshot: dict[str, Any] | None = (
                slim_checkpoint_for_log(checkpoint) if checkpoint is not None else None
            )
            self._emit_obs(
                {
                    "stage": "checkpoint_resolved",
                    "stream_id": stream_id,
                    "checkpoint_type": checkpoint_type,
                    "has_checkpoint_payload": checkpoint is not None,
                }
            )
            self._log(
                {
                    "stage": "run_started",
                    "stream_id": stream_id,
                    "message": "stream run started",
                    "checkpoint_type": checkpoint_type,
                    "checkpoint_before": checkpoint_before_snapshot,
                }
            )
            # Commit run_started immediately via an isolated session so:
            # - later fetch/route failures cannot erase entry evidence
            # - the request DB session is not mid-committed (safe under concurrency)
            self._commit_lifecycle_entry(stream_id=stream_id)
            run_started_committed = True
            summary["transaction_committed"] = True

            if not self.source_limiter.allow(stream_id):
                self._set_stream_status(runtime_stream, "RATE_LIMITED_SOURCE")
                self._log(
                    {
                        "stage": "source_rate_limited",
                        "stream_id": stream_id,
                        "message": "source rate limited",
                    }
                )
                self._log(
                    self._with_run_timing(
                        {
                            "stage": "run_complete",
                            "stream_id": stream_id,
                            "input_events": 0,
                            "mapped_events": 0,
                            "success_events": 0,
                            "extracted_event_count": 0,
                            "mapped_event_count": 0,
                            "delivered_event_count": 0,
                            "checkpoint_before": checkpoint_before_snapshot,
                            "checkpoint_after": checkpoint_before_snapshot,
                            "checkpoint_type": checkpoint_type,
                            "checkpoint_updated": False,
                            "processed_events": 0,
                            "delivered_events": 0,
                            "failed_events": 0,
                            "partial_success": False,
                            "update_reason": "source_rate_limited",
                            "retry_pending": False,
                        }
                    )
                )
                should_commit = True
            else:
                events, enriched_events, tx_stats = self._collect_and_transform_events(
                    runtime_stream=runtime_stream,
                    checkpoint=checkpoint,
                    stream_id=stream_id,
                    run_opts=run_opts,
                )
                summary["extracted_event_count"] = tx_stats.get("extracted_count")
                summary["mapped_event_count"] = tx_stats.get("mapped_count")
                summary["enriched_event_count"] = tx_stats.get("enriched_count")

                if not events:
                    self._emit_obs(
                        {
                            "stage": "no_events",
                            "stream_id": stream_id,
                            "message": "No new events extracted",
                        }
                    )
                    summary["outcome"] = "no_events"
                    summary["message"] = "No new events extracted"
                    summary["delivered_batch_event_count"] = 0
                    self._dedup_summary = finalize_dedup_registry_summary(
                        stream_id=stream_id,
                        successful_events=[],
                        summary=self._dedup_summary,
                        dry_run=bool(run_opts.dry_run),
                        log_fn=self._log,
                    )
                    if self._dedup_summary is not None:
                        summary["dedup_summary"] = self._dedup_summary.to_dict()
                    self._log(
                        self._with_run_timing(
                        {
                            "stage": "run_complete",
                            "stream_id": stream_id,
                            "input_events": 0,
                            "mapped_events": tx_stats.get("mapped_count"),
                            "success_events": 0,
                            "extracted_event_count": tx_stats.get("extracted_count"),
                            "mapped_event_count": tx_stats.get("mapped_count"),
                            "delivered_event_count": 0,
                            "checkpoint_before": checkpoint_before_snapshot,
                            "checkpoint_after": None,
                            "checkpoint_type": checkpoint_type,
                            "checkpoint_updated": False,
                            "processed_events": 0,
                            "delivered_events": 0,
                            "failed_events": 0,
                            "partial_success": False,
                            "update_reason": "no_events_extracted",
                            "retry_pending": False,
                        })
                    )
                    should_commit = True
                elif run_opts.dry_run:
                    summary["delivered_batch_event_count"] = 0
                    summary["skipped_delivery_count"] = len(enriched_events)
                    summary["outcome"] = "dry_run"
                    summary["message"] = "Dry run: destination delivery skipped"
                    processed_events = len(events)
                    delivered_events = 0
                    failed_events = 0
                    partial_success = False
                    checkpoint_after_snapshot: dict[str, Any] | None = None
                    self._dedup_summary = finalize_dedup_registry_summary(
                        stream_id=stream_id,
                        successful_events=enriched_events,
                        summary=self._dedup_summary,
                        dry_run=True,
                        log_fn=self._log,
                    )
                    if self._dedup_summary is not None:
                        summary["dedup_summary"] = self._dedup_summary.to_dict()
                    self._log(
                        self._with_run_timing(
                        {
                            "stage": "run_complete",
                            "stream_id": stream_id,
                            "input_events": len(events),
                            "mapped_events": tx_stats.get("mapped_count"),
                            "success_events": 0,
                            "extracted_event_count": tx_stats.get("extracted_count"),
                            "mapped_event_count": tx_stats.get("mapped_count"),
                            "delivered_event_count": 0,
                            "checkpoint_before": checkpoint_before_snapshot,
                            "checkpoint_after": checkpoint_after_snapshot,
                            "checkpoint_type": checkpoint_type,
                            "checkpoint_updated": False,
                            "processed_events": processed_events,
                            "delivered_events": 0,
                            "failed_events": 0,
                            "partial_success": False,
                            "update_reason": "dry_run_no_delivery",
                            "retry_pending": False,
                        })
                    )
                    should_commit = True
                elif self._route_processing_enabled():
                    self._release_caller_db_before_io(runtime_stream=runtime_stream, stream_arg=stream)
                    route_pipeline = self._execute_route_pipeline(
                        stream_id=stream_id,
                        runtime_stream=runtime_stream,
                        extracted_events=events,
                        tx_stats=tx_stats,
                        checkpoint_before=checkpoint_before_snapshot,
                    )
                    summary["route_count"] = route_pipeline.metrics.route_count
                    summary["route_context_build_time_ms"] = route_pipeline.metrics.route_context_build_time_ms
                    summary["route_transform_count"] = route_pipeline.metrics.route_transform_count
                    summary["route_transform_duration_ms"] = route_pipeline.metrics.route_transform_duration_ms
                    summary["route_transform_fallback_count"] = route_pipeline.metrics.route_transform_fallback_count
                    summary["route_transform_attempt_count"] = route_pipeline.metrics.route_transform_attempt_count
                    summary["route_transform_success_count"] = route_pipeline.metrics.route_transform_success_count
                    summary["route_transform_failure_count"] = route_pipeline.metrics.route_transform_failure_count
                    summary["route_transform_skipped_count"] = route_pipeline.metrics.route_transform_skipped_count
                    summary["route_mapping_operations_applied"] = (
                        route_pipeline.metrics.route_mapping_operations_applied
                    )
                    summary["route_enrichment_operations_applied"] = (
                        route_pipeline.metrics.route_enrichment_operations_applied
                    )
                    summary["route_protection_count"] = route_pipeline.metrics.route_protection_count
                    summary["route_protection_duration_ms"] = route_pipeline.metrics.route_protection_duration_ms
                    summary["route_protection_attempt_count"] = route_pipeline.metrics.route_protection_attempt_count
                    summary["route_protection_success_count"] = route_pipeline.metrics.route_protection_success_count
                    summary["route_protection_failure_count"] = route_pipeline.metrics.route_protection_failure_count
                    summary["route_protection_skipped_count"] = route_pipeline.metrics.route_protection_skipped_count
                    summary["route_protection_operations_applied"] = (
                        route_pipeline.metrics.route_protection_operations_applied
                    )
                    summary["route_auto_protect_count"] = route_pipeline.metrics.route_auto_protect_count
                    summary["route_classification_count"] = route_pipeline.metrics.route_classification_count
                    summary["route_classification_duration_ms"] = route_pipeline.metrics.route_classification_duration_ms
                    summary["route_classification_override_count"] = route_pipeline.metrics.route_classification_override_count
                    summary["route_classification_attempt_count"] = route_pipeline.metrics.route_classification_attempt_count
                    summary["route_classification_success_count"] = route_pipeline.metrics.route_classification_success_count
                    summary["route_classification_failure_count"] = route_pipeline.metrics.route_classification_failure_count
                    summary["route_classification_skipped_count"] = route_pipeline.metrics.route_classification_skipped_count
                    summary["route_classification_operations_applied"] = (
                        route_pipeline.metrics.route_classification_operations_applied
                    )
                    summary["route_policy_count"] = route_pipeline.metrics.route_policy_count
                    summary["route_policy_duration_ms"] = route_pipeline.metrics.route_policy_duration_ms
                    summary["route_policy_allow_count"] = route_pipeline.metrics.route_policy_allow_count
                    summary["route_policy_audit_count"] = route_pipeline.metrics.route_policy_audit_count
                    summary["route_policy_block_count"] = route_pipeline.metrics.route_policy_block_count
                    summary["route_policy_review_count"] = route_pipeline.metrics.route_policy_review_count
                    summary["route_policy_quarantine_count"] = route_pipeline.metrics.route_policy_quarantine_count
                    summary["route_delivery_attempt_count"] = route_pipeline.metrics.route_delivery_attempt_count
                    summary["route_delivery_success_count"] = route_pipeline.metrics.route_delivery_success_count
                    summary["route_delivery_failure_count"] = route_pipeline.metrics.route_delivery_failure_count
                    summary["route_delivery_blocked_count"] = route_pipeline.metrics.route_delivery_blocked_count
                    summary["route_delivery_review_count"] = route_pipeline.metrics.route_delivery_review_count
                    summary["route_delivery_quarantine_count"] = route_pipeline.metrics.route_delivery_quarantine_count
                    summary["route_delivery_duration_ms"] = route_pipeline.metrics.route_delivery_duration_ms
                    summary["mapped_event_count"] = tx_stats.get("mapped_count")
                    summary["enriched_event_count"] = tx_stats.get("enriched_count")

                    reference_events = route_pipeline.checkpoint_reference_events or enriched_events
                    route_dispositions = [
                        {
                            "route_id": r.route_id,
                            "disposition": r.delivery_result.delivery_disposition,
                            "delivery_success": r.delivery_result.delivery_success,
                            "policy_action": r.delivery_result.policy_action,
                        }
                        for r in route_pipeline.stage_results
                        if r.delivery_result is not None
                    ]

                    with PhaseTimer(self._run_timing, "routing"):
                        dynamic_routing = self._evaluate_dynamic_routes(
                            stream_id=stream_id,
                            enriched_events=reference_events,
                        )
                    with PhaseTimer(self._run_timing, "destination_send"):
                        fan_out = self._fan_out(
                            runtime_stream,
                            reference_events,
                            dynamic_routing=dynamic_routing,
                            enriched_events=reference_events,
                            route_payloads=None,
                            skip_base_route_delivery=True,
                            route_delivery_outcome=self._route_delivery_fan_out_outcome(
                                route_pipeline,
                                reference_events,
                            ),
                        )
                    successful_events = fan_out.successful_events
                    summary["delivered_batch_event_count"] = len(successful_events) if successful_events else 0

                    processed_events = len(events)
                    delivered_events = len(successful_events)
                    failed_events = max(0, processed_events - delivered_events)
                    partial_success = bool(successful_events) and (
                        len(fan_out.log_continue_failed_route_ids) > 0 or delivered_events < processed_events
                    )

                    checkpoint_after_snapshot = None
                    if successful_events:
                        cand = successful_events[-1]
                        cand_preview = list(cand.keys())[:40] if isinstance(cand, dict) else None
                        self._emit_obs(
                            {
                                "stage": "checkpoint_candidate",
                                "stream_id": stream_id,
                                "checkpoint_type": checkpoint_type,
                                "last_event_keys_preview": cand_preview,
                                "route_dispositions": route_dispositions,
                            }
                        )
                        if run_opts.persist_checkpoint:
                            with PhaseTimer(self._run_timing, "checkpoint"):
                                update_reason = (
                                    "partial_delivery_success"
                                    if fan_out.log_continue_failed_route_ids
                                    else "full_delivery_success"
                                )
                                checkpoint_after_snapshot = self._update_checkpoint_after_success(
                                    stream_id=stream_id,
                                    checkpoint_type=checkpoint_type,
                                    successful_events=reference_events,
                                    checkpoint_before=checkpoint_before_snapshot,
                                    processed_events=processed_events,
                                    delivered_events=delivered_events,
                                    failed_events=failed_events,
                                    partial_success=partial_success,
                                    update_reason=update_reason,
                                    log_continue_failed_route_ids=fan_out.log_continue_failed_route_ids,
                                )
                            self._emit_obs(
                                {
                                    "stage": "checkpoint_update_staged",
                                    "stream_id": stream_id,
                                    "checkpoint_type": checkpoint_type,
                                }
                            )
                            summary["checkpoint_updated"] = True

                    complete_reason = (
                        "skipped_due_to_failure"
                        if not successful_events
                        else ("partial_delivery_success" if partial_success else "full_delivery_success")
                    )
                    retry_pending = processed_events > 0 and delivered_events == 0 and not successful_events

                    self._dedup_summary = finalize_dedup_registry_summary(
                        stream_id=stream_id,
                        successful_events=successful_events,
                        summary=self._dedup_summary,
                        dry_run=False,
                        log_fn=self._log,
                    )
                    if self._dedup_summary is not None:
                        summary["dedup_summary"] = self._dedup_summary.to_dict()

                    self._log(
                        self._with_run_timing(
                        {
                            "stage": "run_complete",
                            "stream_id": stream_id,
                            "input_events": len(events),
                            "mapped_events": tx_stats.get("mapped_count"),
                            "success_events": len(successful_events),
                            "extracted_event_count": tx_stats.get("extracted_count"),
                            "mapped_event_count": tx_stats.get("mapped_count"),
                            "delivered_event_count": len(successful_events),
                            "checkpoint_before": checkpoint_before_snapshot,
                            "checkpoint_after": checkpoint_after_snapshot,
                            "checkpoint_type": checkpoint_type,
                            "checkpoint_updated": bool(successful_events and run_opts.persist_checkpoint),
                            "processed_events": processed_events,
                            "delivered_events": delivered_events,
                            "failed_events": failed_events,
                            "partial_success": partial_success if successful_events else False,
                            "update_reason": complete_reason,
                            "retry_pending": retry_pending,
                        })
                    )
                    should_commit = True
                else:
                    with PhaseTimer(self._run_timing, "protection"):
                        delivery_events, protection_result = self._prepare_delivery_events(
                            stream_id=stream_id,
                            enriched_events=enriched_events,
                        )
                    with PhaseTimer(self._run_timing, "policy"):
                        policy_result = self._evaluate_policies(
                            stream_id=stream_id,
                            enriched_events=enriched_events,
                        )
                        policy_result = self._merge_schema_drift_policy_quarantine(policy_result)
                    quarantined = self._try_policy_quarantine(
                        stream_id=stream_id,
                        delivery_events=delivery_events,
                        policy_result=policy_result,
                    )
                    if quarantined:
                        processed_events = len(events)
                        self._log(
                            self._with_run_timing(
                            {
                                "stage": "run_complete",
                                "stream_id": stream_id,
                                "input_events": len(events),
                                "mapped_events": tx_stats.get("mapped_count"),
                                "success_events": 0,
                                "extracted_event_count": tx_stats.get("extracted_count"),
                                "mapped_event_count": tx_stats.get("mapped_count"),
                                "delivered_event_count": 0,
                                "checkpoint_before": checkpoint_before_snapshot,
                                "checkpoint_after": None,
                                "checkpoint_type": checkpoint_type,
                                "checkpoint_updated": False,
                                "processed_events": processed_events,
                                "delivered_events": 0,
                                "failed_events": 0,
                                "partial_success": False,
                                "update_reason": "policy_quarantine",
                                "retry_pending": False,
                            })
                        )
                        summary["delivered_batch_event_count"] = 0
                        summary["quarantined"] = True
                        should_commit = True
                    else:
                        with PhaseTimer(self._run_timing, "routing"):
                            dynamic_routing = self._evaluate_dynamic_routes(
                                stream_id=stream_id,
                                enriched_events=enriched_events,
                            )
                        self._release_caller_db_before_io(runtime_stream=runtime_stream, stream_arg=stream)
                        with PhaseTimer(self._run_timing, "destination_send"):
                            from app.route_classification.legacy_payloads import (
                                build_legacy_route_classification_payloads,
                                has_active_classification_route_overrides,
                            )
                            from app.route_policy.legacy_gates import (
                                apply_legacy_delivery_behavior_gates,
                                has_active_delivery_behavior_sources,
                            )
                            from app.route_protection.legacy_payloads import (
                                build_legacy_route_protection_payloads,
                                has_active_protection_route_overrides,
                            )

                            route_overrides = list(_get(runtime_stream, "route_overrides", []) or [])
                            governance_rules = list(_get(runtime_stream, "governance_rules", []) or [])
                            route_payloads = None
                            if has_active_protection_route_overrides(route_overrides):
                                route_payloads = build_legacy_route_protection_payloads(
                                    runtime_stream=runtime_stream,
                                    enriched_events=enriched_events,
                                    db=None,
                                    use_short_db=True,
                                    log_fn=self._log,
                                    schema_drift_policy_result=self._schema_drift_policy_result,
                                    sensitive_detection_result=self._sensitive_detection_context,
                                    batch_id=self._run_id or "",
                                )
                            if has_active_classification_route_overrides(route_overrides):
                                route_payloads = build_legacy_route_classification_payloads(
                                    runtime_stream=runtime_stream,
                                    base_events=delivery_events,
                                    existing_route_payloads=route_payloads,
                                )
                            if has_active_delivery_behavior_sources(
                                route_overrides=route_overrides,
                                governance_rules=governance_rules,
                            ):
                                route_payloads = apply_legacy_delivery_behavior_gates(
                                    runtime_stream=runtime_stream,
                                    existing_route_payloads=route_payloads,
                                    schema_drift_policy_result=self._schema_drift_policy_result,
                                )
                            fan_out = self._fan_out(
                                runtime_stream,
                                delivery_events,
                                dynamic_routing=dynamic_routing,
                                enriched_events=enriched_events,
                                route_payloads=route_payloads,
                            )
                        successful_events = fan_out.successful_events
                        summary["delivered_batch_event_count"] = len(successful_events) if successful_events else 0

                        processed_events = len(events)
                        delivered_events = len(successful_events)
                        failed_events = max(0, processed_events - delivered_events)
                        partial_success = bool(successful_events) and (
                            len(fan_out.log_continue_failed_route_ids) > 0 or delivered_events < processed_events
                        )

                        checkpoint_after_snapshot = None
                        if successful_events:
                            cand = successful_events[-1]
                            cand_preview = list(cand.keys())[:40] if isinstance(cand, dict) else None
                            self._emit_obs(
                                {
                                    "stage": "checkpoint_candidate",
                                    "stream_id": stream_id,
                                    "checkpoint_type": checkpoint_type,
                                    "last_event_keys_preview": cand_preview,
                                }
                            )
                            if run_opts.persist_checkpoint:
                                with PhaseTimer(self._run_timing, "checkpoint"):
                                    update_reason = (
                                        "partial_delivery_success"
                                        if fan_out.log_continue_failed_route_ids
                                        else "full_delivery_success"
                                    )
                                    checkpoint_after_snapshot = self._update_checkpoint_after_success(
                                        stream_id=stream_id,
                                        checkpoint_type=checkpoint_type,
                                        successful_events=enriched_events,
                                        checkpoint_before=checkpoint_before_snapshot,
                                        processed_events=processed_events,
                                        delivered_events=delivered_events,
                                        failed_events=failed_events,
                                        partial_success=partial_success,
                                        update_reason=update_reason,
                                        log_continue_failed_route_ids=fan_out.log_continue_failed_route_ids,
                                    )
                                self._emit_obs(
                                    {
                                        "stage": "checkpoint_update_staged",
                                        "stream_id": stream_id,
                                        "checkpoint_type": checkpoint_type,
                                    }
                                )
                                summary["checkpoint_updated"] = True

                        complete_reason = (
                            "skipped_due_to_failure"
                            if not successful_events
                            else ("partial_delivery_success" if partial_success else "full_delivery_success")
                        )
                        retry_pending = processed_events > 0 and delivered_events == 0 and not successful_events

                        self._dedup_summary = finalize_dedup_registry_summary(
                            stream_id=stream_id,
                            successful_events=successful_events,
                            summary=self._dedup_summary,
                            dry_run=False,
                            log_fn=self._log,
                        )
                        if self._dedup_summary is not None:
                            summary["dedup_summary"] = self._dedup_summary.to_dict()

                        self._log(
                            self._with_run_timing(
                            {
                                "stage": "run_complete",
                                "stream_id": stream_id,
                                "input_events": len(events),
                                "mapped_events": tx_stats.get("mapped_count"),
                                "success_events": len(successful_events),
                                "extracted_event_count": tx_stats.get("extracted_count"),
                                "mapped_event_count": tx_stats.get("mapped_count"),
                                "delivered_event_count": len(successful_events),
                                "checkpoint_before": checkpoint_before_snapshot,
                                "checkpoint_after": checkpoint_after_snapshot,
                                "checkpoint_type": checkpoint_type,
                                "checkpoint_updated": bool(successful_events and run_opts.persist_checkpoint),
                                "processed_events": processed_events,
                                "delivered_events": delivered_events,
                                "failed_events": failed_events,
                                "partial_success": partial_success if successful_events else False,
                                "update_reason": complete_reason,
                                "retry_pending": retry_pending,
                            })
                        )
                        should_commit = True
        except Exception as exc:
            # Drop uncommitted work from the failed run transaction, but preserve
            # already-committed run_started and write run_failed out-of-band.
            self._pending_log_payloads.clear()
            self._pending_checkpoint = None
            self._pending_stream_status.clear()
            self._pending_disabled_routes.clear()
            self._pending_delivery_log_rows.clear()
            should_commit = False
            failure_payload = {
                "stage": "run_failed",
                "stream_id": stream_id,
                "error_type": type(exc).__name__,
                "error_code": "RUNTIME_INTERNAL_ERROR",
                "message": str(exc),
                "run_id": self._run_id,
            }
            self._emit_obs(failure_payload)
            try:
                self._persist_failure_telemetry(failure_payload)
            except Exception:
                logger.exception(
                    "run_failed_telemetry_persist_failed stream_id=%s run_id=%s",
                    stream_id,
                    self._run_id,
                )
            summary["outcome"] = "exception"
            summary["error_code"] = "RUNTIME_INTERNAL_ERROR"
            summary["message"] = str(exc)
            raise
        finally:
            try:
                if should_commit and persist_to_db:
                    self._flush_pending_writes(stream_id=stream_id)
                    summary["transaction_committed"] = True
                elif run_started_committed:
                    # Entry telemetry already durable even if the rest of the run failed.
                    summary["transaction_committed"] = True
            finally:
                try:
                    restore_parked_caller_pending(self._caller_db, self._parked_caller_pending)
                finally:
                    # Preserve for HTTP error detail after request-scoped _run_id is cleared.
                    self._last_run_id = self._run_id or summary.get("run_id")
                    self._active_db = None
                    self._flush_db = None
                    self._caller_db = None
                    self._caller_txn_released = False
                    self._parked_caller_pending = None
                    self._run_id = None
                    self._connector_id = None
                    self._run_timing = None
                    self._pending_delivery_log_rows.clear()
                    self._pending_log_payloads.clear()
                    if cross_lock_acquired:
                        stream_runtime_lock.release("run", stream_id)
                    if lock_acquired:
                        lock.release()

        return summary

    def _release_caller_db_before_io(self, *, runtime_stream: Any, stream_arg: Any) -> None:
        """End any open caller transaction without committing caller-owned changes."""

        db = getattr(self, "_caller_db", None)
        if db is None or not isinstance(db, Session):
            return
        in_txn = getattr(db, "in_transaction", None)
        try:
            was_active = bool(in_txn()) if callable(in_txn) else False
        except Exception:
            was_active = False
        parked = release_caller_transaction(
            db,
            runtime_stream=runtime_stream,
            stream_arg=stream_arg,
            end_with="rollback",
        )
        self._parked_caller_pending = merge_parked_caller_pending(self._parked_caller_pending, parked)
        if was_active or parked:
            self._caller_txn_released = True

    @staticmethod
    def _route_processing_enabled() -> bool:
        return bool(settings.GDC_ROUTE_PROCESSING_ENABLED)

    def _execute_route_pipeline(
        self,
        *,
        stream_id: int,
        runtime_stream: Any,
        extracted_events: list[dict[str, Any]],
        tx_stats: dict[str, int],
        checkpoint_before: dict[str, Any] | None,
    ) -> RoutePipelineResult:
        """M13.2 route pipeline — shared batch + per-route transform before delivery."""

        batch_id = self._run_id or str(uuid.uuid4())
        stream_config = dict(_get(runtime_stream, "stream_config", {}) or {})
        schema_observation: dict[str, Any] = {}
        observed_schema = stream_config.get("observed_schema")
        if isinstance(observed_schema, dict):
            schema_observation["observed_schema"] = dict(observed_schema)

        if self._run_timing is not None:
            self._run_timing.start_phase("schema_drift")
        self._schema_drift_policy_result = self._apply_schema_drift_policy(
            stream_id=stream_id,
            runtime_stream=runtime_stream,
            enriched_events=extracted_events,
        )
        if self._run_timing is not None:
            self._run_timing.end_phase("schema_drift")

        shared_batch = build_shared_batch_context(
            stream_id=stream_id,
            batch_id=batch_id,
            runtime_stream=runtime_stream,
            extracted_events=extracted_events,
            shared_runtime_data={
                "extracted_event_count": tx_stats.get("extracted_count"),
                "stream_protection_rules": list(_get(runtime_stream, "stream_protection_rules", []) or []),
                "stream_classification_rules": list(_get(runtime_stream, "stream_classification_rules", []) or []),
                "stream_policy_rules": list(_get(runtime_stream, "stream_policy_rules", []) or []),
                "route_overrides": list(_get(runtime_stream, "route_overrides", []) or []),
                "governance_rules": list(_get(runtime_stream, "governance_rules", []) or []),
            },
            schema_observation=schema_observation,
            sensitive_detection_result=self._sensitive_detection_context,
            schema_drift_policy_result=self._schema_drift_policy_result,
            checkpoint_cursor_before=checkpoint_before,
        )
        route_contexts, build_metrics = build_route_runtime_contexts(runtime_stream)
        # Never pass the caller/request session into route stages — protection,
        # policy/quarantine, and delivery must use short sessions or no session.
        pipeline = process_routes(
            route_contexts,
            shared_batch,
            log_fn=self._log,
            db=None,
            use_short_db=True,
            base_metrics=build_metrics,
            send_fn=self._make_route_delivery_send_fn(runtime_stream),
            run_id=self._run_id,
        )
        self._log_route_policy_evaluation_complete(stream_id=stream_id, pipeline=pipeline)

        if pipeline.stage_results:
            tx_stats["mapped_count"] = len(pipeline.stage_results[0].events)
            tx_stats["enriched_count"] = len(pipeline.stage_results[0].events)

        self._emit_obs(
            {
                "stage": "route_processing_loop",
                "stream_id": stream_id,
                "batch_id": batch_id,
                "route_count": pipeline.metrics.route_count,
                "route_context_build_time_ms": pipeline.metrics.route_context_build_time_ms,
                "route_transform_count": pipeline.metrics.route_transform_count,
                "route_transform_duration_ms": pipeline.metrics.route_transform_duration_ms,
                "route_transform_fallback_count": pipeline.metrics.route_transform_fallback_count,
                "route_transform_attempt_count": pipeline.metrics.route_transform_attempt_count,
                "route_transform_success_count": pipeline.metrics.route_transform_success_count,
                "route_transform_failure_count": pipeline.metrics.route_transform_failure_count,
                "route_transform_skipped_count": pipeline.metrics.route_transform_skipped_count,
                "route_mapping_operations_applied": pipeline.metrics.route_mapping_operations_applied,
                "route_enrichment_operations_applied": pipeline.metrics.route_enrichment_operations_applied,
                "route_protection_count": pipeline.metrics.route_protection_count,
                "route_protection_duration_ms": pipeline.metrics.route_protection_duration_ms,
                "route_protection_attempt_count": pipeline.metrics.route_protection_attempt_count,
                "route_protection_success_count": pipeline.metrics.route_protection_success_count,
                "route_protection_failure_count": pipeline.metrics.route_protection_failure_count,
                "route_protection_skipped_count": pipeline.metrics.route_protection_skipped_count,
                "route_protection_operations_applied": pipeline.metrics.route_protection_operations_applied,
                "route_auto_protect_count": pipeline.metrics.route_auto_protect_count,
                "route_classification_count": pipeline.metrics.route_classification_count,
                "route_classification_duration_ms": pipeline.metrics.route_classification_duration_ms,
                "route_classification_override_count": pipeline.metrics.route_classification_override_count,
                "route_classification_attempt_count": pipeline.metrics.route_classification_attempt_count,
                "route_classification_success_count": pipeline.metrics.route_classification_success_count,
                "route_classification_failure_count": pipeline.metrics.route_classification_failure_count,
                "route_classification_skipped_count": pipeline.metrics.route_classification_skipped_count,
                "route_classification_operations_applied": pipeline.metrics.route_classification_operations_applied,
                "route_delivery_attempt_count": pipeline.metrics.route_delivery_attempt_count,
                "route_delivery_success_count": pipeline.metrics.route_delivery_success_count,
                "route_delivery_failure_count": pipeline.metrics.route_delivery_failure_count,
                "route_delivery_blocked_count": pipeline.metrics.route_delivery_blocked_count,
                "route_delivery_review_count": pipeline.metrics.route_delivery_review_count,
                "route_delivery_quarantine_count": pipeline.metrics.route_delivery_quarantine_count,
                "route_delivery_duration_ms": pipeline.metrics.route_delivery_duration_ms,
                "routes_processed": len(pipeline.stage_results),
            }
        )
        self._log(
            {
                "stage": "route_processing_loop",
                "stream_id": stream_id,
                "message": "route processing pipeline complete",
                "route_count": pipeline.metrics.route_count,
                "route_context_build_time_ms": pipeline.metrics.route_context_build_time_ms,
                "route_transform_count": pipeline.metrics.route_transform_count,
                "route_transform_duration_ms": pipeline.metrics.route_transform_duration_ms,
                "route_transform_fallback_count": pipeline.metrics.route_transform_fallback_count,
                "route_transform_attempt_count": pipeline.metrics.route_transform_attempt_count,
                "route_transform_success_count": pipeline.metrics.route_transform_success_count,
                "route_transform_failure_count": pipeline.metrics.route_transform_failure_count,
                "route_transform_skipped_count": pipeline.metrics.route_transform_skipped_count,
                "route_mapping_operations_applied": pipeline.metrics.route_mapping_operations_applied,
                "route_enrichment_operations_applied": pipeline.metrics.route_enrichment_operations_applied,
                "route_protection_count": pipeline.metrics.route_protection_count,
                "route_protection_duration_ms": pipeline.metrics.route_protection_duration_ms,
                "route_protection_attempt_count": pipeline.metrics.route_protection_attempt_count,
                "route_protection_success_count": pipeline.metrics.route_protection_success_count,
                "route_protection_failure_count": pipeline.metrics.route_protection_failure_count,
                "route_protection_skipped_count": pipeline.metrics.route_protection_skipped_count,
                "route_protection_operations_applied": pipeline.metrics.route_protection_operations_applied,
                "route_auto_protect_count": pipeline.metrics.route_auto_protect_count,
                "route_classification_count": pipeline.metrics.route_classification_count,
                "route_classification_duration_ms": pipeline.metrics.route_classification_duration_ms,
                "route_classification_override_count": pipeline.metrics.route_classification_override_count,
                "route_classification_attempt_count": pipeline.metrics.route_classification_attempt_count,
                "route_classification_success_count": pipeline.metrics.route_classification_success_count,
                "route_classification_failure_count": pipeline.metrics.route_classification_failure_count,
                "route_classification_skipped_count": pipeline.metrics.route_classification_skipped_count,
                "route_classification_operations_applied": pipeline.metrics.route_classification_operations_applied,
                "route_delivery_attempt_count": pipeline.metrics.route_delivery_attempt_count,
                "route_delivery_success_count": pipeline.metrics.route_delivery_success_count,
                "route_delivery_failure_count": pipeline.metrics.route_delivery_failure_count,
                "routes_processed": len(pipeline.stage_results),
                "events_modified": any(r.modified for r in pipeline.stage_results),
            }
        )
        return pipeline

    def _route_delivery_fan_out_outcome(
        self,
        pipeline: RoutePipelineResult,
        reference_events: list[dict[str, Any]],
    ) -> FanOutOutcome:
        """Build FanOutOutcome from per-route delivery results (M13.6 — no base re-send).

        Delivery success and failure absorption are distinct:
        - delivery_success=False means the destination send failed (never disguised as success).
        - failure_absorbed=True (LOG_AND_CONTINUE) avoids blocking sibling routes; checkpoint
          advances only when at least one route actually delivered.
        """

        log_continue_failed: list[int] = []
        all_required_routes_succeeded = True
        any_delivery_success = False
        saw_send_route = False
        failover_attempt_count = 0
        failover_success_count = 0
        failover_failure_count = 0
        for result in pipeline.stage_results:
            delivery = result.delivery_result
            if delivery is None:
                continue
            if bool(getattr(delivery, "failover_attempted", False)):
                failover_attempt_count += 1
                if bool(getattr(delivery, "failover_succeeded", False)):
                    failover_success_count += 1
                else:
                    failover_failure_count += 1
            if not delivery.delivery_allowed:
                continue
            if delivery.skip_reason in ("no_events", "rate_limited", "destination_disabled"):
                if delivery.skip_reason == "rate_limited":
                    all_required_routes_succeeded = False
                continue
            saw_send_route = True
            if delivery.delivery_success is True:
                any_delivery_success = True
                continue
            if delivery.delivery_success is False:
                if bool(getattr(delivery, "failure_absorbed", False)):
                    log_continue_failed.append(result.route_id)
                    # Absorbed: do not block other routes, but checkpoint needs a real delivery.
                    continue
                all_required_routes_succeeded = False
                continue
            all_required_routes_succeeded = False

        failover_processing_time_ms = int(getattr(pipeline.metrics, "route_delivery_duration_ms", 0) or 0)
        if not saw_send_route:
            return FanOutOutcome(
                successful_events=[],
                failover_attempt_count=failover_attempt_count,
                failover_success_count=failover_success_count,
                failover_failure_count=failover_failure_count,
                failover_processing_time_ms=failover_processing_time_ms,
            )

        if all_required_routes_succeeded and any_delivery_success:
            return FanOutOutcome(
                successful_events=copy_events(reference_events),
                log_continue_failed_route_ids=tuple(log_continue_failed),
                failover_attempt_count=failover_attempt_count,
                failover_success_count=failover_success_count,
                failover_failure_count=failover_failure_count,
                failover_processing_time_ms=failover_processing_time_ms,
            )
        return FanOutOutcome(
            successful_events=[],
            log_continue_failed_route_ids=tuple(log_continue_failed),
            failover_attempt_count=failover_attempt_count,
            failover_success_count=failover_success_count,
            failover_failure_count=failover_failure_count,
            failover_processing_time_ms=failover_processing_time_ms,
        )

    def _make_route_delivery_send_fn(self, runtime_stream: Any):
        """Return send_fn for route_delivery_stage — reuses fan-out adapter path."""

        def _send(route_ctx: RouteRuntimeContext, events: list[dict[str, Any]]) -> RouteSendOutcome:
            return self._deliver_single_route(runtime_stream, route_ctx, events)

        return _send

    def _deliver_single_route(
        self,
        stream: Any,
        route_ctx: RouteRuntimeContext,
        route_events: list[dict[str, Any]],
    ) -> RouteSendOutcome:
        """Route-ON send entry: resolve route row then delegate to shared delivery primitive."""

        route_id = route_ctx.route_id
        routes = list(_get(stream, "routes", []) or [])
        route = next((r for r in routes if int(_get(r, "id", 0)) == route_id), None)
        if route is None:
            return RouteSendOutcome(success=False, latency_ms=0, error="route not found", adapter_stage="route_send_failed")
        return self._send_route_events(
            stream,
            route,
            route_events,
            record_replay_on_failure=True,
        )

    def _send_route_events(
        self,
        stream: Any,
        route: Any,
        route_events: list[dict[str, Any]],
        *,
        failover_bindings: dict[int, Any] | None = None,
        record_replay_on_failure: bool = False,
    ) -> RouteSendOutcome:
        """Shared single-route delivery boundary (Stream owns send; Route is the processing unit).

        Used by Route-ON (`_deliver_single_route`) and Route-OFF (`_fan_out`) so adapter send,
        failover, and failure_policy live in one place. Does not fetch source or write checkpoint.
        """

        stream_id = int(_get(stream, "id"))
        route_id = int(_get(route, "id", 0))
        destination = _get(route, "destination", {}) or {}
        if not bool(_get(destination, "enabled", True)):
            return RouteSendOutcome(
                success=False,
                latency_ms=0,
                destination_disabled=True,
                adapter_stage="route_skip",
                error="destination disabled",
            )

        destination_id = _get(destination, "id")
        effective_rl = _effective_destination_rate_limit_json(route, destination)
        if not self.destination_limiter.allow(route_id, effective_rl):
            self._set_stream_status(stream, "RATE_LIMITED_DESTINATION")
            self._log(
                {
                    "stage": "destination_rate_limited",
                    "stream_id": stream_id,
                    "route_id": route_id,
                    "destination_id": destination_id,
                    "message": "destination rate limited",
                }
            )
            return RouteSendOutcome(
                success=False,
                latency_ms=0,
                rate_limited=True,
                adapter_stage="destination_rate_limited",
                error="destination rate limited",
            )

        destination_type = str(_get(destination, "destination_type", "")).upper()
        destination_config = _get(destination, "config", {}) or {}
        route_fc = _get(route, "formatter_config_json")
        formatter_override: dict[str, Any] | None = None
        if isinstance(route_fc, dict) and route_fc:
            formatter_override = route_fc
        prefix_context = self._prefix_delivery_context(stream, route)

        try:
            send_started = time.monotonic()
            self._send_to_destination(
                destination_type,
                route_events,
                destination_config,
                formatter_override=formatter_override,
                prefix_context=prefix_context,
            )
            latency_ms = max(0, int((time.monotonic() - send_started) * 1000))
            first_keys = (
                list(route_events[0].keys())[:24] if route_events and isinstance(route_events[0], dict) else []
            )
            self._log(
                {
                    "stage": "route_send_success",
                    "stream_id": stream_id,
                    "route_id": route_id,
                    "destination_id": destination_id,
                    "destination_type": destination_type,
                    "event_count": len(route_events),
                    "first_event_keys_preview": first_keys,
                    "latency_ms": latency_ms,
                }
            )
            # Persist dedup registry after successful delivery so scoped dedup works across runs
            # (webhook pushes are separate runs; last_n_hours / checkpoint_window need seeds).
            if self._dedup_summary is not None:
                record_dedup_registry_for_route_success(
                    stream_id=stream_id,
                    route_events=route_events,
                    summary=self._dedup_summary,
                    destination=str(destination_type or "") or None,
                    destination_id=int(destination_id) if destination_id is not None else None,
                    route_id=route_id,
                    log_fn=self._log,
                )
            return RouteSendOutcome(success=True, latency_ms=latency_ms, adapter_stage="route_send_success")
        except Exception as exc:
            latency_ms = max(0, int((time.monotonic() - send_started) * 1000))
            from app.ai_policy.errors import AiPolicyEnforcementError

            if isinstance(exc, AiPolicyEnforcementError):
                self._record_ai_policy_block(exc)
            failure_policy = str(_get(route, "failure_policy", "LOG_AND_CONTINUE")).upper()
            # Always record primary failure before Active/Standby failover.
            self._log(
                {
                    "stage": "route_send_failed",
                    "stream_id": stream_id,
                    "route_id": route_id,
                    "destination_id": destination_id,
                    "destination_type": destination_type,
                    "failure_policy": failure_policy,
                    "error_type": type(exc).__name__,
                    "message": str(exc),
                    "latency_ms": latency_ms,
                    "event_count": len(route_events),
                }
            )
            recovered = False
            fo_result = FailoverAttemptResult()
            bindings = failover_bindings
            if destination_id is not None:
                if bindings is None:
                    bindings = {}
                    try:
                        from app.failover_routing.failover_engine import load_failover_bindings_by_primary

                        bindings = self._db_read(
                            lambda db: load_failover_bindings_by_primary(db, stream_id)
                        )
                    except Exception:
                        logger.exception(
                            "failover_bindings_load_failed stream_id=%s route_id=%s",
                            stream_id,
                            route_id,
                        )
                fo_result = self._attempt_failover_send(
                    stream,
                    route_id=route_id,
                    primary_destination_id=int(destination_id),
                    events=route_events,
                    formatter_override=formatter_override,
                    failover_bindings=bindings,
                    primary_error=exc,
                    primary_latency_ms=latency_ms,
                )
                if fo_result.attempted and fo_result.succeeded:
                    recovered = True
            if not recovered:
                recovered = self._apply_failure_policy(
                    stream,
                    route,
                    route_events,
                    exc,
                    attempt_latency_ms=latency_ms,
                    emit_failure_log=False,
                )
            if fo_result.attempted and not fo_result.succeeded:
                recovered = False

            if record_replay_on_failure and bindings is not None:
                fo_binding = (
                    bindings.get(int(destination_id)) if destination_id is not None else None
                )
                if (
                    fo_result.secondary_send_attempted
                    and not fo_result.succeeded
                    and fo_binding is not None
                ):
                    self._maybe_record_replay_event(
                        stream=stream,
                        route=route,
                        events=route_events,
                        destination_id=int(fo_binding.secondary_destination_id),
                        destination_type=str(fo_binding.secondary_destination_type or ""),
                        formatter_override=formatter_override,
                        prefix_context=build_message_prefix_context(
                            stream_name=str(_get(stream, "name", "") or ""),
                            stream_id=stream_id,
                            destination_name=str(fo_binding.secondary_destination_name or ""),
                            destination_type=str(fo_binding.secondary_destination_type or ""),
                            route_id=route_id,
                        ),
                        delivery_kind="failover_secondary",
                        error=fo_result.secondary_error,
                        failover_route_id=int(fo_binding.failover_route_id),
                    )
                elif (
                    not fo_result.succeeded
                    and not fo_result.secondary_send_attempted
                    and destination_id is not None
                ):
                    self._maybe_record_replay_event(
                        stream=stream,
                        route=route,
                        events=route_events,
                        destination_id=int(destination_id),
                        destination_type=destination_type,
                        formatter_override=formatter_override,
                        prefix_context=prefix_context,
                        delivery_kind="base_route",
                        error=exc,
                    )

            if recovered and fo_result.attempted and fo_result.succeeded:
                return RouteSendOutcome(
                    success=True,
                    latency_ms=latency_ms,
                    adapter_stage="failover_route_send_success",
                    primary_send_failed=True,
                    failover_attempted=True,
                    failover_succeeded=True,
                    failover_secondary_send_attempted=fo_result.secondary_send_attempted,
                )
            if recovered and failure_policy == "LOG_AND_CONTINUE":
                # Actual delivery failed; policy absorbed the failure without blocking other routes.
                return RouteSendOutcome(
                    success=False,
                    latency_ms=latency_ms,
                    adapter_stage="route_send_failed",
                    error=str(exc),
                    failure_absorbed=True,
                    primary_send_failed=True,
                    failover_attempted=fo_result.attempted,
                    failover_succeeded=False,
                    failover_secondary_send_attempted=fo_result.secondary_send_attempted,
                )
            if recovered:
                # RETRY_AND_BACKOFF (or equivalent) recovered via successful resend.
                return RouteSendOutcome(
                    success=True,
                    latency_ms=latency_ms,
                    adapter_stage="route_send_success",
                    primary_send_failed=True,
                    failover_attempted=fo_result.attempted,
                    failover_succeeded=False,
                    failover_secondary_send_attempted=fo_result.secondary_send_attempted,
                )
            return RouteSendOutcome(
                success=False,
                latency_ms=latency_ms,
                adapter_stage="route_send_failed",
                error=str(exc),
                primary_send_failed=True,
                failover_attempted=fo_result.attempted,
                failover_succeeded=False,
                failover_secondary_send_attempted=fo_result.secondary_send_attempted,
            )

    def _execute_route_processing_foundation(
        self,
        *,
        stream_id: int,
        runtime_stream: Any,
        delivery_events: list[dict[str, Any]],
        tx_stats: dict[str, int],
    ) -> dict[str, Any] | None:
        """Deprecated M13.1 hook — retained for test patches; not used in production paths."""

        _ = (stream_id, runtime_stream, delivery_events, tx_stats)
        return None

    def _fan_out(
        self,
        stream: Any,
        events: list[dict[str, Any]],
        *,
        dynamic_routing: Any | None = None,
        enriched_events: list[dict[str, Any]] | None = None,
        route_payloads: dict[int, list[dict[str, Any]]] | None = None,
        skip_base_route_delivery: bool = False,
        route_delivery_outcome: FanOutOutcome | None = None,
    ) -> FanOutOutcome:
        """Send events to all enabled routes and return globally successful events."""

        if skip_base_route_delivery and route_delivery_outcome is not None:
            stream_id = int(_get(stream, "id"))
            base_destination_ids: set[int] = set()
            routes = list(_get(stream, "routes", []) or [])
            for route in routes:
                destination = _get(route, "destination", {}) or {}
                dest_id = _get(destination, "id")
                if dest_id is not None:
                    base_destination_ids.add(int(dest_id))

            failover_bindings: dict[int, Any] = {}
            try:
                from app.failover_routing.failover_engine import load_failover_bindings_by_primary

                failover_bindings = self._db_read(lambda db: load_failover_bindings_by_primary(db, stream_id))
            except Exception:
                logger.exception("failover_bindings_load_failed stream_id=%s", stream_id)
            for binding in failover_bindings.values():
                base_destination_ids.add(int(binding.secondary_destination_id))

            dynamic_deliveries_sent = 0
            if dynamic_routing is not None:
                processed_route_ids = {
                    int(_get(route, "id", 0))
                    for route in routes
                    if bool(_get(route, "enabled", True)) and int(_get(route, "id", 0)) > 0
                }
                dynamic_deliveries_sent = self._deliver_dynamic_routes(
                    stream,
                    events,
                    dynamic_routing=dynamic_routing,
                    skip_route_ids=processed_route_ids,
                    skip_destination_ids=base_destination_ids,
                )
                try:
                    from app.dynamic_routing.dynamic_routing_service import log_dynamic_routing_complete

                    self._db_write(
                        lambda db: log_dynamic_routing_complete(
                            db,
                            stream_id=stream_id,
                            result=dynamic_routing,
                            dynamic_deliveries_this_run=dynamic_deliveries_sent,
                            log_fn=self._log,
                        )
                    )
                except Exception:
                    logger.exception("dynamic_routing_complete_log_failed stream_id=%s", stream_id)
            outcome = route_delivery_outcome
            if failover_bindings:
                try:
                    from app.failover_routing.failover_metrics import log_failover_routing_complete

                    self._db_write(
                        lambda db: log_failover_routing_complete(
                            db,
                            stream_id=stream_id,
                            failover_route_count=len(failover_bindings),
                            attempt_count=outcome.failover_attempt_count,
                            success_count=outcome.failover_success_count,
                            failure_count=outcome.failover_failure_count,
                            processing_time_ms=outcome.failover_processing_time_ms,
                            log_fn=self._log,
                        )
                    )
                except Exception:
                    logger.exception("failover_routing_complete_log_failed stream_id=%s", stream_id)
            return FanOutOutcome(
                successful_events=outcome.successful_events,
                log_continue_failed_route_ids=outcome.log_continue_failed_route_ids,
                dynamic_deliveries_sent=dynamic_deliveries_sent,
                failover_attempt_count=outcome.failover_attempt_count,
                failover_success_count=outcome.failover_success_count,
                failover_failure_count=outcome.failover_failure_count,
                failover_processing_time_ms=outcome.failover_processing_time_ms,
            )

        stream_id = int(_get(stream, "id"))
        routes = list(_get(stream, "routes", []) or [])
        if not routes:
            self._emit_obs({"stage": "pipeline_fan_out", "stream_id": stream_id, "detail": "no_routes_configured"})
            return FanOutOutcome(successful_events=[])
        if not events:
            self._emit_obs({"stage": "pipeline_fan_out", "stream_id": stream_id, "detail": "no_events_extracted"})
            return FanOutOutcome(successful_events=[])

        self._emit_obs(
            {
                "stage": "route",
                "stream_id": stream_id,
                "message": "route fan-out starting",
                "configured_route_count": len(routes),
            }
        )

        all_required_routes_succeeded = True
        any_delivery_success = False
        saw_actionable_route = False
        log_continue_failed_route_ids: list[int] = []
        base_destination_ids: set[int] = set()
        failover_attempt_count = 0
        failover_success_count = 0
        failover_failure_count = 0
        failover_started = time.monotonic()
        failover_bindings: dict[int, Any] = {}
        try:
            from app.failover_routing.failover_engine import load_failover_bindings_by_primary

            failover_bindings = self._db_read(lambda db: load_failover_bindings_by_primary(db, stream_id))
        except Exception:
            logger.exception("failover_bindings_load_failed stream_id=%s", stream_id)

        for route in routes:
            route_id = int(_get(route, "id", 0))
            failure_policy = str(_get(route, "failure_policy", "LOG_AND_CONTINUE")).upper()
            if not bool(_get(route, "enabled", True)):
                self._log(
                    {
                        "stage": "route_skip",
                        "stream_id": stream_id,
                        "route_id": route_id,
                        "skip_reason": "route_disabled",
                        "message": "route_disabled",
                    }
                )
                continue

            destination = _get(route, "destination", {}) or {}
            destination_id = _get(destination, "id")
            if not bool(_get(destination, "enabled", True)):
                self._log(
                    {
                        "stage": "route_skip",
                        "stream_id": stream_id,
                        "route_id": route_id,
                        "destination_id": destination_id,
                        "skip_reason": "destination_disabled",
                        "message": "destination_disabled",
                    }
                )
                continue

            saw_actionable_route = True
            if destination_id is not None:
                base_destination_ids.add(int(destination_id))

            route_events = events
            if route_payloads is not None:
                route_events = route_payloads.get(route_id, events)

            if not route_events:
                self._log(
                    {
                        "stage": "route_skip",
                        "stream_id": stream_id,
                        "route_id": route_id,
                        "skip_reason": "no_route_payload",
                        "message": "route_payload_empty",
                    }
                )
                continue

            send_outcome = self._send_route_events(
                stream,
                route,
                route_events,
                failover_bindings=failover_bindings,
                record_replay_on_failure=True,
            )
            if send_outcome.failover_attempted:
                failover_attempt_count += 1
                if send_outcome.failover_succeeded:
                    failover_success_count += 1
                else:
                    failover_failure_count += 1

            if send_outcome.rate_limited:
                all_required_routes_succeeded = False
                continue

            if send_outcome.destination_disabled:
                continue

            # Preserve OFF fan-out telemetry: primary failure under LOG_AND_CONTINUE is recorded
            # even when failover later recovers the send (checkpoint still advances).
            if send_outcome.primary_send_failed and failure_policy == "LOG_AND_CONTINUE":
                log_continue_failed_route_ids.append(route_id)
            elif send_outcome.failure_absorbed:
                log_continue_failed_route_ids.append(route_id)

            if send_outcome.success:
                any_delivery_success = True
                continue
            if send_outcome.failure_absorbed:
                continue

            all_required_routes_succeeded = False

        for binding in failover_bindings.values():
            base_destination_ids.add(int(binding.secondary_destination_id))

        dynamic_deliveries_sent = 0
        if dynamic_routing is not None:
            processed_route_ids = {
                int(_get(route, "id", 0))
                for route in routes
                if bool(_get(route, "enabled", True)) and int(_get(route, "id", 0)) > 0
            }
            dynamic_deliveries_sent = self._deliver_dynamic_routes(
                stream,
                events,
                dynamic_routing=dynamic_routing,
                skip_route_ids=processed_route_ids,
                skip_destination_ids=base_destination_ids,
            )
            if enriched_events:
                try:
                    from app.dynamic_routing.dynamic_routing_service import log_dynamic_routing_complete

                    self._db_write(
                        lambda db: log_dynamic_routing_complete(
                            db,
                            stream_id=int(_get(stream, "id")),
                            result=dynamic_routing,
                            dynamic_deliveries_this_run=dynamic_deliveries_sent,
                            log_fn=self._log,
                        )
                    )
                except Exception:
                    logger.exception(
                        "dynamic_routing_complete_log_failed stream_id=%s",
                        int(_get(stream, "id")),
                    )

        failover_processing_time_ms = max(0, int((time.monotonic() - failover_started) * 1000))
        if failover_bindings:
            try:
                from app.failover_routing.failover_metrics import log_failover_routing_complete

                self._db_write(
                    lambda db: log_failover_routing_complete(
                        db,
                        stream_id=stream_id,
                        failover_route_count=len(failover_bindings),
                        attempt_count=failover_attempt_count,
                        success_count=failover_success_count,
                        failure_count=failover_failure_count,
                        processing_time_ms=failover_processing_time_ms,
                        log_fn=self._log,
                    )
                )
            except Exception:
                logger.exception("failover_routing_complete_log_failed stream_id=%s", stream_id)

        if not saw_actionable_route:
            self._emit_obs(
                {
                    "stage": "pipeline_no_actionable_routes",
                    "stream_id": stream_id,
                    "detail": "no_destinations_resolved_for_delivery",
                }
            )
            return FanOutOutcome(successful_events=[], dynamic_deliveries_sent=dynamic_deliveries_sent)

        if all_required_routes_succeeded and any_delivery_success:
            return FanOutOutcome(
                successful_events=copy_events(events),
                log_continue_failed_route_ids=tuple(log_continue_failed_route_ids),
                dynamic_deliveries_sent=dynamic_deliveries_sent,
                failover_attempt_count=failover_attempt_count,
                failover_success_count=failover_success_count,
                failover_failure_count=failover_failure_count,
                failover_processing_time_ms=failover_processing_time_ms,
            )
        return FanOutOutcome(
            successful_events=[],
            log_continue_failed_route_ids=tuple(log_continue_failed_route_ids),
            dynamic_deliveries_sent=dynamic_deliveries_sent,
            failover_attempt_count=failover_attempt_count,
            failover_success_count=failover_success_count,
            failover_failure_count=failover_failure_count,
            failover_processing_time_ms=failover_processing_time_ms,
        )

    def _attempt_failover_send(
        self,
        stream: Any,
        *,
        route_id: int,
        primary_destination_id: int,
        events: list[dict[str, Any]],
        formatter_override: dict[str, Any] | None,
        failover_bindings: dict[int, Any],
        primary_error: Exception,
        primary_latency_ms: int,
    ) -> FailoverAttemptResult:
        from app.failover_routing.failover_eligibility import is_failover_eligible_error
        from app.failover_routing.failover_metrics import (
            FAILOVER_ROUTE_ATTEMPT_STAGE,
            FAILOVER_ROUTE_SEND_FAILED_STAGE,
            FAILOVER_ROUTE_SEND_SUCCESS_STAGE,
        )

        stream_id = int(_get(stream, "id"))
        if not is_failover_eligible_error(primary_error):
            return FailoverAttemptResult()

        binding = failover_bindings.get(int(primary_destination_id))
        if binding is None:
            return FailoverAttemptResult()

        if not bool(binding.secondary_destination_enabled):
            self._log(
                {
                    "stage": FAILOVER_ROUTE_ATTEMPT_STAGE,
                    "stream_id": stream_id,
                    "failover_route_id": binding.failover_route_id,
                    "route_id": route_id,
                    "primary_destination_id": primary_destination_id,
                    "secondary_destination_id": binding.secondary_destination_id,
                    "skip_reason": "secondary_destination_disabled",
                    "primary_latency_ms": primary_latency_ms,
                    "error_type": type(primary_error).__name__,
                    "message": str(primary_error),
                }
            )
            return FailoverAttemptResult(attempted=True, succeeded=False)

        limiter_key = -(int(binding.failover_route_id) + 1_000_000)
        rate_limit_json = dict(binding.secondary_rate_limit_json or {})
        if not self.destination_limiter.allow(limiter_key, rate_limit_json):
            self._log(
                {
                    "stage": FAILOVER_ROUTE_ATTEMPT_STAGE,
                    "stream_id": stream_id,
                    "failover_route_id": binding.failover_route_id,
                    "route_id": route_id,
                    "primary_destination_id": primary_destination_id,
                    "secondary_destination_id": binding.secondary_destination_id,
                    "skip_reason": "secondary_rate_limited",
                    "primary_latency_ms": primary_latency_ms,
                }
            )
            return FailoverAttemptResult(attempted=True, succeeded=False)

        stream_name = str(_get(stream, "name", "") or "")
        prefix_context = build_message_prefix_context(
            stream_name=stream_name,
            stream_id=stream_id,
            destination_name=binding.secondary_destination_name,
            destination_type=binding.secondary_destination_type,
            route_id=route_id,
        )
        self._log(
            {
                "stage": FAILOVER_ROUTE_ATTEMPT_STAGE,
                "stream_id": stream_id,
                "failover_route_id": binding.failover_route_id,
                "route_id": route_id,
                "primary_destination_id": primary_destination_id,
                "secondary_destination_id": binding.secondary_destination_id,
                "primary_latency_ms": primary_latency_ms,
                "error_type": type(primary_error).__name__,
                "message": str(primary_error),
            }
        )
        send_started = time.monotonic()
        secondary_config = dict(binding.secondary_destination_config or {})
        try:
            from app.ai_providers.runtime_config import resolve_destination_runtime_config

            secondary_config = self._db_read(
                lambda db: resolve_destination_runtime_config(
                    db,
                    binding.secondary_destination_type,
                    secondary_config,
                )
            )
        except Exception:
            logger.exception("failover_secondary_config_resolve_failed stream_id=%s", stream_id)
        try:
            self._send_to_destination(
                binding.secondary_destination_type,
                events,
                secondary_config,
                formatter_override=formatter_override,
                prefix_context=prefix_context,
            )
            latency_ms = max(0, int((time.monotonic() - send_started) * 1000))
            self._log(
                {
                    "stage": FAILOVER_ROUTE_SEND_SUCCESS_STAGE,
                    "stream_id": stream_id,
                    "failover_route_id": binding.failover_route_id,
                    "route_id": route_id,
                    "primary_destination_id": primary_destination_id,
                    "secondary_destination_id": binding.secondary_destination_id,
                    "event_count": len(events),
                    "latency_ms": latency_ms,
                }
            )
            return FailoverAttemptResult(attempted=True, succeeded=True, secondary_send_attempted=True)
        except Exception as secondary_exc:
            latency_ms = max(0, int((time.monotonic() - send_started) * 1000))
            self._log(
                {
                    "stage": FAILOVER_ROUTE_SEND_FAILED_STAGE,
                    "stream_id": stream_id,
                    "failover_route_id": binding.failover_route_id,
                    "route_id": route_id,
                    "primary_destination_id": primary_destination_id,
                    "secondary_destination_id": binding.secondary_destination_id,
                    "error_type": type(secondary_exc).__name__,
                    "message": str(secondary_exc),
                    "latency_ms": latency_ms,
                }
            )
            return FailoverAttemptResult(
                attempted=True,
                succeeded=False,
                secondary_send_attempted=True,
                secondary_error=secondary_exc,
            )

    def _maybe_record_replay_event(
        self,
        *,
        stream: Any,
        route: Any | None,
        events: list[dict[str, Any]],
        destination_id: int,
        destination_type: str,
        formatter_override: dict[str, Any] | None,
        prefix_context: MessagePrefixResolveContext | None,
        delivery_kind: str,
        error: Exception | None = None,
        rate_limited: bool = False,
        dynamic_route_id: int | None = None,
        failover_route_id: int | None = None,
    ) -> None:
        """Record protected delivery payload for M11 replay (not backfill / preview)."""

        if self._run_opts.dry_run:
            return
        if self._run_opts.replay_start is not None or self._run_opts.replay_end is not None:
            return
        if not events or destination_id <= 0:
            return
        if error is not None:
            from app.ai_policy.errors import AiPolicyEnforcementError

            if isinstance(error, AiPolicyEnforcementError):
                return
        try:
            from app.replay.recording import record_stream_replay_event

            route_id = int(_get(route, "id", 0)) if route is not None else None

            def _record(db: Session) -> None:
                record_stream_replay_event(
                    db,
                    stream_id=int(_get(stream, "id")),
                    destination_id=int(destination_id),
                    delivery_kind=delivery_kind,
                    events=events,
                    destination_type=destination_type,
                    formatter_override=formatter_override,
                    prefix_context=prefix_context,
                    error=error,
                    rate_limited=rate_limited,
                    route_id=route_id if route_id else None,
                    dynamic_route_id=dynamic_route_id,
                    failover_route_id=failover_route_id,
                )

            self._db_write(_record)
        except Exception:
            logger.exception(
                "stream_replay_event_record_failed stream_id=%s destination_id=%s",
                _get(stream, "id"),
                destination_id,
            )

    def _prefix_delivery_context(self, stream: Any, route: Any) -> MessagePrefixResolveContext:
        stream_id = int(_get(stream, "id", 0))
        stream_name = str(_get(stream, "name", "") or "")
        route_id = int(_get(route, "id", 0))
        destination = _get(route, "destination", {}) or {}
        dest_name = str(_get(destination, "name", "") or "")
        dest_type = str(_get(destination, "destination_type", "") or "")
        return build_message_prefix_context(
            stream_name=stream_name,
            stream_id=stream_id,
            destination_name=dest_name,
            destination_type=dest_type,
            route_id=route_id,
        )

    def _record_ai_policy_block(self, exc: Any) -> None:
        runtime_stream = getattr(self, "_runtime_stream", None)
        if not isinstance(runtime_stream, dict):
            return
        source_config = runtime_stream.get("source_config")
        if not isinstance(source_config, dict):
            return
        holder = source_config.get("_ai_sync_holder")
        if not isinstance(holder, dict):
            return
        holder["policy_blocked"] = {
            "stage": str(getattr(exc, "stage", "")),
            "action": str(getattr(exc, "action", "")),
            "policy_id": getattr(exc, "policy_id", None),
            "policy_name": str(getattr(exc, "policy_name", "") or ""),
            "message": str(exc),
        }

    def _send_to_destination(
        self,
        destination_type: str,
        events: list[dict[str, Any]],
        destination_config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        *,
        prefix_context: MessagePrefixResolveContext | None = None,
    ) -> None:
        runtime_stream = getattr(self, "_runtime_stream", None)
        if isinstance(runtime_stream, dict):
            source_config = runtime_stream.get("source_config") or {}
            sync_holder = source_config.get("_ai_sync_holder")
            if isinstance(sync_holder, dict):
                destination_config = dict(destination_config)
                destination_config["_ai_sync_holder"] = sync_holder
            destination_config = dict(destination_config)
            destination_config["_policy_db_short_sessions"] = True
            destination_config["_stream_id"] = int(_get(runtime_stream, "id", 0))
            destination_config["_ai_policy_log_fn"] = self._log
        self.destination_registry.get(destination_type).send(
            events,
            destination_config,
            formatter_override=formatter_override,
            prefix_context=prefix_context,
        )

    def _apply_failure_policy(
        self,
        stream: Any,
        route: Any,
        events: list[dict[str, Any]],
        error: Exception,
        *,
        attempt_latency_ms: int | None = None,
        emit_failure_log: bool = True,
    ) -> bool:
        """Apply route-level failure policy."""

        stream_id = int(_get(stream, "id"))
        route_id = int(_get(route, "id", 0))
        policy = str(_get(route, "failure_policy", "LOG_AND_CONTINUE")).upper()
        if emit_failure_log:
            fail_payload: dict[str, Any] = {
                "stage": "route_send_failed",
                "stream_id": stream_id,
                "route_id": route_id,
                "destination_id": _get(_get(route, "destination", {}) or {}, "id"),
                "failure_policy": policy,
                "error_type": type(error).__name__,
                "message": str(error),
                "latency_ms": attempt_latency_ms,
            }
            if events:
                fail_payload["replay_events"] = copy_events(events, limit=_MAX_REPLAY_EVENTS_IN_LOG)
                fail_payload["event_count"] = len(events)
            self._log(fail_payload)

        if policy == "LOG_AND_CONTINUE":
            return True

        if policy == "PAUSE_STREAM_ON_FAILURE":
            self._set_stream_status(stream, "PAUSED")
            return False

        if policy == "DISABLE_ROUTE_ON_FAILURE":
            self._set_route_enabled(route, False)
            return False

        if policy == "RETRY_AND_BACKOFF":
            retry_count = int(_get(route, "retry_count", 2))
            backoff_seconds = float(_get(route, "backoff_seconds", 1.0))
            destination = _get(route, "destination", {}) or {}
            destination_type = str(_get(destination, "destination_type", "")).upper()
            destination_config = _get(destination, "config", {}) or {}
            route_fc_retry = _get(route, "formatter_config_json")
            formatter_retry: dict[str, Any] | None = None
            if isinstance(route_fc_retry, dict) and route_fc_retry:
                formatter_retry = route_fc_retry
            if not events:
                return False

            prefix_context = self._prefix_delivery_context(stream, route)

            last_exc: Exception | None = None
            for idx in range(retry_count):
                try:
                    rs = time.monotonic()
                    self._send_to_destination(
                        destination_type,
                        events,
                        destination_config,
                        formatter_override=formatter_retry,
                        prefix_context=prefix_context,
                    )
                    rlat = max(0, int((time.monotonic() - rs) * 1000))
                    self._log(
                        {
                            "stage": "route_retry_success",
                            "stream_id": stream_id,
                            "route_id": route_id,
                            "attempt": idx + 1,
                            "retry_count": idx + 1,
                            "latency_ms": rlat,
                        }
                    )
                    if self._dedup_summary is not None:
                        dest_id = _get(destination, "id")
                        record_dedup_registry_for_route_success(
                            stream_id=stream_id,
                            route_events=events,
                            summary=self._dedup_summary,
                            destination=str(destination_type or "") or None,
                            destination_id=int(dest_id) if dest_id is not None else None,
                            route_id=route_id,
                            log_fn=self._log,
                        )
                    return True
                except Exception as exc:  # pragma: no cover - defensive
                    last_exc = exc
                    time.sleep(max(backoff_seconds * (2 ** idx), 0))
            retry_fail_payload: dict[str, Any] = {
                "stage": "route_retry_failed",
                "stream_id": stream_id,
                "route_id": route_id,
                "retry_count": retry_count,
                "error_type": type(last_exc).__name__ if last_exc else None,
                "message": str(last_exc) if last_exc else "retry failed",
            }
            if events:
                retry_fail_payload["replay_events"] = copy_events(events, limit=_MAX_REPLAY_EVENTS_IN_LOG)
                retry_fail_payload["event_count"] = len(events)
            self._log(retry_fail_payload)
            destination = _get(route, "destination", {}) or {}
            dest_id = _get(destination, "id")
            if dest_id is not None:
                self._maybe_record_replay_event(
                    stream=stream,
                    route=route,
                    events=events,
                    destination_id=int(dest_id),
                    destination_type=str(_get(destination, "destination_type", "")).upper(),
                    formatter_override=formatter_retry,
                    prefix_context=prefix_context,
                    delivery_kind="base_route",
                    error=last_exc,
                )
            return False

        self._log(
            {
                "stage": "route_unknown_failure_policy",
                "stream_id": stream_id,
                "route_id": route_id,
                "failure_policy": policy,
            }
        )
        return False

    def _set_stream_status(self, stream: Any, status: str) -> None:
        stream_id = int(_get(stream, "id"))
        self._pending_stream_status[stream_id] = status
        if isinstance(stream, dict):
            stream["status"] = status
        else:
            setattr(stream, "status", status)

    def _set_route_enabled(self, route: Any, enabled: bool) -> None:
        if enabled is False:
            self._pending_disabled_routes.add(int(_get(route, "id")))
        if isinstance(route, dict):
            route["enabled"] = enabled
        else:
            setattr(route, "enabled", enabled)

    def _resolve_checkpoint(
        self, *, runtime_checkpoint: Any, stream_id: int
    ) -> tuple[str, dict[str, Any] | None]:
        checkpoint_type = "CUSTOM_FIELD"
        checkpoint = runtime_checkpoint
        if isinstance(runtime_checkpoint, dict) and "value" in runtime_checkpoint:
            checkpoint = runtime_checkpoint.get("value")
            checkpoint_type = str(runtime_checkpoint.get("type", "CUSTOM_FIELD"))

        if checkpoint is not None:
            return checkpoint_type, checkpoint

        def _read(db: Session) -> tuple[str, dict[str, Any] | None]:
            db_checkpoint = self.checkpoint_service.get_checkpoint(db, stream_id)
            if isinstance(db_checkpoint, dict) and "value" in db_checkpoint:
                return str(db_checkpoint.get("type", "CUSTOM_FIELD")), db_checkpoint.get("value")
            return checkpoint_type, db_checkpoint

        try:
            return run_with_db(_read, commit=False)
        except Exception:
            logger.exception("checkpoint_read_failed stream_id=%s", stream_id)
            return checkpoint_type, self.checkpoint_service.get_checkpoint_for_stream(stream_id)

    def _observe_extracted_event_schema(self, *, stream_id: int, events: list[dict[str, Any]]) -> None:
        """Record observed field paths and run field drift detection (read-only)."""

        if not events:
            return
        try:
            from app.schema_observation.service import observe_extracted_events

            self._db_write(lambda db: observe_extracted_events(db, stream_id, events))
        except Exception:
            logger.exception("schema_observation_failed stream_id=%s", stream_id)

    def _detect_sensitive_fields(self, *, stream_id: int, events: list[dict[str, Any]]) -> None:
        """Detect sensitive fields once per batch; persist and store shared context."""

        if not events:
            return
        try:
            from app.sensitive_detection.service import detect_sensitive_fields

            def _detect(db: Session) -> Any:
                return detect_sensitive_fields(db, stream_id=stream_id, events=events)

            self._sensitive_detection_context = self._db_write(_detect)
        except Exception:
            logger.exception("sensitive_detection_failed stream_id=%s", stream_id)

    def _classify_events(self, *, stream_id: int, events: list[dict[str, Any]]) -> None:
        """Rule-based classification after sensitive detection, before protection."""

        if not events:
            return
        try:
            from app.classification.service import classify_events_for_delivery

            self._db_write(
                lambda db: classify_events_for_delivery(
                    db,
                    stream_id=stream_id,
                    enriched_events=events,
                    log_fn=self._log,
                    detection_context=self._sensitive_detection_context,
                )
            )
        except Exception:
            logger.exception("classification_failed stream_id=%s", stream_id)

    def _apply_schema_drift_policy(
        self,
        *,
        stream_id: int,
        runtime_stream: Any,
        enriched_events: list[dict[str, Any]],
    ) -> Any:
        """Evaluate schema drift policy after sensitive detection, before protection."""

        if not enriched_events:
            return None
        try:
            from app.schema_drift_policy.orchestrator import apply_schema_drift_policy_to_batch

            stream_config = dict(_get(runtime_stream, "stream_config", {}) or {})
            field_mappings = dict(_get(runtime_stream, "field_mappings", {}) or {})
            enrichment_json = dict(_get(runtime_stream, "enrichment", {}) or {})
            return self._db_write(
                lambda db: apply_schema_drift_policy_to_batch(
                    db,
                    stream_id=stream_id,
                    stream_config_json=stream_config,
                    field_mappings=field_mappings,
                    enrichment_json=enrichment_json,
                    enriched_events=enriched_events,
                    detection_context=self._sensitive_detection_context,
                    log_fn=self._log,
                )
            )
        except Exception:
            logger.exception("schema_drift_policy_failed stream_id=%s", stream_id)
            return None

    def _prepare_delivery_events(
        self,
        *,
        stream_id: int,
        enriched_events: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], Any]:
        """Build masked outbound copy; enriched batch stays unmodified for checkpoint."""

        from app.protection.engine import ProtectBatchResult
        from app.protection.service import protect_events_for_delivery

        if not enriched_events:
            empty = ProtectBatchResult(events=[])
            return [], empty

        drift_result = self._schema_drift_policy_result
        ephemeral_rules = None
        if drift_result is not None and getattr(drift_result, "ephemeral_protection_rules", None):
            ephemeral_rules = drift_result.ephemeral_protection_rules

        delivery_events, result = self._db_write(
            lambda db: protect_events_for_delivery(
                db,
                stream_id=stream_id,
                enriched_events=enriched_events,
                ephemeral_rules=ephemeral_rules,
            )
        )
        for warn in result.warnings:
            self._log(
                {
                    "stage": "protection",
                    "stream_id": stream_id,
                    "message": warn.error_message,
                    **warn.to_log_fields(),
                }
            )
        cumulative = {"total_protected_events": 0, "total_protected_fields": 0}
        try:
            from app.protection.metrics import (
                build_protection_complete_payload,
                load_cumulative_protection_totals,
            )

            cumulative = self._db_read(lambda db: load_cumulative_protection_totals(db, stream_id))
        except Exception:
            logger.exception("protection_cumulative_totals_failed stream_id=%s", stream_id)
        self._log(
            build_protection_complete_payload(
                stream_id=stream_id,
                result=result,
                enriched_event_count=len(enriched_events),
                cumulative_totals=cumulative,
            )
        )
        return delivery_events, result

    def _log_route_policy_evaluation_complete(
        self,
        *,
        stream_id: int,
        pipeline: RoutePipelineResult,
    ) -> None:
        """Emit stream-level policy_evaluation_complete from route-path Policy Engine results."""

        if not pipeline.stage_results:
            return
        from app.protection.policy_engine import PolicyBatchResult
        from app.protection.policy_metrics import (
            build_policy_evaluation_complete_payload,
            load_cumulative_policy_totals,
        )

        batch: PolicyBatchResult | None = None
        for result in pipeline.stage_results:
            policy = result.policy_result
            inner = getattr(policy, "policy_batch_result", None) if policy is not None else None
            if isinstance(inner, PolicyBatchResult):
                batch = inner
                break
        if batch is None:
            batch = PolicyBatchResult()
        try:
            cumulative = self._db_read(lambda db: load_cumulative_policy_totals(db, stream_id))
        except Exception:
            cumulative = {"total_audit_events": 0, "total_matched_policies": 0}
        payload = build_policy_evaluation_complete_payload(
            stream_id=stream_id,
            result=batch,
            cumulative_totals=cumulative,
        )
        if self._sensitive_detection_context is not None:
            payload["sensitive_detection_reused"] = True
            payload["sensitive_detection_passes"] = 1
        self._log(payload)

    def _evaluate_policies(
        self,
        *,
        stream_id: int,
        enriched_events: list[dict[str, Any]],
    ) -> Any:
        """Policy evaluation after protection; audit-only or quarantine signal."""

        if not enriched_events:
            from app.protection.policy_engine import PolicyBatchResult

            return PolicyBatchResult()
        try:
            from app.protection.policy_service import evaluate_policies_for_delivery

            return self._db_write(
                lambda db: evaluate_policies_for_delivery(
                    db,
                    stream_id=stream_id,
                    enriched_events=enriched_events,
                    log_fn=self._log,
                    detection_context=self._sensitive_detection_context,
                )
            )
        except Exception:
            logger.exception("policy_evaluation_failed stream_id=%s", stream_id)
            from app.protection.policy_engine import PolicyBatchResult

            return PolicyBatchResult()

    def _merge_schema_drift_policy_quarantine(self, policy_result: Any) -> Any:
        drift_result = self._schema_drift_policy_result
        if drift_result is None or not getattr(drift_result, "should_quarantine", False):
            return policy_result
        try:
            from app.protection.policy_engine import PolicyBatchResult
            from app.schema_drift_policy.orchestrator import merge_schema_drift_quarantine

            if not isinstance(policy_result, PolicyBatchResult):
                policy_result = PolicyBatchResult()
            unknown_fields = list(getattr(drift_result, "unknown_fields", []) or [])
            field_paths = [str(item.enriched_path) for item in unknown_fields if getattr(item, "enriched_path", None)]
            policy_type = str(getattr(drift_result, "quarantine_policy_type", None) or "unknown_normal")
            return merge_schema_drift_quarantine(
                policy_result,
                policy_type=policy_type,
                field_paths=field_paths,
            )
        except Exception:
            logger.exception("schema_drift_policy_quarantine_merge_failed")
            return policy_result

    def _try_policy_quarantine(
        self,
        *,
        stream_id: int,
        delivery_events: list[dict[str, Any]],
        policy_result: Any,
    ) -> bool:
        from app.quarantine.runtime_integration import try_policy_quarantine_for_batch

        return self._db_write(
            lambda db: try_policy_quarantine_for_batch(
                db,
                stream_id=stream_id,
                delivery_events=delivery_events,
                policy_result=policy_result,
                log_fn=self._log,
            )
        )

    def _evaluate_dynamic_routes(
        self,
        *,
        stream_id: int,
        enriched_events: list[dict[str, Any]],
    ) -> Any | None:
        """Dynamic routing selects existing Routes; it does not send destinations."""

        if not enriched_events:
            return None
        try:
            from app.dynamic_routing.dynamic_routing_service import evaluate_dynamic_routes_for_delivery

            return self._db_write(
                lambda db: evaluate_dynamic_routes_for_delivery(
                    db,
                    stream_id=stream_id,
                    enriched_events=enriched_events,
                    detection_context=self._sensitive_detection_context,
                )
            )
        except Exception:
            logger.exception("dynamic_routing_evaluation_failed stream_id=%s", stream_id)
            return None

    def _deliver_dynamic_routes(
        self,
        stream: Any,
        events: list[dict[str, Any]],
        *,
        dynamic_routing: Any,
        skip_destination_ids: set[int],
        skip_route_ids: set[int] | None = None,
    ) -> int:
        """Record Dynamic Route selection. Never sends; delivery stays on the Route pipeline."""

        _ = events
        matches = list(getattr(dynamic_routing, "matches", []) or [])
        if not matches:
            return 0

        stream_id = int(_get(stream, "id"))
        already_processed = set(skip_route_ids or set())
        for match in matches:
            dest_id = int(getattr(match, "destination_id", 0) or 0)
            dynamic_id = int(getattr(match, "dynamic_route_id", 0) or 0)
            bound_route_id = int(getattr(match, "route_id", 0) or 0)
            if bound_route_id <= 0:
                self._log(
                    {
                        "stage": "dynamic_route_send_skip",
                        "stream_id": stream_id,
                        "dynamic_route_id": dynamic_id,
                        "destination_id": dest_id,
                        "skip_reason": "unresolved_route",
                    }
                )
                continue
            if bound_route_id in already_processed:
                self._log(
                    {
                        "stage": "dynamic_route_send_skip",
                        "stream_id": stream_id,
                        "dynamic_route_id": dynamic_id,
                        "route_id": bound_route_id,
                        "destination_id": dest_id,
                        "skip_reason": "duplicate_base_route",
                    }
                )
                continue
            if dest_id in skip_destination_ids:
                self._log(
                    {
                        "stage": "dynamic_route_send_skip",
                        "stream_id": stream_id,
                        "dynamic_route_id": dynamic_id,
                        "route_id": bound_route_id,
                        "destination_id": dest_id,
                        "skip_reason": "duplicate_base_destination",
                    }
                )
                continue
            self._log(
                {
                    "stage": "dynamic_route_send_skip",
                    "stream_id": stream_id,
                    "dynamic_route_id": dynamic_id,
                    "route_id": bound_route_id,
                    "destination_id": dest_id,
                    "skip_reason": "route_not_in_runtime",
                }
            )
        return 0

    def _collect_source_events(
        self,
        *,
        runtime_stream: Any,
        checkpoint: dict[str, Any] | None,
        stream_id: int,
        run_opts: StreamRunOptions,
    ) -> list[dict[str, Any]]:
        """Stream-owned source acquisition + shared batch preparation (once per run).

        Owns fetch/extract/dedup/schema observation. Does not apply stream/global
        mapping or enrichment, does not deliver, and does not write checkpoint.
        """

        source_config = dict(_get(runtime_stream, "source_config", {}) or {})
        stream_config = dict(_get(runtime_stream, "stream_config", {}) or {})

        fetch_checkpoint: dict[str, Any] | None
        if isinstance(checkpoint, dict):
            fetch_checkpoint = dict(checkpoint)
        else:
            fetch_checkpoint = None

        if run_opts.replay_start is not None and run_opts.replay_end is not None:
            iso_s = _replay_iso_utc(run_opts.replay_start)
            iso_e = _replay_iso_utc(run_opts.replay_end)
            stream_config["gdc_replay_start_iso"] = iso_s
            stream_config["gdc_replay_end_iso"] = iso_e
            fc = dict(fetch_checkpoint or {})
            fc["gdc_backfill_start_iso"] = iso_s
            fc["gdc_backfill_end_iso"] = iso_e
            fetch_checkpoint = fc

        self._emit_obs({"stage": "http_fetch_start", "stream_id": stream_id})
        source_type = str(_get(runtime_stream, "source_type", "HTTP_API_POLLING")).strip().upper()
        t_fetch = time.monotonic()
        raw_response = self.source_registry.get(source_type).fetch(source_config, stream_config, fetch_checkpoint)
        fetch_ms = max(0, int((time.monotonic() - t_fetch) * 1000))
        if self._run_timing is not None:
            self._run_timing.add_ms("source_fetch", fetch_ms)
        self._emit_obs(
            {
                "stage": "http_fetch_complete",
                "stream_id": stream_id,
                "raw_type": type(raw_response).__name__,
            }
        )
        self._log(
            {
                "stage": "source_fetch",
                "stream_id": stream_id,
                "message": "source fetch completed",
                "latency_ms": fetch_ms,
                "source_type": source_type,
            }
        )
        t_parse = time.monotonic()
        event_array_path = _get(
            runtime_stream, "event_array_path", _get(stream_config, "event_array_path")
        )
        event_root_path = _get(
            runtime_stream, "event_root_path", _get(stream_config, "event_root_path")
        )
        try:
            events = extract_events(raw_response, event_array_path, event_root_path)
        except MappingError as err:
            # Operators can edit streams with previously persisted paths before
            # fetching a fresh sample. If event_root_path no longer matches a
            # changed upstream payload, do not hard-fail the entire run.
            # Fallback to extracted event objects without root projection.
            if (
                event_root_path is not None
                and str(event_root_path).strip()
                and "event_root_path did not match event item at index"
                in str(err)
            ):
                self._log(
                    {
                        "stage": "parse",
                        "stream_id": stream_id,
                        "status": "EVENT_ROOT_PATH_FALLBACK",
                        "message": (
                            "event_root_path did not match the latest payload; "
                            "continuing run without event_root_path projection"
                        ),
                        "event_root_path": str(event_root_path),
                    }
                )
                events = extract_events(raw_response, event_array_path, None)
            else:
                raise
        if self._run_timing is not None:
            self._run_timing.add_ms("parse", max(0, int((time.monotonic() - t_parse) * 1000)))
        self._log(
            {
                "stage": "parse",
                "stream_id": stream_id,
                "message": "events extracted",
                "extracted_event_count": len(events),
            }
        )
        raw_extracted = events
        # Dedup seed reads use a short session when needed — never the caller session.
        events, dedup_summary = apply_stream_dedup(
            raw_extracted,
            stream_config=stream_config,
            stream_id=stream_id,
            db=None,
            checkpoint=checkpoint if isinstance(checkpoint, dict) else None,
            dry_run=bool(run_opts.dry_run),
            apply_dedup=bool(run_opts.apply_dedup),
            log_fn=self._log,
        )
        self._dedup_summary = dedup_summary
        if dedup_summary is not None:
            self._log(
                {
                    "stage": "dedup_queue_insert",
                    "stream_id": stream_id,
                    "message": "stream dedup applied",
                    **dedup_summary.to_dict(),
                }
            )
        if not events:
            return []

        if self._run_timing is not None:
            self._run_timing.start_phase("schema_drift")
        self._observe_extracted_event_schema(stream_id=stream_id, events=events)
        if self._run_timing is not None:
            self._run_timing.end_phase("schema_drift")
        return events

    def _apply_stream_global_transform(
        self,
        *,
        runtime_stream: Any,
        events: list[dict[str, Any]],
        stream_id: int,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
        """Route Processing OFF: stream-scoped mapping/enrichment/classify/drift.

        Does not fetch source, does not deliver, and does not write checkpoint.
        """

        field_mappings = _get(runtime_stream, "field_mappings", {}) or {}
        t_mapping = time.monotonic()
        mapping_results = apply_mappings_with_results(events, field_mappings)
        if self._run_timing is not None:
            self._run_timing.add_ms("mapping", max(0, int((time.monotonic() - t_mapping) * 1000)))
        mapped_events: list[dict[str, Any]] = []
        for mapping_result in mapping_results:
            if mapping_result.event_error is not None:
                err = mapping_result.event_error
                self._log(
                    {
                        "stage": "mapping",
                        "stream_id": stream_id,
                        "message": err.error_message,
                        "error_code": err.error_code,
                        **err.to_delivery_log_fields(),
                    }
                )
                raise MappingError(err.error_message)
            mapped_events.append(mapping_result.mapped_event)
            for field_err in mapping_result.field_errors:
                self._log(
                    {
                        "stage": "mapping",
                        "stream_id": stream_id,
                        "message": field_err.error_message,
                        "status": "FIELD_TRANSFORM_WARNING",
                        **field_err.to_delivery_log_fields(),
                    }
                )
        self._emit_obs(
            {
                "stage": "mapping",
                "stream_id": stream_id,
                "message": "mapping applied",
                "mapped_event_count": len(mapped_events),
            }
        )
        enrichment_cfg = _get(runtime_stream, "enrichment", {}) or {}
        t_enrichment = time.monotonic()
        batch_result = apply_enrichments_batch(
            mapped_events,
            enrichment_cfg,
            override_policy=str(_get(runtime_stream, "override_policy", "KEEP_EXISTING")),
        )
        if self._run_timing is not None:
            self._run_timing.add_ms(
                "enrichment",
                max(0, int(batch_result.duration_ms or max(0, int((time.monotonic() - t_enrichment) * 1000)))),
            )
        enriched_events = batch_result.events
        if len(events) == len(enriched_events):
            s3_meta_keys = ("s3_bucket", "s3_key", "s3_last_modified", "s3_etag", "s3_size")
            db_meta_keys = ("gdc_db_watermark", "gdc_db_order_value")
            remote_meta_keys = (
                "remote_path",
                "remote_mtime",
                "remote_size",
                "gdc_remote_path",
                "gdc_remote_mtime",
                "gdc_remote_size",
                "gdc_remote_offset",
                "gdc_remote_hash",
                "gdc_remote_protocol",
                "gdc_remote_host",
            )
            for idx, enriched in enumerate(enriched_events):
                raw_ev = events[idx]
                if not isinstance(raw_ev, dict) or not isinstance(enriched, dict):
                    continue
                for mk in s3_meta_keys:
                    if mk in raw_ev and mk not in enriched:
                        enriched[mk] = raw_ev[mk]
                for mk in db_meta_keys:
                    if mk in raw_ev and mk not in enriched:
                        enriched[mk] = raw_ev[mk]
                for mk in remote_meta_keys:
                    if mk in raw_ev and mk not in enriched:
                        enriched[mk] = raw_ev[mk]
                propagate_dedup_metadata(raw_ev, enriched)
        for field_err in batch_result.field_errors:
            self._log(
                {
                    "stage": "enrichment",
                    "stream_id": stream_id,
                    "message": field_err.error_message,
                    "status": "FIELD_TRANSFORM_WARNING",
                    **field_err.to_delivery_log_fields(),
                }
            )
        self._emit_obs(
            {
                "stage": "enrichment",
                "stream_id": stream_id,
                "message": "enrichment applied",
                "enriched_event_count": len(enriched_events),
                "duration_ms": batch_result.duration_ms,
                "warning_count": batch_result.warning_count,
            }
        )
        if self._run_timing is not None:
            self._run_timing.start_phase("sensitive_detection")
        self._detect_sensitive_fields(stream_id=stream_id, events=enriched_events)
        if self._run_timing is not None:
            self._run_timing.end_phase("sensitive_detection")

        if self._run_timing is not None:
            self._run_timing.start_phase("classification")
        self._classify_events(stream_id=stream_id, events=enriched_events)
        if self._run_timing is not None:
            self._run_timing.end_phase("classification")
        self._schema_drift_policy_result = self._apply_schema_drift_policy(
            stream_id=stream_id,
            runtime_stream=runtime_stream,
            enriched_events=enriched_events,
        )
        stats = {
            "extracted_count": len(events),
            "mapped_count": len(mapped_events),
            "enriched_count": len(enriched_events),
        }
        self._emit_obs(
            {
                "stage": "pipeline_transform",
                "stream_id": stream_id,
                "extracted_event_count": stats["extracted_count"],
                "mapped_event_count": stats["mapped_count"],
                "enriched_event_count": stats["enriched_count"],
            }
        )
        return events, enriched_events, stats

    def _collect_and_transform_events(
        self,
        *,
        runtime_stream: Any,
        checkpoint: dict[str, Any] | None,
        stream_id: int,
        run_opts: StreamRunOptions,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
        """Orchestrate Stream-owned source collect then OFF-only stream/global transform.

        Route Processing ON skips stream transform here and hands the shared extracted
        batch to the existing per-route pipeline. Checkpoint and delivery remain outside.
        """

        events = self._collect_source_events(
            runtime_stream=runtime_stream,
            checkpoint=checkpoint,
            stream_id=stream_id,
            run_opts=run_opts,
        )
        if not events:
            return [], [], {"extracted_count": 0, "mapped_count": 0, "enriched_count": 0}

        if self._route_processing_enabled():
            if self._run_timing is not None:
                self._run_timing.start_phase("sensitive_detection")
            self._detect_sensitive_fields(stream_id=stream_id, events=events)
            if self._run_timing is not None:
                self._run_timing.end_phase("sensitive_detection")
            stats = {
                "extracted_count": len(events),
                "mapped_count": 0,
                "enriched_count": 0,
            }
            self._emit_obs(
                {
                    "stage": "pipeline_shared_phase",
                    "stream_id": stream_id,
                    "extracted_event_count": stats["extracted_count"],
                    "route_processing": True,
                }
            )
            return events, list(events), stats

        return self._apply_stream_global_transform(
            runtime_stream=runtime_stream,
            events=events,
            stream_id=stream_id,
        )

    def _update_checkpoint_after_success(
        self,
        *,
        stream_id: int,
        checkpoint_type: str,
        successful_events: list[dict[str, Any]],
        checkpoint_before: dict[str, Any] | None,
        processed_events: int,
        delivered_events: int,
        failed_events: int,
        partial_success: bool,
        update_reason: str,
        log_continue_failed_route_ids: tuple[int, ...],
    ) -> dict[str, Any] | None:
        correlated = [
            {"route_id": int(rid), "failure_kind": "log_and_continue_absorbed"} for rid in log_continue_failed_route_ids
        ]
        last_ev = copy_event_dict(successful_events[-1])
        checkpoint_value: dict[str, Any] = {"last_success_event": last_ev}
        if isinstance(last_ev, dict):
            sk = last_ev.get("s3_key")
            slm = last_ev.get("s3_last_modified")
            etag = last_ev.get("s3_etag")
            if sk is not None:
                checkpoint_value["last_processed_key"] = sk
            if slm is not None:
                checkpoint_value["last_processed_last_modified"] = slm
            if etag is not None:
                checkpoint_value["last_processed_etag"] = etag
            wm = last_ev.get("gdc_db_watermark")
            lo = last_ev.get("gdc_db_order_value")
            if wm is not None:
                checkpoint_value["last_processed_db_watermark"] = wm
            if lo is not None:
                checkpoint_value["last_processed_db_order"] = lo
            rp = last_ev.get("remote_path") or last_ev.get("gdc_remote_path")
            rmt = last_ev.get("remote_mtime") or last_ev.get("gdc_remote_mtime")
            rsz = last_ev.get("remote_size")
            if rsz is None:
                rsz = last_ev.get("gdc_remote_size")
            roff = last_ev.get("gdc_remote_offset")
            rhash = last_ev.get("gdc_remote_hash")
            if rp is not None:
                checkpoint_value["last_processed_key"] = rp
                checkpoint_value["last_processed_file"] = rp
            if rmt is not None:
                checkpoint_value["last_processed_last_modified"] = rmt
                checkpoint_value["last_processed_mtime"] = rmt
            if rsz is not None:
                checkpoint_value["last_processed_size"] = rsz
            if roff is not None:
                checkpoint_value["last_processed_offset"] = roff
            if rhash is not None:
                checkpoint_value["last_processed_hash"] = rhash
        stream_cfg = _get(self._runtime_stream or {}, "stream_config", {}) if isinstance(self._runtime_stream, dict) else {}
        checkpoint_value = build_runtime_checkpoint_template_context(
            checkpoint_value,
            stream_cfg if isinstance(stream_cfg, dict) else {},
        )
        after_preview = copy_json_value(checkpoint_value)
        self._pending_checkpoint = {
            "stream_id": stream_id,
            "checkpoint_type": checkpoint_type,
            "checkpoint_value": checkpoint_value,
        }
        self._log(
            {
                "stage": "checkpoint_update",
                "stream_id": stream_id,
                "message": "checkpoint updated after successful destination delivery",
                "checkpoint_type": checkpoint_type,
                "checkpoint_before": slim_checkpoint_for_log(checkpoint_before)
                if checkpoint_before is not None
                else None,
                "checkpoint_after": slim_checkpoint_for_log(after_preview) if isinstance(after_preview, dict) else after_preview,
                "processed_events": processed_events,
                "delivered_events": delivered_events,
                "failed_events": failed_events,
                "partial_success": partial_success,
                "update_reason": update_reason,
                "correlated_route_failures": correlated,
            }
        )
        return after_preview if isinstance(after_preview, dict) else None

    def _commit_lifecycle_entry(self, *, stream_id: int | None = None) -> None:
        """Persist staged run_started rows on an isolated short-lived session."""

        payloads = [p for p in self._pending_log_payloads if str(p.get("stage")) == "run_started"]
        if not payloads:
            return

        def _write(db: Session) -> None:
            if not hasattr(db, "add"):
                return
            for payload in payloads:
                row = self._build_delivery_log_row(payload)
                if row is not None:
                    db.add(row)
            if hasattr(db, "flush"):
                db.flush()

        self._db_write(_write)
        # Drop only the committed entry rows; leave any other staged work intact.
        self._pending_log_payloads = [
            p for p in self._pending_log_payloads if str(p.get("stage")) != "run_started"
        ]
        self._emit_obs({"stage": "run_started_committed", "stream_id": stream_id})

    def _persist_failure_telemetry(self, payload: dict[str, Any]) -> None:
        """Persist run_failed (or similar) using a dedicated short-lived DB session.

        Must not reuse the request session that may already be rolled back / dirty.
        """

        enriched = dict(payload)
        if self._run_id and not enriched.get("run_id"):
            enriched["run_id"] = self._run_id
        if self._connector_id is not None and enriched.get("connector_id") is None:
            enriched["connector_id"] = self._connector_id

        def _write(db: Session) -> None:
            row = self._build_delivery_log_row(enriched)
            if row is None or not hasattr(db, "add"):
                return
            db.add(row)
            if hasattr(db, "flush"):
                db.flush()

        # Prefer isolated session so request-session rollback cannot erase failure evidence.
        self._db_write(_write)

    def _flush_pending_writes(self, *, stream_id: int | None = None) -> None:
        """Commit buffered delivery logs, checkpoint, and stream/route status in one short transaction."""

        if not (
            self._pending_log_payloads
            or self._pending_stream_status
            or self._pending_disabled_routes
            or self._pending_checkpoint is not None
        ):
            return

        def _write(db: Session) -> None:
            if hasattr(db, "query"):
                for sid, status in self._pending_stream_status.items():
                    update_stream_status(db, int(sid), status)
                for route_id in self._pending_disabled_routes:
                    disable_route(db, int(route_id))
            if self._pending_checkpoint is not None:
                pc = self._pending_checkpoint
                self.checkpoint_service.update_checkpoint_after_success(
                    db=db,
                    stream_id=int(pc["stream_id"]),
                    checkpoint_type=str(pc["checkpoint_type"]),
                    checkpoint_value=pc["checkpoint_value"],
                )
            if hasattr(db, "add"):
                for payload in self._pending_log_payloads:
                    row = self._build_delivery_log_row(payload)
                    if row is not None:
                        db.add(row)
                        self._pending_delivery_log_rows.append(row)
                if self._pending_delivery_log_rows and hasattr(db, "flush"):
                    db.flush()
                    self._ingest_committed_delivery_logs()

        # Always persist via a short-lived session — never commit the caller Session.
        if (
            self._pending_log_payloads
            or self._pending_stream_status
            or self._pending_disabled_routes
            or self._pending_checkpoint is not None
        ):
            self._db_write(_write)
            # Refresh caller identity map only when it has no pending caller-owned work.
            if (
                self._caller_db is not None
                and hasattr(self._caller_db, "expire_all")
                and not session_has_pending_changes(self._caller_db)
                and not self._parked_caller_pending
            ):
                try:
                    self._caller_db.expire_all()
                except Exception:
                    pass
        self._pending_log_payloads.clear()
        self._pending_stream_status.clear()
        self._pending_disabled_routes.clear()
        self._pending_checkpoint = None
        self._emit_obs({"stage": "transaction_committed", "stream_id": stream_id})

    def _commit_if_needed(self, db: Session | None, *, stream_id: int | None = None) -> None:
        if db is not None and hasattr(db, "commit"):
            if self._pending_delivery_log_rows and hasattr(db, "flush"):
                db.flush()
                self._ingest_committed_delivery_logs()
            db.commit()
            self._emit_obs({"stage": "transaction_committed", "stream_id": stream_id})

    def _ingest_committed_delivery_logs(self) -> None:
        if not self._pending_delivery_log_rows:
            return
        try:
            from app.logs.incremental_aggregates import ingest_delivery_log_row

            for row in self._pending_delivery_log_rows:
                if row.id is not None:
                    ingest_delivery_log_row(row)
        except Exception:
            logger.exception("incremental_delivery_log_ingest_failed")
        finally:
            self._pending_delivery_log_rows.clear()

    @classmethod
    def _get_lock(cls, stream_id: int) -> threading.Lock:
        with cls._locks_guard:
            if stream_id not in cls._locks:
                cls._locks[stream_id] = threading.Lock()
            return cls._locks[stream_id]

    @classmethod
    def is_lock_held(cls, stream_id: int) -> bool:
        """Return whether any process currently owns the stream run lock."""

        with cls._locks_guard:
            lock = cls._locks.get(int(stream_id))
            if lock is not None and lock.locked():
                return True
        return stream_runtime_lock.is_held("run", int(stream_id))

    @classmethod
    def is_worker_ownership_held(cls, stream_id: int) -> bool:
        """True when a scheduler worker (any process) owns this stream."""

        return stream_runtime_lock.is_held("worker", int(stream_id))

    @classmethod
    def try_acquire_worker_ownership(cls, stream_id: int) -> bool:
        """Acquire cross-process scheduler-worker ownership for stream_id."""

        return stream_runtime_lock.try_acquire("worker", int(stream_id))

    @classmethod
    def release_worker_ownership(cls, stream_id: int) -> None:
        """Release cross-process scheduler-worker ownership for stream_id."""

        stream_runtime_lock.release("worker", int(stream_id))

    @classmethod
    def active_lock_stream_ids(cls) -> list[int]:
        """Return stream IDs with an active run lock (local or cross-process)."""

        with cls._locks_guard:
            local = {stream_id for stream_id, lock in cls._locks.items() if lock.locked()}
        return sorted(set(local) | set(stream_runtime_lock.active_stream_ids("run")))

    def _with_run_timing(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Attach run-level timing trace to run_complete delivery_logs rows."""

        out = dict(payload)
        if self._run_timing is not None and out.get("stage") == "run_complete":
            timing = self._run_timing.finalize()
            out.update(timing)
            out["latency_ms"] = timing["run_duration_ms"]
        return out

    def _emit_obs(self, payload: dict[str, Any]) -> None:
        """Structured runtime observability (logger only; not persisted to delivery_logs)."""

        logger.info("%s", payload)

    def _log(self, payload: dict[str, Any]) -> None:
        """Emit structured logs as dict payload."""

        enriched: dict[str, Any] = dict(payload)
        if self._run_id:
            enriched["run_id"] = self._run_id
        if self._connector_id is not None:
            enriched["connector_id"] = self._connector_id
        logger.info("%s", enriched)
        self._persist_delivery_log(enriched)

    def _build_delivery_log_row(self, payload: dict[str, Any]) -> DeliveryLog | None:
        """Build a DeliveryLog ORM row from a structured payload (no DB I/O)."""

        stage = str(payload.get("stage", "")).strip()
        if stage not in {
            "run_started",
            "run_failed",
            "source_fetch",
            "parse",
            "mapping",
            "enrichment",
            "classification_complete",
            "protection_complete",
            "policy_evaluation_complete",
            "ai_policy_prompt",
            "ai_policy_response",
            "dynamic_routing_complete",
            "dynamic_route_send_success",
            "dynamic_route_send_failed",
            "dynamic_route_send_skip",
            "dynamic_route_send_rate_limited",
            "dynamic_route_skip",
            "dynamic_route_rate_limited",
            "failover_routing_complete",
            "failover_route_attempt",
            "failover_route_send_success",
            "failover_route_send_failed",
            "route",
            "route_send_success",
            "route_send_failed",
            "route_retry_success",
            "route_retry_failed",
            "source_rate_limited",
            "destination_rate_limited",
            "route_skip",
            "route_unknown_failure_policy",
            "route_processing_loop",
            "checkpoint_update",
            "run_complete",
            "dedup_queue_insert",
            "dedup_registry",
            *SCHEMA_DRIFT_POLICY_DELIVERY_LOG_STAGES,
        }:
            return None

        level = "INFO"
        status = "OK"
        error_code = None
        if stage in {"route_send_failed", "route_retry_failed"}:
            level = "ERROR"
            status = "FAILED"
            error_code = str(payload.get("error_type")) if payload.get("error_type") else None
        elif stage == "run_failed":
            level = "ERROR"
            status = "FAILED"
            error_code = str(payload.get("error_code") or payload.get("error_type") or "RUNTIME_INTERNAL_ERROR")
        elif stage == "source_rate_limited":
            level = "WARN"
            status = "RATE_LIMITED"
            error_code = "SOURCE_RATE_LIMITED"
        elif stage == "destination_rate_limited":
            level = "WARN"
            status = "RATE_LIMITED"
            error_code = "DESTINATION_RATE_LIMITED"
        elif stage == "route_skip":
            status = "SKIPPED"
        elif stage == "route_unknown_failure_policy":
            level = "ERROR"
            status = "FAILED"
            error_code = "UNKNOWN_FAILURE_POLICY"
        elif stage == "run_started":
            status = "OK"
        elif stage in {"run_complete", "checkpoint_update"}:
            status = "COMPLETED"
        elif stage in {"dedup_queue_insert", "dedup_registry"}:
            status = "OK"
        elif stage == "classification_complete":
            status = "OK"
        elif stage == "protection_complete":
            status = "OK"
        elif stage == "dynamic_routing_complete":
            status = "OK"
        elif stage in {"dynamic_route_send_success"}:
            status = "OK"
        elif stage in {"dynamic_route_send_failed"}:
            level = "ERROR"
            status = "FAILED"
            error_code = str(payload.get("error_type")) if payload.get("error_type") else None
        elif stage == "dynamic_route_rate_limited":
            level = "WARN"
            status = "RATE_LIMITED"
            error_code = "DESTINATION_RATE_LIMITED"
        elif stage in {"dynamic_route_send_skip", "dynamic_route_skip"}:
            status = "SKIPPED"
        elif stage in {"dynamic_route_send_rate_limited", "dynamic_route_rate_limited"}:
            level = "WARN"
            status = "RATE_LIMITED"
            error_code = "DESTINATION_RATE_LIMITED"
        elif stage == "failover_routing_complete":
            status = "OK"
        elif stage == "failover_route_send_success":
            status = "OK"
        elif stage == "failover_route_send_failed":
            level = "ERROR"
            status = "FAILED"
            error_code = str(payload.get("error_type")) if payload.get("error_type") else None
        elif stage == "failover_route_attempt":
            status = "OK"
        elif stage in SCHEMA_DRIFT_POLICY_DELIVERY_LOG_STAGES:
            if stage == "schema_drift_policy_path_resolution_failed":
                level = "WARN"
            status = "OK"

        message = schema_drift_policy_delivery_log_message(payload) or str(payload.get("message") or stage)
        stream_id = payload.get("stream_id")
        route_id = payload.get("route_id")
        destination_id = payload.get("destination_id")
        connector_raw = payload.get("connector_id")
        run_id_raw = payload.get("run_id")
        lat_raw = payload.get("latency_ms", payload.get("processing_time_ms"))
        latency_ms: int | None = None
        if isinstance(lat_raw, int) and lat_raw >= 0:
            latency_ms = lat_raw
        elif lat_raw is not None:
            try:
                latency_ms = max(0, int(lat_raw))
            except (TypeError, ValueError):
                latency_ms = None

        retry_count = 0
        if stage == "route_retry_success":
            retry_count = int(payload.get("attempt") or payload.get("retry_count") or 0)
        elif stage == "route_retry_failed":
            retry_count = int(payload.get("retry_count") or 0)

        payload_sample = build_delivery_log_payload_sample(payload)

        return DeliveryLog(
            connector_id=int(connector_raw) if connector_raw is not None else None,
            stream_id=int(stream_id) if stream_id is not None else None,
            route_id=int(route_id) if route_id is not None else None,
            destination_id=int(destination_id) if destination_id is not None else None,
            stage=stage,
            level=level,
            status=status,
            message=message,
            payload_sample=payload_sample if isinstance(payload_sample, dict) else {},
            retry_count=retry_count,
            http_status=None,
            latency_ms=latency_ms,
            error_code=error_code,
            run_id=str(run_id_raw) if run_id_raw else None,
        )

    def _persist_delivery_log(self, payload: dict[str, Any]) -> None:
        """Buffer selected runtime log stages for flush at run end."""

        row = self._build_delivery_log_row(payload)
        if row is None:
            return
        self._pending_log_payloads.append(dict(payload))
