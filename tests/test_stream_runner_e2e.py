from __future__ import annotations

import uuid
from types import MethodType
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.routes.models import Route
from app.rate_limit.destination_limiter import DestinationRateLimiter
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.sources.models import Source
from app.streams.models import Stream

class _AllowAllLimiter:
    def allow(self, _value: int, rate_limit_json: dict[str, Any] | None = None) -> bool:
        return True


class _DenyAllLimiter:
    def allow(self, _value: int, rate_limit_json: dict[str, Any] | None = None) -> bool:
        return False


class _FakePoller:
    def __init__(self, response: dict[str, Any] | None = None, error: Exception | None = None) -> None:
        self.response = response if response is not None else {"items": []}
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def fetch(self, source_config: dict[str, Any], stream_config: dict[str, Any], checkpoint: dict[str, Any] | None) -> Any:
        self.calls.append(
            {
                "source_config": source_config,
                "stream_config": stream_config,
                "checkpoint": checkpoint,
            }
        )
        if self.error is not None:
            raise self.error
        return self.response


class _FakeWebhookSender:
    def __init__(self, fail_urls: set[str] | None = None) -> None:
        self.fail_urls = fail_urls or set()
        self.calls: list[dict[str, Any]] = []

    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self.calls.append({"events": events, "config": config, "formatter_override": formatter_override})
        if config.get("url") in self.fail_urls:
            raise RuntimeError(f"webhook send failed: {config.get('url')}")


class _RetryAwareWebhookSender:
    def __init__(self, fail_count_by_url: dict[str, int] | None = None) -> None:
        self.fail_count_by_url = dict(fail_count_by_url or {})
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
        remaining_failures = self.fail_count_by_url.get(url, 0)
        if remaining_failures > 0:
            self.fail_count_by_url[url] = remaining_failures - 1
            raise RuntimeError(f"webhook send failed: {url}")


