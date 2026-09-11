"""Runtime status and API test endpoints."""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded, preview_read_bounded_session
from app.runtime.dashboard_read_cache import dashboard_read_cache
from app.runtime.stats_health_bulk_cache import stats_health_bulk_cache
from app.runtime.stats_health_bulk_service import resolve_bulk_stream_ids_param
from app.platform_admin import journal
from app.runtime import (
    control_service,
    observability_summary,
    pipeline_debug_service,
    preview_service,
    read_service,
    replay_service,
    route_classification_service,
    route_policy_service,
    route_protection_service,
    route_transform_service,
    stream_configuration_service,
)
from app.runtime.analytics_router import router as runtime_analytics_router
from app.runtime.health_router import router as runtime_health_router
from app.runtime.governance_workspace_snapshot_schemas import GovernanceWorkspaceSnapshotResponse
from app.runtime.governance_workspace_snapshot_service import build_governance_workspace_snapshot
from app.runtime.operational_snapshot_schemas import OperationalSnapshotResponse
from app.runtime.operational_snapshot_service import build_operational_snapshot
from app.runtime.metrics_service import build_degraded_stream_runtime_metrics, build_stream_runtime_metrics
from app.runtime.errors import PreviewRequestError, SourceFetchError
from app.startup_readiness import get_startup_snapshot
from app.runtime.metrics_window import normalize_metrics_window_token
from app.schema_observation.schemas import (
    SchemaBaselineResetRequest,
    SchemaBaselineResetResponse,
    SchemaFieldDriftAcknowledgeRequest,
    SchemaFieldDriftAcknowledgeResponse,
    StreamObservedSchemaResponse,
    StreamSchemaFieldDriftsResponse,
    StreamSchemaFieldDriftsSummaryResponse,
)
from app.schema_observation import service as schema_observation_service
from app.sensitive_detection.schemas import (
    SensitiveFindingAcknowledgeRequest,
    SensitiveFindingAcknowledgeResponse,
    StreamSensitiveFindingsResponse,
    StreamSensitiveFindingsSummaryResponse,
)
from app.sensitive_detection import service as sensitive_detection_service
from app.classification.schemas import (
    ClassificationRuleCreateRequest,
    ClassificationRulePatchRequest,
    ClassificationRuleResponse,
    PlatformClassificationSummaryResponse,
    StreamClassificationRulesResponse,
    StreamClassificationSummaryResponse,
)
from app.protection.policy_schemas import (
    PolicyRuleCreateRequest,
    PolicyRulePatchRequest,
    PolicyRuleResponse,
    StreamPolicyRulesResponse,
    StreamPolicySummaryResponse,
)
from app.dynamic_routing.schemas import (
    DynamicRouteCreateRequest,
    DynamicRoutePatchRequest,
    DynamicRouteResponse,
    PlatformDynamicRoutingSummaryResponse,
    StreamDynamicRoutesResponse,
    StreamDynamicRoutingSummaryResponse,
)
from app.failover_routing.schemas import (
    FailoverRouteCreateRequest,
    FailoverRoutePatchRequest,
    FailoverRouteResponse,
    PlatformFailoverRoutingSummaryResponse,
    StreamFailoverRoutesResponse,
    StreamFailoverRoutingSummaryResponse,
)
from app.route_classification.schemas import (
    RouteClassificationEffectiveResponse,
    RouteClassificationRuleCreateRequest,
    RouteClassificationRulePatchRequest,
    RouteClassificationRuleResponse,
    RouteClassificationRulesResponse,
)
from app.route_policy.schemas import (
    RoutePolicyEffectiveResponse,
    RoutePolicyRuleCreateRequest,
    RoutePolicyRulePatchRequest,
    RoutePolicyRuleResponse,
    RoutePolicyRulesResponse,
)
from app.route_protection.schemas import (
    RouteProtectionEffectiveResponse,
    RouteProtectionRuleCreateRequest,
    RouteProtectionRulePatchRequest,
    RouteProtectionRuleResponse,
    RouteProtectionRulesResponse,
)
from app.protection.schemas import (
    IdentityVaultSummaryResponse,
    ProtectionRuleCreateRequest,
    ProtectionRuleDirectBulkRequest,
    ProtectionRuleDirectBulkResponse,
    ProtectionRulePatchRequest,
    ProtectionRuleResponse,
    SensitiveFindingResolveRequest,
    SensitiveFindingResolveResponse,
    StreamProtectionRulesResponse,
    StreamProtectionSummaryResponse,
)
from app.runtime.schemas import (
    ConnectorUIConfigResponse,
    ConnectorUISaveRequest,
    ConnectorUISaveResponse,
    DashboardOutcomeTimeseriesResponse,
    DashboardSummaryResponse,
    DestinationUIConfigResponse,
    DestinationUISaveRequest,
    DestinationUISaveResponse,
    DeliveryFormatDraftPreviewRequest,
    DeliveryFormatDraftPreviewResponse,
    E2EDraftPreviewRequest,
    E2EDraftPreviewResponse,
    ExtractionValidateRequest,
    ExtractionValidateResponse,
    EnrichmentExecPreviewRequest,
    EnrichmentExecPreviewResponse,
    EnrichmentValidateRequest,
    EnrichmentValidateResponse,
    FinalEventDraftPreviewRequest,
    FinalEventDraftPreviewResponse,
    RuntimeFailureTrendResponse,
    RuntimeLogsCleanupRequest,
    RuntimeLogsCleanupResponse,
    DeliveryLogReplayRequest,
    DeliveryLogReplayResponse,
    PlatformQuarantineSummaryResponse,
    PlatformReplaySummaryResponse,
    QuarantineEventActionResponse,
    QuarantineEventItem,
    ReplayEventActionResponse,
    ReplayEventItem,
    StreamQuarantineEventsResponse,
    StreamQuarantineSummaryResponse,
    StreamReplayEventsResponse,
    StreamReplaySummaryResponse,
    RuntimeLogsPageResponse,
    RuntimeLogsTotalsResponse,
    RuntimeEnrichmentSaveRequest,
    RuntimeEnrichmentSaveResponse,
    RuntimeMappingSaveRequest,
    RuntimeMappingSaveResponse,
    RuntimeRouteEnabledSaveRequest,
    RuntimeRouteEnabledSaveResponse,
    RuntimeRouteFailurePolicySaveRequest,
    RuntimeRouteFailurePolicySaveResponse,
    RuntimeRouteFormatterSaveRequest,
    RuntimeRouteFormatterSaveResponse,
    RuntimeDestinationRateLimitSaveRequest,
    RuntimeDestinationRateLimitSaveResponse,
    RuntimeRouteRateLimitSaveRequest,
    RuntimeRouteRateLimitSaveResponse,
    RuntimeStreamControlResponse,
    RuntimeStreamRunOnceResponse,
    SourceUIConfigResponse,
    SourceUISaveRequest,
    SourceUISaveResponse,
    StreamUIConfigResponse,
    StreamUISaveRequest,
    StreamUISaveResponse,
    RuntimeStreamRateLimitSaveRequest,
    RuntimeStreamRateLimitSaveResponse,
    FormatPreviewRequest,
    FormatPreviewResponse,
    ConnectorAuthTestRequest,
    ConnectorAuthTestResponse,
    DeliveryPrefixFormatPreviewRequest,
    DeliveryPrefixFormatPreviewResponse,
    HttpApiTestRequest,
    HttpApiTestResponse,
    MappingDraftPreviewRequest,
    MappingDraftPreviewResponse,
    MappingJsonPathsRequest,
    MappingJsonPathsResponse,
    MappingValidateRequest,
    MappingValidateResponse,
    MappingUISaveRequest,
    MappingUISaveResponse,
    MappingUIConfigResponse,
    RouteEnrichmentUIConfigResponse,
    RouteEnrichmentUISaveRequest,
    RouteEnrichmentUISaveResponse,
    RouteMappingUIConfigResponse,
    RouteMappingUISaveRequest,
    RouteMappingUISaveResponse,
    RouteTransformEffectiveResponse,
    MappingPreviewRequest,
    MappingPreviewResponse,
    TransformPreviewRequest,
    TransformPreviewResponse,
    SensitiveDetectionPreviewRequest,
    SensitiveDetectionPreviewResponse,
    RouteDeliveryPreviewRequest,
    RouteDeliveryPreviewResponse,
    PipelineDebugRequest,
    PipelineDebugResponse,
    RouteUIConfigResponse,
    RouteUISaveRequest,
    RouteUISaveResponse,
    CheckpointHistoryResponse,
    CheckpointTraceResponse,
    RuntimeLogSearchResponse,
    RuntimeTraceResponse,
    RuntimeAlertSummaryResponse,
    ObservabilitySummaryResponse,
    RuntimeSystemResourcesResponse,
    RuntimeTimelineResponse,
    StreamHealthResponse,
    StreamRuntimeMetricsResponse,
    StreamRuntimeStatsHealthBundleResponse,
    BulkStreamStatsHealthResponse,
    StreamRuntimeStatsResponse,
    WebhookIngestObservabilityResponse,
    StreamConfigurationResponse,
    StreamSampleDataResponse,
    StreamSampleDataSaveRequest,
    StreamDeduplicationConfig,
    StreamDeduplicationSaveRequest,
    StreamDedupRuntimeStatus,
    StreamIncrementalTestRequest,
    StreamIncrementalTestResponse,
    StreamReplayRequest,
    StreamReplayResponse,
    StreamIncrementalFetchConfig,
    StreamIncrementalFetchSaveRequest,
    StreamIncrementalFetchStatus,
    StreamCheckpointManageResponse,
    StreamCheckpointUpdateRequest,
    StreamCheckpointResetRequest,
)
from app.runtime.system_resources import collect_runtime_system_resources
from app.runtime.topology_schemas import RuntimeTopologyResponse
from app.runtime.topology_service import get_runtime_topology
from app.stream_governance.router import router as stream_governance_router
from app.validation.schemas import ValidationOperationalSummaryResponse

router = APIRouter()
logger = logging.getLogger(__name__)


def _raise_mapping_save_http_error(exc: BaseException) -> None:
    """Map mapping save failures to HTTP responses; log import failures for ops."""

    if isinstance(exc, control_service.MappingPathValidationError):
        violations = exc.violations
        raise HTTPException(
            status_code=422,
            detail={
                "error_code": "ENVELOPE_RELATIVE_MAPPING_PATH",
                "message": (
                    violations[0]["message"]
                    if violations
                    else "Mapping paths must be relative to the extracted event."
                ),
                "violations": violations,
            },
        ) from exc
    if isinstance(exc, ModuleNotFoundError):
        failed_import = exc.name or (str(exc.args[0]) if exc.args else None)
        logger.error(
            "mapping_save_import_failed module=%s path=%s",
            failed_import,
            getattr(exc, "path", None),
        )
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": "MAPPING_SAVE_FAILED",
                "message": f"Import failed: {failed_import or exc}",
                "failed_import": failed_import,
            },
        ) from exc
    if isinstance(exc, ImportError):
        failed_name = getattr(exc, "name", None)
        logger.error(
            "mapping_save_import_failed error_type=%s failed_import=%s message=%s",
            type(exc).__name__,
            failed_name,
            str(exc),
        )
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": "MAPPING_SAVE_FAILED",
                "message": str(exc),
                "failed_import": failed_name,
            },
        ) from exc
    logger.exception("mapping_save_unexpected_error error_type=%s", type(exc).__name__)
    raise HTTPException(
        status_code=500,
        detail={
            "error_code": "MAPPING_SAVE_FAILED",
            "message": str(exc),
        },
    ) from exc


@router.get("/status")
async def get_runtime_status() -> dict[str, object]:
    """Startup diagnostics: DB target, Alembic revision, schema readiness, scheduler activation."""

    return get_startup_snapshot().as_public_dict()


