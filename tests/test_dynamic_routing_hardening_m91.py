"""M9.1 — dynamic routing hardening (parity, isolation, bounded summary, regression)."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.dynamic_routing.dynamic_routing_metrics import (
    DYNAMIC_ROUTING_COMPLETE_STAGE,
    build_dynamic_routing_complete_payload,
    load_dynamic_routing_runtime_metrics,
)
from app.dynamic_routing.dynamic_routing_service import (
    evaluate_dynamic_routes_for_preview,
    resolve_selected_destination_names,
)
from app.dynamic_routing.operator_workflow import build_dynamic_routing_summary, create_dynamic_route
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.routes.models import Route
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest
from app.sources.models import Source
from app.streams.models import Stream
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _add_enabled_route_for_destination,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context


class _SecurityFailWebhookSender:
    def __init__(self, base: _FakeWebhookSender) -> None:
        self.base = base

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        if config.get("url") == "https://security-webhook.example.com/events":
            raise RuntimeError("dynamic destination send failed")
        self.base.send(events, config, formatter_override=formatter_override, **kwargs)


def _seed_secret_mapping(db: Session, stream_id: int) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
    }


def _add_dynamic_to_base_destination(
    db: Session,
    stream_id: int,
    destination_id: int,
) -> None:
    create_dynamic_route(
        db,
        stream_id=stream_id,
        name="Duplicate Secret",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=int(destination_id),
    )


@pytest.fixture
def sensitive_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)


def test_duplicate_destination_skip_single_send(
    db_session: Session,
    sensitive_runtime: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    base_dest_id = fixture["destination_ids"][0]
    _add_dynamic_to_base_destination(db_session, stream_id, base_dest_id)
    _seed_secret_mapping(db_session, stream_id)
    db_session.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-dup",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    assert len(sender.calls) == 1
    assert sender.calls[0]["config"]["url"] == "https://receiver-0.example.com/events"

    skip_logs = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == "dynamic_route_send_skip",
        )
        .all()
    )
    assert skip_logs
    assert any(
        (row.payload_sample or {}).get("skip_reason") in {"duplicate_base_route", "duplicate_base_destination"}
        for row in skip_logs
    )

    complete = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == DYNAMIC_ROUTING_COMPLETE_STAGE,
        )
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert complete is not None
    sample = complete.payload_sample or {}
    assert int(sample.get("dynamic_deliveries_this_run") or 0) == 0
    assert int(sample.get("dynamic_deliveries") or 0) == int(sample.get("total_dynamic_deliveries") or 0)


def test_dynamic_route_failure_isolation_checkpoint(
    db_session: Session,
    sensitive_runtime: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = Destination(
        name="Security Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://security-webhook.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add(security)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(security.id))
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret Security",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    _seed_secret_mapping(db_session, stream_id)
    db_session.commit()

    before = (
        db_session.query(Checkpoint)
        .filter(Checkpoint.stream_id == stream_id)
        .one()
        .checkpoint_value_json
    )
    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-iso",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    base_sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=_SecurityFailWebhookSender(base_sender))
    summary = runner.run(load_stream_context(db_session, stream_id), db=db_session)

    assert summary["outcome"] == "completed"
    assert summary["checkpoint_updated"] is True
    after = (
        db_session.query(Checkpoint)
        .filter(Checkpoint.stream_id == stream_id)
        .one()
        .checkpoint_value_json
    )
    assert after != before
    assert after["last_success_event"]["event_id"] == "evt-iso"

    assert any(
        row.stage == "route_send_success"
        for row in db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    )
    assert any(
        row.stage == "route_send_failed"
        for row in db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id).all()
    )


def test_summary_latest_row_bounded_no_full_scan(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    query_count = {"n": 0}
    engine = db_session.get_bind()

    def _before(_conn, _cursor, statement, _params, _ctx, _many=False):
        sql = str(statement).lower()
        if "delivery_logs" in sql and "count(" in sql:
            query_count["n"] += 1

    event.listen(engine, "before_cursor_execute", _before)
    try:
        for idx in range(3):
            payload = {
                "stage": DYNAMIC_ROUTING_COMPLETE_STAGE,
                "stream_id": stream_id,
                "dynamic_route_count": 1,
                "matched_dynamic_route_count": idx + 1,
                "selected_destination_count": 1,
                "processing_time_ms": 1,
                "total_matched_dynamic_routes": (idx + 1) * 10,
                "total_dynamic_deliveries": (idx + 1) * 5,
                "matched_dynamic_routes": (idx + 1) * 10,
                "dynamic_deliveries": (idx + 1) * 5,
            }
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
        metrics = load_dynamic_routing_runtime_metrics(db_session, stream_id, total_dynamic_routes=1)
        assert metrics["matched_dynamic_routes"] == 30
        assert metrics["dynamic_deliveries"] == 15
    finally:
        event.remove(engine, "before_cursor_execute", _before)
    assert query_count["n"] == 0


def test_preview_runtime_selected_destination_parity(
    db_session: Session,
    sensitive_runtime: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = Destination(
        name="Security Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://security-webhook.example.com/events"},
        enabled=True,
    )
    db_session.add(security)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(security.id))
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret Route",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    _seed_secret_mapping(db_session, stream_id)
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
    preview_count = len(preview.selected_destinations)

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-parity",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    before_events = copy.deepcopy(poller.response)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)
    assert poller.response == before_events

    complete = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == DYNAMIC_ROUTING_COMPLETE_STAGE,
        )
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert complete is not None
    assert int((complete.payload_sample or {}).get("selected_destination_count") or 0) == preview_count


def test_disabled_dynamic_route_excluded_from_preview_and_counts(
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = Destination(
        name="Security Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://security-webhook.example.com/events"},
        enabled=True,
    )
    db_session.add(security)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(security.id), enabled=False)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Disabled",
        enabled=False,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    db_session.commit()

    names = evaluate_dynamic_routes_for_preview(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"api_key": "x"}],
    )
    assert "Security Webhook" not in names
    assert names == [fixture["destination_names"][0]]


def test_no_base_routes_stream_summary_and_preview_stable(db_session: Session) -> None:
    connector = Connector(name="no-route", description="m91", status="RUNNING")
    db_session.add(connector)
    db_session.flush()
    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://example.com"},
        enabled=True,
    )
    db_session.add(source)
    db_session.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="no-route-stream",
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/events"},
        enabled=True,
        status="RUNNING",
    )
    db_session.add(stream)
    db_session.flush()
    db_session.add(
        Mapping(
            stream_id=stream.id,
            event_array_path="$.items",
            field_mappings_json={"message": "$.message"},
        )
    )
    db_session.commit()

    summary = build_dynamic_routing_summary(db_session, stream.id)
    assert summary["total_dynamic_routes"] == 0
    assert summary["matched_dynamic_routes"] == 0
    assert summary["dynamic_deliveries"] == 0

    preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload={"items": [{"message": "hi"}]},
            event_array_path="$.items",
            field_mappings={"message": "$.message"},
            stream_id=stream.id,
        ),
        db=db_session,
    )
    assert preview.selected_destinations == []


def test_runtime_payload_immutable_on_dynamic_delivery(
    db_session: Session,
    sensitive_runtime: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    security = Destination(
        name="Security Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://security-webhook.example.com/events"},
        enabled=True,
    )
    db_session.add(security)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(security.id))
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Secret",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=security.id,
    )
    _seed_secret_mapping(db_session, stream_id)
    db_session.commit()

    payload = {
        "items": [
            {
                "id": "evt-immut",
                "api_key": "super-secret-token-value",
                "message": "hello",
                "vendor": "v",
            }
        ]
    }
    poller = _FakePoller(response=copy.deepcopy(payload))
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)
    assert poller.response == payload
    for call in sender.calls:
        for event in call["events"]:
            assert "api_key" in event


def test_build_complete_payload_cumulative_aliases(db_session: Session) -> None:
    from app.dynamic_routing.dynamic_routing_engine import DynamicRoutingBatchResult

    result = DynamicRoutingBatchResult(
        dynamic_route_count=2,
        matched_dynamic_route_count=1,
        selected_destination_count=2,
        duration_ms=3,
    )
    payload = build_dynamic_routing_complete_payload(
        stream_id=1,
        result=result,
        dynamic_deliveries_this_run=1,
        cumulative_totals={"matched_dynamic_routes": 4, "dynamic_deliveries": 7},
    )
    assert payload["total_matched_dynamic_routes"] == 5
    assert payload["total_dynamic_deliveries"] == 8
    assert payload["dynamic_deliveries_this_run"] == 1


def test_resolve_selected_destinations_dedupes_by_destination_id(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _add_dynamic_to_base_destination(db_session, stream_id, fixture["destination_ids"][0])
    db_session.commit()
    names = resolve_selected_destination_names(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"api_key": "x"}],
    )
    assert names == [fixture["destination_names"][0]]
