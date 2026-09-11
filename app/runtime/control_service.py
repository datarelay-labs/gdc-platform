"""Runtime control: stream start/stop; delivery_logs retention cleanup."""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.destinations.models import Destination
from app.connectors.models import Connector
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.platform_admin import journal
from app.platform_admin.config_entity_snapshots import (
    serialize_destination_config,
    serialize_mapping_for_stream,
    serialize_route_config,
    serialize_stream_config,
)
from app.routes.models import Route
from app.runners.stream_runner import StreamRunner
from app.scheduler import runtime_state as scheduler_runtime_state
from app.security.secrets import mask_secrets, preserve_masked_secrets
from app.sources.models import Source
from app.runtime.schemas import (
    ConnectorUISaveRequest,
    ConnectorUISaveResponse,
    DestinationUISaveRequest,
    DestinationUISaveResponse,
    MappingUISaveRequest,
    MappingUISaveResponse,
    RouteUISaveRequest,
    RouteUISaveResponse,
    RuntimeDestinationRateLimitSaveRequest,
    RuntimeDestinationRateLimitSaveResponse,
    RuntimeEnrichmentSaveRequest,
    RuntimeEnrichmentSaveResponse,
    RuntimeLogsCleanupResponse,
    RuntimeMappingSaveRequest,
    RuntimeMappingSaveResponse,
    RuntimeRouteEnabledSaveRequest,
    RuntimeRouteEnabledSaveResponse,
    RuntimeRouteFailurePolicySaveRequest,
    RuntimeRouteFailurePolicySaveResponse,
    RuntimeRouteFormatterSaveRequest,
    RuntimeRouteFormatterSaveResponse,
    RuntimeRouteRateLimitSaveRequest,
    RuntimeRouteRateLimitSaveResponse,
    RuntimeStreamControlResponse,
    RuntimeStreamRateLimitSaveRequest,
    RuntimeStreamRateLimitSaveResponse,
    SourceUISaveRequest,
    SourceUISaveResponse,
    StreamUISaveRequest,
    StreamUISaveResponse,
)
from app.streams.models import Stream


# API tokens (Mapping UI) ↔ values persisted for StreamRunner / enrichment_engine.
_ENRICHMENT_OVERRIDE_API_TO_DB = {"fill_missing": "KEEP_EXISTING", "override": "OVERRIDE"}
_ENRICHMENT_OVERRIDE_DB_TO_API = {"KEEP_EXISTING": "fill_missing", "OVERRIDE": "override"}


def _assert_mapping_paths_relative_to_extracted_event(
    field_mappings: dict,
    event_array_path: str | None,
    event_root_path: str | None,
) -> None:
    from app.parsers.extraction_paths import validate_mapping_paths_for_extraction

    violations = validate_mapping_paths_for_extraction(field_mappings, event_array_path, event_root_path)
    if violations:
        raise MappingPathValidationError(violations)


class StreamNotFoundError(Exception):
    """Raised when stream_id is missing; router maps to HTTP 404 STREAM_NOT_FOUND."""

    def __init__(self, stream_id: int) -> None:
        super().__init__(stream_id)
        self.stream_id = stream_id


class StreamStopFailedError(Exception):
    """Raised when the stop lifecycle cannot be safely advanced."""

    def __init__(self, stream_id: int, message: str) -> None:
        super().__init__(message)
        self.stream_id = stream_id
        self.message = message


class MappingPathValidationError(Exception):
    """Raised when mapping JSONPaths break the extracted-event contract."""

    def __init__(self, violations: list[dict[str, str]]) -> None:
        super().__init__("mapping path validation failed")
        self.violations = violations


class RouteNotFoundError(Exception):
    """Raised when route_id is missing; router maps to HTTP 404 ROUTE_NOT_FOUND."""

    def __init__(self, route_id: int) -> None:
        super().__init__(route_id)
        self.route_id = route_id


class DestinationNotFoundError(Exception):
    """Raised when destination_id is missing; router maps to HTTP 404 DESTINATION_NOT_FOUND."""

    def __init__(self, destination_id: int) -> None:
        super().__init__(destination_id)
        self.destination_id = destination_id


class SourceNotFoundError(Exception):
    """Raised when source_id is missing; router maps to HTTP 404 SOURCE_NOT_FOUND."""

    def __init__(self, source_id: int) -> None:
        super().__init__(source_id)
        self.source_id = source_id