@router.get("/streams/{stream_id}/mapping-ui/config", response_model=MappingUIConfigResponse)
async def get_stream_mapping_ui_config(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> MappingUIConfigResponse:
    """Load stream/source/mapping/enrichment/routes config for Mapping UI screen."""

    try:
        return read_service.get_mapping_ui_config(db, stream_id)
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.get("/routes/{route_id}/ui/config", response_model=RouteUIConfigResponse)
async def get_route_ui_config(
    route_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> RouteUIConfigResponse:
    """Load route and destination config for Route UI screen."""

    try:
        return read_service.get_route_ui_config(db, route_id)
    except read_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.get("/routes/{route_id}/mapping-ui/config", response_model=RouteMappingUIConfigResponse)
async def get_route_mapping_ui_config(
    route_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> RouteMappingUIConfigResponse:
    """Load per-route mapping config (dual-read with stream fallback)."""

    try:
        return route_transform_service.get_route_mapping_ui_config(db, route_id)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.post("/routes/{route_id}/mapping-ui/save", response_model=RouteMappingUISaveResponse)
async def save_route_mapping_ui_config(
    route_id: int,
    payload: RouteMappingUISaveRequest,
    db: Session = Depends(get_db),
) -> RouteMappingUISaveResponse:
    """Save or clear per-route mapping override."""

    try:
        return route_transform_service.save_route_mapping_ui_config(db, route_id, payload)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except control_service.MappingPathValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "error_code": "MAPPING_PATH_VALIDATION_FAILED",
                "message": "mapping path validation failed",
                "violations": exc.violations,
            },
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error_code": "INVALID_REQUEST", "message": str(exc)},
        ) from exc


@router.get("/routes/{route_id}/enrichment-ui/config", response_model=RouteEnrichmentUIConfigResponse)
async def get_route_enrichment_ui_config(
    route_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> RouteEnrichmentUIConfigResponse:
    """Load per-route enrichment config (dual-read with stream fallback)."""

    try:
        return route_transform_service.get_route_enrichment_ui_config(db, route_id)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.post("/routes/{route_id}/enrichment-ui/save", response_model=RouteEnrichmentUISaveResponse)
async def save_route_enrichment_ui_config(
    route_id: int,
    payload: RouteEnrichmentUISaveRequest,
    db: Session = Depends(get_db),
) -> RouteEnrichmentUISaveResponse:
    """Save or clear per-route enrichment override."""

    try:
        return route_transform_service.save_route_enrichment_ui_config(db, route_id, payload)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error_code": "INVALID_REQUEST", "message": str(exc)},
        ) from exc


@router.get("/routes/{route_id}/transform/effective", response_model=RouteTransformEffectiveResponse)
async def get_route_transform_effective(
    route_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> RouteTransformEffectiveResponse:
    """Resolved per-route transform config (dual-read summary for operator UI)."""

    try:
        return route_transform_service.get_route_transform_effective(db, route_id)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.get("/routes/{route_id}/protection-rules", response_model=RouteProtectionRulesResponse)
async def get_route_protection_rules(
    route_id: int,
    enabled_only: bool = Query(False),
    db: Session = Depends(get_db_read_bounded),
) -> RouteProtectionRulesResponse:
    from app.protection.engine import protection_enabled
    from app.route_protection.operator_workflow import list_route_protection_rules

    try:
        stream_id, rules = list_route_protection_rules(db, route_id, enabled_only=enabled_only)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    return RouteProtectionRulesResponse(
        route_id=route_id,
        stream_id=stream_id,
        protection_enabled=protection_enabled(),
        rules=rules,
        rule_count=len(rules),
    )


@router.post("/routes/{route_id}/protection-rules", response_model=RouteProtectionRuleResponse)
async def create_route_protection_rule(
    route_id: int,
    body: RouteProtectionRuleCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> RouteProtectionRuleResponse:
    from app.audit.service import audit_actor_from_request
    from app.protection.operator_workflow import ProtectionRuleConflictError, ProtectionRuleValidationError
    from app.route_protection.operator_workflow import (
        create_route_protection_rule as create_rule,
        list_route_protection_rules,
    )

    actor = audit_actor_from_request(request)
    try:
        rule = create_rule(
            db,
            route_id=route_id,
            field_path=body.field_path,
            sensitivity_class=body.sensitivity_class,
            protection_mode=body.protection_mode,
            enabled=body.enabled,
            source_finding_id=body.source_finding_id,
            actor_username=actor.actor_username or "system",
        )
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except ProtectionRuleConflictError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "PROTECTION_RULE_CONFLICT", "message": str(exc)},
        ) from exc
    except ProtectionRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "PROTECTION_RULE_INVALID", "message": str(exc)},
        ) from exc
    stream_id, entries = list_route_protection_rules(db, route_id)
    entry = next((e for e in entries if e["id"] == rule.id), None)
    if entry is None:
        raise HTTPException(status_code=500, detail="rule created but not readable")
    return RouteProtectionRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.patch(
    "/routes/{route_id}/protection-rules/{rule_id}",
    response_model=RouteProtectionRuleResponse,
)
async def patch_route_protection_rule(
    route_id: int,
    rule_id: int,
    body: RouteProtectionRulePatchRequest,
    db: Session = Depends(get_db),
) -> RouteProtectionRuleResponse:
    from app.protection.operator_workflow import ProtectionRuleValidationError
    from app.route_protection.operator_workflow import (
        RouteProtectionRuleNotFoundError,
        list_route_protection_rules,
        patch_route_protection_rule as patch_rule,
    )

    try:
        patch_rule(
            db,
            route_id=route_id,
            rule_id=rule_id,
            protection_mode=body.protection_mode,
            enabled=body.enabled,
            sensitivity_class=body.sensitivity_class,
        )
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except RouteProtectionRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "PROTECTION_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc
    except ProtectionRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "PROTECTION_RULE_INVALID", "message": str(exc)},
        ) from exc
    _, entries = list_route_protection_rules(db, route_id)
    entry = next((e for e in entries if e["id"] == rule_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return RouteProtectionRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.delete("/routes/{route_id}/protection-rules/{rule_id}", status_code=204)
async def delete_route_protection_rule(
    route_id: int,
    rule_id: int,
    db: Session = Depends(get_db),
) -> None:
    from app.route_protection.operator_workflow import (
        RouteProtectionRuleNotFoundError,
        delete_route_protection_rule as delete_rule,
    )

    try:
        delete_rule(db, route_id=route_id, rule_id=rule_id)
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except RouteProtectionRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "PROTECTION_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc


@router.get("/routes/{route_id}/protection/effective", response_model=RouteProtectionEffectiveResponse)
async def get_route_protection_effective(
    route_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> RouteProtectionEffectiveResponse:
    """Resolved per-route protection config (dual-read summary for operator UI)."""

    try:
        return route_protection_service.get_route_protection_effective(db, route_id)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.get("/routes/{route_id}/classification-rules", response_model=RouteClassificationRulesResponse)
async def get_route_classification_rules(
    route_id: int,
    enabled_only: bool = Query(False),
    db: Session = Depends(get_db_read_bounded),
) -> RouteClassificationRulesResponse:
    from app.route_classification.operator_workflow import list_route_classification_rules

    try:
        stream_id, rules = list_route_classification_rules(db, route_id, enabled_only=enabled_only)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    return RouteClassificationRulesResponse(
        route_id=route_id,
        stream_id=stream_id,
        rules=rules,
        rule_count=len(rules),
    )


@router.post("/routes/{route_id}/classification-rules", response_model=RouteClassificationRuleResponse)
async def create_route_classification_rule(
    route_id: int,
    body: RouteClassificationRuleCreateRequest,
    db: Session = Depends(get_db),
) -> RouteClassificationRuleResponse:
    from app.classification.operator_workflow import ClassificationRuleValidationError
    from app.route_classification.operator_workflow import (
        create_route_classification_rule as create_rule,
        list_route_classification_rules,
    )

    try:
        rule = create_rule(
            db,
            route_id=route_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True),
            classification_level=body.classification_level,
        )
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except ClassificationRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "CLASSIFICATION_RULE_INVALID", "message": str(exc)},
        ) from exc
    _, entries = list_route_classification_rules(db, route_id)
    entry = next((e for e in entries if e["id"] == rule.id), None)
    if entry is None:
        raise HTTPException(status_code=500, detail="rule created but not readable")
    return RouteClassificationRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.patch(
    "/routes/{route_id}/classification-rules/{rule_id}",
    response_model=RouteClassificationRuleResponse,
)
async def patch_route_classification_rule(
    route_id: int,
    rule_id: int,
    body: RouteClassificationRulePatchRequest,
    db: Session = Depends(get_db),
) -> RouteClassificationRuleResponse:
    from app.classification.operator_workflow import ClassificationRuleValidationError
    from app.route_classification.operator_workflow import (
        RouteClassificationRuleNotFoundError,
        list_route_classification_rules,
        patch_route_classification_rule as patch_rule,
    )

    try:
        patch_rule(
            db,
            route_id=route_id,
            rule_id=rule_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True)
            if body.condition_json is not None
            else None,
            classification_level=body.classification_level,
        )
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except RouteClassificationRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "CLASSIFICATION_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc
    except ClassificationRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "CLASSIFICATION_RULE_INVALID", "message": str(exc)},
        ) from exc
    _, entries = list_route_classification_rules(db, route_id)
    entry = next((e for e in entries if e["id"] == rule_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return RouteClassificationRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.delete("/routes/{route_id}/classification-rules/{rule_id}", status_code=204)
async def delete_route_classification_rule(
    route_id: int,
    rule_id: int,
    db: Session = Depends(get_db),
) -> None:
    from app.route_classification.operator_workflow import (
        RouteClassificationRuleNotFoundError,
        delete_route_classification_rule as delete_rule,
    )

    try:
        delete_rule(db, route_id=route_id, rule_id=rule_id)
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except RouteClassificationRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "CLASSIFICATION_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc


@router.get("/routes/{route_id}/classification/effective", response_model=RouteClassificationEffectiveResponse)
async def get_route_classification_effective(
    route_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> RouteClassificationEffectiveResponse:
    """Resolved per-route classification config (dual-read summary for operator UI)."""

    try:
        return route_classification_service.get_route_classification_effective(db, route_id)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.get("/routes/{route_id}/policy-rules", response_model=RoutePolicyRulesResponse)
async def get_route_policy_rules(
    route_id: int,
    enabled_only: bool = Query(False),
    db: Session = Depends(get_db_read_bounded),
) -> RoutePolicyRulesResponse:
    from app.route_policy.operator_workflow import list_route_policy_rules

    try:
        stream_id, rules = list_route_policy_rules(db, route_id, enabled_only=enabled_only)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    return RoutePolicyRulesResponse(
        route_id=route_id,
        stream_id=stream_id,
        rules=rules,
        rule_count=len(rules),
    )


@router.post("/routes/{route_id}/policy-rules", response_model=RoutePolicyRuleResponse)
async def create_route_policy_rule(
    route_id: int,
    body: RoutePolicyRuleCreateRequest,
    db: Session = Depends(get_db),
) -> RoutePolicyRuleResponse:
    from app.protection.policy_operator_workflow import PolicyRuleValidationError
    from app.route_policy.operator_workflow import (
        create_route_policy_rule as create_rule,
        list_route_policy_rules,
    )

    try:
        rule = create_rule(
            db,
            route_id=route_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True),
            action_type=body.action_type,
        )
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except PolicyRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "POLICY_RULE_VALIDATION", "message": str(exc)},
        ) from exc
    _, entries = list_route_policy_rules(db, route_id)
    entry = next((e for e in entries if e["id"] == rule.id), None)
    if entry is None:
        raise HTTPException(status_code=500, detail="rule created but not readable")
    return RoutePolicyRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.patch(
    "/routes/{route_id}/policy-rules/{rule_id}",
    response_model=RoutePolicyRuleResponse,
)
async def patch_route_policy_rule(
    route_id: int,
    rule_id: int,
    body: RoutePolicyRulePatchRequest,
    db: Session = Depends(get_db),
) -> RoutePolicyRuleResponse:
    from app.protection.policy_operator_workflow import PolicyRuleValidationError
    from app.route_policy.operator_workflow import (
        RoutePolicyRuleNotFoundError,
        list_route_policy_rules,
        patch_route_policy_rule as patch_rule,
    )

    try:
        patch_rule(
            db,
            route_id=route_id,
            rule_id=rule_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True)
            if body.condition_json is not None
            else None,
            action_type=body.action_type,
        )
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except RoutePolicyRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "POLICY_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc
    except PolicyRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "POLICY_RULE_VALIDATION", "message": str(exc)},
        ) from exc
    _, entries = list_route_policy_rules(db, route_id)
    entry = next((e for e in entries if e["id"] == rule_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return RoutePolicyRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.delete("/routes/{route_id}/policy-rules/{rule_id}", status_code=204)
async def delete_route_policy_rule(
    route_id: int,
    rule_id: int,
    db: Session = Depends(get_db),
) -> None:
    from app.route_policy.operator_workflow import (
        RoutePolicyRuleNotFoundError,
        delete_route_policy_rule as delete_rule,
    )

    try:
        delete_rule(db, route_id=route_id, rule_id=rule_id)
        db.commit()
    except control_service.RouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except RoutePolicyRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "POLICY_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc


@router.get("/routes/{route_id}/policy/effective", response_model=RoutePolicyEffectiveResponse)
async def get_route_policy_effective(
    route_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> RoutePolicyEffectiveResponse:
    """Resolved per-route policy config (dual-read summary for operator UI)."""

    try:
        return route_policy_service.get_route_policy_effective(db, route_id)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.get(
    "/streams/{stream_id}/governance/workspace-snapshot",
    response_model=GovernanceWorkspaceSnapshotResponse,
)
async def get_governance_workspace_snapshot(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> GovernanceWorkspaceSnapshotResponse:
    """Bulk read-only effective governance for Governance Workspace (one stream)."""

    try:
        return build_governance_workspace_snapshot(db, stream_id)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.post("/streams/{stream_id}/mapping-ui/save", response_model=MappingUISaveResponse)
async def save_stream_mapping_ui_config(
    stream_id: int,
    payload: MappingUISaveRequest,
    db: Session = Depends(get_db),
) -> MappingUISaveResponse:
    """Save Mapping UI bundle settings with one transactional commit."""

    try:
        return control_service.save_runtime_mapping_ui_config(db, stream_id, payload)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except Exception as exc:
        _raise_mapping_save_http_error(exc)


@router.post("/routes/{route_id}/ui/save", response_model=RouteUISaveResponse)
async def save_route_ui_config(
    route_id: int,
    payload: RouteUISaveRequest,
    db: Session = Depends(get_db),
) -> RouteUISaveResponse:
    """Save Route UI screen settings with one commit."""

    try:
        return control_service.save_runtime_route_ui_config(db, route_id, payload)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc
    except control_service.DestinationNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "DESTINATION_NOT_FOUND",
                "message": f"destination not found: {exc.destination_id}",
            },
        ) from exc


@router.get("/destinations/{destination_id}/ui/config", response_model=DestinationUIConfigResponse)
async def get_destination_ui_config(
    destination_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> DestinationUIConfigResponse:
    """Load destination + connected routes config for Destination UI screen."""

    try:
        return read_service.get_destination_ui_config(db, destination_id)
    except read_service.DestinationNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "DESTINATION_NOT_FOUND",
                "message": f"destination not found: {exc.destination_id}",
            },
        ) from exc


@router.post("/destinations/{destination_id}/ui/save", response_model=DestinationUISaveResponse)
async def save_destination_ui_config(
    destination_id: int,
    payload: DestinationUISaveRequest,
    db: Session = Depends(get_db),
) -> DestinationUISaveResponse:
    """Save Destination UI screen settings with one commit."""

    try:
        return control_service.save_runtime_destination_ui_config(db, destination_id, payload)
    except control_service.DestinationNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "DESTINATION_NOT_FOUND",
                "message": f"destination not found: {exc.destination_id}",
            },
        ) from exc


