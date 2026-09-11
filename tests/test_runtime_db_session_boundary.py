"""P1: caller/request Session must not stay in a transaction during destination I/O."""

from __future__ import annotations

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from app.destinations.adapters.registry import DestinationAdapterRegistry
from app.destinations.models import Destination
from app.failover_routing.operator_workflow import create_failover_route
from app.replay.service import ReplayInProgressError, execute_replay_event
from app.routes.models import Route
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.runners.stream_runner_db import release_caller_transaction
from tests.test_replay_engine_m11 import _insert_replay_row, _seed_stream_runtime as _seed_replay_stream
from tests.test_stream_runner_e2e import _FakePoller, _build_runner, _seed_stream_runtime


class _InstrumentedWebhookSender:
    """Webhook sender that records whether the caller Session is mid-transaction during send."""

    def __init__(self, *, hold_s: float = 0.05, fail_urls: set[str] | None = None) -> None:
        self.hold_s = hold_s
        self.fail_urls = fail_urls or set()
        self.calls: list[dict[str, Any]] = []
        self.caller_db: Session | None = None
        self.observed_caller_in_transaction: list[bool] = []
        self.in_send = threading.Event()
        self.release = threading.Event()

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        _ = formatter_override, kwargs
        self.calls.append({"events": events, "config": config})
        db = self.caller_db
        if db is not None and hasattr(db, "in_transaction"):
            self.observed_caller_in_transaction.append(bool(db.in_transaction()))
        self.in_send.set()
        if not self.release.is_set():
            self.release.wait(timeout=self.hold_s)
        if config.get("url") in self.fail_urls:
            raise TimeoutError(f"webhook send failed: {config.get('url')}")