class ConnectorNotFoundError(Exception):
    """Raised when connector_id is missing; router maps to HTTP 404 CONNECTOR_NOT_FOUND."""

    def __init__(self, connector_id: int) -> None:
        super().__init__(connector_id)
        self.connector_id = connector_id


def start_stream(db: Session, stream_id: int, request: object | None = None) -> RuntimeStreamControlResponse:
    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)
    stream.enabled = True
    stream.status = "RUNNING"
    # Deploy/activation: confirm Stream Schema Drift baseline from Union Schema.
    # API Test alone does not call start — baseline is not auto-confirmed there.
    try:
        from app.schema_observation.union_schema_baseline import establish_baseline_from_union_schema

        config = stream.config_json if isinstance(stream.config_json, dict) else None
        establish_baseline_from_union_schema(db, stream_id, config_json=config)
    except Exception:
        logger.exception("schema_baseline_from_union_schema_failed stream_id=%s", stream_id)
    journal.record_audit_event(
        db,
        action="STREAM_STARTED",
        entity_type="STREAM",
        entity_id=stream_id,
        entity_name=str(stream.name),
        request=request,
    )
    db.commit()
    db.refresh(stream)
    return RuntimeStreamControlResponse(
        stream_id=int(stream.id),
        enabled=bool(stream.enabled),
        status=str(stream.status),
        action="start",
        message="Stream is enabled and status set to RUNNING.",
    )


def _stream_runtime_is_terminal(stream_id: int) -> bool:
    return (
        not StreamRunner.is_lock_held(stream_id)
        and not StreamRunner.is_worker_ownership_held(stream_id)
        and not scheduler_runtime_state.is_stream_worker_alive(stream_id)
    )


def reconcile_stale_stream_runtime(db: Session, stream_id: int) -> bool:
    """Reconcile disabled stale RUNNING/STOPPING state when no local owner exists."""

    stream = db.query(Stream).filter(Stream.id == stream_id).with_for_update().first()
    if stream is None:
        raise StreamNotFoundError(stream_id)
    if (
        not bool(stream.enabled)
        and str(stream.status) in {"RUNNING", "STOPPING"}
        and _stream_runtime_is_terminal(stream_id)
    ):
        stream.status = "STOPPED"
        db.commit()
        return True
    return False


def stop_stream(db: Session, stream_id: int, request: object | None = None) -> RuntimeStreamControlResponse:
    stream = db.query(Stream).filter(Stream.id == stream_id).with_for_update().first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    if not bool(stream.enabled) and str(stream.status) == "STOPPED" and _stream_runtime_is_terminal(stream_id):
        return RuntimeStreamControlResponse(
            stream_id=int(stream.id),
            enabled=False,
            status="STOPPED",
            action="stop",
            stop_phase="confirmed",
            terminal=True,
            message="Stream stop was already confirmed.",
        )

    try:
        stream.enabled = False
        stream.status = "STOPPING"
        journal.record_audit_event(
            db,
            action="STREAM_STOP_REQUESTED",
            entity_type="STREAM",
            entity_id=stream_id,
            entity_name=str(stream.name),
            request=request,
        )
        db.commit()

        scheduler_runtime_state.request_stream_stop(stream_id)
        wait_sec = max(0.0, float(os.environ.get("GDC_STREAM_STOP_WAIT_SEC", "5")))
        deadline = time.monotonic() + wait_sec
        while not _stream_runtime_is_terminal(stream_id) and time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            scheduler_runtime_state.join_stream_worker(stream_id, min(0.05, max(0.0, remaining)))
            if remaining > 0:
                time.sleep(min(0.05, remaining))

        if _stream_runtime_is_terminal(stream_id):
            stream = db.query(Stream).filter(Stream.id == stream_id).with_for_update().one()
            stream.status = "STOPPED"
            journal.record_audit_event(
                db,
                action="STREAM_STOPPED",
                entity_type="STREAM",
                entity_id=stream_id,
                entity_name=str(stream.name),
                request=request,
            )
            db.commit()
            db.refresh(stream)
            return RuntimeStreamControlResponse(
                stream_id=int(stream.id),
                enabled=False,
                status="STOPPED",
                action="stop",
                stop_phase="confirmed",
                terminal=True,
                message="Stream stop confirmed; no local worker or run lock remains.",
            )

        return RuntimeStreamControlResponse(
            stream_id=int(stream.id),
            enabled=False,
            status="STOPPING",
            action="stop",
            stop_phase="waiting",
            terminal=False,
            message="Stream stop accepted; worker or run lock is still active.",
        )
    except Exception as exc:
        db.rollback()
        try:
            failed_stream = db.query(Stream).filter(Stream.id == stream_id).with_for_update().first()
            if failed_stream is not None:
                failed_stream.enabled = False
                failed_stream.status = "STOP_FAILED"
                db.commit()
        except Exception:
            db.rollback()
        raise StreamStopFailedError(stream_id, str(exc)) from exc