class _FailIfCalledSyslogSender:
    def send(
        self,
        events: list[dict[str, Any]],
        config: dict[str, Any],
        formatter_override: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:  # pragma: no cover
        raise AssertionError("syslog sender should not be called in these tests")


@pytest.fixture
def db(db_session: Session) -> Session:
    return db_session


def _seed_stream_runtime(
    db: Session,
    *,
    failure_policies: list[str] | None = None,
    route_enabled_flags: list[bool] | None = None,
    override_policy: str = "KEEP_EXISTING",
    route_rate_limit_jsons: list[dict[str, Any]] | None = None,
    destination_rate_limit_jsons: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    suffix = uuid.uuid4().hex[:10]
    connector_name = f"pytest-sr-{suffix}"
    stream_name = f"pytest-sr-stream-{suffix}"

    connector = Connector(name=connector_name, description="stream runner e2e", status="RUNNING")
    db.add(connector)
    db.flush()

    source = Source(
        connector_id=connector.id,
        source_type="HTTP_API_POLLING",
        config_json={"base_url": "https://api.example.com"},
        auth_json={"Authorization": "Bearer test"},
        enabled=True,
    )
    db.add(source)
    db.flush()

    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name=stream_name,
        stream_type="HTTP_API_POLLING",
        config_json={"endpoint": "/events", "event_array_path": "$.items"},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={"max_requests": 10, "per_seconds": 60},
    )
    db.add(stream)
    db.flush()

    mapping = Mapping(
        stream_id=stream.id,
        event_array_path="$.items",
        field_mappings_json={"event_id": "$.id", "message": "$.message", "vendor": "$.vendor"},
        raw_payload_mode="JSON",
    )
    enrichment = Enrichment(
        stream_id=stream.id,
        enrichment_json={"vendor": "MappedVendorShouldWin", "product": "GDC"},
        override_policy=override_policy,
        enabled=True,
    )
    db.add_all([mapping, enrichment])
    db.flush()

    policies = failure_policies if failure_policies is not None else ["LOG_AND_CONTINUE"]
    enabled_flags = route_enabled_flags if route_enabled_flags is not None else [True for _ in policies]

    routes: list[Route] = []
    destinations: list[Destination] = []
    for idx, policy in enumerate(policies):
        dest_rl = {"max_events": 100, "per_seconds": 1}
        if destination_rate_limit_jsons is not None and idx < len(destination_rate_limit_jsons):
            dest_rl = destination_rate_limit_jsons[idx]

        destination = Destination(
            name=f"pytest-sr-dest-{suffix}-{idx}",
            destination_type="WEBHOOK_POST",
            config_json={"url": f"https://receiver-{idx}.example.com/events"},
            rate_limit_json=dest_rl,
            enabled=True,
        )
        db.add(destination)
        db.flush()
        destinations.append(destination)

        route_rl: dict[str, Any] = {}
        if route_rate_limit_jsons is not None and idx < len(route_rate_limit_jsons):
            route_rl = route_rate_limit_jsons[idx]

        route = Route(
            stream_id=stream.id,
            destination_id=destination.id,
            enabled=enabled_flags[idx],
            failure_policy=policy,
            formatter_config_json={},
            rate_limit_json=route_rl,
            status="ENABLED",
        )
        db.add(route)
        db.flush()
        routes.append(route)

    checkpoint = Checkpoint(
        stream_id=stream.id,
        checkpoint_type="EVENT_ID",
        checkpoint_value_json={"last_success_event": {"event_id": "seed-0"}},
    )
    db.add(checkpoint)
    db.commit()

    return {
        "stream_id": stream.id,
        "stream_name": stream.name,
        "connector_id": connector.id,
        "connector_name": connector.name,
        "route_ids": [route.id for route in routes],
        "destination_ids": [destination.id for destination in destinations],
        "destination_names": [destination.name for destination in destinations],
    }


def _add_enabled_route_for_destination(
    db: Session,
    stream_id: int,
    destination_id: int,
    *,
    enabled: bool = True,
) -> Route:
    """Attach an existing destination to the stream as a first-class Route."""

    route = Route(
        stream_id=int(stream_id),
        destination_id=int(destination_id),
        enabled=enabled,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED" if enabled else "DISABLED",
    )
    db.add(route)
    db.flush()
    return route


def _checkpoint_value(db: Session, stream_id: int) -> dict[str, Any]:
    row = db.query(Checkpoint).filter(Checkpoint.stream_id == stream_id).first()
    assert row is not None
    return row.checkpoint_value_json


def _build_runner(
    *,
    poller: _FakePoller,
    webhook_sender: _FakeWebhookSender,
    source_limiter: Any | None = None,
    destination_limiter: Any | None = None,
) -> StreamRunner:
    return StreamRunner(
        poller=poller,
        source_limiter=source_limiter if source_limiter is not None else _AllowAllLimiter(),
        destination_limiter=destination_limiter if destination_limiter is not None else _AllowAllLimiter(),
        webhook_sender=webhook_sender,
        syslog_sender=_FailIfCalledSyslogSender(),
    )


def _count_commits(db: Session) -> list[None]:
    original_commit = db.commit
    calls: list[None] = []

    def _wrapped_commit(self: Session) -> None:
        calls.append(None)
        original_commit()

    db.commit = MethodType(_wrapped_commit, db)  # type: ignore[method-assign]
    return calls


def _count_rollbacks(db: Session) -> list[None]:
    original_rollback = db.rollback
    calls: list[None] = []

    def _wrapped_rollback(self: Session) -> None:
        calls.append(None)
        original_rollback()

    db.rollback = MethodType(_wrapped_rollback, db)  # type: ignore[method-assign]
    return calls


def _delivery_logs(db: Session, stream_id: int) -> list[DeliveryLog]:
    return (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id)
        .order_by(DeliveryLog.id.asc())
        .all()
    )


