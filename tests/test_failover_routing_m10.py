"""M10 / M10.1 failover routing — Active/Standby, hardening, observability."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db, get_db_read_bounded
from app.destinations.models import Destination
from app.dynamic_routing.operator_workflow import create_dynamic_route
from app.failover_routing.failover_metrics import (
    FAILOVER_ROUTING_COMPLETE_STAGE,
    FAILOVER_ROUTE_ATTEMPT_STAGE,
    FAILOVER_ROUTE_SEND_FAILED_STAGE,
    FAILOVER_ROUTE_SEND_SUCCESS_STAGE,
    build_failover_routing_complete_payload,
    build_platform_failover_routing_summary,
    load_failover_routing_runtime_metrics,
)
from app.failover_routing.failover_eligibility import is_failover_eligible_error
from app.failover_routing.operator_workflow import (
    build_failover_routing_summary,
    create_failover_route,
    list_failover_routes,
    patch_failover_route,
)
from app.failover_routing.schemas import (
    FailoverRouteCreateRequest,
    FailoverRoutePatchRequest,
    FailoverRouteResponse,
    PlatformFailoverRoutingSummaryResponse,
    StreamFailoverRoutesResponse,
    StreamFailoverRoutingSummaryResponse,
)
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.routes.models import Route
from app.runtime.errors import DestinationSendError
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _add_enabled_route_for_destination,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context


class _FailoverWebhookSender:
    """Webhook fake that raises DestinationSendError (matches production sender)."""

    def __init__(
        self,
        *,
        fail_urls: set[str] | None = None,
        status_by_url: dict[str, int] | None = None,
    ) -> None:
        self.fail_urls = fail_urls or set()
        self.status_by_url = dict(status_by_url or {})
        self.calls: list[dict[str, Any]] = []

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self.calls.append({"events": events, "config": config, "formatter_override": formatter_override})
        url = str(config.get("url"))
        if url in self.status_by_url:
            raise DestinationSendError(
                f"webhook send failed: {url}",
                http_status=int(self.status_by_url[url]),
            )
        if url in self.fail_urls:
            raise DestinationSendError(f"webhook send failed: {url}")


def _failover_test_app() -> FastAPI:
    from app.streams.repository import get_stream_by_id

    router = APIRouter()

    @router.get("/failover-routing/summary", response_model=PlatformFailoverRoutingSummaryResponse)
    async def get_platform_summary(db: Session = Depends(get_db_read_bounded)) -> PlatformFailoverRoutingSummaryResponse:
        payload = build_platform_failover_routing_summary(db)
        return PlatformFailoverRoutingSummaryResponse.model_validate(payload)

    @router.get("/streams/{stream_id}/failover-routes", response_model=StreamFailoverRoutesResponse)
    async def get_routes(
        stream_id: int,
        enabled_only: bool = Query(False),
        db: Session = Depends(get_db_read_bounded),
    ) -> StreamFailoverRoutesResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        routes = list_failover_routes(db, stream_id, enabled_only=enabled_only)
        return StreamFailoverRoutesResponse(stream_id=stream_id, routes=routes, route_count=len(routes))  # type: ignore[arg-type]

    @router.get("/streams/{stream_id}/failover-routing/summary", response_model=StreamFailoverRoutingSummaryResponse)
    async def get_summary(stream_id: int, db: Session = Depends(get_db_read_bounded)) -> StreamFailoverRoutingSummaryResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        return StreamFailoverRoutingSummaryResponse.model_validate(build_failover_routing_summary(db, stream_id))

    @router.post("/streams/{stream_id}/failover-routes", response_model=FailoverRouteResponse)
    async def post_route(
        stream_id: int,
        body: FailoverRouteCreateRequest,
        db: Session = Depends(get_db),
    ) -> FailoverRouteResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        rule = create_failover_route(
            db,
            stream_id=stream_id,
            primary_destination_id=body.primary_destination_id,
            secondary_destination_id=body.secondary_destination_id,
            enabled=body.enabled,
        )
        db.commit()
        entries = list_failover_routes(db, stream_id)
        entry = next(e for e in entries if e["id"] == rule.id)
        return FailoverRouteResponse(route=entry)  # type: ignore[arg-type]

    @router.patch("/streams/{stream_id}/failover-routes/{route_id}", response_model=FailoverRouteResponse)
    async def patch_route(
        stream_id: int,
        route_id: int,
        body: FailoverRoutePatchRequest,
        db: Session = Depends(get_db),
    ) -> FailoverRouteResponse:
        patch_failover_route(
            db,
            stream_id=stream_id,
            route_id=route_id,
            primary_destination_id=body.primary_destination_id,
            secondary_destination_id=body.secondary_destination_id,
            enabled=body.enabled,
        )
        db.commit()
        entries = list_failover_routes(db, stream_id)
        entry = next(e for e in entries if e["id"] == route_id)
        return FailoverRouteResponse(route=entry)  # type: ignore[arg-type]

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/runtime")
    return app


@pytest.fixture
def failover_api_client(db_session: Session) -> TestClient:
    app = _failover_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def _seed_primary_backup(
    db: Session,
    *,
    primary_url: str = "https://primary.example.com/events",
    backup_url: str = "https://backup.example.com/events",
    primary_name: str = "Primary Syslog",
    backup_name: str = "Backup Syslog",
) -> dict[str, Any]:
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route = db.query(Route).filter(Route.stream_id == stream_id).one()
    primary_dest = db.get(Destination, int(route.destination_id))
    assert primary_dest is not None
    primary_dest.name = primary_name
    primary_dest.config_json = {"url": primary_url}
    backup = Destination(
        name=backup_name,
        destination_type="WEBHOOK_POST",
        config_json={"url": backup_url},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db.add(backup)
    db.flush()
    create_failover_route(
        db,
        stream_id=stream_id,
        primary_destination_id=int(primary_dest.id),
        secondary_destination_id=int(backup.id),
        enabled=True,
    )
    db.commit()
    return {
        **fixture,
        "primary_dest_id": int(primary_dest.id),
        "backup_dest_id": int(backup.id),
        "primary_url": primary_url,
        "backup_url": backup_url,
    }


def test_create_failover_route(db_session: Session, failover_api_client: TestClient) -> None:
    ctx = _seed_primary_backup(db_session)
    resp = failover_api_client.get(f"/api/v1/runtime/streams/{ctx['stream_id']}/failover-routes")
    assert resp.status_code == 200
    body = resp.json()
    assert body["route_count"] == 1
    assert body["routes"][0]["policy"] == "ACTIVE_STANDBY"


def test_primary_success_secondary_not_sent(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)
    urls = [c["config"]["url"] for c in sender.calls]
    assert ctx["primary_url"] in urls
    assert ctx["backup_url"] not in urls
    assert not db_session.query(DeliveryLog).filter(
        DeliveryLog.stream_id == ctx["stream_id"],
        DeliveryLog.stage == FAILOVER_ROUTE_ATTEMPT_STAGE,
    ).count()
    complete = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == ctx["stream_id"],
            DeliveryLog.stage == FAILOVER_ROUTING_COMPLETE_STAGE,
        )
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert complete is not None
    sample = complete.payload_sample or {}
    assert int(sample.get("attempt_count") or 0) == 0
    assert int(sample.get("success_count") or 0) == 0
    assert int(sample.get("failure_count") or 0) == 0


def test_primary_fail_secondary_success(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)
    urls = [c["config"]["url"] for c in sender.calls]
    assert ctx["primary_url"] in urls
    assert ctx["backup_url"] in urls
    success = db_session.query(DeliveryLog).filter(
        DeliveryLog.stream_id == ctx["stream_id"],
        DeliveryLog.stage == FAILOVER_ROUTE_SEND_SUCCESS_STAGE,
    ).all()
    assert success
    primary_failed = db_session.query(DeliveryLog).filter(
        DeliveryLog.stream_id == ctx["stream_id"],
        DeliveryLog.stage == "route_send_failed",
    ).all()
    assert primary_failed, "primary failure must be logged even when standby recovers"


def test_primary_fail_secondary_fail(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"], ctx["backup_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)
    failed = db_session.query(DeliveryLog).filter(
        DeliveryLog.stream_id == ctx["stream_id"],
        DeliveryLog.stage == FAILOVER_ROUTE_SEND_FAILED_STAGE,
    ).all()
    assert failed


def test_checkpoint_success_via_secondary(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    cp_before = db_session.query(Checkpoint).filter(Checkpoint.stream_id == ctx["stream_id"]).one()
    before_val = dict(cp_before.checkpoint_value_json or {})
    poller = _FakePoller(
        response={"items": [{"id": "e2", "message": "checkpoint-test", "vendor": "v"}]}
    )
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)
    db_session.refresh(cp_before)
    after_val = dict(cp_before.checkpoint_value_json or {})
    assert after_val != before_val
    run_complete = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == ctx["stream_id"],
            DeliveryLog.stage == "run_complete",
        )
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert run_complete is not None
    assert (run_complete.payload_sample or {}).get("checkpoint_updated") is True


def test_checkpoint_not_updated_when_secondary_fails(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    cp_before = db_session.query(Checkpoint).filter(Checkpoint.stream_id == ctx["stream_id"]).one()
    before_val = dict(cp_before.checkpoint_value_json or {})
    poller = _FakePoller(response={"items": [{"id": "e3", "message": "fail-both", "vendor": "v"}]})
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"], ctx["backup_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)
    db_session.refresh(cp_before)
    assert dict(cp_before.checkpoint_value_json or {}) == before_val
    run_complete = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == ctx["stream_id"],
            DeliveryLog.stage == "run_complete",
        )
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert run_complete is not None
    assert (run_complete.payload_sample or {}).get("checkpoint_updated") is False


def test_preview_failover_plan(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload={"items": [{"id": "1", "message": "x", "vendor": "v"}]},
            event_array_path="$.items",
            field_mappings={"event_id": "$.id", "message": "$.message"},
            stream_id=ctx["stream_id"],
        ),
        db=db_session,
    )
    assert len(preview.failover_plan) == 1
    assert preview.failover_plan[0].primary == "Primary Syslog"
    assert preview.failover_plan[0].secondary == "Backup Syslog"


def test_summary_and_observability(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)

    summary = build_failover_routing_summary(db_session, ctx["stream_id"])
    assert summary["total_failover_routes"] == 1
    assert summary["failover_attempts"] >= 1
    assert summary["failover_successes"] >= 1

    platform = build_platform_failover_routing_summary(db_session)
    assert platform["total_failover_routes"] >= 1

    complete = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == ctx["stream_id"],
            DeliveryLog.stage == FAILOVER_ROUTING_COMPLETE_STAGE,
        )
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert complete is not None
    sample = complete.payload_sample or {}
    for key in (
        "stream_id",
        "failover_route_count",
        "attempt_count",
        "success_count",
        "failure_count",
        "processing_time_ms",
    ):
        assert key in sample

    payload = build_failover_routing_complete_payload(
        stream_id=ctx["stream_id"],
        failover_route_count=1,
        attempt_count=1,
        success_count=1,
        failure_count=0,
        processing_time_ms=5,
    )
    assert payload["stage"] == FAILOVER_ROUTING_COMPLETE_STAGE


def test_disabled_failover_route_not_evaluated(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    rule = list_failover_routes(db_session, ctx["stream_id"])[0]
    patch_failover_route(
        db_session,
        stream_id=ctx["stream_id"],
        route_id=int(rule["id"]),
        enabled=False,
    )
    db_session.commit()
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)
    assert ctx["backup_url"] not in {c["config"]["url"] for c in sender.calls}
    assert not db_session.query(DeliveryLog).filter(
        DeliveryLog.stream_id == ctx["stream_id"],
        DeliveryLog.stage == FAILOVER_ROUTE_ATTEMPT_STAGE,
    ).count()


def test_429_does_not_trigger_failover(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender(status_by_url={ctx["primary_url"]: 429})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)
    urls = {c["config"]["url"] for c in sender.calls}
    assert ctx["primary_url"] in urls
    assert ctx["backup_url"] not in urls
    stream_id = ctx["stream_id"]
    for stage in (
        FAILOVER_ROUTE_ATTEMPT_STAGE,
        FAILOVER_ROUTE_SEND_SUCCESS_STAGE,
        FAILOVER_ROUTE_SEND_FAILED_STAGE,
    ):
        assert not db_session.query(DeliveryLog).filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == stage,
        ).count()


def test_429_not_failover_eligible() -> None:
    assert is_failover_eligible_error(DestinationSendError("rate limited", http_status=429)) is False


def test_4xx_not_failover_eligible_except_handled_by_status() -> None:
    assert is_failover_eligible_error(DestinationSendError("bad request", http_status=400)) is False


def test_5xx_failover_eligible() -> None:
    assert is_failover_eligible_error(DestinationSendError("server error", http_status=503)) is True


def test_summary_latest_row_bounded_no_full_scan(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    stream_id = ctx["stream_id"]
    query_count = {"n": 0}
    engine = db_session.get_bind()

    def _before(_conn, _cursor, statement, _params, _ctx, _many=False):
        sql = str(statement).lower()
        if "delivery_logs" in sql and "count(" in sql:
            query_count["n"] += 1

    event.listen(engine, "before_cursor_execute", _before)
    try:
        for idx in range(3):
            payload = build_failover_routing_complete_payload(
                stream_id=stream_id,
                failover_route_count=1,
                attempt_count=0,
                success_count=0,
                failure_count=0,
                processing_time_ms=1,
                cumulative_totals={
                    "failover_attempts": (idx + 1) * 10,
                    "failover_successes": (idx + 1) * 5,
                    "failover_failures": 0,
                },
            )
            db_session.add(
                DeliveryLog(
                    stream_id=stream_id,
                    stage=FAILOVER_ROUTING_COMPLETE_STAGE,
                    status="ok",
                    message="failover routing evaluation complete",
                    payload_sample=payload,
                )
            )
        db_session.commit()
        metrics = load_failover_routing_runtime_metrics(db_session, stream_id, total_failover_routes=1)
        assert metrics["failover_attempts"] == 30
        assert metrics["failover_successes"] == 15
    finally:
        event.remove(engine, "before_cursor_execute", _before)
    assert query_count["n"] == 0


def test_platform_summary_bounded_no_delivery_logs_count(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    stream_id = ctx["stream_id"]
    payload = build_failover_routing_complete_payload(
        stream_id=stream_id,
        failover_route_count=1,
        attempt_count=2,
        success_count=1,
        failure_count=1,
        processing_time_ms=3,
    )
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=FAILOVER_ROUTING_COMPLETE_STAGE,
            status="ok",
            message="failover routing evaluation complete",
            payload_sample=payload,
        )
    )
    db_session.commit()
    query_count = {"n": 0}
    engine = db_session.get_bind()

    def _before(_conn, _cursor, statement, _params, _ctx, _many=False):
        sql = str(statement).lower()
        if "delivery_logs" in sql and "count(" in sql:
            query_count["n"] += 1

    event.listen(engine, "before_cursor_execute", _before)
    try:
        summary = build_platform_failover_routing_summary(db_session)
        assert summary["failover_attempts"] >= 2
    finally:
        event.remove(engine, "before_cursor_execute", _before)
    assert query_count["n"] == 0


def test_preview_failover_plan_excludes_disabled_route(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    stream_id = ctx["stream_id"]
    alt_primary = Destination(
        name="Alt Primary",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://alt-primary.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    backup2 = Destination(
        name="Backup Two",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://backup2.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add_all([alt_primary, backup2])
    db_session.flush()
    db_session.add(
        Route(
            stream_id=stream_id,
            destination_id=int(alt_primary.id),
            failure_policy="LOG_AND_CONTINUE",
            enabled=True,
            formatter_config_json={},
            rate_limit_json={},
            status="ENABLED",
        )
    )
    create_failover_route(
        db_session,
        stream_id=stream_id,
        primary_destination_id=int(alt_primary.id),
        secondary_destination_id=int(backup2.id),
        enabled=False,
    )
    db_session.commit()
    preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload={"items": [{"id": "1", "message": "x", "vendor": "v"}]},
            event_array_path="$.items",
            field_mappings={"event_id": "$.id", "message": "$.message"},
            stream_id=stream_id,
        ),
        db=db_session,
    )
    assert len(preview.failover_plan) == 1
    assert preview.failover_plan[0].primary == "Primary Syslog"
    assert preview.failover_plan[0].secondary == "Backup Syslog"


def test_preview_runtime_payload_immutable(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    payload = {"items": [{"id": "1", "message": "x", "vendor": "v", "api_key": "secret"}]}
    payload_before = copy.deepcopy(payload)
    preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload=payload,
            event_array_path="$.items",
            field_mappings={"event_id": "$.id", "message": "$.message"},
            stream_id=ctx["stream_id"],
        ),
        db=db_session,
    )
    assert payload == payload_before
    assert preview.failover_plan


@pytest.fixture
def sensitive_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)


def _seed_secret_mapping(db: Session, stream_id: int) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
    }


def test_dynamic_routing_and_failover_combined(
    db_session: Session,
    sensitive_runtime: None,
) -> None:
    ctx = _seed_primary_backup(db_session)
    stream_id = ctx["stream_id"]
    dynamic_dest = Destination(
        name="Dynamic Fanout",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://dynamic-fanout.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add(dynamic_dest)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(dynamic_dest.id))
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret Fanout",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=int(dynamic_dest.id),
    )
    _seed_secret_mapping(db_session, stream_id)
    db_session.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-fo-dyn",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    urls = [c["config"]["url"] for c in sender.calls]
    assert ctx["primary_url"] in urls
    assert ctx["backup_url"] in urls
    assert "https://dynamic-fanout.example.com/events" in urls
    assert urls.count(ctx["backup_url"]) == 1

    run_complete = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id, DeliveryLog.stage == "run_complete")
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert run_complete is not None
    assert (run_complete.payload_sample or {}).get("checkpoint_updated") is True


def test_dynamic_routing_skips_failover_secondary_duplicate(
    db_session: Session,
    sensitive_runtime: None,
) -> None:
    ctx = _seed_primary_backup(db_session)
    stream_id = ctx["stream_id"]
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Backup Dup",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=int(ctx["primary_dest_id"]),
    )
    _seed_secret_mapping(db_session, stream_id)
    db_session.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-dup-fo",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    assert [c["config"]["url"] for c in sender.calls].count(ctx["backup_url"]) == 1
    skip_logs = db_session.query(DeliveryLog).filter(
        DeliveryLog.stream_id == stream_id,
        DeliveryLog.stage == "dynamic_route_send_skip",
    ).all()
    assert any(
        (row.payload_sample or {}).get("skip_reason") in {"duplicate_base_route", "duplicate_base_destination"}
        for row in skip_logs
    )