def save_runtime_stream_mapping(
    db: Session,
    stream_id: int,
    payload: RuntimeMappingSaveRequest,
) -> RuntimeMappingSaveResponse:
    """Create or update the single Mapping row for stream_id (one commit; Mapping columns only)."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    mapping_before = serialize_mapping_for_stream(db, stream_id)

    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
    fields = dict(payload.field_mappings)

    _assert_mapping_paths_relative_to_extracted_event(fields, payload.event_array_path, payload.event_root_path)

    if mapping is None:
        mapping = Mapping(
            stream_id=stream_id,
            event_array_path=payload.event_array_path,
            event_root_path=payload.event_root_path,
            field_mappings_json=fields,
        )
        db.add(mapping)
        message = "Mapping configuration created for stream."
    else:
        mapping.event_array_path = payload.event_array_path
        mapping.event_root_path = payload.event_root_path
        mapping.field_mappings_json = fields
        message = "Mapping configuration updated for stream."

    db.flush()
    journal.record_audit_event(
        db,
        action="STREAM_EDITED",
        actor_username="system",
        entity_type="STREAM",
        entity_id=stream_id,
        entity_name=str(stream.name),
        details={"source": "runtime_mapping_save", "mapping_id": int(mapping.id)},
    )
    journal.record_config_version(
        db,
        entity_type="MAPPING_CONFIG",
        entity_id=stream_id,
        entity_name=str(stream.name),
        summary="Mapping configuration saved",
        snapshot_before=mapping_before,
        snapshot_after=serialize_mapping_for_stream(db, stream_id),
    )
    db.commit()
    db.refresh(mapping)

    fm = mapping.field_mappings_json or {}
    return RuntimeMappingSaveResponse(
        stream_id=stream_id,
        mapping_id=int(mapping.id),
        event_array_path=mapping.event_array_path,
        event_root_path=mapping.event_root_path,
        field_count=len(fm),
        message=message,
    )


def save_runtime_mapping_ui_config(
    db: Session,
    stream_id: int,
    payload: MappingUISaveRequest,
) -> MappingUISaveResponse:
    """Save Mapping UI bundle (mapping/enrichment/route formatter) with one commit."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    mapping_saved = False
    enrichment_saved = False
    route_formatter_route_ids: list[int] = []

    mapping_before: dict | None = None
    if payload.mapping is not None:
        mapping_before = serialize_mapping_for_stream(db, stream_id)

    routes_before: dict[int, dict] = {}
    for rf in payload.route_formatters:
        route = db.query(Route).filter(Route.id == rf.route_id).first()
        if route is None or int(route.stream_id) != stream_id:
            raise RouteNotFoundError(rf.route_id)
        routes_before[int(route.id)] = serialize_route_config(route)

    if payload.mapping is not None:
        mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
        fields = dict(payload.mapping.field_mappings)
        _assert_mapping_paths_relative_to_extracted_event(
            fields,
            payload.mapping.event_array_path,
            payload.mapping.event_root_path,
        )
        if mapping is None:
            mapping = Mapping(
                stream_id=stream_id,
                event_array_path=payload.mapping.event_array_path,
                event_root_path=payload.mapping.event_root_path,
                field_mappings_json=fields,
                raw_payload_mode=payload.mapping.raw_payload_mode,
            )
            db.add(mapping)
        else:
            mapping.event_array_path = payload.mapping.event_array_path
            mapping.event_root_path = payload.mapping.event_root_path
            mapping.field_mappings_json = fields
            mapping.raw_payload_mode = payload.mapping.raw_payload_mode
        mapping_saved = True

    if payload.enrichment is not None:
        fields = dict(payload.enrichment.enrichment)
        enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
        if enrichment is None:
            enrichment = Enrichment(
                stream_id=stream_id,
                enrichment_json=fields,
                override_policy=payload.enrichment.override_policy,
                enabled=payload.enrichment.enabled,
            )
            db.add(enrichment)
        else:
            enrichment.enrichment_json = fields
            enrichment.override_policy = payload.enrichment.override_policy
            enrichment.enabled = payload.enrichment.enabled
        enrichment_saved = True

    governance_result: dict | None = None
    if mapping_saved or enrichment_saved:
        try:
            from app.mappers.governance_snapshot import merge_governance_into_enrichment
            from app.mappers.mapping_rules import normalize_field_mappings
            from app.mappers.stream_readiness_evaluation import evaluate_stream_readiness
        except ModuleNotFoundError:
            normalize_field_mappings = None  # type: ignore[assignment,misc]
            merge_governance_into_enrichment = None  # type: ignore[assignment,misc]
            evaluate_stream_readiness = None  # type: ignore[assignment,misc]

        if (
            normalize_field_mappings is not None
            and merge_governance_into_enrichment is not None
            and evaluate_stream_readiness is not None
        ):
            mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).first()
            enrichment_row = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
            fm = dict(mapping.field_mappings_json or {}) if mapping else {}
            ej = dict(enrichment_row.enrichment_json or {}) if enrichment_row else {}
            rows = [
                {
                    "output_field": r.output_field,
                    "source_json_path": r.source_json_path,
                    "transforms": list(r.transforms),
                }
                for r in normalize_field_mappings(fm)
            ]
            governance_result = evaluate_stream_readiness(
                current_mappings=rows,
                enrichment=ej,
                target_schema="stellar_cyber_interflow",
            )
            if enrichment_row is not None:
                enrichment_row.enrichment_json = merge_governance_into_enrichment(
                    ej,
                    dict(governance_result.get("snapshot") or {}),
                )

    for rf in payload.route_formatters:
        route = db.query(Route).filter(Route.id == rf.route_id).first()
        if route is None or int(route.stream_id) != stream_id:
            raise RouteNotFoundError(rf.route_id)
        route.formatter_config_json = dict(rf.formatter_config)
        route_formatter_route_ids.append(int(route.id))

    db.flush()

    if mapping_saved and mapping_before is not None:
        journal.record_audit_event(
            db,
            action="STREAM_EDITED",
            actor_username="system",
            entity_type="STREAM",
            entity_id=stream_id,
            entity_name=str(stream.name),
            details={"source": "runtime_mapping_ui_save", "mapping": True},
        )
        journal.record_config_version(
            db,
            entity_type="MAPPING_CONFIG",
            entity_id=stream_id,
            entity_name=str(stream.name),
            summary="Mapping UI bundle: mapping saved",
            snapshot_before=mapping_before,
            snapshot_after=serialize_mapping_for_stream(db, stream_id),
        )

    for rid in route_formatter_route_ids:
        route = db.query(Route).filter(Route.id == rid).first()
        if route is None:
            continue
        journal.record_config_version(
            db,
            entity_type="ROUTE_CONFIG",
            entity_id=rid,
            entity_name=str(stream.name),
            summary="Mapping UI bundle: route formatter saved",
            snapshot_before=routes_before.get(rid),
            snapshot_after=serialize_route_config(route),
        )

    db.commit()

    readiness_out = None
    snapshot_out = None
    if governance_result:
        from app.runtime.schemas import StreamReadinessResult

        rd = governance_result.get("readiness") or {}
        readiness_out = StreamReadinessResult(
            status=rd.get("status", "NEEDS_REVIEW"),
            score=int(rd.get("score") or 0),
            quality_score=float(rd.get("quality_score") or 0),
            coverage_percent=float(rd.get("coverage_percent") or 0),
            warnings=list(rd.get("warnings") or []),
            blocking_issues=list(rd.get("blocking_issues") or []),
            recommendations=list(rd.get("recommendations") or []),
            conflict_count=int(rd.get("conflict_count") or 0),
            low_confidence_count=int(rd.get("low_confidence_count") or 0),
            missing_recommended=list(rd.get("missing_recommended") or []),
        )
        snapshot_out = dict(governance_result.get("snapshot") or {})

    return MappingUISaveResponse(
        stream_id=stream_id,
        mapping_saved=mapping_saved,
        enrichment_saved=enrichment_saved,
        route_formatter_saved_count=len(route_formatter_route_ids),
        route_formatter_route_ids=route_formatter_route_ids,
        message="Mapping UI configuration saved successfully",
    )