@router.get("/streams/{stream_id}/ui/config", response_model=StreamUIConfigResponse)
async def get_stream_ui_config(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamUIConfigResponse:
    """Load stream + related summaries for Stream UI screen."""

    try:
        return read_service.get_stream_ui_config(db, stream_id)
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.post("/streams/{stream_id}/ui/save", response_model=StreamUISaveResponse)
async def save_stream_ui_config(
    stream_id: int,
    payload: StreamUISaveRequest,
    db: Session = Depends(get_db),
) -> StreamUISaveResponse:
    """Save Stream UI screen settings with one commit."""

    try:
        return control_service.save_runtime_stream_ui_config(db, stream_id, payload)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.get("/sources/{source_id}/ui/config", response_model=SourceUIConfigResponse)
async def get_source_ui_config(
    source_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> SourceUIConfigResponse:
    """Load source + connected streams config for Source UI screen."""

    try:
        return read_service.get_source_ui_config(db, source_id)
    except read_service.SourceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {exc.source_id}"},
        ) from exc


@router.post("/sources/{source_id}/ui/save", response_model=SourceUISaveResponse)
async def save_source_ui_config(
    source_id: int,
    payload: SourceUISaveRequest,
    db: Session = Depends(get_db),
) -> SourceUISaveResponse:
    """Save Source UI screen settings with one commit."""

    try:
        return control_service.save_runtime_source_ui_config(db, source_id, payload)
    except control_service.SourceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "SOURCE_NOT_FOUND", "message": f"source not found: {exc.source_id}"},
        ) from exc


@router.get("/connectors/{connector_id}/ui/config", response_model=ConnectorUIConfigResponse)
async def get_connector_ui_config(
    connector_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> ConnectorUIConfigResponse:
    """Load connector + source/stream summaries for Connector UI screen."""

    try:
        return read_service.get_connector_ui_config(db, connector_id)
    except read_service.ConnectorNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {exc.connector_id}"},
        ) from exc


@router.post("/connectors/{connector_id}/ui/save", response_model=ConnectorUISaveResponse)
async def save_connector_ui_config(
    connector_id: int,
    payload: ConnectorUISaveRequest,
    db: Session = Depends(get_db),
) -> ConnectorUISaveResponse:
    """Save Connector UI screen settings with one commit."""

    try:
        return control_service.save_runtime_connector_ui_config(db, connector_id, payload)
    except control_service.ConnectorNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "CONNECTOR_NOT_FOUND", "message": f"connector not found: {exc.connector_id}"},
        ) from exc


@router.get("/stats/stream/{stream_id}", response_model=StreamRuntimeStatsResponse)
async def get_stream_runtime_stats(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
    limit: int = Query(100, ge=1, le=1000),
    window: str | None = Query(
        None,
        description="Optional rolling window for summary counters (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp shared across observability pages.",
    ),
) -> StreamRuntimeStatsResponse:
    """Summarize recent committed delivery_logs and checkpoint for a stream (read-only)."""

    try:
        w = normalize_metrics_window_token(window) if window is not None else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return read_service.get_stream_runtime_stats(db, stream_id, limit, window=w, snapshot_id=snapshot_id)
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.get("/streams/{stream_id}/metrics", response_model=StreamRuntimeMetricsResponse)
async def get_stream_runtime_metrics(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
    window: str = Query(
        "1h",
        description="Rolling window for KPIs and charts (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp to reuse across runtime widgets.",
    ),
) -> StreamRuntimeMetricsResponse:
    """Stream Runtime panel: KPIs, time buckets, route rows, checkpoint snapshot, recent runs (read-only)."""

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return build_stream_runtime_metrics(db, stream_id, window=w, snapshot_id=snapshot_id)
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        logger.exception("stream_runtime_metrics_degraded stream_id=%s", stream_id)
        db.rollback()
        try:
            return build_degraded_stream_runtime_metrics(db, stream_id, window=w, snapshot_id=snapshot_id)
        except read_service.StreamNotFoundError as nf:
            raise HTTPException(
                status_code=404,
                detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {nf.stream_id}"},
            ) from nf
        except Exception as inner:
            raise HTTPException(status_code=500, detail="Failed to load stream runtime metrics.") from inner


@router.get("/streams/{stream_id}/webhook-ingest", response_model=WebhookIngestObservabilityResponse)
async def get_stream_webhook_ingest_observability(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
    window: str = Query(
        "1h",
        description="Rolling window for ingest counters (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp shared across runtime widgets.",
    ),
    log_limit: int = Query(20, ge=1, le=100),
) -> WebhookIngestObservabilityResponse:
    """Webhook receiver ingest health from delivery_logs (read-only)."""

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return read_service.get_webhook_ingest_observability(
            db,
            stream_id,
            window=w,
            snapshot_id=snapshot_id,
            log_limit=log_limit,
        )
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc
    except read_service.StreamNotWebhookReceiverError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "error_code": "STREAM_NOT_WEBHOOK_RECEIVER",
                "message": f"stream is not a webhook receiver: {exc.stream_id}",
            },
        ) from exc


@router.get("/health/stream/{stream_id}", response_model=StreamHealthResponse)
async def get_stream_runtime_health(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
    limit: int = Query(100, ge=1, le=1000),
    window: str = Query(
        "1h",
        description="Rolling window for snapshot-backed health (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp shared across runtime widgets.",
    ),
) -> StreamHealthResponse:
    """Per-route and stream health (snapshot-backed when read model is populated)."""

    try:
        return read_service.get_stream_runtime_health(
            db,
            stream_id,
            limit,
            window=window,
            snapshot_id=snapshot_id,
        )
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc



def _raise_stream_configuration_not_found(exc: stream_configuration_service.StreamNotFoundError) -> None:
    raise HTTPException(
        status_code=404,
        detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
    ) from exc