def test_destination_send_caller_transaction_inactive(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_ROUTE_PROCESSING_ENABLED", True)
    seeded = _seed_stream_runtime(db_session)
    sender = _InstrumentedWebhookSender(hold_s=0.15)
    sender.caller_db = db_session
    poller = _FakePoller(response={"items": [{"id": "e1", "message": "hi", "vendor": "v"}]})
    runner = _build_runner(poller=poller, webhook_sender=sender)

    ctx = load_stream_context(db_session, seeded["stream_id"])
    runner.run(ctx, db=db_session)

    assert sender.calls
    assert sender.observed_caller_in_transaction
    assert all(active is False for active in sender.observed_caller_in_transaction)


def test_multi_route_send_caller_transaction_inactive(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_ROUTE_PROCESSING_ENABLED", True)
    seeded = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    sender = _InstrumentedWebhookSender(hold_s=0.05)
    sender.caller_db = db_session
    poller = _FakePoller(response={"items": [{"id": "e2", "message": "multi", "vendor": "v"}]})
    runner = _build_runner(poller=poller, webhook_sender=sender)

    ctx = load_stream_context(db_session, seeded["stream_id"])
    runner.run(ctx, db=db_session)

    assert len(sender.calls) >= 2
    assert sender.observed_caller_in_transaction
    assert all(active is False for active in sender.observed_caller_in_transaction)


def test_failover_primary_and_secondary_send_caller_txn_inactive(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session, failure_policies=["LOG_AND_CONTINUE"])
    route = db_session.query(Route).filter(Route.stream_id == seeded["stream_id"]).one()
    primary = db_session.get(Destination, int(route.destination_id))
    assert primary is not None
    primary_url = str((primary.config_json or {}).get("url"))
    secondary = Destination(
        name="sess-bound-secondary",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://backup-session-boundary.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add(secondary)
    db_session.flush()
    create_failover_route(
        db_session,
        stream_id=seeded["stream_id"],
        primary_destination_id=int(primary.id),
        secondary_destination_id=int(secondary.id),
        enabled=True,
    )
    db_session.commit()

    sender = _InstrumentedWebhookSender(hold_s=0.05, fail_urls={primary_url})
    sender.caller_db = db_session
    poller = _FakePoller(response={"items": [{"id": "e3", "message": "fo", "vendor": "v"}]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(load_stream_context(db_session, seeded["stream_id"]), db=db_session)

    assert len(sender.calls) >= 2
    assert sender.observed_caller_in_transaction
    assert all(active is False for active in sender.observed_caller_in_transaction)


def test_replay_send_caller_transaction_inactive(db_session: Session) -> None:
    seeded = _seed_replay_stream(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"event_id": "r1", "message": "replay"}])
    sender = _InstrumentedWebhookSender(hold_s=0.15)
    sender.caller_db = db_session
    registry = DestinationAdapterRegistry(webhook_sender=sender)

    result = execute_replay_event(db_session, int(row.id), destination_registry=registry)
    assert result["outcome"] == "replayed"
    assert sender.observed_caller_in_transaction
    assert all(active is False for active in sender.observed_caller_in_transaction)


def test_replay_concurrent_second_worker_sees_in_progress(
    db_session: Session,
    db_engine: Any,
) -> None:
    seeded = _seed_replay_stream(db_session)
    row = _insert_replay_row(db_session, seeded=seeded, events=[{"event_id": "conc"}])
    event_id = int(row.id)

    sender = _InstrumentedWebhookSender(hold_s=2.0)
    registry = DestinationAdapterRegistry(webhook_sender=sender)
    SessionLocal = sessionmaker(bind=db_engine, expire_on_commit=False)
    barrier = threading.Barrier(2)
    results: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def _worker() -> None:
        session = SessionLocal()
        try:
            barrier.wait(timeout=5)
            out = execute_replay_event(session, event_id, destination_registry=registry)
            session.commit()
            results.append(out)
        except BaseException as exc:
            session.rollback()
            errors.append(exc)
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = [pool.submit(_worker), pool.submit(_worker)]
        assert sender.in_send.wait(timeout=5.0)
        sender.release.set()
        for fut in as_completed(futs):
            fut.result()

    assert len(sender.calls) == 1
    success = [r for r in results if r.get("outcome") == "replayed"]
    assert len(success) == 1
    assert len(errors) + len(results) == 2
    if errors:
        assert all(isinstance(e, ReplayInProgressError) for e in errors)


def test_release_caller_transaction_helper_ends_txn(db_session: Session) -> None:
    seeded = _seed_stream_runtime(db_session)
    ctx = load_stream_context(db_session, seeded["stream_id"])
    db_session.execute(text("SELECT 1"))
    assert db_session.in_transaction() is True
    release_caller_transaction(db_session, runtime_stream=ctx.stream, stream_arg=ctx, end_with="rollback")
    assert db_session.in_transaction() is False
    db_session.execute(text("SELECT 1"))


def test_unrelated_pending_not_auto_committed_during_destination_send(
    db_session: Session,
    db_engine: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Caller-owned pending rows must survive StreamRunner without being committed."""

    monkeypatch.setattr("app.config.settings.GDC_ROUTE_PROCESSING_ENABLED", True)
    seeded = _seed_stream_runtime(db_session)
    ctx = load_stream_context(db_session, seeded["stream_id"])

    marker = f"ownership-pending-{uuid.uuid4().hex[:12]}"
    unrelated = Destination(
        name=marker,
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://unrelated-ownership.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add(unrelated)
    assert db_session.in_transaction() is True
    assert any(obj is unrelated for obj in db_session.new)

    sender = _InstrumentedWebhookSender(hold_s=0.15)
    sender.caller_db = db_session
    poller = _FakePoller(response={"items": [{"id": "own-1", "message": "hi", "vendor": "v"}]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(ctx, db=db_session)

    assert sender.calls
    assert sender.observed_caller_in_transaction
    assert all(active is False for active in sender.observed_caller_in_transaction)

    OtherSession = sessionmaker(bind=db_engine, expire_on_commit=False)
    with OtherSession() as other:
        assert other.query(Destination).filter(Destination.name == marker).count() == 0

    assert any(getattr(obj, "name", None) == marker for obj in db_session.new)
    db_session.commit()
    with OtherSession() as other:
        assert other.query(Destination).filter(Destination.name == marker).count() == 1


def test_unrelated_pending_update_not_auto_committed_during_destination_send(
    db_session: Session,
    db_engine: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_ROUTE_PROCESSING_ENABLED", True)
    seeded = _seed_stream_runtime(db_session)
    ctx = load_stream_context(db_session, seeded["stream_id"])
    primary = db_session.get(Destination, int(seeded["destination_ids"][0]))
    assert primary is not None
    original_name = str(primary.name)
    dirty_name = f"dirty-{uuid.uuid4().hex[:10]}"
    primary.name = dirty_name
    assert primary in db_session.dirty

    sender = _InstrumentedWebhookSender(hold_s=0.1)
    sender.caller_db = db_session
    poller = _FakePoller(response={"items": [{"id": "own-2", "message": "hi", "vendor": "v"}]})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(ctx, db=db_session)

    assert sender.observed_caller_in_transaction
    assert all(active is False for active in sender.observed_caller_in_transaction)

    OtherSession = sessionmaker(bind=db_engine, expire_on_commit=False)
    with OtherSession() as other:
        row = other.get(Destination, int(seeded["destination_ids"][0]))
        assert row is not None
        assert row.name == original_name

    assert any(getattr(obj, "name", None) == dirty_name for obj in db_session.dirty)
    db_session.commit()
    with OtherSession() as other:
        row = other.get(Destination, int(seeded["destination_ids"][0]))
        assert row is not None
        assert row.name == dirty_name