def save_runtime_stream_enrichment(
    db: Session,
    stream_id: int,
    payload: RuntimeEnrichmentSaveRequest,
) -> RuntimeEnrichmentSaveResponse:
    """Create or update the single Enrichment row for stream_id (one commit; Enrichment columns only)."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    db_policy = _ENRICHMENT_OVERRIDE_API_TO_DB[payload.override_policy]
    fields = dict(payload.enrichment)

    enrichment = db.query(Enrichment).filter(Enrichment.stream_id == stream_id).first()
    if enrichment is None:
        enrichment = Enrichment(
            stream_id=stream_id,
            enrichment_json=fields,
            override_policy=db_policy,
            enabled=payload.enabled,
        )
        db.add(enrichment)
        message = "Enrichment configuration created for stream."
    else:
        enrichment.enrichment_json = fields
        enrichment.override_policy = db_policy
        enrichment.enabled = payload.enabled
        message = "Enrichment configuration updated for stream."

    db.commit()
    db.refresh(enrichment)

    ej = enrichment.enrichment_json or {}
    api_policy = _ENRICHMENT_OVERRIDE_DB_TO_API.get(
        str(enrichment.override_policy or ""),
        str(enrichment.override_policy or ""),
    )
    return RuntimeEnrichmentSaveResponse(
        stream_id=stream_id,
        enrichment_id=int(enrichment.id),
        field_count=len(ej),
        override_policy=api_policy,
        enabled=bool(enrichment.enabled),
        message=message,
    )


def save_runtime_route_formatter_config(
    db: Session,
    route_id: int,
    payload: RuntimeRouteFormatterSaveRequest,
) -> RuntimeRouteFormatterSaveResponse:
    """Update Route.formatter_config_json only (one commit; Route row only)."""

    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)

    stream = db.query(Stream).filter(Stream.id == int(route.stream_id)).first()
    stream_name = str(stream.name) if stream is not None else None
    route_before = serialize_route_config(route)
    route.formatter_config_json = dict(payload.formatter_config)
    db.flush()
    journal.record_config_version(
        db,
        entity_type="ROUTE_CONFIG",
        entity_id=route_id,
        entity_name=stream_name,
        summary="Runtime route formatter saved",
        snapshot_before=route_before,
        snapshot_after=serialize_route_config(route),
    )
    db.commit()
    db.refresh(route)

    formatter_config = dict(route.formatter_config_json or {})
    return RuntimeRouteFormatterSaveResponse(
        route_id=int(route.id),
        stream_id=int(route.stream_id),
        destination_id=int(route.destination_id),
        formatter_config=formatter_config,
        field_count=len(formatter_config),
        message="Route formatter configuration saved.",
    )


def save_runtime_route_ui_config(
    db: Session,
    route_id: int,
    payload: RouteUISaveRequest,
) -> RouteUISaveResponse:
    """Save Route UI settings (route fields + destination.enabled) in one commit."""

    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)

    destination = db.query(Destination).filter(Destination.id == route.destination_id).first()
    if destination is None:
        raise DestinationNotFoundError(route.destination_id)

    stream = db.query(Stream).filter(Stream.id == int(route.stream_id)).first()
    stream_name = str(stream.name) if stream is not None else None

    route_before = serialize_route_config(route)
    dest_before = serialize_destination_config(destination)

    route_touched = any(
        getattr(payload, k) is not None
        for k in ("route_enabled", "route_formatter_config", "route_rate_limit", "failure_policy")
    )
    dest_touched = payload.destination_enabled is not None

    if payload.route_enabled is not None:
        route.enabled = bool(payload.route_enabled)
    if payload.route_formatter_config is not None:
        route.formatter_config_json = dict(payload.route_formatter_config)
    if payload.route_rate_limit is not None:
        route.rate_limit_json = dict(payload.route_rate_limit)
    if payload.failure_policy is not None:
        route.failure_policy = payload.failure_policy
    if payload.destination_enabled is not None:
        destination.enabled = bool(payload.destination_enabled)

    db.flush()

    if route_touched:
        journal.record_config_version(
            db,
            entity_type="ROUTE_CONFIG",
            entity_id=route_id,
            entity_name=stream_name,
            summary="Runtime route UI save",
            snapshot_before=route_before,
            snapshot_after=serialize_route_config(route),
        )
    if dest_touched:
        journal.record_config_version(
            db,
            entity_type="DESTINATION_CONFIG",
            entity_id=int(destination.id),
            entity_name=str(destination.name),
            summary="Runtime route UI save (destination enabled)",
            snapshot_before=dest_before,
            snapshot_after=serialize_destination_config(destination),
        )

    db.commit()

    return RouteUISaveResponse(
        route_id=int(route.id),
        destination_id=int(route.destination_id),
        route_enabled=bool(route.enabled),
        destination_enabled=bool(destination.enabled),
        failure_policy=str(route.failure_policy),
        formatter_config=dict(route.formatter_config_json or {}),
        route_rate_limit=dict(route.rate_limit_json or {}),
        message="Route UI configuration saved successfully",
    )


def save_runtime_destination_ui_config(
    db: Session,
    destination_id: int,
    payload: DestinationUISaveRequest,
) -> DestinationUISaveResponse:
    """Save Destination UI settings (name/enabled/config/rate-limit) in one commit."""

    destination = db.query(Destination).filter(Destination.id == destination_id).first()
    if destination is None:
        raise DestinationNotFoundError(destination_id)

    dest_before = serialize_destination_config(destination)
    destination.name = payload.name
    destination.enabled = bool(payload.enabled)
    destination.config_json = preserve_masked_secrets(
        dict(payload.config_json),
        dict(destination.config_json or {}),
    )
    destination.rate_limit_json = dict(payload.rate_limit_json)

    db.flush()
    journal.record_config_version(
        db,
        entity_type="DESTINATION_CONFIG",
        entity_id=destination_id,
        entity_name=str(destination.name),
        summary="Runtime destination UI save",
        snapshot_before=dest_before,
        snapshot_after=serialize_destination_config(destination),
    )
    db.commit()

    return DestinationUISaveResponse(
        destination_id=int(destination.id),
        name=str(destination.name),
        enabled=bool(destination.enabled),
        config_json=mask_secrets(dict(destination.config_json or {})),
        rate_limit_json=dict(destination.rate_limit_json or {}),
        message="Destination UI configuration saved successfully",
    )


def save_runtime_stream_ui_config(
    db: Session,
    stream_id: int,
    payload: StreamUISaveRequest,
) -> StreamUISaveResponse:
    """Save Stream UI settings (name/enabled/polling/config/rate-limit) in one commit."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    stream_before = serialize_stream_config(stream)
    stream.name = payload.name
    stream.enabled = bool(payload.enabled)
    stream.polling_interval = int(payload.polling_interval)
    stream.config_json = dict(payload.config_json)
    stream.rate_limit_json = dict(payload.rate_limit_json)

    db.flush()
    journal.record_config_version(
        db,
        entity_type="STREAM_CONFIG",
        entity_id=stream_id,
        entity_name=str(stream.name),
        summary="Runtime stream UI save",
        snapshot_before=stream_before,
        snapshot_after=serialize_stream_config(stream),
    )
    db.commit()

    return StreamUISaveResponse(
        stream_id=int(stream.id),
        name=str(stream.name),
        enabled=bool(stream.enabled),
        polling_interval=int(stream.polling_interval),
        config_json=dict(stream.config_json or {}),
        rate_limit_json=dict(stream.rate_limit_json or {}),
        message="Stream UI configuration saved successfully",
    )