@router.get("/streams/{stream_id}/configuration", response_model=StreamConfigurationResponse)
async def get_stream_configuration(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamConfigurationResponse:
    """Human-readable stream configuration sections for the Configuration tab."""

    try:
        return stream_configuration_service.get_stream_configuration(db, stream_id)
    except stream_configuration_service.StreamNotFoundError as exc:
        _raise_stream_configuration_not_found(exc)


@router.get("/streams/{stream_id}/sample-data", response_model=StreamSampleDataResponse)
async def get_stream_sample_data(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamSampleDataResponse:
    """Load wizard sample-data artifacts for a stream."""

    try:
        return stream_configuration_service.get_stream_sample_data(db, stream_id)
    except stream_configuration_service.StreamNotFoundError as exc:
        _raise_stream_configuration_not_found(exc)


@router.put("/streams/{stream_id}/sample-data", response_model=StreamSampleDataResponse)
async def put_stream_sample_data(
    stream_id: int,
    payload: StreamSampleDataSaveRequest,
    db: Session = Depends(get_db),
) -> StreamSampleDataResponse:
    """Persist wizard sample-data artifacts for a stream."""

    try:
        result = stream_configuration_service.save_stream_sample_data(db, stream_id, payload)
        db.commit()
        return result
    except stream_configuration_service.StreamNotFoundError as exc:
        db.rollback()
        _raise_stream_configuration_not_found(exc)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/streams/{stream_id}/deduplication", response_model=StreamDedupRuntimeStatus)
async def get_stream_deduplication(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamDedupRuntimeStatus:
    """Load stream deduplication configuration and last runtime counters."""

    try:
        return stream_configuration_service.get_stream_deduplication(db, stream_id)
    except stream_configuration_service.StreamNotFoundError as exc:
        _raise_stream_configuration_not_found(exc)


@router.put("/streams/{stream_id}/deduplication", response_model=StreamDeduplicationConfig)
async def put_stream_deduplication(
    stream_id: int,
    payload: StreamDeduplicationSaveRequest,
    db: Session = Depends(get_db),
) -> StreamDeduplicationConfig:
    """Save stream deduplication configuration."""

    try:
        result = stream_configuration_service.save_stream_deduplication(db, stream_id, payload)
        db.commit()
        return result
    except stream_configuration_service.StreamNotFoundError as exc:
        db.rollback()
        _raise_stream_configuration_not_found(exc)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/streams/{stream_id}/incremental-fetch", response_model=StreamIncrementalFetchStatus)
async def get_stream_incremental_fetch(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamIncrementalFetchStatus:
    """Load incremental-fetch framework configuration and runtime state."""

    try:
        return stream_configuration_service.get_stream_incremental_fetch(db, stream_id)
    except stream_configuration_service.StreamNotFoundError as exc:
        _raise_stream_configuration_not_found(exc)


@router.put("/streams/{stream_id}/incremental-fetch", response_model=StreamIncrementalFetchConfig)
async def put_stream_incremental_fetch(
    stream_id: int,
    payload: StreamIncrementalFetchSaveRequest,
    db: Session = Depends(get_db),
) -> StreamIncrementalFetchConfig:
    """Save incremental-fetch framework configuration."""

    try:
        result = stream_configuration_service.save_stream_incremental_fetch(db, stream_id, payload)
        db.commit()
        return result
    except stream_configuration_service.StreamNotFoundError as exc:
        db.rollback()
        _raise_stream_configuration_not_found(exc)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/streams/{stream_id}/incremental-test", response_model=StreamIncrementalTestResponse)
async def post_stream_incremental_test(
    stream_id: int,
    payload: StreamIncrementalTestRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> StreamIncrementalTestResponse:
    """Run a dry incremental fetch test without advancing the live checkpoint."""

    try:
        return stream_configuration_service.run_stream_incremental_test(
            db,
            stream_id,
            payload,
            api_origin=str(request.base_url).rstrip("/") or None,
        )
    except stream_configuration_service.StreamNotFoundError as exc:
        _raise_stream_configuration_not_found(exc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (PreviewRequestError, SourceFetchError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/streams/{stream_id}/replay", response_model=StreamReplayResponse)
async def post_stream_operational_replay(
    stream_id: int,
    payload: StreamReplayRequest,
    db: Session = Depends(get_db),
) -> StreamReplayResponse:
    """Operational replay / backfill entrypoint for the Configuration tab."""

    try:
        return stream_configuration_service.run_stream_operational_replay(db, stream_id, payload)
    except stream_configuration_service.StreamNotFoundError as exc:
        _raise_stream_configuration_not_found(exc)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/streams/{stream_id}/checkpoint", response_model=StreamCheckpointManageResponse)
async def get_stream_checkpoint_manage(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamCheckpointManageResponse:
    """Load checkpoint manage view (legacy + framework split)."""

    try:
        return stream_configuration_service.get_stream_checkpoint_manage(db, stream_id)
    except stream_configuration_service.StreamNotFoundError as exc:
        _raise_stream_configuration_not_found(exc)


@router.put("/streams/{stream_id}/checkpoint", response_model=StreamCheckpointManageResponse)
async def put_stream_checkpoint_manage(
    stream_id: int,
    payload: StreamCheckpointUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> StreamCheckpointManageResponse:
    """Manually update the stream checkpoint value."""

    try:
        before = stream_configuration_service.get_stream_checkpoint_manage(db, stream_id)
        previous_value = (
            before.fetch_checkpoint
            if before.framework_enabled
            else (before.legacy_checkpoint or before.checkpoint_value)
        )
        result = stream_configuration_service.update_stream_checkpoint(db, stream_id, payload)
        new_value = (
            result.fetch_checkpoint
            if result.framework_enabled
            else (result.legacy_checkpoint or result.checkpoint_value)
        )
        journal.record_audit_event(
            db,
            action="STREAM_CHECKPOINT_UPDATED",
            entity_type="STREAM",
            entity_id=int(stream_id),
            details={
                "affected_count": 1,
                "previous_value": previous_value,
                "new_value": new_value,
                "checkpoint_type": payload.checkpoint_type,
                "success": True,
            },
            request=request,
        )
        db.commit()
        return result
    except stream_configuration_service.StreamNotFoundError as exc:
        db.rollback()
        _raise_stream_configuration_not_found(exc)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/streams/{stream_id}/checkpoint/reset", response_model=StreamCheckpointManageResponse)
async def post_stream_checkpoint_reset(
    stream_id: int,
    payload: StreamCheckpointResetRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> StreamCheckpointManageResponse:
    """Reset the stream checkpoint."""

    try:
        before = stream_configuration_service.get_stream_checkpoint_manage(db, stream_id)
        previous_value = (
            {
                "fetch_checkpoint": before.fetch_checkpoint,
                "delivery_checkpoint": before.delivery_checkpoint,
                "legacy_checkpoint": before.legacy_checkpoint or before.checkpoint_value,
                "framework_enabled": before.framework_enabled,
            }
        )
        result = stream_configuration_service.reset_stream_checkpoint(db, stream_id, payload)
        journal.record_audit_event(
            db,
            action="STREAM_CHECKPOINT_RESET",
            entity_type="STREAM",
            entity_id=int(stream_id),
            details={
                "affected_count": 1,
                "previous_value": previous_value,
                "new_value": {
                    "fetch_checkpoint": result.fetch_checkpoint,
                    "delivery_checkpoint": result.delivery_checkpoint,
                    "legacy_checkpoint": result.legacy_checkpoint or result.checkpoint_value,
                    "framework_enabled": result.framework_enabled,
                },
                "reason": getattr(payload, "reason", None),
                "success": True,
            },
            request=request,
        )
        db.commit()
        return result
    except stream_configuration_service.StreamNotFoundError as exc:
        db.rollback()
        _raise_stream_configuration_not_found(exc)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        db.rollback()
        raise



@router.get("/streams/{stream_id}/observed-schema", response_model=StreamObservedSchemaResponse)
async def get_stream_observed_schema(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamObservedSchemaResponse:
    """Read runtime observed field paths for a Stream (observation inventory; see schema-field-drifts for signals)."""

    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    row = schema_observation_service.get_observed_schema_row(db, stream_id)
    payload = schema_observation_service.build_observed_schema_read_model(stream_id=stream_id, row=row)
    return StreamObservedSchemaResponse.model_validate(payload)


@router.get("/streams/{stream_id}/schema-field-drifts", response_model=StreamSchemaFieldDriftsResponse)
async def get_stream_schema_field_drifts(
    stream_id: int,
    status: str | None = Query(
        "open",
        description="Filter findings: open (default), acknowledged, or all.",
    ),
    db: Session = Depends(get_db_read_bounded),
) -> StreamSchemaFieldDriftsResponse:
    """Read field drift findings for a Stream (M4: status filter; default open)."""

    from app.schema_observation.operator_workflow import normalize_status_filter
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        normalize_status_filter(status)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    payload = schema_observation_service.get_field_drifts_for_stream(db, stream_id, status_filter=status)
    return StreamSchemaFieldDriftsResponse.model_validate(payload)


@router.get(
    "/streams/{stream_id}/schema-field-drifts/summary",
    response_model=StreamSchemaFieldDriftsSummaryResponse,
)
async def get_stream_schema_field_drifts_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamSchemaFieldDriftsSummaryResponse:
    """Drift counts by status and category plus baseline metadata."""

    from app.schema_observation.operator_workflow import build_drift_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    payload = build_drift_summary(db, stream_id)
    return StreamSchemaFieldDriftsSummaryResponse.model_validate(payload)


@router.post(
    "/streams/{stream_id}/schema-field-drifts/{finding_id}/acknowledge",
    response_model=SchemaFieldDriftAcknowledgeResponse,
)
async def acknowledge_stream_schema_field_drift(
    stream_id: int,
    finding_id: int,
    body: SchemaFieldDriftAcknowledgeRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> SchemaFieldDriftAcknowledgeResponse:
    """Acknowledge an open drift finding (open → acknowledged)."""

    from app.audit.service import audit_actor_from_request
    from app.schema_observation.operator_workflow import (
        DriftFindingNotFoundError,
        DriftFindingStateError,
        acknowledge_field_drift,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    actor = audit_actor_from_request(request)
    try:
        finding = acknowledge_field_drift(
            db,
            stream_id=stream_id,
            finding_id=finding_id,
            actor_username=actor.actor_username or "system",
            note=body.note,
        )
        db.commit()
    except DriftFindingNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "DRIFT_FINDING_NOT_FOUND", "message": str(exc)},
        ) from exc
    except DriftFindingStateError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "DRIFT_FINDING_STATE", "message": str(exc)},
        ) from exc
    return SchemaFieldDriftAcknowledgeResponse(
        id=finding.id,
        stream_id=finding.stream_id,
        field_path=finding.field_path,
        category=finding.category,
        status=finding.status,
        acknowledged_at=finding.acknowledged_at,  # type: ignore[arg-type]
        acknowledged_by=finding.acknowledged_by or actor.actor_username or "system",
        operator_note=finding.operator_note,
    )


@router.get("/streams/{stream_id}/sensitive-findings", response_model=StreamSensitiveFindingsResponse)
async def get_stream_sensitive_findings(
    stream_id: int,
    status: str | None = Query(
        "open",
        description="Filter findings: open (default), acknowledged, or all.",
    ),
    db: Session = Depends(get_db_read_bounded),
) -> StreamSensitiveFindingsResponse:
    """Read sensitive field findings for a Stream (M5: default open, confirm gate applied)."""

    from app.sensitive_detection.operator_workflow import normalize_status_filter
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        normalize_status_filter(status)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    payload = sensitive_detection_service.get_sensitive_findings_for_stream(db, stream_id, status_filter=status)
    return StreamSensitiveFindingsResponse.model_validate(payload)


@router.get(
    "/streams/{stream_id}/sensitive-findings/summary",
    response_model=StreamSensitiveFindingsSummaryResponse,
)
async def get_stream_sensitive_findings_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamSensitiveFindingsSummaryResponse:
    """Sensitive finding counts by status and class."""

    from app.sensitive_detection.operator_workflow import build_sensitive_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    payload = build_sensitive_summary(db, stream_id)
    return StreamSensitiveFindingsSummaryResponse.model_validate(payload)


@router.post(
    "/streams/{stream_id}/sensitive-findings/{finding_id}/acknowledge",
    response_model=SensitiveFindingAcknowledgeResponse,
)
async def acknowledge_stream_sensitive_finding(
    stream_id: int,
    finding_id: int,
    body: SensitiveFindingAcknowledgeRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> SensitiveFindingAcknowledgeResponse:
    """Acknowledge an open sensitive finding (open → acknowledged)."""

    from app.audit.service import audit_actor_from_request
    from app.sensitive_detection.operator_workflow import (
        SensitiveFindingNotFoundError,
        SensitiveFindingStateError,
        acknowledge_sensitive_finding,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    actor = audit_actor_from_request(request)
    try:
        finding = acknowledge_sensitive_finding(
            db,
            stream_id=stream_id,
            finding_id=finding_id,
            actor_username=actor.actor_username or "system",
            note=body.note,
        )
        db.commit()
    except SensitiveFindingNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "SENSITIVE_FINDING_NOT_FOUND", "message": str(exc)},
        ) from exc
    except SensitiveFindingStateError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "SENSITIVE_FINDING_STATE", "message": str(exc)},
        ) from exc
    return SensitiveFindingAcknowledgeResponse(
        id=finding.id,
        stream_id=finding.stream_id,
        field_path=finding.field_path,
        sensitivity_class=finding.sensitivity_class,
        detection_method=finding.detection_method,
        status=finding.status,
        acknowledged_at=finding.acknowledged_at,  # type: ignore[arg-type]
        acknowledged_by=finding.acknowledged_by or actor.actor_username or "system",
        operator_note=finding.operator_note,
    )


@router.get("/streams/{stream_id}/protection-rules", response_model=StreamProtectionRulesResponse)
async def get_stream_protection_rules(
    stream_id: int,
    enabled_only: bool = Query(False, description="When true, return only enabled rules."),
    db: Session = Depends(get_db_read_bounded),
) -> StreamProtectionRulesResponse:
    from app.protection.engine import protection_enabled
    from app.protection.operator_workflow import list_protection_rules
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    rules = list_protection_rules(db, stream_id, enabled_only=enabled_only)
    return StreamProtectionRulesResponse(
        stream_id=stream_id,
        protection_enabled=protection_enabled(),
        rules=rules,
        rule_count=len(rules),
    )


@router.get("/protection/vault/summary", response_model=IdentityVaultSummaryResponse)
async def get_identity_vault_summary(
    db: Session = Depends(get_db_read_bounded),
) -> IdentityVaultSummaryResponse:
    from app.protection.identity_vault import build_vault_summary

    payload = build_vault_summary(db)
    return IdentityVaultSummaryResponse.model_validate(payload)


@router.get("/streams/{stream_id}/protection/summary", response_model=StreamProtectionSummaryResponse)
async def get_stream_protection_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamProtectionSummaryResponse:
    from app.protection.operator_workflow import build_protection_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    payload = build_protection_summary(db, stream_id)
    return StreamProtectionSummaryResponse.model_validate(payload)


@router.get("/streams/{stream_id}/classification-rules", response_model=StreamClassificationRulesResponse)
async def get_stream_classification_rules(
    stream_id: int,
    enabled_only: bool = Query(False, description="When true, return only enabled rules."),
    db: Session = Depends(get_db_read_bounded),
) -> StreamClassificationRulesResponse:
    from app.classification.operator_workflow import list_classification_rules
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    rules = list_classification_rules(db, stream_id, enabled_only=enabled_only)
    return StreamClassificationRulesResponse(stream_id=stream_id, rules=rules, rule_count=len(rules))


@router.post("/streams/{stream_id}/classification-rules", response_model=ClassificationRuleResponse)
async def create_stream_classification_rule(
    stream_id: int,
    body: ClassificationRuleCreateRequest,
    db: Session = Depends(get_db),
) -> ClassificationRuleResponse:
    from app.classification.operator_workflow import (
        ClassificationRuleValidationError,
        create_classification_rule,
        list_classification_rules,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        rule = create_classification_rule(
            db,
            stream_id=stream_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True),
            classification_level=body.classification_level,
        )
        db.commit()
    except ClassificationRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "CLASSIFICATION_RULE_INVALID", "message": str(exc)},
        ) from exc
    entries = list_classification_rules(db, stream_id)
    entry = next(e for e in entries if e["id"] == rule.id)
    return ClassificationRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.patch(
    "/streams/{stream_id}/classification-rules/{rule_id}",
    response_model=ClassificationRuleResponse,
)
async def patch_stream_classification_rule(
    stream_id: int,
    rule_id: int,
    body: ClassificationRulePatchRequest,
    db: Session = Depends(get_db),
) -> ClassificationRuleResponse:
    from app.classification.operator_workflow import (
        ClassificationRuleNotFoundError,
        ClassificationRuleValidationError,
        list_classification_rules,
        patch_classification_rule,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        patch_classification_rule(
            db,
            stream_id=stream_id,
            rule_id=rule_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True)
            if body.condition_json is not None
            else None,
            classification_level=body.classification_level,
        )
        db.commit()
    except ClassificationRuleNotFoundError:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "CLASSIFICATION_RULE_NOT_FOUND", "message": f"rule not found: {rule_id}"},
        ) from None
    except ClassificationRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "CLASSIFICATION_RULE_INVALID", "message": str(exc)},
        ) from exc
    entries = list_classification_rules(db, stream_id)
    entry = next(e for e in entries if e["id"] == rule_id)
    return ClassificationRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.get("/streams/{stream_id}/classification/summary", response_model=StreamClassificationSummaryResponse)
async def get_stream_classification_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamClassificationSummaryResponse:
    from app.classification.operator_workflow import build_classification_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    payload = build_classification_summary(db, stream_id)
    return StreamClassificationSummaryResponse.model_validate(payload)


@router.get("/classification/summary", response_model=PlatformClassificationSummaryResponse)
async def get_platform_classification_summary(
    db: Session = Depends(get_db_read_bounded),
) -> PlatformClassificationSummaryResponse:
    from app.classification.operator_workflow import build_platform_summary

    payload = build_platform_summary(db)
    return PlatformClassificationSummaryResponse.model_validate(payload)


@router.get("/streams/{stream_id}/policy-rules", response_model=StreamPolicyRulesResponse)
async def get_stream_policy_rules(
    stream_id: int,
    enabled_only: bool = Query(False, description="When true, return only enabled rules."),
    db: Session = Depends(get_db_read_bounded),
) -> StreamPolicyRulesResponse:
    from app.protection.policy_operator_workflow import list_policy_rules
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    rules = list_policy_rules(db, stream_id, enabled_only=enabled_only)
    return StreamPolicyRulesResponse(stream_id=stream_id, rules=rules, rule_count=len(rules))


@router.get("/streams/{stream_id}/policy/summary", response_model=StreamPolicySummaryResponse)
async def get_stream_policy_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamPolicySummaryResponse:
    from app.protection.policy_operator_workflow import build_policy_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    payload = build_policy_summary(db, stream_id)
    return StreamPolicySummaryResponse.model_validate(payload)


@router.post("/streams/{stream_id}/policy-rules", response_model=PolicyRuleResponse)
async def create_stream_policy_rule(
    stream_id: int,
    body: PolicyRuleCreateRequest,
    db: Session = Depends(get_db),
) -> PolicyRuleResponse:
    from app.protection.policy_operator_workflow import (
        PolicyRuleValidationError,
        create_policy_rule,
        list_policy_rules,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        rule = create_policy_rule(
            db,
            stream_id=stream_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True),
            action_type=body.action_type,
        )
        db.commit()
    except PolicyRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "POLICY_RULE_VALIDATION", "message": str(exc)},
        ) from exc
    entries = list_policy_rules(db, stream_id)
    entry = next(e for e in entries if e["id"] == rule.id)
    return PolicyRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.patch("/streams/{stream_id}/policy-rules/{rule_id}", response_model=PolicyRuleResponse)
async def patch_stream_policy_rule(
    stream_id: int,
    rule_id: int,
    body: PolicyRulePatchRequest,
    db: Session = Depends(get_db),
) -> PolicyRuleResponse:
    from app.protection.policy_operator_workflow import (
        PolicyRuleNotFoundError,
        PolicyRuleValidationError,
        list_policy_rules,
        patch_policy_rule,
    )

    try:
        patch_policy_rule(
            db,
            stream_id=stream_id,
            rule_id=rule_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(exclude_none=True) if body.condition_json is not None else None,
            action_type=body.action_type,
        )
        db.commit()
    except PolicyRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "POLICY_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc
    except PolicyRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "POLICY_RULE_VALIDATION", "message": str(exc)},
        ) from exc
    entries = list_policy_rules(db, stream_id)
    entry = next(e for e in entries if e["id"] == rule_id)
    return PolicyRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.get("/dynamic-routing/summary", response_model=PlatformDynamicRoutingSummaryResponse)
async def get_platform_dynamic_routing_summary(
    db: Session = Depends(get_db_read_bounded),
) -> PlatformDynamicRoutingSummaryResponse:
    from app.dynamic_routing.dynamic_routing_metrics import build_platform_dynamic_routing_summary

    payload = build_platform_dynamic_routing_summary(db)
    return PlatformDynamicRoutingSummaryResponse.model_validate(payload)


