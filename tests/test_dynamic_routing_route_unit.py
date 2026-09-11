"""P0-1 — Dynamic Routing selects existing Routes; no destination-direct send."""

from __future__ import annotations

import inspect
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.destinations.models import Destination
from app.dynamic_routing.operator_workflow import DynamicRouteValidationError, create_dynamic_route
from app.failover_routing.operator_workflow import create_failover_route
from app.logs.models import DeliveryLog
from app.mappings.models import Mapping
from app.protection.models import POLICY_ACTION_BLOCK, PROTECTION_MODE_FULL_MASK
from app.route_policy.models import RoutePolicyRule
from app.route_protection.models import RouteProtectionRule
from app.route_transform.models import RouteMapping
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner import StreamRunner
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII, SENSITIVITY_CLASS_SECRET
from tests.test_failover_routing_m10 import _FailoverWebhookSender
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _add_enabled_route_for_destination,
    _build_runner,
    _checkpoint_value,
    _seed_stream_runtime,
)

EMAIL_MASK = "********"
SECRET_EVENT = {
    "id": "evt-dyn-route-unit",
    "api_key": "super-secret-token-value",
    "email": "alice@example.com",
    "message": "hello",
    "vendor": "v",
}


def _enable_route_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_PROTECTION_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_CLASSIFICATION_ENABLED", True)
    monkeypatch.setattr(settings, "GDC_SENSITIVE_DETECTION_ENABLED", True)


def _seed_secret_and_email_mapping(db: Session, stream_id: int) -> None:
    mapping = db.query(Mapping).filter(Mapping.stream_id == stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
        "email": "$.email",
    }


def _events_by_url(sender: _FakeWebhookSender) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for call in sender.calls:
        url = str(call["config"]["url"])
        out.setdefault(url, []).extend(list(call["events"]))
    return out


def test_dynamic_route_create_rejects_destination_without_existing_route(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    dest = Destination(
        name="Orphan dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://orphan.example.com/events"},
        enabled=True,
    )
    db_session.add(dest)
    db_session.flush()
    with pytest.raises(DynamicRouteValidationError, match="no existing route"):
        create_dynamic_route(
            db_session,
            stream_id=fixture["stream_id"],
            name="orphan",
            enabled=True,
            condition_json={"sensitivity_class": "secret"},
            destination_id=int(dest.id),
        )


def test_deliver_dynamic_routes_has_no_direct_destination_send() -> None:
    src = inspect.getsource(StreamRunner._deliver_dynamic_routes)
    assert "_send_to_destination" not in src
    assert "duplicate_base_route" in src
    src_fan = inspect.getsource(StreamRunner._fan_out)
    assert "per_route_protection_active_dynamic_uses_stream_payload" not in src_fan


def test_dynamic_route_cannot_bypass_protection(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    fixture = _seed_stream_runtime(
        db_session,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = int(fixture["stream_id"])
    route_a, route_b = (int(rid) for rid in fixture["route_ids"])
    url_a = "https://receiver-0.example.com/events"
    url_b = "https://receiver-1.example.com/events"
    _seed_secret_and_email_mapping(db_session, stream_id)
    db_session.add(
        RouteProtectionRule(
            route_id=route_a,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="p0-1",
        )
    )
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Select A",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        route_id=route_a,
    )
    db_session.commit()

    sender = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response={"items": [dict(SECRET_EVENT)]}), webhook_sender=sender)
    original_send = runner._send_to_destination
    send_sites: list[str] = []

    def _wrapped_send(*args: Any, **kwargs: Any) -> Any:
        send_sites.append("route_pipeline")
        return original_send(*args, **kwargs)

    runner._send_to_destination = _wrapped_send  # type: ignore[method-assign]
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    by_url = _events_by_url(sender)
    assert set(by_url) == {url_a, url_b}
    assert [c["config"]["url"] for c in sender.calls].count(url_a) == 1
    assert [c["config"]["url"] for c in sender.calls].count(url_b) == 1
    assert by_url[url_a][0]["email"] == EMAIL_MASK
    assert by_url[url_b][0]["email"] == "alice@example.com"
    assert send_sites
    assert not any(
        row.stage == "dynamic_route_send_success"
        for row in db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id)
    )