_MASK = "********"


def _merge_source_config_preserve_secrets(incoming: dict[str, Any], existing: dict[str, Any] | None) -> dict[str, Any]:
    """Keep existing secret-ish values when UI resubmits the redacted mask."""

    return preserve_masked_secrets(dict(incoming), dict(existing or {}))


def save_runtime_source_ui_config(
    db: Session,
    source_id: int,
    payload: SourceUISaveRequest,
) -> SourceUISaveResponse:
    """Save Source UI settings (enabled/config/auth) in one commit."""

    source = db.query(Source).filter(Source.id == source_id).first()
    if source is None:
        raise SourceNotFoundError(source_id)

    source.enabled = bool(payload.enabled)
    merged_cfg = _merge_source_config_preserve_secrets(dict(payload.config_json), source.config_json)
    source.config_json = merged_cfg
    source.auth_json = preserve_masked_secrets(dict(payload.auth_json), dict(source.auth_json or {}))
    if payload.source_type is not None and str(payload.source_type).strip():
        source.source_type = str(payload.source_type).strip().upper()

    db.commit()

    return SourceUISaveResponse(
        source_id=int(source.id),
        enabled=bool(source.enabled),
        config_json=mask_secrets(dict(source.config_json or {})),
        auth_json=mask_secrets(dict(source.auth_json or {})),
        message="Source UI configuration saved successfully",
    )


