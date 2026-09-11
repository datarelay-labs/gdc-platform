"""P1-4 — Route Processing default ON, failover/replay parity, no new runtime."""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.failover_routing.failover_metrics import (
    FAILOVER_ROUTE_SEND_SUCCESS_STAGE,
    FAILOVER_ROUTING_COMPLETE_STAGE,
)
from app.logs.models import DeliveryLog
from app.replay.models import REPLAY_STATUS_PENDING, StreamReplayEvent
from app.runners.stream_loader import load_stream_context
from tests.test_failover_routing_m10 import _FailoverWebhookSender, _seed_primary_backup
from tests.test_replay_engine_m11 import _ReplayWebhookSender
from tests.test_stream_runner_e2e import _FakePoller, _build_runner, _seed_stream_runtime


def test_route_processing_default_is_on() -> None:
    assert Settings.model_fields["GDC_ROUTE_PROCESSING_ENABLED"].default is True


@pytest.mark.parametrize("route_on", [False, True], ids=["flag_off", "flag_on"])
def test_failover_primary_fail_secondary_success_flag_matrix(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    route_on: bool,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", route_on)
    ctx = _seed_primary_backup(db_session)
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    summary = runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)

    urls = [c["config"]["url"] for c in sender.calls]
    assert ctx["primary_url"] in urls
    assert ctx["backup_url"] in urls
    assert summary["outcome"] == "completed"
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
    assert db_session.query(DeliveryLog).filter(
        DeliveryLog.stream_id == ctx["stream_id"],
        DeliveryLog.stage == FAILOVER_ROUTE_SEND_SUCCESS_STAGE,
    ).count() >= 1
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
    assert int(sample.get("attempt_count") or 0) >= 1
    assert int(sample.get("success_count") or 0) >= 1


@pytest.mark.parametrize("route_on", [False, True], ids=["flag_off", "flag_on"])
def test_replay_records_on_route_failure_flag_matrix(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    route_on: bool,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", route_on)
    seeded = _seed_stream_runtime(db_session)
    poller = _FakePoller(
        response={"items": [{"id": "evt-replay-1", "message": "replay-record", "vendor": "MappedVendor"}]}
    )
    sender = _ReplayWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, int(seeded["stream_id"])), db=db_session)
    db_session.commit()

    rows = (
        db_session.query(StreamReplayEvent)
        .filter(StreamReplayEvent.stream_id == int(seeded["stream_id"]))
        .all()
    )
    assert len(rows) >= 1
    assert rows[0].status == REPLAY_STATUS_PENDING
    assert isinstance(rows[0].protected_payload_json, dict)
    assert rows[0].protected_payload_json.get("events")


@pytest.mark.parametrize("route_on", [False, True], ids=["flag_off", "flag_on"])
def test_failover_bindings_present_log_complete_on_primary_success(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    route_on: bool,
) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", route_on)
    ctx = _seed_primary_backup(db_session)
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, ctx["stream_id"]), db=db_session)

    urls = [c["config"]["url"] for c in sender.calls]
    assert ctx["primary_url"] in urls
    assert ctx["backup_url"] not in urls
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
