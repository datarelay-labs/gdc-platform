"""Toxiproxy TCP-level fault → checkpoint hold → recovery → delivery E2E.

Covers gaps WireMock status faults and docker-stop cannot express:
- source connection latency/timeout, reset, unavailable
- destination connection reset / unavailable
- checkpoint must not advance on failure; must advance after recovery
- no event loss / no unexpected duplicate on recovery re-run
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.checkpoints.models import Checkpoint
from app.database import get_db
from app.logs.models import DeliveryLog
from app.main import app
from app.templates.registry import clear_template_cache
from tests.e2e_toxiproxy_helpers import (
    PROXY_DEST,
    PROXY_SOURCE,
    TOXIPROXY_API_URL,
    TOXIPROXY_DEST_BASE_URL,
    TOXIPROXY_SOURCE_BASE_URL,
    WIREMOCK_BASE_URL,
    ensure_source_and_dest_proxies,
    inject_connection_interrupt,
    inject_latency,
    inject_reset_peer,
    inject_unavailable,
    remove_fault,
    toxiproxy_reachable,
    wait_http_transport_failure,
    wait_proxy_path_ok,
    wait_toxiproxy_ready,
    write_evidence,
)
from tests.e2e_wiremock_helpers import (
    create_webhook_destination,
    delivery_log_stages,
    enable_stream_for_run,
    ensure_template_wiremock_mappings,
    reset_wiremock_journal,
    reset_wiremock_scenarios,
    wiremock_received_json_bodies,
    wiremock_reachable,
)

pytestmark = [
    pytest.mark.wiremock_integration,
    pytest.mark.e2e_toxiproxy,
    pytest.mark.e2e_checkpoint,
    pytest.mark.e2e_delivery,
]

_skip_msg = (
    f"Toxiproxy/WireMock required "
    f"(api={TOXIPROXY_API_URL}, wiremock={WIREMOCK_BASE_URL}; "
    f"start: ./scripts/testing/start-test-stack.sh)"
)
skip_no_stack = pytest.mark.skipif(
    not (wiremock_reachable(WIREMOCK_BASE_URL) and toxiproxy_reachable(TOXIPROXY_API_URL)),
    reason=_skip_msg,
)


@pytest.fixture
def client(db_session: Session) -> TestClient:
    clear_template_cache()

    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_template_cache()


@pytest.fixture
def toxiproxy_proxies() -> dict[str, Any]:
    wait_toxiproxy_ready()
    proxies = ensure_source_and_dest_proxies(enabled=True)
    wait_proxy_path_ok(TOXIPROXY_SOURCE_BASE_URL)
    wait_proxy_path_ok(TOXIPROXY_DEST_BASE_URL)
    try:
        yield proxies
    finally:
        remove_fault(PROXY_SOURCE)
        remove_fault(PROXY_DEST)


def _checkpoint_value(db: Session, checkpoint_id: int) -> dict[str, Any]:
    db.expire_all()
    row = db.get(Checkpoint, checkpoint_id)
    assert row is not None
    return dict(row.checkpoint_value_json or {})


def _delivery_success_count(db: Session, stream_id: int) -> int:
    db.expire_all()
    return (
        db.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stream_id)
        .filter(DeliveryLog.stage == "route_send_success")
        .count()
    )


def _instantiate_generic(
    client: TestClient,
    *,
    source_host: str,
    dest_base: str,
    dest_path: str,
    name: str,
    retry_count: int = 0,
) -> dict[str, Any]:
    ensure_template_wiremock_mappings(WIREMOCK_BASE_URL)
    reset_wiremock_scenarios(WIREMOCK_BASE_URL)
    reset_wiremock_journal(WIREMOCK_BASE_URL)

    dest_id = create_webhook_destination(client, dest_base, path=dest_path, retry_count=retry_count)
    ins = client.post(
        "/api/v1/templates/generic_rest_polling/instantiate",
        json={
            "connector_name": name,
            "host": source_host,
            "credentials": {"bearer_token": "template-e2e-generic-bearer"},
            "destination_id": dest_id,
            "create_route": True,
        },
    )
    assert ins.status_code == 201, ins.text
    out = ins.json()
    stream_id = int(out["stream_id"])

    # Keep source fetch retries short so TCP faults surface quickly (observable, not sleep-gated).
    st = client.get(f"/api/v1/streams/{stream_id}").json()
    cfg = dict(st.get("config_json") or {})
    cfg["timeout_seconds"] = 2
    cfg["retry_count"] = 0
    cfg["retry_backoff_seconds"] = 0
    up = client.put(f"/api/v1/streams/{stream_id}", json={"config_json": cfg})
    assert up.status_code == 200, up.text

    return {
        "stream_id": stream_id,
        "route_id": int(out["route_id"]),
        "checkpoint_id": int(out["checkpoint_id"]),
        "dest_id": dest_id,
        "dest_path": dest_path,
    }


@skip_no_stack
@pytest.mark.e2e_retry
def test_toxiproxy_http_source_latency_timeout_hold_then_recover(
    client: TestClient, db_session: Session, toxiproxy_proxies: dict[str, Any]
) -> None:
    """A: source latency → fetch fail, no delivery, checkpoint hold → recover → deliver + advance."""

    dest_path = "/receiver/webhook"
    stack = _instantiate_generic(
        client,
        source_host=TOXIPROXY_SOURCE_BASE_URL,
        dest_base=WIREMOCK_BASE_URL,
        dest_path=dest_path,
        name="Toxiproxy source latency",
    )
    stream_id = stack["stream_id"]
    ck_id = stack["checkpoint_id"]
    cp_before = _checkpoint_value(db_session, ck_id)
    deliveries_before = _delivery_success_count(db_session, stream_id)

    toxic = inject_latency(PROXY_SOURCE, latency_ms=8000)
    evidence: dict[str, Any] = {
        "path": "http_source",
        "fault": {"type": "latency", "toxic": toxic},
        "checkpoint_before": cp_before,
        "deliveries_before": deliveries_before,
    }

    enable_stream_for_run(client, stream_id)
    fail_run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert fail_run.status_code == 502, fail_run.text
    detail = fail_run.json().get("detail") or {}
    evidence["expected_failure"] = {
        "http_status": fail_run.status_code,
        "detail": detail,
    }
    assert "timeout" in str(detail).lower() or "failed" in str(detail).lower() or "HTTP" in str(detail)

    db_session.expire_all()
    stages_fail = delivery_log_stages(db_session, stream_id)
    assert "route_send_success" not in stages_fail
    assert "checkpoint_update" not in stages_fail
    cp_held = _checkpoint_value(db_session, ck_id)
    assert cp_held == cp_before
    assert _delivery_success_count(db_session, stream_id) == deliveries_before
    payloads_during = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    assert payloads_during == []
    evidence["checkpoint_during_fault"] = cp_held
    evidence["stages_during_fault"] = sorted(stages_fail)
    evidence["destination_payloads_during_fault"] = len(payloads_during)

    remove_fault(PROXY_SOURCE)
    wait_proxy_path_ok(TOXIPROXY_SOURCE_BASE_URL)
    evidence["fault_removed"] = True

    # Stream may still be RUNNING after source failure (unlike dest PAUSE); re-enable for clarity.
    enable_stream_for_run(client, stream_id)
    ok_run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert ok_run.status_code == 200, ok_run.text
    body = ok_run.json()
    assert body.get("checkpoint_updated") is True
    assert int(body.get("extracted_event_count") or 0) >= 1

    db_session.expire_all()
    stages_ok = delivery_log_stages(db_session, stream_id)
    assert "route_send_success" in stages_ok
    assert "checkpoint_update" in stages_ok
    cp_after = _checkpoint_value(db_session, ck_id)
    assert cp_after != cp_before
    assert "last_success_event" in cp_after
    payloads = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    assert len(payloads) == 1
    assert payloads[0].get("event_id") == "gen-evt-1"
    deliveries_after = _delivery_success_count(db_session, stream_id)
    assert deliveries_after == deliveries_before + 1

    evidence.update(
        {
            "recovery_observed": True,
            "checkpoint_after": cp_after,
            "final_delivery_success": True,
            "event_loss": 0,
            "unexpected_duplicates": 0,
            "delivery_count": len(payloads),
            "correlation_event_id": payloads[0].get("event_id"),
            "stages_after_recovery": sorted(stages_ok),
        }
    )
    write_evidence("source_latency_timeout_hold_recover", evidence)


@skip_no_stack
def test_toxiproxy_http_source_unavailable_and_reset_hold_then_recover(
    client: TestClient, db_session: Session, toxiproxy_proxies: dict[str, Any]
) -> None:
    """A (extra): unavailable + reset_peer both hold checkpoint; recovery delivers once."""

    dest_path = "/receiver/webhook"
    stack = _instantiate_generic(
        client,
        source_host=TOXIPROXY_SOURCE_BASE_URL,
        dest_base=WIREMOCK_BASE_URL,
        dest_path=dest_path,
        name="Toxiproxy source unavailable/reset",
    )
    stream_id = stack["stream_id"]
    ck_id = stack["checkpoint_id"]
    cp_before = _checkpoint_value(db_session, ck_id)
    evidence: dict[str, Any] = {"path": "http_source", "faults": []}

    # 1) connection unavailable (proxy disabled → HTTP transport failure)
    inject_unavailable(PROXY_SOURCE)
    wait_http_transport_failure(f"{TOXIPROXY_SOURCE_BASE_URL}/__admin/mappings")
    enable_stream_for_run(client, stream_id)
    fail1 = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert fail1.status_code == 502, fail1.text
    assert _checkpoint_value(db_session, ck_id) == cp_before
    assert wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path) == []
    evidence["faults"].append({"type": "unavailable", "failure_status": fail1.status_code})

    remove_fault(PROXY_SOURCE)
    wait_proxy_path_ok(TOXIPROXY_SOURCE_BASE_URL)

    # 2) connection reset
    inject_reset_peer(PROXY_SOURCE, timeout_ms=0)
    wait_http_transport_failure(f"{TOXIPROXY_SOURCE_BASE_URL}/__admin/mappings")
    enable_stream_for_run(client, stream_id)
    fail2 = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert fail2.status_code == 502, fail2.text
    assert _checkpoint_value(db_session, ck_id) == cp_before
    assert "route_send_success" not in delivery_log_stages(db_session, stream_id)
    evidence["faults"].append({"type": "reset_peer", "failure_status": fail2.status_code})
    evidence["checkpoint_held"] = True

    remove_fault(PROXY_SOURCE)
    wait_proxy_path_ok(TOXIPROXY_SOURCE_BASE_URL)
    enable_stream_for_run(client, stream_id)
    ok = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert ok.status_code == 200, ok.text
    assert ok.json().get("checkpoint_updated") is True
    payloads = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    assert len(payloads) == 1
    assert payloads[0].get("event_id") == "gen-evt-1"
    evidence.update(
        {
            "fault_removed": True,
            "recovery_observed": True,
            "final_delivery_success": True,
            "event_loss": 0,
            "unexpected_duplicates": 0,
            "checkpoint_after": _checkpoint_value(db_session, ck_id),
            "delivery_count": len(payloads),
        }
    )
    write_evidence("source_unavailable_reset_hold_recover", evidence)


@skip_no_stack
@pytest.mark.e2e_retry
def test_toxiproxy_destination_interrupt_hold_then_recover_no_loss_no_dup(
    client: TestClient, db_session: Session, toxiproxy_proxies: dict[str, Any]
) -> None:
    """B: dest connection interrupt (limit_data) → fail + hold → recover → single delivery."""

    dest_path = "/receiver/webhook"
    stack = _instantiate_generic(
        client,
        source_host=WIREMOCK_BASE_URL,
        dest_base=TOXIPROXY_DEST_BASE_URL,
        dest_path=dest_path,
        name="Toxiproxy dest interrupt",
        retry_count=0,
    )
    stream_id = stack["stream_id"]
    route_id = stack["route_id"]
    ck_id = stack["checkpoint_id"]

    rput = client.put(
        f"/api/v1/routes/{route_id}",
        json={"failure_policy": "PAUSE_STREAM_ON_FAILURE"},
    )
    assert rput.status_code == 200, rput.text

    cp_before = _checkpoint_value(db_session, ck_id)
    deliveries_before = _delivery_success_count(db_session, stream_id)

    toxic = inject_connection_interrupt(PROXY_DEST, bytes_limit=1)
    wait_http_transport_failure(f"{TOXIPROXY_DEST_BASE_URL}/__admin/mappings")
    evidence: dict[str, Any] = {
        "path": "destination_webhook",
        "fault": {"type": "limit_data_upstream", "toxic": toxic},
        "checkpoint_before": cp_before,
        "deliveries_before": deliveries_before,
    }

    enable_stream_for_run(client, stream_id)
    fail_run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert fail_run.status_code == 200, fail_run.text
    fail_body = fail_run.json()
    assert fail_body.get("checkpoint_updated") is False
    evidence["expected_failure"] = {
        "http_status": fail_run.status_code,
        "checkpoint_updated": fail_body.get("checkpoint_updated"),
        "extracted_event_count": fail_body.get("extracted_event_count"),
    }

    db_session.expire_all()
    stages_fail = delivery_log_stages(db_session, stream_id)
    assert "route_send_success" not in stages_fail
    assert "checkpoint_update" not in stages_fail
    assert "route_send_failed" in stages_fail or "run_failed" in stages_fail or any(
        "fail" in s for s in stages_fail
    )
    cp_held = _checkpoint_value(db_session, ck_id)
    assert cp_held == cp_before
    payloads_during = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    assert payloads_during == [], "interrupt must not complete a sink POST"
    evidence["checkpoint_during_fault"] = cp_held
    evidence["stages_during_fault"] = sorted(stages_fail)
    evidence["destination_payloads_during_fault"] = len(payloads_during)

    st = client.get(f"/api/v1/streams/{stream_id}").json()
    assert st.get("status") == "PAUSED"
    evidence["stream_paused"] = True

    remove_fault(PROXY_DEST)
    wait_proxy_path_ok(TOXIPROXY_DEST_BASE_URL)
    evidence["fault_removed"] = True

    enable_stream_for_run(client, stream_id)
    ok_run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert ok_run.status_code == 200, ok_run.text
    ok_body = ok_run.json()
    assert ok_body.get("checkpoint_updated") is True
    assert int(ok_body.get("extracted_event_count") or 0) >= 1

    payloads = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    event_ids = [p.get("event_id") for p in payloads if p.get("event_id") == "gen-evt-1"]
    assert len(event_ids) == 1, f"expected 1 delivery of gen-evt-1, got {len(event_ids)} payloads={payloads}"
    deliveries_after = _delivery_success_count(db_session, stream_id)
    assert deliveries_after == deliveries_before + 1
    cp_after = _checkpoint_value(db_session, ck_id)
    assert cp_after != cp_before

    evidence.update(
        {
            "recovery_observed": True,
            "checkpoint_after": cp_after,
            "final_delivery_success": True,
            "event_loss": 0,
            "unexpected_duplicates": 0,
            "delivery_count": len(event_ids),
            "correlation_event_id": "gen-evt-1",
            "stages_after_recovery": sorted(delivery_log_stages(db_session, stream_id)),
        }
    )
    write_evidence("destination_interrupt_hold_recover", evidence)


@skip_no_stack
def test_toxiproxy_destination_unavailable_hold_then_recover(
    client: TestClient, db_session: Session, toxiproxy_proxies: dict[str, Any]
) -> None:
    """B (extra): dest connection unavailable holds checkpoint; recovery delivers once."""

    dest_path = "/receiver/webhook"
    stack = _instantiate_generic(
        client,
        source_host=WIREMOCK_BASE_URL,
        dest_base=TOXIPROXY_DEST_BASE_URL,
        dest_path=dest_path,
        name="Toxiproxy dest unavailable",
        retry_count=0,
    )
    stream_id = stack["stream_id"]
    route_id = stack["route_id"]
    ck_id = stack["checkpoint_id"]

    assert (
        client.put(
            f"/api/v1/routes/{route_id}",
            json={"failure_policy": "PAUSE_STREAM_ON_FAILURE"},
        ).status_code
        == 200
    )

    cp_before = _checkpoint_value(db_session, ck_id)
    inject_unavailable(PROXY_DEST)
    wait_http_transport_failure(f"{TOXIPROXY_DEST_BASE_URL}/__admin/mappings")

    enable_stream_for_run(client, stream_id)
    fail_run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert fail_run.status_code == 200, fail_run.text
    assert fail_run.json().get("checkpoint_updated") is False
    assert _checkpoint_value(db_session, ck_id) == cp_before
    assert "route_send_success" not in delivery_log_stages(db_session, stream_id)
    assert wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path) == []

    remove_fault(PROXY_DEST)
    wait_proxy_path_ok(TOXIPROXY_DEST_BASE_URL)
    enable_stream_for_run(client, stream_id)
    ok = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert ok.status_code == 200, ok.text
    assert ok.json().get("checkpoint_updated") is True
    payloads = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    assert len([p for p in payloads if p.get("event_id") == "gen-evt-1"]) == 1

    write_evidence(
        "destination_unavailable_hold_recover",
        {
            "path": "destination_webhook",
            "fault": {"type": "unavailable"},
            "checkpoint_before": cp_before,
            "checkpoint_after": _checkpoint_value(db_session, ck_id),
            "fault_removed": True,
            "recovery_observed": True,
            "final_delivery_success": True,
            "event_loss": 0,
            "unexpected_duplicates": 0,
            "delivery_count": 1,
        },
    )


@skip_no_stack
def test_toxiproxy_destination_reset_peer_hold_documents_at_least_once(
    client: TestClient, db_session: Session, toxiproxy_proxies: dict[str, Any]
) -> None:
    """reset_peer may reach the sink before the client sees failure (at-least-once).

    Checkpoint must still hold on the failed run. Evidence records sink receipt count;
    this is transport semantics, not hidden by the harness.
    """

    dest_path = "/receiver/webhook"
    stack = _instantiate_generic(
        client,
        source_host=WIREMOCK_BASE_URL,
        dest_base=TOXIPROXY_DEST_BASE_URL,
        dest_path=dest_path,
        name="Toxiproxy dest reset_peer",
        retry_count=0,
    )
    stream_id = stack["stream_id"]
    route_id = stack["route_id"]
    ck_id = stack["checkpoint_id"]
    assert (
        client.put(
            f"/api/v1/routes/{route_id}",
            json={"failure_policy": "PAUSE_STREAM_ON_FAILURE"},
        ).status_code
        == 200
    )

    cp_before = _checkpoint_value(db_session, ck_id)
    toxic = inject_reset_peer(PROXY_DEST, timeout_ms=0)
    wait_http_transport_failure(f"{TOXIPROXY_DEST_BASE_URL}/__admin/mappings")

    enable_stream_for_run(client, stream_id)
    fail_run = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert fail_run.status_code == 200, fail_run.text
    assert fail_run.json().get("checkpoint_updated") is False
    assert _checkpoint_value(db_session, ck_id) == cp_before
    assert "route_send_success" not in delivery_log_stages(db_session, stream_id)

    sink_during = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    # Proven: reset_peer often forwards the POST then RSTs the client (see probe).
    assert len(sink_during) >= 1

    remove_fault(PROXY_DEST)
    wait_proxy_path_ok(TOXIPROXY_DEST_BASE_URL)
    enable_stream_for_run(client, stream_id)
    ok = client.post(f"/api/v1/runtime/streams/{stream_id}/run-once")
    assert ok.status_code == 200, ok.text
    assert ok.json().get("checkpoint_updated") is True

    sink_after = wiremock_received_json_bodies(WIREMOCK_BASE_URL, path_contains=dest_path)
    product_success = _delivery_success_count(db_session, stream_id)
    write_evidence(
        "destination_reset_peer_at_least_once",
        {
            "path": "destination_webhook",
            "fault": {"type": "reset_peer", "toxic": toxic},
            "checkpoint_before": cp_before,
            "checkpoint_after": _checkpoint_value(db_session, ck_id),
            "sink_receipts_during_fault": len(sink_during),
            "sink_receipts_after_recovery": len(sink_after),
            "product_route_send_success_count": product_success,
            "note": (
                "TCP reset_peer can complete upstream POST before client failure; "
                "recovery re-send yields sink-level duplicate under at-least-once delivery. "
                "Not a harness hide — product checkpoint hold is still required."
            ),
            "checkpoint_hold_verified": True,
            "recovery_observed": True,
            "final_delivery_success": True,
            "event_loss": 0,
            "unexpected_duplicates": max(0, len(sink_after) - 1),
        },
    )
    assert product_success == 1
    assert _checkpoint_value(db_session, ck_id) != cp_before