@router.get("/streams/{stream_id}/dynamic-routes", response_model=StreamDynamicRoutesResponse)
async def get_stream_dynamic_routes(
    stream_id: int,
    enabled_only: bool = Query(False, description="When true, return only enabled rules."),
    db: Session = Depends(get_db_read_bounded),
) -> StreamDynamicRoutesResponse:
    from app.dynamic_routing.operator_workflow import list_dynamic_routes
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    routes = list_dynamic_routes(db, stream_id, enabled_only=enabled_only)
    return StreamDynamicRoutesResponse(stream_id=stream_id, routes=routes, route_count=len(routes))  # type: ignore[arg-type]


@router.get("/streams/{stream_id}/dynamic-routing/summary", response_model=StreamDynamicRoutingSummaryResponse)
async def get_stream_dynamic_routing_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamDynamicRoutingSummaryResponse:
    from app.dynamic_routing.operator_workflow import build_dynamic_routing_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    payload = build_dynamic_routing_summary(db, stream_id)
    return StreamDynamicRoutingSummaryResponse.model_validate(payload)


@router.post("/streams/{stream_id}/dynamic-routes", response_model=DynamicRouteResponse)
async def create_stream_dynamic_route(
    stream_id: int,
    body: DynamicRouteCreateRequest,
    db: Session = Depends(get_db),
) -> DynamicRouteResponse:
    from app.dynamic_routing.operator_workflow import (
        DynamicRouteValidationError,
        create_dynamic_route,
        list_dynamic_routes,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        rule = create_dynamic_route(
            db,
            stream_id=stream_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump(),
            destination_id=body.destination_id,
            route_id=body.route_id,
        )
        db.commit()
    except DynamicRouteValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "DYNAMIC_ROUTE_VALIDATION", "message": str(exc)},
        ) from exc
    entries = list_dynamic_routes(db, stream_id)
    entry = next(e for e in entries if e["id"] == rule.id)
    return DynamicRouteResponse(route=entry)  # type: ignore[arg-type]


@router.patch("/streams/{stream_id}/dynamic-routes/{route_id}", response_model=DynamicRouteResponse)
async def patch_stream_dynamic_route(
    stream_id: int,
    route_id: int,
    body: DynamicRoutePatchRequest,
    db: Session = Depends(get_db),
) -> DynamicRouteResponse:
    from app.dynamic_routing.operator_workflow import (
        DynamicRouteNotFoundError,
        DynamicRouteValidationError,
        list_dynamic_routes,
        patch_dynamic_route,
    )

    try:
        patch_dynamic_route(
            db,
            stream_id=stream_id,
            route_id=route_id,
            name=body.name,
            enabled=body.enabled,
            condition_json=body.condition_json.model_dump() if body.condition_json is not None else None,
            destination_id=body.destination_id,
            target_route_id=body.route_id,
        )
        db.commit()
    except DynamicRouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "DYNAMIC_ROUTE_NOT_FOUND", "message": str(exc)},
        ) from exc
    except DynamicRouteValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "DYNAMIC_ROUTE_VALIDATION", "message": str(exc)},
        ) from exc
    entries = list_dynamic_routes(db, stream_id)
    entry = next(e for e in entries if e["id"] == route_id)
    return DynamicRouteResponse(route=entry)  # type: ignore[arg-type]


@router.get("/failover-routing/summary", response_model=PlatformFailoverRoutingSummaryResponse)
async def get_platform_failover_routing_summary(
    db: Session = Depends(get_db_read_bounded),
) -> PlatformFailoverRoutingSummaryResponse:
    from app.failover_routing.failover_metrics import build_platform_failover_routing_summary

    payload = build_platform_failover_routing_summary(db)
    return PlatformFailoverRoutingSummaryResponse.model_validate(payload)


@router.get("/streams/{stream_id}/failover-routes", response_model=StreamFailoverRoutesResponse)
async def get_stream_failover_routes(
    stream_id: int,
    enabled_only: bool = Query(False, description="When true, return only enabled rules."),
    db: Session = Depends(get_db_read_bounded),
) -> StreamFailoverRoutesResponse:
    from app.failover_routing.operator_workflow import list_failover_routes
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    routes = list_failover_routes(db, stream_id, enabled_only=enabled_only)
    return StreamFailoverRoutesResponse(stream_id=stream_id, routes=routes, route_count=len(routes))  # type: ignore[arg-type]


@router.get("/streams/{stream_id}/failover-routing/summary", response_model=StreamFailoverRoutingSummaryResponse)
async def get_stream_failover_routing_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamFailoverRoutingSummaryResponse:
    from app.failover_routing.operator_workflow import build_failover_routing_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    payload = build_failover_routing_summary(db, stream_id)
    return StreamFailoverRoutingSummaryResponse.model_validate(payload)


@router.post("/streams/{stream_id}/failover-routes", response_model=FailoverRouteResponse)
async def create_stream_failover_route(
    stream_id: int,
    body: FailoverRouteCreateRequest,
    db: Session = Depends(get_db),
) -> FailoverRouteResponse:
    from app.failover_routing.operator_workflow import (
        FailoverRouteValidationError,
        create_failover_route,
        list_failover_routes,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        rule = create_failover_route(
            db,
            stream_id=stream_id,
            primary_destination_id=body.primary_destination_id,
            secondary_destination_id=body.secondary_destination_id,
            enabled=body.enabled,
        )
        db.commit()
    except FailoverRouteValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "FAILOVER_ROUTE_VALIDATION", "message": str(exc)},
        ) from exc
    entries = list_failover_routes(db, stream_id)
    entry = next(e for e in entries if e["id"] == rule.id)
    return FailoverRouteResponse(route=entry)  # type: ignore[arg-type]


@router.patch("/streams/{stream_id}/failover-routes/{route_id}", response_model=FailoverRouteResponse)
async def patch_stream_failover_route(
    stream_id: int,
    route_id: int,
    body: FailoverRoutePatchRequest,
    db: Session = Depends(get_db),
) -> FailoverRouteResponse:
    from app.failover_routing.operator_workflow import (
        FailoverRouteNotFoundError,
        FailoverRouteValidationError,
        list_failover_routes,
        patch_failover_route,
    )

    try:
        patch_failover_route(
            db,
            stream_id=stream_id,
            route_id=route_id,
            primary_destination_id=body.primary_destination_id,
            secondary_destination_id=body.secondary_destination_id,
            enabled=body.enabled,
        )
        db.commit()
    except FailoverRouteNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "FAILOVER_ROUTE_NOT_FOUND", "message": str(exc)},
        ) from exc
    except FailoverRouteValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "FAILOVER_ROUTE_VALIDATION", "message": str(exc)},
        ) from exc
    entries = list_failover_routes(db, stream_id)
    entry = next(e for e in entries if e["id"] == route_id)
    return FailoverRouteResponse(route=entry)  # type: ignore[arg-type]


@router.post("/streams/{stream_id}/protection-rules", response_model=ProtectionRuleResponse)
async def create_stream_protection_rule(
    stream_id: int,
    body: ProtectionRuleCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> ProtectionRuleResponse:
    from app.audit.service import audit_actor_from_request
    from app.protection.operator_workflow import (
        ProtectionRuleConflictError,
        ProtectionRuleValidationError,
        SensitiveFindingNotFoundError,
        SensitiveFindingStateError,
        create_protection_rule,
        list_protection_rules,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    actor = audit_actor_from_request(request)
    try:
        rule = create_protection_rule(
            db,
            stream_id=stream_id,
            field_path=body.field_path,
            sensitivity_class=body.sensitivity_class,
            protection_mode=body.protection_mode,
            source_finding_id=body.source_finding_id,
            enabled=body.enabled,
            actor_username=actor.actor_username or "system",
        )
        db.commit()
    except ProtectionRuleConflictError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "PROTECTION_RULE_CONFLICT", "message": str(exc)},
        ) from exc
    except (ProtectionRuleValidationError, SensitiveFindingStateError) as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "PROTECTION_RULE_INVALID", "message": str(exc)},
        ) from exc
    except SensitiveFindingNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "SENSITIVE_FINDING_NOT_FOUND", "message": str(exc)},
        ) from exc
    entries = list_protection_rules(db, stream_id)
    entry = next((e for e in entries if e["id"] == rule.id), None)
    if entry is None:
        raise HTTPException(status_code=500, detail="rule created but not readable")
    return ProtectionRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.post(
    "/streams/{stream_id}/protection-rules/direct",
    response_model=ProtectionRuleDirectBulkResponse,
)
async def create_stream_protection_rules_direct(
    stream_id: int,
    body: ProtectionRuleDirectBulkRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> ProtectionRuleDirectBulkResponse:
    from app.audit.service import audit_actor_from_request
    from app.protection.operator_workflow import (
        ProtectionRuleConflictError,
        ProtectionRuleValidationError,
        list_protection_rules,
        upsert_protection_rules_direct_bulk,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    actor = audit_actor_from_request(request)
    payload = [
        {
            "field_path": r.field_path,
            "sensitivity_class": r.sensitivity_class,
            "protection_mode": r.protection_mode,
            "enabled": r.enabled,
        }
        for r in body.rules
    ]
    try:
        _rules, created, updated, skipped = upsert_protection_rules_direct_bulk(
            db,
            stream_id=stream_id,
            rules=payload,
            actor_username=actor.actor_username or "wizard",
        )
        db.commit()
    except ProtectionRuleConflictError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "PROTECTION_RULE_CONFLICT", "message": str(exc)},
        ) from exc
    except ProtectionRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "PROTECTION_RULE_INVALID", "message": str(exc)},
        ) from exc

    entries = list_protection_rules(db, stream_id)
    path_set = {r.field_path for r in body.rules}
    matched = [e for e in entries if e["field_path"] in path_set]
    return ProtectionRuleDirectBulkResponse(
        stream_id=stream_id,
        created=created,
        updated=updated,
        skipped=skipped,
        rules=matched,
    )


@router.patch(
    "/streams/{stream_id}/protection-rules/{rule_id}",
    response_model=ProtectionRuleResponse,
)
async def patch_stream_protection_rule(
    stream_id: int,
    rule_id: int,
    body: ProtectionRulePatchRequest,
    db: Session = Depends(get_db),
) -> ProtectionRuleResponse:
    from app.protection.operator_workflow import (
        ProtectionRuleNotFoundError,
        ProtectionRuleValidationError,
        list_protection_rules,
        patch_protection_rule,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    try:
        patch_protection_rule(
            db,
            stream_id=stream_id,
            rule_id=rule_id,
            protection_mode=body.protection_mode,
            enabled=body.enabled,
            sensitivity_class=body.sensitivity_class,
        )
        db.commit()
    except ProtectionRuleNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "PROTECTION_RULE_NOT_FOUND", "message": str(exc)},
        ) from exc
    except ProtectionRuleValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"error_code": "PROTECTION_RULE_INVALID", "message": str(exc)},
        ) from exc
    entries = list_protection_rules(db, stream_id)
    entry = next((e for e in entries if e["id"] == rule_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return ProtectionRuleResponse(rule=entry)  # type: ignore[arg-type]


@router.post(
    "/streams/{stream_id}/sensitive-findings/{finding_id}/resolve",
    response_model=SensitiveFindingResolveResponse,
)
async def resolve_stream_sensitive_finding(
    stream_id: int,
    finding_id: int,
    body: SensitiveFindingResolveRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> SensitiveFindingResolveResponse:
    from app.audit.service import audit_actor_from_request
    from app.protection.operator_workflow import (
        ProtectionRuleValidationError,
        SensitiveFindingNotFoundError,
        SensitiveFindingStateError,
        resolve_sensitive_finding,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    actor = audit_actor_from_request(request)
    try:
        finding = resolve_sensitive_finding(
            db,
            stream_id=stream_id,
            finding_id=finding_id,
            resolution=body.resolution,
            actor_username=actor.actor_username or "system",
            note=body.note,
        )
        db.commit()
    except SensitiveFindingNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "SENSITIVE_FINDING_NOT_FOUND", "message": str(exc)},
        ) from exc
    except (SensitiveFindingStateError, ProtectionRuleValidationError) as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "SENSITIVE_FINDING_STATE", "message": str(exc)},
        ) from exc
    fj = finding.finding_json if isinstance(finding.finding_json, dict) else None
    return SensitiveFindingResolveResponse(
        id=finding.id,
        stream_id=finding.stream_id,
        field_path=finding.field_path,
        sensitivity_class=finding.sensitivity_class,
        detection_method=finding.detection_method,
        status=finding.status,
        resolution=finding.resolution,
        resolved_at=finding.resolved_at,
        resolved_by=finding.resolved_by,
        operator_note=finding.operator_note,
        finding=fj,
    )


@router.post(
    "/streams/{stream_id}/schema-baseline/reset",
    response_model=SchemaBaselineResetResponse,
)
async def reset_stream_schema_baseline(
    stream_id: int,
    body: SchemaBaselineResetRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> SchemaBaselineResetResponse:
    """Re-establish baseline from current observed paths; resolve open findings."""

    from app.audit.service import audit_actor_from_request
    from app.schema_observation.operator_workflow import (
        DriftFindingStateError,
        ObservedSchemaNotFoundError,
        build_baseline_reset_response,
        reset_schema_baseline,
    )
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    actor = audit_actor_from_request(request)
    try:
        row, resolved_count = reset_schema_baseline(
            db,
            stream_id=stream_id,
            actor_username=actor.actor_username or "system",
            reason=body.reason,
        )
        db.commit()
    except ObservedSchemaNotFoundError as exc:
        db.rollback()
        raise HTTPException(
            status_code=404,
            detail={"error_code": "OBSERVED_SCHEMA_NOT_FOUND", "message": "observed schema not found"},
        ) from exc
    except DriftFindingStateError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={"error_code": "BASELINE_RESET_FAILED", "message": str(exc)},
        ) from exc
    payload = build_baseline_reset_response(
        stream_id,
        row,
        resolved_open_finding_count=resolved_count,
    )
    return SchemaBaselineResetResponse.model_validate(payload)


