"""M12 Quarantine MVP — policy quarantine, release, discard, preview, summary."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db, get_db_read_bounded
from app.logs.models import DeliveryLog
from app.protection.policy_operator_workflow import PolicyRuleValidationError, create_policy_rule
from app.protection.policy_service import would_quarantine_for_preview
from app.quarantine.metrics import (
    QUARANTINE_EVENT_CREATED_STAGE,
    QUARANTINE_EVENT_DISCARDED_STAGE,
    QUARANTINE_EVENT_RELEASED_STAGE,
)
from app.quarantine.models import (
    QUARANTINE_SOURCE_POLICY,
    QUARANTINE_STATUS_DISCARDED,
    QUARANTINE_STATUS_QUARANTINED,
    QUARANTINE_STATUS_RELEASED,
    StreamQuarantineEvent,
)
from app.quarantine.recording import record_policy_quarantine_event
from app.quarantine.service import (
    build_stream_quarantine_summary,
    discard_quarantine_event,
    execute_quarantine_release,
    list_stream_quarantine_events,
)
from app.protection.policy_engine import evaluate_batch
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import (
    FinalEventDraftPreviewRequest,
    PlatformQuarantineSummaryResponse,
    QuarantineEventActionResponse,
    QuarantineEventItem,
    StreamQuarantineEventsResponse,
    StreamQuarantineSummaryResponse,
)
from app.mappings.models import Mapping
from tests.test_stream_runner_e2e import _FakePoller, _FakeWebhookSender, _build_runner, _seed_stream_runtime
from app.runners.stream_loader import load_stream_context


class _QuarantineWebhookSender:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self.calls.append({"events": events, "config": config})
        if self.fail:
            raise RuntimeError("release send failed")


def _quarantine_test_app() -> FastAPI:
    from app.quarantine import service as quarantine_engine_service
    from app.streams.repository import get_stream_by_id

    router = APIRouter()

    @router.get("/quarantine/summary", response_model=PlatformQuarantineSummaryResponse)
    async def platform_summary(db: Session = Depends(get_db_read_bounded)) -> PlatformQuarantineSummaryResponse:
        from app.quarantine.service import build_platform_quarantine_summary

        return PlatformQuarantineSummaryResponse.model_validate(build_platform_quarantine_summary(db))

    @router.get("/streams/{stream_id}/quarantine/summary", response_model=StreamQuarantineSummaryResponse)
    async def stream_summary(stream_id: int, db: Session = Depends(get_db_read_bounded)) -> StreamQuarantineSummaryResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        return StreamQuarantineSummaryResponse.model_validate(build_stream_quarantine_summary(db, stream_id))

    @router.get("/streams/{stream_id}/quarantine-events", response_model=StreamQuarantineEventsResponse)
    async def list_events(
        stream_id: int,
        status: str | None = Query(None),
        limit: int = Query(50, ge=1, le=200),
        db: Session = Depends(get_db_read_bounded),
    ) -> StreamQuarantineEventsResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        events = quarantine_engine_service.list_stream_quarantine_events(db, stream_id, status=status, limit=limit)
        items = [QuarantineEventItem.model_validate(e) for e in events]
        return StreamQuarantineEventsResponse(stream_id=stream_id, events=items, event_count=len(items))

    @router.post("/quarantine-events/{event_id}/release", response_model=QuarantineEventActionResponse)
    async def release_event(event_id: int, db: Session = Depends(get_db)) -> QuarantineEventActionResponse:
        try:
            result = quarantine_engine_service.execute_quarantine_release(db, event_id, released_by="tester")
            db.commit()
            return QuarantineEventActionResponse.model_validate(result)
        except quarantine_engine_service.QuarantineEventNotFoundError:
            raise HTTPException(status_code=404, detail="not found") from None
        except quarantine_engine_service.QuarantineEventStateError as exc:
            raise HTTPException(status_code=409, detail=exc.message) from exc

    @router.post("/quarantine-events/{event_id}/discard", response_model=QuarantineEventActionResponse)
    async def discard_event(event_id: int, db: Session = Depends(get_db)) -> QuarantineEventActionResponse:
        try:
            result = quarantine_engine_service.discard_quarantine_event(db, event_id)
            db.commit()
            return QuarantineEventActionResponse.model_validate(
                {**result, "outcome": "discarded", "message": "discarded"}
            )
        except quarantine_engine_service.QuarantineEventNotFoundError:
            raise HTTPException(status_code=404, detail="not found") from None

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/runtime")
    return app


@pytest.fixture
def quarantine_api_client(db_session: Session) -> TestClient:
    app = _quarantine_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def _create_quarantine_policy(db: Session, stream_id: int) -> None:
    create_policy_rule(
        db,
        stream_id=stream_id,
        name="Secret Quarantine",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="quarantine",
    )
    db.commit()


def test_quarantine_action_type_allowed(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    rule = create_policy_rule(
        db_session,
        stream_id=fixture["stream_id"],
        name="Q",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="quarantine",
    )
    assert rule.action_type == "quarantine"


def test_invalid_action_still_rejected(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    with pytest.raises(PolicyRuleValidationError):
        create_policy_rule(
            db_session,
            stream_id=fixture["stream_id"],
            name="Bad",
            enabled=True,
            condition_json={"sensitivity_class": "secret"},
            action_type="invalid_action",
        )


def test_policy_quarantine_runtime_blocks_delivery_and_checkpoint(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _create_quarantine_policy(db_session, stream_id)
    mapping = db_session.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
    }
    db_session.commit()

    cp_before = {"marker": "before"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-1",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    assert len(sender.calls) == 0

    row = (
        db_session.query(StreamQuarantineEvent)
        .filter(StreamQuarantineEvent.stream_id == stream_id)
        .one()
    )
    assert row.status == QUARANTINE_STATUS_QUARANTINED
    assert row.quarantine_source == QUARANTINE_SOURCE_POLICY
    payload = row.protected_payload_json
    assert isinstance(payload, dict)
    assert "events" in payload
    assert isinstance(payload["events"], list)
    assert payload["events"]
    meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    assert "enriched_events" not in meta
    assert "final_events" not in meta

    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json == cp_before

    created_logs = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == QUARANTINE_EVENT_CREATED_STAGE,
        )
        .all()
    )
    assert created_logs
    sample = created_logs[-1].payload_sample or {}
    assert sample.get("quarantine_event_id") == row.id
    assert sample.get("quarantine_reason")


def test_preview_would_quarantine_no_persist(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _create_quarantine_policy(db_session, stream_id)

    preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload={"items": [{"api_key": "secret-value-12345", "message": "hi"}]},
            event_array_path="$.items",
            field_mappings={"api_key": "$.api_key", "message": "$.message"},
            stream_id=stream_id,
        ),
        db=db_session,
    )
    assert preview.would_quarantine is True
    assert db_session.query(StreamQuarantineEvent).filter(StreamQuarantineEvent.stream_id == stream_id).count() == 0


def test_would_quarantine_helper(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _create_quarantine_policy(db_session, stream_id)
    assert would_quarantine_for_preview(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"api_key": "secret1234567890"}],
    )


def test_protected_payload_only_in_storage(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _create_quarantine_policy(db_session, stream_id)
    result = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"api_key": "x"}],
        findings=[{"sensitivity_class": "secret"}],
    )
    delivery = [{"api_key": "masked-value"}]
    row = record_policy_quarantine_event(
        db_session,
        stream_id=stream_id,
        delivery_events=delivery,
        policy_result=result,
    )
    assert row is not None
    raw = row.protected_payload_json
    assert raw == {"events": [{"api_key": "masked-value"}]}
    assert "enriched" not in json.dumps(row.metadata_json).lower()


def test_release_success_updates_checkpoint(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]

    cp_before = {"marker": "v1"}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()

    row = StreamQuarantineEvent(
        stream_id=stream_id,
        quarantine_reason="policy:test",
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": [{"id": "e1", "message": "ok"}]},
        metadata_json={"event_count": 1},
    )
    db_session.add(row)
    db_session.commit()

    from app.destinations.adapters.registry import DestinationAdapterRegistry

    registry = DestinationAdapterRegistry(webhook_sender=_QuarantineWebhookSender())
    result = execute_quarantine_release(
        db_session,
        int(row.id),
        destination_registry=registry,
        released_by="op",
    )
    assert result["outcome"] == "released"
    assert result["status"] == QUARANTINE_STATUS_RELEASED
    assert result["checkpoint_updated"] is True

    cp_after = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp_after.checkpoint_value_json != cp_before

    released_logs = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == QUARANTINE_EVENT_RELEASED_STAGE,
        )
        .all()
    )
    assert released_logs


def test_release_failure_keeps_quarantined(db_session: Session) -> None:
    from app.routes.models import Route

    fixture = _seed_stream_runtime(db_session, failure_policies=["PAUSE_STREAM_ON_FAILURE"])
    stream_id = fixture["stream_id"]
    route = db_session.query(Route).filter(Route.stream_id == stream_id).one()
    route.failure_policy = "PAUSE_STREAM_ON_FAILURE"
    db_session.commit()

    row = StreamQuarantineEvent(
        stream_id=stream_id,
        quarantine_reason="policy:test",
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": [{"id": "e1"}]},
        metadata_json={},
    )
    db_session.add(row)
    db_session.commit()

    from app.destinations.adapters.registry import DestinationAdapterRegistry

    registry = DestinationAdapterRegistry(webhook_sender=_QuarantineWebhookSender(fail=True))
    result = execute_quarantine_release(db_session, int(row.id), destination_registry=registry)
    assert result["outcome"] == "failed"
    db_session.refresh(row)
    assert row.status == QUARANTINE_STATUS_QUARANTINED


def test_discard_no_checkpoint(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    cp_before = {"x": 1}
    cp_row = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    cp_row.checkpoint_value_json = cp_before
    db_session.commit()
    row = StreamQuarantineEvent(
        stream_id=stream_id,
        quarantine_reason="policy:test",
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": [{"id": "e1"}]},
        metadata_json={},
    )
    db_session.add(row)
    db_session.commit()

    discard_quarantine_event(db_session, int(row.id))
    db_session.refresh(row)
    assert row.status == QUARANTINE_STATUS_DISCARDED

    cp = db_session.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).one()
    assert cp.checkpoint_value_json == cp_before

    logs = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == QUARANTINE_EVENT_DISCARDED_STAGE,
        )
        .all()
    )
    assert logs


def test_summary_from_table_not_delivery_logs(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    for status in (
        QUARANTINE_STATUS_QUARANTINED,
        QUARANTINE_STATUS_RELEASED,
        QUARANTINE_STATUS_DISCARDED,
    ):
        db_session.add(
            StreamQuarantineEvent(
                stream_id=stream_id,
                quarantine_reason="policy:x",
                quarantine_source=QUARANTINE_SOURCE_POLICY,
                status=status,
                protected_payload_json={"events": []},
                metadata_json={},
            )
        )
    db_session.commit()
    summary = build_stream_quarantine_summary(db_session, stream_id)
    assert summary["quarantined_count"] == 1
    assert summary["released_count"] == 1
    assert summary["discarded_count"] == 1


def test_quarantine_api_list_and_summary(quarantine_api_client: TestClient, db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    row = StreamQuarantineEvent(
        stream_id=stream_id,
        quarantine_reason="policy:api",
        quarantine_source=QUARANTINE_SOURCE_POLICY,
        status=QUARANTINE_STATUS_QUARANTINED,
        protected_payload_json={"events": [{"a": 1}]},
        metadata_json={"event_count": 1},
    )
    db_session.add(row)
    db_session.commit()

    summary = quarantine_api_client.get(f"/api/v1/runtime/streams/{stream_id}/quarantine/summary")
    assert summary.status_code == 200
    assert summary.json()["quarantined_count"] == 1

    events = quarantine_api_client.get(f"/api/v1/runtime/streams/{stream_id}/quarantine-events")
    assert events.status_code == 200
    assert events.json()["event_count"] == 1

    listed = list_stream_quarantine_events(db_session, stream_id)
    assert len(listed) == 1
