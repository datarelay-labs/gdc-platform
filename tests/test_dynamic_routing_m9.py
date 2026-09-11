"""M9 dynamic routing — evaluation, API, runtime, preview, observability."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.destinations.models import Destination
from app.mappings.models import Mapping
from app.dynamic_routing.dynamic_routing_engine import evaluate_batch
from app.dynamic_routing.dynamic_routing_metrics import (
    DYNAMIC_ROUTING_COMPLETE_STAGE,
    build_dynamic_routing_complete_payload,
    build_platform_dynamic_routing_summary,
)
from app.dynamic_routing.operator_workflow import (
    DynamicRouteValidationError,
    build_dynamic_routing_summary,
    create_dynamic_route,
    list_dynamic_routes,
    patch_dynamic_route,
)
from app.dynamic_routing.schemas import (
    DynamicRouteCreateRequest,
    DynamicRoutePatchRequest,
    DynamicRouteResponse,
    PlatformDynamicRoutingSummaryResponse,
    StreamDynamicRoutesResponse,
    StreamDynamicRoutingSummaryResponse,
)
from app.dynamic_routing.dynamic_routing_service import evaluate_dynamic_routes_for_preview
from app.logs.models import DeliveryLog
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _add_enabled_route_for_destination,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context


def _dynamic_test_app() -> FastAPI:
    from app.streams.repository import get_stream_by_id

    router = APIRouter()

    @router.get("/dynamic-routing/summary", response_model=PlatformDynamicRoutingSummaryResponse)
    async def get_platform_summary(db: Session = Depends(get_db_read_bounded)) -> PlatformDynamicRoutingSummaryResponse:
        payload = build_platform_dynamic_routing_summary(db)
        return PlatformDynamicRoutingSummaryResponse.model_validate(payload)

    @router.get("/streams/{stream_id}/dynamic-routes", response_model=StreamDynamicRoutesResponse)
    async def get_routes(
        stream_id: int,
        enabled_only: bool = Query(False),
        db: Session = Depends(get_db_read_bounded),
    ) -> StreamDynamicRoutesResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        routes = list_dynamic_routes(db, stream_id, enabled_only=enabled_only)
        return StreamDynamicRoutesResponse(stream_id=stream_id, routes=routes, route_count=len(routes))  # type: ignore[arg-type]

    @router.get("/streams/{stream_id}/dynamic-routing/summary", response_model=StreamDynamicRoutingSummaryResponse)
    async def get_summary(stream_id: int, db: Session = Depends(get_db_read_bounded)) -> StreamDynamicRoutingSummaryResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        return StreamDynamicRoutingSummaryResponse.model_validate(build_dynamic_routing_summary(db, stream_id))

    @router.post("/streams/{stream_id}/dynamic-routes", response_model=DynamicRouteResponse)
    async def post_route(
        stream_id: int,
        body: DynamicRouteCreateRequest,
        db: Session = Depends(get_db),
    ) -> DynamicRouteResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
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
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        entries = list_dynamic_routes(db, stream_id)
        entry = next(e for e in entries if e["id"] == rule.id)
        return DynamicRouteResponse(route=entry)  # type: ignore[arg-type]

    @router.patch("/streams/{stream_id}/dynamic-routes/{route_id}", response_model=DynamicRouteResponse)
    async def patch_route(
        stream_id: int,
        route_id: int,
        body: DynamicRoutePatchRequest,
        db: Session = Depends(get_db),
    ) -> DynamicRouteResponse:
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
        except DynamicRouteValidationError as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        entries = list_dynamic_routes(db, stream_id)
        entry = next(e for e in entries if e["id"] == route_id)
        return DynamicRouteResponse(route=entry)  # type: ignore[arg-type]

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/runtime")
    return app


@pytest.fixture
def dynamic_api_client(db_session: Session) -> TestClient:
    app = _dynamic_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def _add_security_destination(db: Session, stream_id: int) -> Destination:
    dest = Destination(
        name="Security Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://security-webhook.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db.add(dest)
    db.flush()
    _add_enabled_route_for_destination(db, stream_id, int(dest.id))
    return dest


def test_create_dynamic_route(db_session: Session, dynamic_api_client: TestClient) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = _add_security_destination(db_session, stream_id)
    db_session.commit()
    resp = dynamic_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/dynamic-routes",
        json={
            "name": "Secret Security Fan-out",
            "enabled": True,
            "condition_json": {"sensitivity_class": "secret"},
            "destination_id": security.id,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["route"]["name"] == "Secret Security Fan-out"
    assert body["route"]["destination_id"] == security.id
    assert body["route"]["route_id"] is not None


def test_route_match_and_no_match(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = _add_security_destination(db_session, stream_id)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret Route",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    db_session.commit()
    findings = [{"sensitivity_class": "secret"}]
    matched = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"api_key": "x"}],
        findings=findings,
    )
    assert matched.matched_dynamic_route_count == 1
    assert matched.matches[0].destination_name == "Security Webhook"

    no_match = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"message": "hi"}],
        findings=[{"sensitivity_class": "pii"}],
    )
    assert no_match.matched_dynamic_route_count == 0


def test_disabled_dynamic_route_not_evaluated(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = _add_security_destination(db_session, stream_id)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Disabled Secret",
        enabled=False,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    db_session.commit()
    result = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"api_key": "x"}],
        findings=[{"sensitivity_class": "secret"}],
    )
    assert result.dynamic_route_count == 0
    assert result.matched_dynamic_route_count == 0


def test_preview_selected_destinations(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = _add_security_destination(db_session, stream_id)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret Route",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    db_session.commit()
    preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload={"items": [{"api_key": "secret-value-12345", "message": "hi"}]},
            event_array_path="$.items",
            field_mappings={"api_key": "$.api_key", "message": "$.message"},
            stream_id=stream_id,
        ),
        db=db_session,
    )
    assert fixture["destination_names"][0] in preview.selected_destinations
    assert "Security Webhook" in preview.selected_destinations


def test_runtime_dynamic_routing_additive_fan_out(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = _add_security_destination(db_session, stream_id)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret Security",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    mapping = db_session.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
    }
    db_session.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-secret",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    urls = {call["config"]["url"] for call in sender.calls}
    assert "https://receiver-0.example.com/events" in urls
    assert "https://security-webhook.example.com/events" in urls
    assert len(sender.calls) == 2

    dyn_logs = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == DYNAMIC_ROUTING_COMPLETE_STAGE,
        )
        .all()
    )
    assert dyn_logs
    sample = dyn_logs[-1].payload_sample or {}
    for key in (
        "stream_id",
        "dynamic_route_count",
        "matched_dynamic_route_count",
        "selected_destination_count",
        "processing_time_ms",
    ):
        assert key in sample
    assert int(sample.get("matched_dynamic_route_count") or 0) >= 1

    success_dyn = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id, DeliveryLog.stage == "dynamic_route_send_success")
        .all()
    )
    assert not success_dyn
    skip_dyn = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id, DeliveryLog.stage == "dynamic_route_send_skip")
        .all()
    )
    assert any(
        (row.payload_sample or {}).get("skip_reason") == "duplicate_base_route"
        for row in skip_dyn
    )


def test_observability_summary(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = _add_security_destination(db_session, stream_id)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret Route",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    db_session.commit()
    result = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"password": "x"}],
        findings=[{"sensitivity_class": "secret"}],
    )
    payload = build_dynamic_routing_complete_payload(stream_id=stream_id, result=result)
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=DYNAMIC_ROUTING_COMPLETE_STAGE,
            status="ok",
            message="dynamic routing evaluation complete",
            payload_sample=payload,
        )
    )
    db_session.commit()
    summary = build_dynamic_routing_summary(db_session, stream_id)
    assert summary["total_dynamic_routes"] == 1
    assert summary["matched_dynamic_routes"] >= 1


def test_dynamic_api_summary(dynamic_api_client: TestClient, db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = _add_security_destination(db_session, stream_id)
    db_session.commit()
    dynamic_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/dynamic-routes",
        json={
            "name": "PII Route",
            "condition_json": {"sensitivity_class": "pii"},
            "destination_id": security.id,
        },
    )
    summary = dynamic_api_client.get(f"/api/v1/runtime/streams/{stream_id}/dynamic-routing/summary")
    assert summary.status_code == 200
    assert summary.json()["total_dynamic_routes"] == 1

    platform = dynamic_api_client.get("/api/v1/runtime/dynamic-routing/summary")
    assert platform.status_code == 200
    assert platform.json()["total_dynamic_routes"] >= 1


def test_preview_service_selected_destinations_helper(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    names = evaluate_dynamic_routes_for_preview(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"message": "plain"}],
    )
    assert fixture["destination_names"][0] in names