@router.get("/streams/stats-health/bulk", response_model=BulkStreamStatsHealthResponse)
async def get_bulk_stream_runtime_stats_health(
    ids: str | None = Query(None, description="Comma-separated stream ids"),
    stream_ids: str | None = Query(None, description="Legacy alias for ids"),
    limit: int = Query(100, ge=1, le=1000),
    window: str = Query(
        "1h",
        description="Rolling window for summary counters (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp shared across observability pages.",
    ),
) -> BulkStreamStatsHealthResponse:
    """Bulk stats + health for many streams (one bounded aggregate read; no per-stream loops)."""

    try:
        parsed_stream_ids = resolve_bulk_stream_ids_param(ids=ids, stream_ids=stream_ids)
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await stats_health_bulk_cache.get_bulk(parsed_stream_ids, limit, w, snapshot_id=snapshot_id)


@router.get("/streams/{stream_id}/stats-health", response_model=StreamRuntimeStatsHealthBundleResponse)
async def get_stream_runtime_stats_health_bundle(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
    limit: int = Query(100, ge=1, le=1000),
    window: str | None = Query(
        None,
        description="Optional rolling window for summary counters (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp shared across observability pages.",
    ),
) -> StreamRuntimeStatsHealthBundleResponse:
    """Stats + health with one delivery_logs scan (reduces duplicate work vs separate GETs)."""

    try:
        w = normalize_metrics_window_token(window) if window is not None else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return read_service.get_stream_runtime_stats_and_health(db, stream_id, limit, window=w, snapshot_id=snapshot_id)
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc
    except Exception:
        logger.exception("stream_runtime_stats_health_degraded stream_id=%s", stream_id)
        db.rollback()
        try:
            return read_service.get_degraded_stream_runtime_stats_and_health(db, stream_id, limit)
        except read_service.StreamNotFoundError as exc:
            raise HTTPException(
                status_code=404,
                detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
            ) from exc


@router.get("/dashboard/summary", response_model=DashboardSummaryResponse)
async def get_runtime_dashboard_summary(
    limit: int = Query(100, ge=1, le=1000),
    window: str = Query(
        "1h",
        description="Recent delivery_logs window (15m, 1h, 6h, 24h, 7d, 30d).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 dashboard aggregate snapshot timestamp to reuse across widgets.",
    ),
) -> DashboardSummaryResponse:
    """Cross-stream dashboard summary (read-only).

    Operational path: ``runtime_*_snapshot`` when populated. Legacy fallback scans
    ``delivery_logs`` — not for Runtime Overview initial render.
    """

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return await dashboard_read_cache.get_summary(limit, w, snapshot_id=snapshot_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OperationalError:
        logger.warning("runtime_dashboard_summary_router_degraded window=%s", w)
        from app.runtime.read_service import _degraded_runtime_dashboard_summary

        return _degraded_runtime_dashboard_summary(window=w)


@router.get("/validation/operational-summary", response_model=ValidationOperationalSummaryResponse)
async def get_runtime_validation_operational_summary(
    db: Session = Depends(get_db_read_bounded),
    scoring_mode: str = Query(
        "current_runtime",
        description="current_runtime = live posture incidents; historical_analytics = full OPEN-alert history.",
    ),
    window: str = Query(
        "1h",
        description="Rolling window for live delivery incidents (15m, 1h, 6h, 24h).",
    ),
) -> ValidationOperationalSummaryResponse:
    """Continuous validation alert posture and recovery timeline (read-only)."""

    return read_service.get_validation_operational_summary(db, scoring_mode=scoring_mode, window=window)


@router.get("/dashboard/outcome-timeseries", response_model=DashboardOutcomeTimeseriesResponse)
async def get_dashboard_outcome_timeseries(
    window: str = Query(
        "1h",
        description="Rolling delivery_logs window for stacked outcome buckets (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 dashboard aggregate snapshot timestamp to reuse across widgets.",
    ),
) -> DashboardOutcomeTimeseriesResponse:
    """Cross-stream outcome buckets for dashboard charts (read-only).

    Short windows may use snapshot operational buckets; longer windows use legacy
    ``delivery_logs`` aggregation (lazy-loaded on the Operations dashboard).
    """

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return await dashboard_read_cache.get_outcome_timeseries(w, snapshot_id=snapshot_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/operational-snapshot", response_model=OperationalSnapshotResponse)
async def get_runtime_operational_snapshot(
    db: Session = Depends(get_db_read_bounded),
) -> OperationalSnapshotResponse:
    """Operational snapshot for Routes/Runtime/Streams UI (physical read model when populated)."""

    return build_operational_snapshot(db)


@router.get("/observability/summary", response_model=ObservabilitySummaryResponse)
async def get_runtime_observability_summary(
    db: Session = Depends(get_db_read_bounded),
    window: str = Query(
        "24h",
        description="Canonical rolling metrics window (15m, 1h, 6h, 24h).",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp shared across observability pages.",
    ),
) -> ObservabilitySummaryResponse:
    """Canonical observability totals shared by dashboard/runtime/routes/analytics/logs."""

    try:
        return observability_summary.get_observability_summary(db, window=window, snapshot_id=snapshot_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/failures/trend", response_model=RuntimeFailureTrendResponse)
async def get_runtime_failure_trend(
    db: Session = Depends(get_db_read_bounded),
    limit: int = Query(1000, ge=1, le=10000),
    stream_id: int | None = Query(None),
    route_id: int | None = Query(None),
    destination_id: int | None = Query(None),
    window: str = Query(
        "1h",
        description="Restrict aggregation to rows newer than window end minus this duration.",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp to reuse across runtime widgets.",
    ),
) -> RuntimeFailureTrendResponse:
    """Aggregated failure / rate-limit counts from delivery_logs (read-only; no payload_sample)."""

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return read_service.get_runtime_failure_trend(
        db,
        limit=limit,
        stream_id=stream_id,
        route_id=route_id,
        destination_id=destination_id,
        window=w,
        snapshot_id=snapshot_id,
    )


@router.get("/logs/search", response_model=RuntimeLogSearchResponse)
async def search_runtime_delivery_logs(
    db: Session = Depends(get_db_read_bounded),
    stream_id: int | None = Query(None),
    route_id: int | None = Query(None),
    destination_id: int | None = Query(None),
    run_id: str | None = Query(None, description="Correlation id for one StreamRunner execution."),
    stage: str | None = Query(None),
    level: str | None = Query(None),
    status: str | None = Query(None),
    error_code: str | None = Query(None),
    partial_success: bool | None = Query(
        None,
        description="When set, restricts to run_complete rows with matching payload_sample.partial_success.",
    ),
    limit: int = Query(100, ge=1, le=1000),
    window: str = Query(
        "1h",
        description="Only include rows with created_at within this rolling window.",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp to reuse across runtime widgets.",
    ),
) -> RuntimeLogSearchResponse:
    """Search delivery_logs with optional filters (read-only; no payload_sample)."""

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return read_service.search_runtime_logs(
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
        limit=limit,
        window=w,
        snapshot_id=snapshot_id,
    )


@router.get("/logs/alerts/summary", response_model=RuntimeAlertSummaryResponse)
async def get_runtime_alert_summary(
    db: Session = Depends(get_db_read_bounded),
    window: str = Query(
        "1h",
        description="Rolling window for WARN/ERROR aggregation (15m, 1h, 6h, 24h).",
    ),
    limit: int = Query(100, ge=1, le=500),
) -> RuntimeAlertSummaryResponse:
    """Grouped WARN/ERROR summaries with stream and connector names."""

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return read_service.get_runtime_alert_summary(db, window=w, limit=limit)


@router.get("/system/resources", response_model=RuntimeSystemResourcesResponse)
async def get_runtime_system_resources() -> RuntimeSystemResourcesResponse:
    """Lightweight local CPU/memory/disk/network snapshot for the API host process."""

    return collect_runtime_system_resources()


@router.get("/logs/page", response_model=RuntimeLogsPageResponse)
async def get_runtime_logs_page(
    db: Session = Depends(get_db_read_bounded),
    limit: int = Query(100, ge=1, le=500),
    cursor_created_at: datetime | None = Query(None),
    cursor_id: int | None = Query(None),
    stream_id: int | None = Query(None),
    route_id: int | None = Query(None),
    destination_id: int | None = Query(None),
    run_id: str | None = Query(None, description="Correlation id for one StreamRunner execution."),
    stage: str | None = Query(None),
    level: str | None = Query(None),
    status: str | None = Query(None),
    error_code: str | None = Query(None),
    partial_success: bool | None = Query(
        None,
        description="When set, restricts to run_complete rows with matching payload_sample.partial_success.",
    ),
    window: str | None = Query(
        None,
        description="Optional rolling window (15m, 1h, 6h, 24h) — filters rows by created_at.",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp to reuse across runtime widgets.",
    ),
) -> RuntimeLogsPageResponse:
    """Cursor-paged delivery_logs (read-only; no payload_sample)."""

    if (cursor_created_at is None) ^ (cursor_id is None):
        raise HTTPException(
            status_code=422,
            detail={
                "error_code": "INVALID_CURSOR",
                "message": "cursor_created_at and cursor_id must both be set or both omitted",
            },
        )

    w_token: str | None = None
    if window is not None and str(window).strip() != "":
        try:
            w_token = normalize_metrics_window_token(window)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return read_service.get_runtime_logs_page(
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
        cursor_created_at=cursor_created_at,
        cursor_id=cursor_id,
        window=w_token,
        snapshot_id=snapshot_id,
    )


@router.get("/logs/totals", response_model=RuntimeLogsTotalsResponse)
async def get_runtime_logs_totals(
    db: Session = Depends(get_db_read_bounded),
    stream_id: int | None = Query(None),
    route_id: int | None = Query(None),
    destination_id: int | None = Query(None),
    run_id: str | None = Query(None, description="Correlation id for one StreamRunner execution."),
    stage: str | None = Query(None),
    level: str | None = Query(None),
    status: str | None = Query(None),
    error_code: str | None = Query(None),
    partial_success: bool | None = Query(
        None,
        description="When set, restricts to run_complete rows with matching payload_sample.partial_success.",
    ),
    window: str = Query(
        "1h",
        description="Only include rows with created_at within this rolling window.",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp to reuse across runtime widgets.",
    ),
) -> RuntimeLogsTotalsResponse:
    """Full-window delivery_logs totals independent of cursor-paged rows."""

    try:
        w = normalize_metrics_window_token(window)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return read_service.get_runtime_logs_totals(
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
        window=w,
        snapshot_id=snapshot_id,
    )


@router.get("/checkpoints/trace", response_model=CheckpointTraceResponse)
async def get_checkpoint_trace(
    db: Session = Depends(get_db_read_bounded),
    run_id: str = Query(..., min_length=8, description="StreamRunner execution correlation id."),
    stream_id: int | None = Query(None, description="Optional stream scope when run_id is ambiguous."),
) -> CheckpointTraceResponse:
    """Operational checkpoint trace for one run (read-only)."""

    try:
        return read_service.get_checkpoint_trace_for_run(db, run_id.strip(), stream_id=stream_id)
    except read_service.RunTraceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "CHECKPOINT_TRACE_NOT_FOUND", "message": f"no logs for run_id: {exc.run_id}"},
        ) from exc


@router.get("/checkpoints/streams/{stream_id}/history", response_model=CheckpointHistoryResponse)
async def get_stream_checkpoint_history(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
    limit: int = Query(50, ge=1, le=200),
) -> CheckpointHistoryResponse:
    """Recent checkpoint_update rows for a stream (read-only)."""

    try:
        return read_service.get_stream_checkpoint_history(db, stream_id, limit=limit)
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.get("/runs/{run_id}/checkpoint", response_model=CheckpointTraceResponse)
async def get_run_checkpoint_summary(run_id: str, db: Session = Depends(get_db_read_bounded)) -> CheckpointTraceResponse:
    """Checkpoint-focused summary for one run_id (same payload as /checkpoints/trace)."""

    rid = run_id.strip()
    try:
        return read_service.get_checkpoint_trace_for_run(db, rid, stream_id=None)
    except read_service.RunTraceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "RUN_CHECKPOINT_NOT_FOUND", "message": f"no logs for run_id: {exc.run_id}"},
        ) from exc


@router.get("/logs/{log_id}/trace", response_model=RuntimeTraceResponse)
async def get_delivery_log_trace(log_id: int, db: Session = Depends(get_db_read_bounded)) -> RuntimeTraceResponse:
    """Timeline for one delivery_logs row; expands to full run when run_id is present."""

    try:
        return read_service.get_runtime_trace_for_delivery_log(db, log_id)
    except read_service.DeliveryLogNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "DELIVERY_LOG_NOT_FOUND", "message": f"log not found: {exc.log_id}"},
        ) from exc


@router.get("/runs/{run_id}/trace", response_model=RuntimeTraceResponse)
async def get_run_trace(run_id: str, db: Session = Depends(get_db_read_bounded)) -> RuntimeTraceResponse:
    """Timeline for all delivery_logs rows sharing run_id (one stream execution)."""

    try:
        return read_service.get_runtime_trace_for_run(db, run_id)
    except read_service.RunTraceNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "RUN_TRACE_NOT_FOUND", "message": f"no logs for run_id: {exc.run_id}"},
        ) from exc


@router.get("/replay/summary", response_model=PlatformReplaySummaryResponse)
async def get_platform_replay_summary(
    db: Session = Depends(get_db_read_bounded),
) -> PlatformReplaySummaryResponse:
    from app.replay.service import build_platform_replay_summary

    return PlatformReplaySummaryResponse.model_validate(build_platform_replay_summary(db))