def test_stream_runner_run_id_consistent_across_persisted_logs(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])

    poller = _FakePoller(response={"items": [{"id": "evt-runid", "message": "hello", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)

    runner.run(context, db=db)

    rows = _delivery_logs(db, seeded["stream_id"])
    assert rows
    distinct_run_ids = {row.run_id for row in rows}
    non_null = {rid for rid in distinct_run_ids if rid}
    assert len(non_null) == 1


def test_runtime_emitted_logs_successful_single_destination_flow(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])

    poller = _FakePoller(response={"items": [{"id": "evt-1", "message": "hello", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(poller.calls) == 1
    assert len(sender.calls) == 1
    payload = sender.calls[0]["events"][0]
    assert payload["event_id"] == "evt-1"
    assert payload["message"] == "hello"
    assert payload["vendor"] == "MappedVendor"
    assert payload["product"] == "GDC"
    assert before_checkpoint != after_checkpoint
    assert after_checkpoint["last_success_event"]["event_id"] == "evt-1"

    rows = _delivery_logs(db, seeded["stream_id"])
    success_logs = [row for row in rows if row.stage == "route_send_success"]
    assert len(success_logs) == 1
    assert success_logs[0].route_id == seeded["route_ids"][0]


def test_runtime_emitted_logs_multi_destination_fan_out_success(db: Session) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    context = load_stream_context(db, seeded["stream_id"])

    poller = _FakePoller(response={"items": [{"id": "evt-2", "message": "fanout", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)

    runner.run(context, db=db)
    checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(sender.calls) == 2
    sent_urls = {call["config"]["url"] for call in sender.calls}
    assert sent_urls == {
        "https://receiver-0.example.com/events",
        "https://receiver-1.example.com/events",
    }
    assert checkpoint["last_success_event"]["event_id"] == "evt-2"

    rows = _delivery_logs(db, seeded["stream_id"])
    success_logs = [row for row in rows if row.stage == "route_send_success"]
    assert len(success_logs) == 2
    assert {row.route_id for row in success_logs} == set(seeded["route_ids"])


def test_runtime_emitted_logs_partial_destination_failure_no_checkpoint_advance_for_pause_policy(db: Session) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "PAUSE_STREAM_ON_FAILURE"])
    context = load_stream_context(db, seeded["stream_id"])

    poller = _FakePoller(response={"items": [{"id": "evt-3", "message": "partial", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender(fail_urls={"https://receiver-1.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(sender.calls) == 2
    assert before_checkpoint == after_checkpoint

    rows = _delivery_logs(db, seeded["stream_id"])
    failure_logs = [row for row in rows if row.stage == "route_send_failed"]
    assert len(failure_logs) == 1
    assert failure_logs[0].message is not None
    assert failure_logs[0].route_id == seeded["route_ids"][1]
    assert context.stream["status"] == "PAUSED"


def test_runtime_emitted_logs_disabled_route_ignored_enabled_route_still_works(db: Session) -> None:
    seeded = _seed_stream_runtime(
        db,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
        route_enabled_flags=[True, False],
    )
    context = load_stream_context(db, seeded["stream_id"])

    poller = _FakePoller(response={"items": [{"id": "evt-4", "message": "enabled-only", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)

    runner.run(context, db=db)
    checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(sender.calls) == 1
    assert sender.calls[0]["config"]["url"] == "https://receiver-0.example.com/events"
    assert checkpoint["last_success_event"]["event_id"] == "evt-4"
    rows = _delivery_logs(db, seeded["stream_id"])
    assert not any(row.stage == "route_send_success" and row.route_id == seeded["route_ids"][1] for row in rows)


def test_runtime_emitted_logs_mapping_then_enrichment_ordering_keep_existing_policy(db: Session) -> None:
    seeded = _seed_stream_runtime(db, override_policy="KEEP_EXISTING")
    context = load_stream_context(db, seeded["stream_id"])

    poller = _FakePoller(response={"items": [{"id": "evt-5", "message": "ordering", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)

    runner.run(context, db=db)

    assert len(sender.calls) == 1
    payload = sender.calls[0]["events"][0]
    assert payload["event_id"] == "evt-5"
    assert payload["message"] == "ordering"
    assert payload["product"] == "GDC"
    assert payload["vendor"] == "MappedVendor"
    assert payload["vendor"] != "MappedVendorShouldWin"

    rows = _delivery_logs(db, seeded["stream_id"])
    success_logs = [row for row in rows if row.stage == "run_complete"]
    assert success_logs
    assert success_logs[-1].status == "COMPLETED"


def test_runtime_emitted_logs_source_fetch_failure_no_send_no_checkpoint_update_and_error_logged(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])

    poller = _FakePoller(error=RuntimeError("source fetch failed"))
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    with pytest.raises(RuntimeError, match="source fetch failed"):
        runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(sender.calls) == 0
    assert before_checkpoint == after_checkpoint

    # Failure telemetry is committed on an isolated session (not the request session).
    db.expire_all()
    persisted = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "run_failed")
        .first()
    )
    assert persisted is not None
    assert any(
        row.stage == "run_started"
        for row in db.query(DeliveryLog).filter(DeliveryLog.stream_id == seeded["stream_id"]).all()
    )


def test_persisted_delivery_logs_success_path(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])
    poller = _FakePoller(response={"items": [{"id": "evt-6", "message": "persist-gap", "vendor": "MappedVendor"}]})
    runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())

    runner.run(context, db=db)

    rows = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    )
    assert any(row.stage == "route_send_success" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)

    success_row = next(row for row in rows if row.stage == "route_send_success")
    assert success_row.stream_id == seeded["stream_id"]
    assert success_row.route_id == seeded["route_ids"][0]
    assert success_row.destination_id == seeded["destination_ids"][0]
    assert success_row.level == "INFO"
    assert success_row.status == "OK"


def test_persisted_delivery_logs_failure_path(db: Session) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["PAUSE_STREAM_ON_FAILURE"])
    context = load_stream_context(db, seeded["stream_id"])
    poller = _FakePoller(response={"items": [{"id": "evt-7", "message": "persist-gap-fail", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)

    runner.run(context, db=db)

    rows = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    )
    assert any(row.stage == "route_send_failed" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)

    failed_row = next(row for row in rows if row.stage == "route_send_failed")
    assert failed_row.stream_id == seeded["stream_id"]
    assert failed_row.route_id == seeded["route_ids"][0]
    assert failed_row.destination_id == seeded["destination_ids"][0]
    assert failed_row.level == "ERROR"
    assert failed_row.status == "FAILED"
    assert failed_row.error_code == "RuntimeError"


def test_runner_owns_single_commit_on_success_with_checkpoint_and_logs(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)

    poller = _FakePoller(response={"items": [{"id": "evt-commit-1", "message": "ok", "vendor": "MappedVendor"}]})
    runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())

    runner.run(context, db=db)

    # Runner must not commit the caller Session (short-session writes only).
    assert len(commit_calls) == 0
    checkpoint = _checkpoint_value(db, seeded["stream_id"])
    assert checkpoint["last_success_event"]["event_id"] == "evt-commit-1"

    rows = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    )
    assert any(row.stage == "route_send_success" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)


def test_runner_owns_single_commit_on_partial_failure_logs_without_checkpoint_update(db: Session) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "PAUSE_STREAM_ON_FAILURE"])
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)

    poller = _FakePoller(response={"items": [{"id": "evt-commit-2", "message": "partial", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender(fail_urls={"https://receiver-1.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(commit_calls) == 0
    assert before_checkpoint == after_checkpoint

    rows = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    )
    assert any(row.stage == "route_send_failed" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)


def test_runner_owns_failure_commit_for_run_failed_without_checkpoint_update(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)
    rollback_calls = _count_rollbacks(db)

    poller = _FakePoller(error=RuntimeError("source fetch failed"))
    runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    with pytest.raises(RuntimeError, match="source fetch failed"):
        runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    # Request-session commit/rollback stay quiet; runner owns failure telemetry
    # via an isolated short-lived write session.
    assert len(commit_calls) == 0
    assert len(rollback_calls) == 0
    assert before_checkpoint == after_checkpoint

    db.expire_all()
    failed = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "run_failed")
        .first()
    )
    assert failed is not None


def test_retry_and_backoff_success_updates_checkpoint_with_single_commit(db: Session) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["RETRY_AND_BACKOFF"])
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)

    # Avoid sleep during retries in tests.
    context.routes[0]["retry_count"] = 2
    context.routes[0]["backoff_seconds"] = 0

    poller = _FakePoller(response={"items": [{"id": "evt-retry-1", "message": "retry-ok", "vendor": "MappedVendor"}]})
    sender = _RetryAwareWebhookSender({"https://receiver-0.example.com/events": 1})
    runner = _build_runner(poller=poller, webhook_sender=sender)  # type: ignore[arg-type]

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(commit_calls) == 0
    assert len(sender.calls) == 2
    assert before_checkpoint != after_checkpoint
    assert after_checkpoint["last_success_event"]["event_id"] == "evt-retry-1"
    rows = _delivery_logs(db, seeded["stream_id"])
    assert any(row.stage == "route_send_failed" for row in rows)
    assert any(row.stage == "route_retry_success" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)
    assert not any(row.stage == "run_failed" for row in rows)


def test_retry_and_backoff_exhausted_does_not_update_checkpoint_with_single_commit(
    db: Session
) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["RETRY_AND_BACKOFF"])
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)

    # Avoid sleep during retries in tests.
    context.routes[0]["retry_count"] = 2
    context.routes[0]["backoff_seconds"] = 0

    poller = _FakePoller(response={"items": [{"id": "evt-retry-2", "message": "retry-fail", "vendor": "MappedVendor"}]})
    sender = _RetryAwareWebhookSender({"https://receiver-0.example.com/events": 3})
    runner = _build_runner(poller=poller, webhook_sender=sender)  # type: ignore[arg-type]

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(commit_calls) == 0
    assert len(sender.calls) == 3
    assert before_checkpoint == after_checkpoint
    rows = _delivery_logs(db, seeded["stream_id"])
    assert any(row.stage == "route_send_failed" for row in rows)
    assert any(row.stage == "route_retry_failed" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)
    assert not any(row.stage == "run_failed" for row in rows)


def test_disable_route_on_failure_stages_route_disable_with_single_runner_commit(
    db: Session
) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["DISABLE_ROUTE_ON_FAILURE"])
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)
    rollback_calls = _count_rollbacks(db)

    poller = _FakePoller(response={"items": [{"id": "evt-disable-1", "message": "disable", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)

    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])
    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(commit_calls) == 0
    # One rollback releases the caller read txn before destination I/O.
    assert len(rollback_calls) == 1
    assert before_checkpoint == after_checkpoint
    assert context.routes[0]["enabled"] is False

    route_row = db.query(Route).filter(Route.id == seeded["route_ids"][0]).first()
    assert route_row is not None
    assert route_row.enabled is False

    rows = _delivery_logs(db, seeded["stream_id"])
    assert any(row.stage == "route_send_failed" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)
    assert not any(row.stage == "run_failed" for row in rows)


def test_source_rate_limited_is_persisted_with_single_commit(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)
    rollback_calls = _count_rollbacks(db)

    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-rate-1"}]}),
        webhook_sender=_FakeWebhookSender(),
        source_limiter=_DenyAllLimiter(),
    )

    runner.run(context, db=db)

    # No destination I/O → no caller txn release; runtime writes use short sessions.
    assert len(commit_calls) == 0
    assert len(rollback_calls) == 0
    assert context.stream["status"] == "RATE_LIMITED_SOURCE"
    row = db.query(DeliveryLog).filter(
        DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "source_rate_limited"
    ).first()
    assert row is not None
    assert row.level == "WARN"
    assert row.status == "RATE_LIMITED"
    assert row.error_code == "SOURCE_RATE_LIMITED"


def test_destination_rate_limited_is_persisted_and_checkpoint_unchanged_with_single_commit(
    db: Session
) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)
    rollback_calls = _count_rollbacks(db)
    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-rate-2", "message": "rate", "vendor": "MappedVendor"}]}),
        webhook_sender=_FakeWebhookSender(),
        destination_limiter=_DenyAllLimiter(),
    )

    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(commit_calls) == 0
    assert len(rollback_calls) == 1
    assert before_checkpoint == after_checkpoint
    rows = _delivery_logs(db, seeded["stream_id"])
    assert any(row.stage == "destination_rate_limited" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)
    drl = next(r for r in rows if r.stage == "destination_rate_limited")
    assert drl.error_code == "DESTINATION_RATE_LIMITED"
    assert drl.destination_id == seeded["destination_ids"][0]


def test_route_rate_limit_json_second_run_skips_sender(db: Session) -> None:
    seeded = _seed_stream_runtime(
        db,
        route_rate_limit_jsons=[{"max_events": 1, "per_seconds": 3600}],
    )
    context = load_stream_context(db, seeded["stream_id"])
    poller = _FakePoller(response={"items": [{"id": "rl-1", "message": "m", "vendor": "V"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=poller,
        webhook_sender=sender,
        destination_limiter=DestinationRateLimiter(),
    )
    commit_calls = _count_commits(db)

    runner.run(context, db=db)
    assert len(sender.calls) == 1

    runner.run(context, db=db)
    assert len(sender.calls) == 1
    assert len(commit_calls) == 0

    rows = _delivery_logs(db, seeded["stream_id"])
    assert any(r.stage == "route_send_success" for r in rows)
    lim_rows = [r for r in rows if r.stage == "destination_rate_limited"]
    assert len(lim_rows) >= 1
    assert lim_rows[-1].route_id == seeded["route_ids"][0]
    assert lim_rows[-1].destination_id == seeded["destination_ids"][0]
    assert lim_rows[-1].error_code == "DESTINATION_RATE_LIMITED"


def test_route_rate_limit_overrides_destination_rate_limit(db: Session) -> None:
    seeded = _seed_stream_runtime(
        db,
        route_rate_limit_jsons=[{"max_events": 1, "per_seconds": 3600}],
        destination_rate_limit_jsons=[{"max_events": 50, "per_seconds": 3600}],
    )
    context = load_stream_context(db, seeded["stream_id"])
    poller = _FakePoller(response={"items": [{"id": "ov-1", "message": "m", "vendor": "V"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=poller,
        webhook_sender=sender,
        destination_limiter=DestinationRateLimiter(),
    )

    runner.run(context, db=db)
    runner.run(context, db=db)
    assert len(sender.calls) == 1


def test_destination_rate_limit_used_when_route_empty(db: Session) -> None:
    seeded = _seed_stream_runtime(
        db,
        destination_rate_limit_jsons=[{"max_events": 1, "per_seconds": 3600}],
    )
    context = load_stream_context(db, seeded["stream_id"])
    poller = _FakePoller(response={"items": [{"id": "df-1", "message": "m", "vendor": "V"}]})
    sender = _FakeWebhookSender()
    runner = _build_runner(
        poller=poller,
        webhook_sender=sender,
        destination_limiter=DestinationRateLimiter(),
    )

    runner.run(context, db=db)
    runner.run(context, db=db)
    assert len(sender.calls) == 1


def test_route_skip_is_persisted_with_single_runner_commit(db: Session) -> None:
    seeded = _seed_stream_runtime(
        db,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
        route_enabled_flags=[True, True],
    )
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)
    rollback_calls = _count_rollbacks(db)

    # Force one route to be skipped at runtime while keeping two routes loaded.
    context.routes[1]["enabled"] = False
    if isinstance(context.stream, dict) and "routes" in context.stream:
        context.stream["routes"][1]["enabled"] = False

    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-skip-1", "message": "skip", "vendor": "MappedVendor"}]}),
        webhook_sender=_FakeWebhookSender(),
    )

    runner.run(context, db=db)

    assert len(commit_calls) == 0
    assert len(rollback_calls) == 1
    rows = _delivery_logs(db, seeded["stream_id"])
    assert any(row.stage == "route_skip" for row in rows)
    assert any(row.stage == "route_send_success" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)


def test_route_unknown_failure_policy_is_persisted_with_single_commit(
    db: Session
) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["UNKNOWN_POLICY"])
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)
    rollback_calls = _count_rollbacks(db)
    before_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    sender = _FakeWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    runner = _build_runner(
        poller=_FakePoller(response={"items": [{"id": "evt-unknown-1", "message": "unknown", "vendor": "MappedVendor"}]}),
        webhook_sender=sender,
    )

    runner.run(context, db=db)
    after_checkpoint = _checkpoint_value(db, seeded["stream_id"])

    assert len(commit_calls) == 0
    assert len(rollback_calls) == 1
    assert before_checkpoint == after_checkpoint
    rows = _delivery_logs(db, seeded["stream_id"])
    assert any(row.stage == "route_send_failed" for row in rows)
    assert any(row.stage == "route_unknown_failure_policy" for row in rows)
    assert any(row.stage == "run_complete" for row in rows)


def test_run_skip_on_lock_conflict_has_no_commit_no_rollback_no_pipeline_execution(
    db: Session
) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])
    commit_calls = _count_commits(db)
    rollback_calls = _count_rollbacks(db)

    # Simulate lock contention by pre-acquiring StreamRunner's lock for this stream.
    lock = StreamRunner._get_lock(seeded["stream_id"])
    assert lock.acquire(blocking=False) is True
    try:
        poller = _FakePoller(response={"items": [{"id": "evt-lock-1"}]})
        runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())

        runner.run(context, db=db)

        assert len(commit_calls) == 0
        assert len(rollback_calls) == 0
        assert len(poller.calls) == 0
        assert db.query(DeliveryLog).filter(DeliveryLog.stream_id == seeded["stream_id"]).count() == 0

        # run() must not release lock when acquire failed.
        assert lock.acquire(blocking=False) is False
    finally:
        lock.release()


def test_checkpoint_update_delivery_log_contains_trace_fields(db: Session) -> None:
    seeded = _seed_stream_runtime(db)
    context = load_stream_context(db, seeded["stream_id"])
    poller = _FakePoller(response={"items": [{"id": "evt-trace-1", "message": "hello", "vendor": "MappedVendor"}]})
    runner = _build_runner(poller=poller, webhook_sender=_FakeWebhookSender())
    runner.run(context, db=db)

    ck = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "checkpoint_update")
        .first()
    )
    assert ck is not None
    ps = ck.payload_sample
    assert isinstance(ps, dict)
    assert ps.get("update_reason") == "full_delivery_success"
    assert ps.get("processed_events") == 1
    assert ps.get("delivered_events") == 1
    assert ps.get("partial_success") is False
    assert "checkpoint_before" in ps
    assert "checkpoint_after" in ps

    rc = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "run_complete")
        .order_by(DeliveryLog.id.desc())
        .first()
    )
    assert rc is not None
    rps = rc.payload_sample
    assert isinstance(rps, dict)
    assert rps.get("checkpoint_updated") is True
    assert rps.get("retry_pending") is False


def test_checkpoint_not_advanced_skipped_has_run_complete_retry_hint(db: Session) -> None:
    seeded = _seed_stream_runtime(db, failure_policies=["DISABLE_ROUTE_ON_FAILURE"])
    context = load_stream_context(db, seeded["stream_id"])
    poller = _FakePoller(response={"items": [{"id": "evt-skip-1", "message": "hello", "vendor": "MappedVendor"}]})
    sender = _FakeWebhookSender(fail_urls={"https://receiver-0.example.com/events"})
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(context, db=db)

    assert (
        db.query(DeliveryLog).filter(DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "checkpoint_update").count()
        == 0
    )
    rc = (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == seeded["stream_id"], DeliveryLog.stage == "run_complete")
        .first()
    )
    assert rc is not None
    rps = rc.payload_sample
    assert isinstance(rps, dict)
    assert rps.get("checkpoint_updated") is False
    assert rps.get("retry_pending") is True
    assert rps.get("update_reason") == "skipped_due_to_failure"