def test_dynamic_route_cannot_bypass_policy_block(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    route_a = int(fixture["route_ids"][0])
    _seed_secret_and_email_mapping(db_session, stream_id)
    db_session.add(
        RoutePolicyRule(
            route_id=route_a,
            name="block secrets",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_SECRET},
            action_type=POLICY_ACTION_BLOCK,
        )
    )
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Select blocked A",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        route_id=route_a,
    )
    db_session.commit()

    before = _checkpoint_value(db_session, stream_id)
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response={"items": [dict(SECRET_EVENT)]}), webhook_sender=sender)
    summary = runner.run(load_stream_context(db_session, stream_id), db=db_session)

    assert sender.calls == []
    assert summary.get("checkpoint_updated") is not True
    assert _checkpoint_value(db_session, stream_id) == before
    assert not any(
        row.stage == "dynamic_route_send_success"
        for row in db_session.query(DeliveryLog).filter(DeliveryLog.stream_id == stream_id)
    )


def test_dynamic_route_uses_transformed_route_payload(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    fixture = _seed_stream_runtime(
        db_session,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = int(fixture["stream_id"])
    route_a, _route_b = (int(rid) for rid in fixture["route_ids"])
    url_a = "https://receiver-0.example.com/events"
    _seed_secret_and_email_mapping(db_session, stream_id)
    db_session.add(
        RouteMapping(
            route_id=route_a,
            field_mappings_json={
                "event_id": "$.id",
                "normalized_message": "$.message",
                "unmapped_fields_policy": "drop_unmapped",
            },
        )
    )
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Select transformed A",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        route_id=route_a,
    )
    db_session.commit()

    sender = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response={"items": [dict(SECRET_EVENT)]}), webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    by_url = _events_by_url(sender)
    route_a_event = by_url[url_a][0]
    assert route_a_event.get("normalized_message") == "hello"
    assert "message" not in route_a_event
    assert [c["config"]["url"] for c in sender.calls].count(url_a) == 1


def test_dynamic_plus_failover_uses_processed_payload(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    route_a = int(fixture["route_ids"][0])
    primary = db_session.get(Destination, int(fixture["destination_ids"][0]))
    assert primary is not None
    primary_url = "https://primary-dyn.example.com/events"
    backup_url = "https://backup-dyn.example.com/events"
    primary.config_json = {"url": primary_url}
    backup = Destination(
        name="Backup dyn",
        destination_type="WEBHOOK_POST",
        config_json={"url": backup_url},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add(backup)
    db_session.flush()
    create_failover_route(
        db_session,
        stream_id=stream_id,
        primary_destination_id=int(primary.id),
        secondary_destination_id=int(backup.id),
        enabled=True,
    )
    _seed_secret_and_email_mapping(db_session, stream_id)
    db_session.add(
        RouteProtectionRule(
            route_id=route_a,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="p0-1",
        )
    )
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Select failover route",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        route_id=route_a,
    )
    db_session.commit()

    sender = _FailoverWebhookSender(fail_urls={primary_url})
    runner = _build_runner(poller=_FakePoller(response={"items": [dict(SECRET_EVENT)]}), webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    urls = [c["config"]["url"] for c in sender.calls]
    assert primary_url in urls
    assert backup_url in urls
    assert urls.count(backup_url) == 1
    backup_events = [c["events"] for c in sender.calls if c["config"]["url"] == backup_url][0]
    assert backup_events[0]["email"] == EMAIL_MASK


def test_base_and_dynamic_same_route_delivers_once(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    route_a = int(fixture["route_ids"][0])
    _seed_secret_and_email_mapping(db_session, stream_id)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Same as base",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        route_id=route_a,
    )
    db_session.commit()

    sender = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response={"items": [dict(SECRET_EVENT)]}), webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    assert len(sender.calls) == 1
    skip_logs = (
        db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id, DeliveryLog.stage == "dynamic_route_send_skip")
        .all()
    )
    assert any((row.payload_sample or {}).get("skip_reason") == "duplicate_base_route" for row in skip_logs)


def test_unresolved_destination_binding_does_not_send(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_route_runtime(monkeypatch)
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    orphan = Destination(
        name="No route dest",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://no-route.example.com/events"},
        enabled=True,
    )
    db_session.add(orphan)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(orphan.id), enabled=False)
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="disabled-only route",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        destination_id=int(orphan.id),
    )
    _seed_secret_and_email_mapping(db_session, stream_id)
    db_session.commit()

    sender = _FakeWebhookSender()
    runner = _build_runner(poller=_FakePoller(response={"items": [dict(SECRET_EVENT)]}), webhook_sender=sender)
    runner.run(load_stream_context(db_session, stream_id), db=db_session)

    urls = {c["config"]["url"] for c in sender.calls}
    assert "https://no-route.example.com/events" not in urls
    assert "https://receiver-0.example.com/events" in urls