@router.get("/streams/{stream_id}/replay/summary", response_model=StreamReplaySummaryResponse)
async def get_stream_replay_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamReplaySummaryResponse:
    from app.replay.service import build_stream_replay_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    return StreamReplaySummaryResponse.model_validate(build_stream_replay_summary(db, stream_id))


@router.get("/streams/{stream_id}/replay-events", response_model=StreamReplayEventsResponse)
async def list_stream_replay_events(
    stream_id: int,
    status: str | None = Query(None, description="Filter by pending, replayed, failed, or discarded."),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db_read_bounded),
) -> StreamReplayEventsResponse:
    from app.replay.service import list_stream_replay_events
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    events = list_stream_replay_events(db, stream_id, status=status, limit=limit)
    items = [ReplayEventItem.model_validate(e) for e in events]
    return StreamReplayEventsResponse(stream_id=stream_id, events=items, event_count=len(items))


@router.post("/replay-events/{event_id}/replay", response_model=ReplayEventActionResponse)
async def replay_stream_replay_event(
    event_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> ReplayEventActionResponse:
    from app.replay import service as replay_engine_service

    try:
        result = replay_engine_service.execute_replay_event(db, event_id)
    except replay_engine_service.ReplayEventNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "REPLAY_EVENT_NOT_FOUND", "message": str(exc)},
        ) from exc
    except replay_engine_service.ReplayEventStateError as exc:
        status_code = 409 if exc.error_code in {"REPLAY_DISCARDED", "REPLAY_ALREADY_REPLAYED"} else 422
        raise HTTPException(
            status_code=status_code,
            detail={"error_code": exc.error_code, "message": exc.message},
        ) from exc
    except replay_engine_service.ReplayInProgressError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "REPLAY_IN_PROGRESS",
                "message": str(exc),
                "replay_event_id": exc.event_id,
            },
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "REPLAY_FAILED", "message": str(exc)},
        ) from exc

    journal.record_audit_event(
        db,
        action="REPLAY_EVENT_EXECUTE",
        entity_type="STREAM_REPLAY_EVENT",
        entity_id=int(event_id),
        details={
            "outcome": result.get("outcome"),
            "stream_id": result.get("stream_id"),
            "destination_id": result.get("destination_id"),
            "status": result.get("status"),
            "retry_count": result.get("retry_count"),
        },
        request=request,
    )
    db.commit()
    return ReplayEventActionResponse.model_validate(result)


@router.post("/replay-events/{event_id}/discard", response_model=ReplayEventActionResponse)
async def discard_stream_replay_event(
    event_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> ReplayEventActionResponse:
    from app.replay import service as replay_engine_service

    try:
        result = replay_engine_service.discard_replay_event(db, event_id)
    except replay_engine_service.ReplayEventNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "REPLAY_EVENT_NOT_FOUND", "message": str(exc)},
        ) from exc
    except replay_engine_service.ReplayEventStateError as exc:
        raise HTTPException(
            status_code=409,
            detail={"error_code": exc.error_code, "message": exc.message},
        ) from exc
    except replay_engine_service.ReplayInProgressError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "REPLAY_IN_PROGRESS",
                "message": str(exc),
                "replay_event_id": exc.event_id,
            },
        ) from exc

    journal.record_audit_event(
        db,
        action="REPLAY_EVENT_DISCARD",
        entity_type="STREAM_REPLAY_EVENT",
        entity_id=int(event_id),
        details={"stream_id": result.get("stream_id"), "status": result.get("status")},
        request=request,
    )
    db.commit()
    return ReplayEventActionResponse.model_validate(
        {**result, "outcome": "discarded", "message": "Replay event discarded."}
    )


@router.get("/quarantine/summary", response_model=PlatformQuarantineSummaryResponse)
async def get_platform_quarantine_summary(
    db: Session = Depends(get_db_read_bounded),
) -> PlatformQuarantineSummaryResponse:
    from app.quarantine.service import build_platform_quarantine_summary

    return PlatformQuarantineSummaryResponse.model_validate(build_platform_quarantine_summary(db))


@router.get("/streams/{stream_id}/quarantine/summary", response_model=StreamQuarantineSummaryResponse)
async def get_stream_quarantine_summary(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
) -> StreamQuarantineSummaryResponse:
    from app.quarantine.service import build_stream_quarantine_summary
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    return StreamQuarantineSummaryResponse.model_validate(build_stream_quarantine_summary(db, stream_id))


@router.get("/streams/{stream_id}/quarantine-events", response_model=StreamQuarantineEventsResponse)
async def list_stream_quarantine_events(
    stream_id: int,
    status: str | None = Query(None, description="Filter by quarantined, released, or discarded."),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db_read_bounded),
) -> StreamQuarantineEventsResponse:
    from app.quarantine.service import list_stream_quarantine_events
    from app.streams.repository import get_stream_by_id

    if get_stream_by_id(db, stream_id) is None:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {stream_id}"},
        )
    events = list_stream_quarantine_events(db, stream_id, status=status, limit=limit)
    items = [QuarantineEventItem.model_validate(e) for e in events]
    return StreamQuarantineEventsResponse(stream_id=stream_id, events=items, event_count=len(items))


@router.post("/quarantine-events/{event_id}/release", response_model=QuarantineEventActionResponse)
async def release_stream_quarantine_event(
    event_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> QuarantineEventActionResponse:
    from app.audit.service import audit_actor_from_request
    from app.quarantine import service as quarantine_service

    actor = audit_actor_from_request(request)
    released_by = actor.actor_username or "system"
    try:
        result = quarantine_service.execute_quarantine_release(
            db,
            event_id,
            released_by=released_by,
        )
    except quarantine_service.QuarantineEventNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "QUARANTINE_EVENT_NOT_FOUND", "message": str(exc)},
        ) from exc
    except quarantine_service.QuarantineEventStateError as exc:
        status_code = 409 if exc.error_code in {"QUARANTINE_DISCARDED", "QUARANTINE_ALREADY_RELEASED"} else 422
        raise HTTPException(
            status_code=status_code,
            detail={"error_code": exc.error_code, "message": exc.message},
        ) from exc
    except quarantine_service.QuarantineInProgressError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "QUARANTINE_IN_PROGRESS",
                "message": str(exc),
                "quarantine_event_id": exc.event_id,
            },
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "QUARANTINE_RELEASE_FAILED", "message": str(exc)},
        ) from exc

    journal.record_audit_event(
        db,
        action="QUARANTINE_EVENT_RELEASE",
        entity_type="STREAM_QUARANTINE_EVENT",
        entity_id=int(event_id),
        details={
            "outcome": result.get("outcome"),
            "stream_id": result.get("stream_id"),
            "status": result.get("status"),
            "checkpoint_updated": result.get("checkpoint_updated"),
        },
        request=request,
    )
    db.commit()
    return QuarantineEventActionResponse.model_validate(result)


@router.post("/quarantine-events/{event_id}/discard", response_model=QuarantineEventActionResponse)
async def discard_stream_quarantine_event(
    event_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> QuarantineEventActionResponse:
    from app.quarantine import service as quarantine_service

    try:
        result = quarantine_service.discard_quarantine_event(db, event_id)
    except quarantine_service.QuarantineEventNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "QUARANTINE_EVENT_NOT_FOUND", "message": str(exc)},
        ) from exc
    except quarantine_service.QuarantineEventStateError as exc:
        raise HTTPException(
            status_code=409,
            detail={"error_code": exc.error_code, "message": exc.message},
        ) from exc
    except quarantine_service.QuarantineInProgressError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "QUARANTINE_IN_PROGRESS",
                "message": str(exc),
                "quarantine_event_id": exc.event_id,
            },
        ) from exc

    journal.record_audit_event(
        db,
        action="QUARANTINE_EVENT_DISCARD",
        entity_type="STREAM_QUARANTINE_EVENT",
        entity_id=int(event_id),
        details={"stream_id": result.get("stream_id"), "status": result.get("status")},
        request=request,
    )
    db.commit()
    return QuarantineEventActionResponse.model_validate(
        {**result, "outcome": "discarded", "message": "Quarantine event discarded."}
    )


@router.post("/replay/delivery-log/{log_id}", response_model=DeliveryLogReplayResponse)
async def replay_failed_delivery_log(
    log_id: int,
    request: Request,
    payload: DeliveryLogReplayRequest | None = None,
    db: Session = Depends(get_db),
) -> DeliveryLogReplayResponse:
    """Replay a failed route delivery from delivery_logs evidence; never updates checkpoints."""

    dry_run = bool(payload.dry_run) if payload is not None else False
    try:
        result = replay_service.replay_delivery_log(db, log_id, dry_run=dry_run)
    except replay_service.DeliveryLogNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "DELIVERY_LOG_NOT_FOUND", "message": f"log not found: {exc.log_id}"},
        ) from exc
    except replay_service.ReplayNotEligibleError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error_code": exc.error_code, "message": exc.message},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "REPLAY_FAILED", "message": str(exc)},
        ) from exc

    journal.record_audit_event(
        db,
        action="REPLAY_DRY_RUN" if result.dry_run else "REPLAY_EXECUTE",
        entity_type="DELIVERY_LOG",
        entity_id=int(log_id),
        details={
            "outcome": result.outcome,
            "stream_id": result.stream_id,
            "route_id": result.route_id,
            "destination_id": result.destination_id,
            "event_count": result.event_count,
            "replay_run_id": result.replay_run_id,
        },
        request=request,
    )
    db.commit()
    return DeliveryLogReplayResponse(
        log_id=result.log_id,
        dry_run=result.dry_run,
        outcome=result.outcome,  # type: ignore[arg-type]
        message=result.message,
        event_count=result.event_count,
        route_id=result.route_id,
        destination_id=result.destination_id,
        stream_id=result.stream_id,
        replay_run_id=result.replay_run_id,
        preview_message_count=result.preview_message_count,
        preview_messages=result.preview_messages,
        error_type=result.error_type,
    )


@router.post("/logs/cleanup", response_model=RuntimeLogsCleanupResponse)
async def cleanup_runtime_logs(
    payload: RuntimeLogsCleanupRequest,
    db: Session = Depends(get_db),
) -> RuntimeLogsCleanupResponse:
    """Remove old delivery_logs by age, or dry-run count only (single commit when not dry_run)."""

    return control_service.cleanup_delivery_logs(
        db,
        older_than_days=payload.older_than_days,
        dry_run=payload.dry_run,
    )


@router.get("/timeline/stream/{stream_id}", response_model=RuntimeTimelineResponse)
async def get_stream_runtime_timeline(
    stream_id: int,
    db: Session = Depends(get_db_read_bounded),
    limit: int = Query(100, ge=1, le=500),
    stage: str | None = Query(None),
    level: str | None = Query(None),
    status: str | None = Query(None),
    route_id: int | None = Query(None),
    destination_id: int | None = Query(None),
) -> RuntimeTimelineResponse:
    """delivery_logs timeline for one stream: chronological order (read-only; no payload_sample)."""

    try:
        return read_service.get_stream_runtime_timeline(
            db,
            stream_id,
            limit=limit,
            stage=stage,
            level=level,
            status=status,
            route_id=route_id,
            destination_id=destination_id,
        )
    except read_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.post("/streams/{stream_id}/start", response_model=RuntimeStreamControlResponse)
async def start_runtime_stream(
    stream_id: int, request: Request, db: Session = Depends(get_db)
) -> RuntimeStreamControlResponse:
    """Enable stream and set status to RUNNING (single commit; does not invoke StreamRunner)."""

    try:
        return control_service.start_stream(db, stream_id, request=request)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.post("/streams/{stream_id}/stop", response_model=RuntimeStreamControlResponse)
async def stop_runtime_stream(
    stream_id: int, request: Request, response: Response, db: Session = Depends(get_db)
) -> RuntimeStreamControlResponse:
    """Request stop and return 200 only after local worker and lock termination."""

    try:
        result = control_service.stop_stream(db, stream_id, request=request)
        response.status_code = 200 if result.terminal and result.status == "STOPPED" else 202
        return result
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc
    except control_service.StreamStopFailedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"error_code": "STREAM_STOP_FAILED", "message": exc.message},
        ) from exc