def save_runtime_connector_ui_config(
    db: Session,
    connector_id: int,
    payload: ConnectorUISaveRequest,
) -> ConnectorUISaveResponse:
    """Save Connector UI settings (name/description/status) in one commit."""

    connector = db.query(Connector).filter(Connector.id == connector_id).first()
    if connector is None:
        raise ConnectorNotFoundError(connector_id)

    connector.name = payload.name
    connector.description = payload.description
    connector.status = payload.status

    db.commit()

    return ConnectorUISaveResponse(
        connector_id=int(connector.id),
        name=str(connector.name),
        description=connector.description,
        status=str(connector.status),
        message="Connector UI configuration saved successfully",
    )


def save_runtime_route_failure_policy(
    db: Session,
    route_id: int,
    payload: RuntimeRouteFailurePolicySaveRequest,
) -> RuntimeRouteFailurePolicySaveResponse:
    """Update Route.failure_policy only (one commit; Route row only)."""

    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)

    stream = db.query(Stream).filter(Stream.id == int(route.stream_id)).first()
    stream_name = str(stream.name) if stream is not None else None
    route_before = serialize_route_config(route)
    route.failure_policy = payload.failure_policy
    db.flush()
    journal.record_config_version(
        db,
        entity_type="ROUTE_CONFIG",
        entity_id=route_id,
        entity_name=stream_name,
        summary="Runtime route failure policy saved",
        snapshot_before=route_before,
        snapshot_after=serialize_route_config(route),
    )
    db.commit()
    db.refresh(route)

    return RuntimeRouteFailurePolicySaveResponse(
        route_id=int(route.id),
        stream_id=int(route.stream_id),
        destination_id=int(route.destination_id),
        failure_policy=str(route.failure_policy),
        message="Route failure policy saved successfully",
    )


