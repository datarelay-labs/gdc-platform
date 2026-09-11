"""M11.1 Replay Hardening — concurrency, E2E recording, state, observability, summary bounds."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session, sessionmaker

from app.checkpoints.models import Checkpoint
from app.database import get_db, get_db_read_bounded
from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.models import Destination
from app.dynamic_routing.operator_workflow import create_dynamic_route
from app.failover_routing.operator_workflow import create_failover_route
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.replay.metrics import (
    REPLAY_EVENT_DISCARDED_STAGE,
    REPLAY_EVENT_RECORDED_STAGE,
    REPLAY_EVENT_REPLAYED_STAGE,
    REPLAY_EVENT_REPLAY_FAILED_STAGE,
)
from app.replay.models import (
    DELIVERY_KIND_BASE_ROUTE,
    DELIVERY_KIND_FAILOVER_SECONDARY,
    REPLAY_STATUS_DISCARDED,
    REPLAY_STATUS_FAILED,
    REPLAY_STATUS_PENDING,
    REPLAY_STATUS_REPLAYED,
    StreamReplayEvent,
)
from app.replay.service import (
    ReplayEventStateError,
    ReplayInProgressError,
    build_platform_replay_summary,
    build_stream_replay_summary,
    checkpoint_unchanged,
    discard_replay_event,
    execute_replay_event,
)
from app.runtime import replay_service as delivery_log_replay_service
from tests.test_failover_routing_m10 import (
    _FailoverWebhookSender,
    _seed_primary_backup,
)
from tests.test_dynamic_routing_hardening_m91 import (
    _SecurityFailWebhookSender,
    _seed_secret_mapping,
)
from tests.test_replay_engine_m11 import (
    _ReplayWebhookSender,
    _insert_replay_row,
    _payload_hash,
    _replay_test_app,
)
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _add_enabled_route_for_destination,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context


def _hardening_api_client(db_session: Session) -> TestClient:
    app = _replay_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


class _SlowReplayWebhookSender:
    def __init__(self, delay_s: float = 0.35) -> None:
        self.delay_s = delay_s
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        with self._lock:
            self.calls.append({"events": events, "config": config})
        time.sleep(self.delay_s)


def _checkpoint_value(db: Session, stream_id: int) -> dict[str, Any]:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == int(stream_id)).first()
    assert row is not None
    return dict(row.checkpoint_value_json or {})


def _obs_payloads(db: Session, stream_id: int, stage: str) -> list[dict[str, Any]]:
    rows = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == int(stream_id), DeliveryLog.stage == stage)
        .all()
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        sample = row.payload_sample if isinstance(row.payload_sample, dict) else {}
        out.append(sample)
    return out


def _assert_obs_required(payload: dict[str, Any]) -> None:
    for key in ("stream_id", "destination_id", "replay_event_id", "status", "retry_count"):
        assert key in payload, f"missing {key} in {payload}"


def test_concurrent_replay_event_single_destination_send(
    db_session: Session,
    db_engine: Any,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"event_id": "conc-1"}])
    event_id = int(row.id)
    stream_id = int(seeded["stream_id"])
    shared_sender = _SlowReplayWebhookSender()
    shared_registry = DestinationAdapterRegistry(webhook_sender=shared_sender)
    SessionLocal = sessionmaker(bind=db_engine, expire_on_commit=False)
    barrier = threading.Barrier(2)
    results: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def _worker() -> None:
        session = SessionLocal()
        try:
            barrier.wait(timeout=5)
            result = execute_replay_event(session, event_id, destination_registry=shared_registry)
            session.commit()
            results.append(result)
        except BaseException as exc:
            session.rollback()
            errors.append(exc)
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = [pool.submit(_worker), pool.submit(_worker)]
        for fut in as_completed(futs):
            fut.result()

    assert len(shared_sender.calls) == 1
    success = [r for r in results if r.get("outcome") == "replayed"]
    assert len(success) == 1
    assert len(errors) + len(results) == 2
    if errors:
        assert all(isinstance(e, ReplayInProgressError) for e in errors)

    db_session.expire_all()
    refreshed = db_session.get(StreamReplayEvent, event_id)
    assert refreshed is not None
    assert refreshed.status == REPLAY_STATUS_REPLAYED
    assert refreshed.retry_count == 1

    replayed_logs = _obs_payloads(db_session, stream_id, REPLAY_EVENT_REPLAYED_STAGE)
    assert len(replayed_logs) == 1
    _assert_obs_required(replayed_logs[0])


def test_delivery_log_replay_allows_duplicate_send_without_row_lock(
    db_session: Session,
) -> None:
    """Delivery-log replay (legacy) is separate from M11; it does not lock the source log row."""

    from tests.test_delivery_log_replay import _insert_failed_log

    seeded = _seed_stream_runtime(db_session)
    events = [{"event_id": "dl-1", "message": "x"}]
    failed = _insert_failed_log(db_session, seeded=seeded, events=events)
    sender = _FakeWebhookSender()
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    delivery_log_replay_service.replay_delivery_log(
        db_session, int(failed.id), destination_registry=registry
    )
    delivery_log_replay_service.replay_delivery_log(
        db_session, int(failed.id), destination_registry=registry
    )
    db_session.commit()
    assert len(sender.calls) == 2


def test_failover_secondary_failure_records_replay_event(db_session: Session) -> None:
    ctx = _seed_primary_backup(db_session)
    stream_id = ctx["stream_id"]
    before_cp = _checkpoint_value(db_session, stream_id)
    poller = _FakePoller(response={"items": [{"id": "fo-replay", "message": "hi", "vendor": "v"}]})
    sender = _FailoverWebhookSender(fail_urls={ctx["primary_url"], ctx["backup_url"]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)
    db_session.commit()

    rows = (
        db_session.query(StreamReplayEvent)
        .filter(
            StreamReplayEvent.stream_id == stream_id,
            StreamReplayEvent.delivery_kind == DELIVERY_KIND_FAILOVER_SECONDARY,
        )
        .all()
    )
    assert len(rows) == 1
    row = rows[0]
    assert row.status == REPLAY_STATUS_PENDING
    assert row.destination_id == ctx["backup_dest_id"]
    assert isinstance(row.protected_payload_json, dict)
    assert row.protected_payload_json.get("events")
    assert checkpoint_unchanged(db_session, stream_id, before_cp)

    recorded = _obs_payloads(db_session, stream_id, REPLAY_EVENT_RECORDED_STAGE)
    assert recorded
    _assert_obs_required(recorded[-1])


def test_dynamic_route_failure_records_replay_event(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
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
        destination_id=int(security.id),
    )
    _seed_secret_mapping(db_session, stream_id)
    db_session.commit()
    before_cp = _checkpoint_value(db_session, stream_id)

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "dyn-replay",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    base_sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=_SecurityFailWebhookSender(base_sender))
    runner.run(load_stream_context(db_session, stream_id), db=db_session)
    db_session.commit()

    rows = (
        db_session.query(StreamReplayEvent)
        .filter(
            StreamReplayEvent.stream_id == stream_id,
            StreamReplayEvent.delivery_kind == DELIVERY_KIND_BASE_ROUTE,
        )
        .all()
    )
    assert len(rows) == 1
    assert rows[0].status == REPLAY_STATUS_PENDING
    assert rows[0].destination_id == int(security.id)
    after_cp = _checkpoint_value(db_session, stream_id)
    assert after_cp != before_cp


@pytest.mark.parametrize(
    "terminal_status,expected_code",
    [
        (REPLAY_STATUS_REPLAYED, "REPLAY_ALREADY_REPLAYED"),
        (REPLAY_STATUS_DISCARDED, "REPLAY_DISCARDED"),
    ],
)
def test_forbidden_replay_from_terminal_status(
    db_session: Session,
    terminal_status: str,
    expected_code: str,
) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(
        db_session,
        seeded=seeded,
        events=[{"x": 1}],
        status=terminal_status,
    )
    with pytest.raises(ReplayEventStateError) as exc:
        execute_replay_event(
            db_session,
            int(row.id),
            destination_registry=DestinationAdapterRegistry(webhook_sender=_ReplayWebhookSender()),
        )
    assert exc.value.error_code == expected_code


def test_forbidden_discard_from_terminal_status(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(
        db_session,
        seeded=seeded,
        events=[{"x": 1}],
        status=REPLAY_STATUS_REPLAYED,
    )
    with pytest.raises(ReplayEventStateError) as exc:
        discard_replay_event(db_session, int(row.id))
    assert exc.value.error_code == "REPLAY_INVALID_STATE"


def test_replay_payload_hash_unchanged_in_storage(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    events = [{"k": "immutable", "n": 42}]
    before_hash = _payload_hash(events)
    row = _insert_replay_row(db_session, seeded=seeded, events=events)
    sender = _ReplayWebhookSender()
    execute_replay_event(
        db_session,
        int(row.id),
        destination_registry=DestinationAdapterRegistry(webhook_sender=sender),
    )
    db_session.refresh(row)
    stored = row.protected_payload_json.get("events") if isinstance(row.protected_payload_json, dict) else []
    assert _payload_hash(stored) == before_hash
    assert _payload_hash(sender.calls[0]["events"]) == before_hash


def test_summary_uses_stream_replay_events_not_delivery_logs(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    _insert_replay_row(db_session, seeded=seeded, events=[{"a": 1}], status=REPLAY_STATUS_PENDING)
    _insert_replay_row(db_session, seeded=seeded, events=[{"b": 2}], status=REPLAY_STATUS_FAILED)
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage="route_send_failed",
            status="FAILED",
            message="noise",
            payload_sample={"events": [{"z": 99}]},
        )
    )
    db_session.commit()

    engine = db_session.get_bind()
    delivery_log_queries = {"n": 0}

    def _before(_conn, _cursor, statement, _params, _ctx, _many=False) -> None:
        sql = str(statement).lower()
        if "delivery_logs" in sql:
            delivery_log_queries["n"] += 1

    event.listen(engine, "before_cursor_execute", _before)
    try:
        stream_summary = build_stream_replay_summary(db_session, stream_id)
        platform_summary = build_platform_replay_summary(db_session)
    finally:
        event.remove(engine, "before_cursor_execute", _before)

    assert stream_summary["pending_count"] >= 1
    assert stream_summary["failed_count"] >= 1
    assert platform_summary["total_count"] >= 2
    assert delivery_log_queries["n"] == 0


def test_observability_stages_include_required_fields(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    stream_id = int(seeded["stream_id"])
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"id": "obs-1"}])
    dest = db_session.query(Destination).filter(Destination.id == int(seeded["destination_ids"][0])).first()
    assert dest is not None
    url = str((dest.config_json or {}).get("url"))
    fail_registry = DestinationAdapterRegistry(webhook_sender=_ReplayWebhookSender(fail_urls={url}))
    execute_replay_event(db_session, int(row.id), destination_registry=fail_registry)
    db_session.commit()

    for stage in (REPLAY_EVENT_REPLAY_FAILED_STAGE,):
        payloads = _obs_payloads(db_session, stream_id, stage)
        assert payloads
        _assert_obs_required(payloads[-1])

    ok_registry = DestinationAdapterRegistry(webhook_sender=_ReplayWebhookSender())
    execute_replay_event(db_session, int(row.id), destination_registry=ok_registry)
    db_session.commit()
    replayed = _obs_payloads(db_session, stream_id, REPLAY_EVENT_REPLAYED_STAGE)
    assert replayed
    _assert_obs_required(replayed[-1])

    discard_replay_event(db_session, int(_insert_replay_row(db_session, seeded=seeded, events=[{"d": 1}]).id))
    db_session.commit()
    discarded = _obs_payloads(db_session, stream_id, REPLAY_EVENT_DISCARDED_STAGE)
    assert discarded
    _assert_obs_required(discarded[-1])


def test_api_replay_already_replayed_returns_409(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"id": "api-409"}])
    client = _hardening_api_client(db_session)
    sender = _ReplayWebhookSender()
    execute_replay_event(
        db_session,
        int(row.id),
        destination_registry=DestinationAdapterRegistry(webhook_sender=sender),
    )
    db_session.commit()
    resp = client.post(f"/api/v1/runtime/replay-events/{row.id}/replay")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    if isinstance(detail, dict):
        assert detail["error_code"] == "REPLAY_ALREADY_REPLAYED"
    else:
        assert "REPLAY_ALREADY_REPLAYED" in str(detail) or "replayed" in str(detail).lower()
    assert len(sender.calls) == 1