@router.post("/streams/{stream_id}/pipeline-debug", response_model=PipelineDebugResponse)
async def stream_pipeline_debug(
    stream_id: int,
    payload: PipelineDebugRequest,
    db: Session = Depends(get_db),
) -> PipelineDebugResponse:
    """Inspect one sample event through mapping, enrichment, formatting, and route delivery preview."""

    try:
        return pipeline_debug_service.run_stream_pipeline_debug(db, stream_id, payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/streams/{stream_id}/run-once", response_model=RuntimeStreamRunOnceResponse)
async def run_stream_once(
    stream_id: int, request: Request, db: Session = Depends(get_db)
) -> RuntimeStreamRunOnceResponse:
    """Execute one StreamRunner cycle with DB-backed delivery_logs + checkpoint (manual / verification).

    HTTP 2xx is returned only when Runtime actually entered and produced a committed
    lifecycle outcome (``completed`` / ``no_events``). Lock contention and dispatch
    failures return explicit non-2xx error codes — never a silent no-op 2xx.
    """

    from app.runners.stream_loader import load_stream_context
    from app.runners.stream_runner import StreamRunner

    try:
        context = load_stream_context(db, stream_id, require_enabled_stream=False)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "STREAM_RUN_UNAVAILABLE",
                "message": str(exc),
                "stream_id": stream_id,
            },
        ) from exc

    runner = StreamRunner()
    try:
        summary = runner.run(context, db=db)
    except SourceFetchError as exc:
        detail: dict = {
            "error_code": "SOURCE_FETCH_FAILED",
            "message": str(exc),
            "stream_id": stream_id,
            "runtime_run_id": getattr(runner, "_last_run_id", None),
        }
        if getattr(exc, "detail", None):
            detail.update(exc.detail)
        raise HTTPException(status_code=502, detail=detail) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": "RUNTIME_INTERNAL_ERROR",
                "message": str(exc),
                "stream_id": stream_id,
                "runtime_run_id": getattr(runner, "_last_run_id", None),
            },
        ) from exc

    oc_raw = str(summary.get("outcome") or "completed")
    runtime_run_id = summary.get("run_id")

    # Lock not acquired: Runtime did not start — never return 2xx.
    if oc_raw == "skipped_lock":
        journal.record_audit_event(
            db,
            action="STREAM_RUN_NOW",
            entity_type="STREAM",
            entity_id=stream_id,
            details={
                "outcome": "skipped_lock",
                "error_code": summary.get("error_code") or "RUN_ALREADY_ACTIVE",
                "message": summary.get("message") or "stream already running",
            },
            request=request,
        )
        db.commit()
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": summary.get("error_code") or "RUN_ALREADY_ACTIVE",
                "message": summary.get("message") or "stream already running",
                "stream_id": stream_id,
                "runtime_run_id": runtime_run_id,
            },
        )

    # Guard against any future silent success path without lifecycle commit.
    if oc_raw not in ("completed", "no_events", "dry_run") or not bool(
        summary.get("transaction_committed")
    ):
        journal.record_audit_event(
            db,
            action="STREAM_RUN_NOW",
            entity_type="STREAM",
            entity_id=stream_id,
            details={
                "outcome": oc_raw,
                "error_code": summary.get("error_code") or "RUN_NOT_STARTED",
                "transaction_committed": bool(summary.get("transaction_committed")),
                "runtime_run_id": runtime_run_id,
            },
            request=request,
        )
        db.commit()
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": summary.get("error_code") or "RUN_NOT_STARTED",
                "message": summary.get("message")
                or f"runtime did not produce a committed lifecycle outcome (outcome={oc_raw})",
                "stream_id": stream_id,
                "runtime_run_id": runtime_run_id,
            },
        )

    oc: str = "no_events" if oc_raw == "no_events" else "completed"

    journal.record_audit_event(
        db,
        action="STREAM_RUN_NOW",
        entity_type="STREAM",
        entity_id=stream_id,
        details={
            "outcome": oc,
            "checkpoint_updated": bool(summary.get("checkpoint_updated")),
            "delivered_batch_event_count": summary.get("delivered_batch_event_count"),
            "runtime_run_id": runtime_run_id,
        },
        request=request,
    )
    db.commit()

    return RuntimeStreamRunOnceResponse(
        stream_id=int(summary.get("stream_id", stream_id)),
        outcome=oc,  # type: ignore[arg-type]
        message=str(summary["message"]) if summary.get("message") else None,
        extracted_event_count=summary.get("extracted_event_count"),
        mapped_event_count=summary.get("mapped_event_count"),
        enriched_event_count=summary.get("enriched_event_count"),
        delivered_batch_event_count=summary.get("delivered_batch_event_count"),
        checkpoint_updated=bool(summary.get("checkpoint_updated")),
        transaction_committed=bool(summary.get("transaction_committed")),
        runtime_run_id=str(runtime_run_id) if runtime_run_id else None,
    )


@router.post("/mappings/stream/{stream_id}/save", response_model=RuntimeMappingSaveResponse)
async def save_runtime_stream_mapping(
    stream_id: int,
    payload: RuntimeMappingSaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeMappingSaveResponse:
    """Persist Mapping draft (event_array_path + field_mappings_json) for a stream; single DB commit."""

    try:
        return control_service.save_runtime_stream_mapping(db, stream_id, payload)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc
    except Exception as exc:
        _raise_mapping_save_http_error(exc)


@router.post("/enrichments/stream/{stream_id}/save", response_model=RuntimeEnrichmentSaveResponse)
async def save_runtime_stream_enrichment(
    stream_id: int,
    payload: RuntimeEnrichmentSaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeEnrichmentSaveResponse:
    """Persist Enrichment draft (enrichment_json + override_policy + enabled) for a stream; single DB commit."""

    try:
        return control_service.save_runtime_stream_enrichment(db, stream_id, payload)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.post("/routes/{route_id}/formatter/save", response_model=RuntimeRouteFormatterSaveResponse)
async def save_runtime_route_formatter_config(
    route_id: int,
    payload: RuntimeRouteFormatterSaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeRouteFormatterSaveResponse:
    """Persist Route-level formatter override config; single DB commit."""

    try:
        return control_service.save_runtime_route_formatter_config(db, route_id, payload)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.post("/routes/{route_id}/failure-policy/save", response_model=RuntimeRouteFailurePolicySaveResponse)
async def save_runtime_route_failure_policy(
    route_id: int,
    payload: RuntimeRouteFailurePolicySaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeRouteFailurePolicySaveResponse:
    """Persist Route-level failure policy config; single DB commit."""

    try:
        return control_service.save_runtime_route_failure_policy(db, route_id, payload)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.post("/routes/{route_id}/enabled/save", response_model=RuntimeRouteEnabledSaveResponse)
async def save_runtime_route_enabled_state(
    route_id: int,
    payload: RuntimeRouteEnabledSaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeRouteEnabledSaveResponse:
    """Persist Route.enabled toggle only; single DB commit."""

    try:
        return control_service.save_runtime_route_enabled_state(db, route_id, payload)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.post("/routes/{route_id}/rate-limit/save", response_model=RuntimeRouteRateLimitSaveResponse)
async def save_runtime_route_rate_limit(
    route_id: int,
    payload: RuntimeRouteRateLimitSaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeRouteRateLimitSaveResponse:
    """Persist Route-level destination send rate-limit config; single DB commit."""

    try:
        return control_service.save_runtime_route_rate_limit(db, route_id, payload)
    except control_service.RouteNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "ROUTE_NOT_FOUND", "message": f"route not found: {exc.route_id}"},
        ) from exc


@router.post("/streams/{stream_id}/rate-limit/save", response_model=RuntimeStreamRateLimitSaveResponse)
async def save_runtime_stream_rate_limit(
    stream_id: int,
    payload: RuntimeStreamRateLimitSaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeStreamRateLimitSaveResponse:
    """Persist Stream-level source/API rate-limit config; single DB commit."""

    try:
        return control_service.save_runtime_stream_rate_limit(db, stream_id, payload)
    except control_service.StreamNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "STREAM_NOT_FOUND", "message": f"stream not found: {exc.stream_id}"},
        ) from exc


@router.post("/destinations/{destination_id}/rate-limit/save", response_model=RuntimeDestinationRateLimitSaveResponse)
async def save_runtime_destination_rate_limit(
    destination_id: int,
    payload: RuntimeDestinationRateLimitSaveRequest,
    db: Session = Depends(get_db),
) -> RuntimeDestinationRateLimitSaveResponse:
    """Persist Destination-level send rate-limit config; single DB commit."""

    try:
        return control_service.save_runtime_destination_rate_limit(db, destination_id, payload)
    except control_service.DestinationNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "DESTINATION_NOT_FOUND",
                "message": f"destination not found: {exc.destination_id}",
            },
        ) from exc


@router.post("/api-test/http", response_model=HttpApiTestResponse)
async def api_test_http(payload: HttpApiTestRequest, request: Request, db: Session = Depends(get_db)) -> HttpApiTestResponse:
    """Execute HTTP poll + JSON preview without DB side effects."""

    try:
        return preview_service.run_http_api_test(payload, db, api_origin=str(request.base_url).rstrip("/"))
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/api-test/connector-auth", response_model=ConnectorAuthTestResponse)
async def api_test_connector_auth(
    payload: ConnectorAuthTestRequest,
    db: Session = Depends(get_db),
) -> ConnectorAuthTestResponse:
    """Validate connector authentication only (no stream endpoint)."""

    try:
        return preview_service.run_connector_auth_test(payload, db)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/mapping", response_model=MappingPreviewResponse)
async def preview_mapping(payload: MappingPreviewRequest) -> MappingPreviewResponse:
    """Preview extract -> mapping -> enrichment without runtime side effects."""

    try:
        return preview_service.run_mapping_preview(payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/mapping-draft", response_model=MappingDraftPreviewResponse)
async def preview_mapping_draft(payload: MappingDraftPreviewRequest) -> MappingDraftPreviewResponse:
    """Preview mapping results from selected JSONPath rules without DB writes."""

    try:
        return preview_service.run_mapping_draft_preview(payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/final-event-draft", response_model=FinalEventDraftPreviewResponse)
async def preview_final_event_draft(
    payload: FinalEventDraftPreviewRequest,
) -> FinalEventDraftPreviewResponse:
    """Preview mapping + enrichment final events without DB writes."""

    try:
        with preview_read_bounded_session(payload.stream_id) as db:
            return preview_service.run_final_event_draft_preview(payload, db=db)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/enrichment-exec", response_model=EnrichmentExecPreviewResponse)
async def preview_enrichment_exec(payload: EnrichmentExecPreviewRequest) -> EnrichmentExecPreviewResponse:
    """Execute enrichment rules on a mapped event (same engine as runtime)."""

    try:
        return preview_service.run_enrichment_exec_preview(payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/transform", response_model=TransformPreviewResponse)
async def preview_transform(payload: TransformPreviewRequest) -> TransformPreviewResponse:
    """Preview Advanced Transform rules (JSONata / regex_extract) via Safe Expression Engine."""

    return preview_service.run_transform_preview(payload)


@router.post("/preview/sensitive-detection", response_model=SensitiveDetectionPreviewResponse)
async def preview_sensitive_detection(
    payload: SensitiveDetectionPreviewRequest,
) -> SensitiveDetectionPreviewResponse:
    """Run the existing Sensitive Detection Engine on sample events (suggestion-only)."""

    return preview_service.run_sensitive_detection_preview(payload)


@router.post("/preview/enrichment-validate", response_model=EnrichmentValidateResponse)
async def preview_enrichment_validate(payload: EnrichmentValidateRequest) -> EnrichmentValidateResponse:
    """Validate enrichment configuration without runtime execution."""

    return preview_service.run_enrichment_validate(payload)


@router.post("/preview/delivery-format-draft", response_model=DeliveryFormatDraftPreviewResponse)
async def preview_delivery_format_draft(
    payload: DeliveryFormatDraftPreviewRequest,
) -> DeliveryFormatDraftPreviewResponse:
    """Preview destination-formatted messages from final events without DB writes."""

    try:
        return preview_service.run_delivery_format_draft_preview(payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/e2e-draft", response_model=E2EDraftPreviewResponse)
async def preview_e2e_draft(
    payload: E2EDraftPreviewRequest,
) -> E2EDraftPreviewResponse:
    """Preview mapping -> enrichment -> delivery format in one read-only call."""

    try:
        with preview_read_bounded_session(payload.stream_id) as db:
            return preview_service.run_e2e_draft_preview(payload, db=db)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/json-paths", response_model=MappingJsonPathsResponse)
async def preview_mapping_json_paths(payload: MappingJsonPathsRequest) -> MappingJsonPathsResponse:
    """Enumerate scalar JSONPath candidates from an in-memory payload for Mapping UI (read-only)."""

    return preview_service.extract_mapping_json_paths(payload)


@router.post("/preview/mapping-validate", response_model=MappingValidateResponse)
async def preview_mapping_validate(payload: MappingValidateRequest) -> MappingValidateResponse:
    """Validate mapping rules and optional sample payload without DB writes."""

    return preview_service.run_mapping_validate(payload)


@router.post("/preview/extraction-validate", response_model=ExtractionValidateResponse)
async def preview_extraction_validate(payload: ExtractionValidateRequest) -> ExtractionValidateResponse:
    """Validate custom extraction paths against sample payload without DB writes."""

    return preview_service.run_extraction_validate(payload)


@router.post("/preview/format", response_model=FormatPreviewResponse)
async def preview_format(payload: FormatPreviewRequest) -> FormatPreviewResponse:
    """Preview destination-formatted messages without any runtime side effects."""

    try:
        return preview_service.run_format_preview(payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/format-preview", response_model=DeliveryPrefixFormatPreviewResponse)
async def format_preview_delivery_prefix(
    payload: DeliveryPrefixFormatPreviewRequest,
) -> DeliveryPrefixFormatPreviewResponse:
    """Resolve message prefix variables and show final wire payload (read-only)."""

    try:
        return preview_service.run_delivery_prefix_format_preview(payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/preview/route-delivery", response_model=RouteDeliveryPreviewResponse)
async def preview_route_delivery(
    payload: RouteDeliveryPreviewRequest,
    db: Session = Depends(get_db),
) -> RouteDeliveryPreviewResponse:
    """Preview sender-ready payloads for a DB-backed Route without sending or mutating runtime state."""

    try:
        return preview_service.run_route_delivery_preview(db, payload)
    except PreviewRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.get("/topology", response_model=RuntimeTopologyResponse)
async def runtime_topology(
    db: Session = Depends(get_db_read_bounded),
    window: str | None = Query(
        "24h",
        description="Rolling window for health summary (15m, 1h, 6h, 24h).",
    ),
    scoring_mode: str | None = Query(
        "current_runtime",
        description="current_runtime or historical_analytics health scoring.",
    ),
    snapshot_id: str | None = Query(
        None,
        description="Optional ISO-8601 aggregate snapshot timestamp.",
    ),
) -> RuntimeTopologyResponse:
    """Read-only configured pipeline graph: Source → Stream → Mapping → Enrichment → Route → Destination."""

    return get_runtime_topology(
        db,
        window=window,
        scoring_mode=scoring_mode,
        snapshot_id=snapshot_id,
    )


router.include_router(runtime_analytics_router, prefix="/analytics", tags=["runtime-analytics"])
router.include_router(runtime_health_router, prefix="/health", tags=["runtime-health"])
router.include_router(stream_governance_router, tags=["stream-governance"])