def save_runtime_route_enabled_state(
    db: Session,
    route_id: int,
    payload: RuntimeRouteEnabledSaveRequest,
) -> RuntimeRouteEnabledSaveResponse:
    """Update Route.enabled only (one commit; Route row only)."""

    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)

    stream = db.query(Stream).filter(Stream.id == int(route.stream_id)).first()
    stream_name = str(stream.name) if stream is not None else None
    route_before = serialize_route_config(route)

    route.enabled = bool(payload.enabled)
    if route.enabled:
        route.disable_reason = None
    elif payload.disable_reason is not None:
        reason = str(payload.disable_reason).strip()
        route.disable_reason = reason if reason else None
    db.flush()
    journal.record_config_version(
        db,
        entity_type="ROUTE_CONFIG",
        entity_id=route_id,
        entity_name=stream_name,
        summary="Runtime route enabled state saved",
        snapshot_before=route_before,
        snapshot_after=serialize_route_config(route),
    )
    db.commit()
    db.refresh(route)

    return RuntimeRouteEnabledSaveResponse(
        route_id=int(route.id),
        stream_id=int(route.stream_id),
        destination_id=int(route.destination_id),
        enabled=bool(route.enabled),
        message="Route enabled state saved successfully",
    )


def save_runtime_route_rate_limit(
    db: Session,
    route_id: int,
    payload: RuntimeRouteRateLimitSaveRequest,
) -> RuntimeRouteRateLimitSaveResponse:
    """Update Route.rate_limit_json only (one commit; Route row only)."""

    route = db.query(Route).filter(Route.id == route_id).first()
    if route is None:
        raise RouteNotFoundError(route_id)

    stream = db.query(Stream).filter(Stream.id == int(route.stream_id)).first()
    stream_name = str(stream.name) if stream is not None else None
    route_before = serialize_route_config(route)
    route.rate_limit_json = dict(payload.rate_limit)
    db.flush()
    journal.record_config_version(
        db,
        entity_type="ROUTE_CONFIG",
        entity_id=route_id,
        entity_name=stream_name,
        summary="Runtime route rate limit saved",
        snapshot_before=route_before,
        snapshot_after=serialize_route_config(route),
    )
    db.commit()
    db.refresh(route)

    rate_limit = dict(route.rate_limit_json or {})
    return RuntimeRouteRateLimitSaveResponse(
        route_id=int(route.id),
        stream_id=int(route.stream_id),
        destination_id=int(route.destination_id),
        rate_limit=rate_limit,
        field_count=len(rate_limit),
        message="Route rate limit configuration saved.",
    )


def save_runtime_stream_rate_limit(
    db: Session,
    stream_id: int,
    payload: RuntimeStreamRateLimitSaveRequest,
) -> RuntimeStreamRateLimitSaveResponse:
    """Update Stream.rate_limit_json only (one commit; Stream row only)."""

    stream = db.query(Stream).filter(Stream.id == stream_id).first()
    if stream is None:
        raise StreamNotFoundError(stream_id)

    stream_before = serialize_stream_config(stream)
    stream.rate_limit_json = dict(payload.rate_limit)
    db.flush()
    journal.record_config_version(
        db,
        entity_type="STREAM_CONFIG",
        entity_id=stream_id,
        entity_name=str(stream.name),
        summary="Runtime stream rate limit saved",
        snapshot_before=stream_before,
        snapshot_after=serialize_stream_config(stream),
    )
    db.commit()
    db.refresh(stream)

    rate_limit = dict(stream.rate_limit_json or {})
    return RuntimeStreamRateLimitSaveResponse(
        stream_id=int(stream.id),
        connector_id=int(stream.connector_id),
        source_id=int(stream.source_id),
        rate_limit=rate_limit,
        field_count=len(rate_limit),
        message="Stream source rate limit saved successfully",
    )


def save_runtime_destination_rate_limit(
    db: Session,
    destination_id: int,
    payload: RuntimeDestinationRateLimitSaveRequest,
) -> RuntimeDestinationRateLimitSaveResponse:
    """Update Destination.rate_limit_json only (one commit; Destination row only)."""

    destination = db.query(Destination).filter(Destination.id == destination_id).first()
    if destination is None:
        raise DestinationNotFoundError(destination_id)

    dest_before = serialize_destination_config(destination)
    destination.rate_limit_json = dict(payload.rate_limit)
    db.flush()
    journal.record_config_version(
        db,
        entity_type="DESTINATION_CONFIG",
        entity_id=destination_id,
        entity_name=str(destination.name),
        summary="Runtime destination rate limit saved",
        snapshot_before=dest_before,
        snapshot_after=serialize_destination_config(destination),
    )
    db.commit()
    db.refresh(destination)

    rate_limit = dict(destination.rate_limit_json or {})
    return RuntimeDestinationRateLimitSaveResponse(
        destination_id=int(destination.id),
        destination_type=str(destination.destination_type),
        rate_limit=rate_limit,
        field_count=len(rate_limit),
        message="Destination rate limit saved successfully",
    )


def cleanup_delivery_logs(
    db: Session,
    *,
    older_than_days: int,
    dry_run: bool,
) -> RuntimeLogsCleanupResponse:
    """Delete delivery_logs with created_at before cutoff, or count only when dry_run."""

    cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
    flt = DeliveryLog.created_at < cutoff
    matched_count = db.query(DeliveryLog).filter(flt).count()
    deleted_count = 0
    if dry_run:
        message = "Dry run: matched rows were counted; nothing deleted."
    else:
        deleted_count = db.query(DeliveryLog).filter(flt).delete(synchronize_session=False)
        db.commit()
        message = f"Deleted {deleted_count} delivery_logs row(s) with created_at before cutoff."
    return RuntimeLogsCleanupResponse(
        older_than_days=older_than_days,
        dry_run=dry_run,
        cutoff=cutoff,
        matched_count=matched_count,
        deleted_count=deleted_count,
        message=message,
    )
