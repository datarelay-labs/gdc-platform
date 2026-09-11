"""M8.1 — policy engine hardening (observability, parity, bounded summary, regression)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.logs.models import DeliveryLog
from app.protection.policy_engine import evaluate_batch
from app.protection.policy_metrics import (
    POLICY_EVALUATION_COMPLETE_STAGE,
    build_policy_evaluation_complete_payload,
    load_cumulative_policy_totals,
    load_policy_runtime_metrics,
)
from app.protection.policy_operator_workflow import build_policy_summary, create_policy_rule
from app.protection.policy_service import evaluate_policies_for_delivery
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest
from app.database import get_db, get_db_read_bounded
from tests.test_policy_engine_m8 import _policy_test_app
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context

@pytest.fixture
def policy_api_client(db_session: Session) -> TestClient:
    app = _policy_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


_REQUIRED_LOG_KEYS = frozenset(
    {
        "stream_id",
        "policy_count",
        "matched_policy_count",
        "audit_event_count",
        "processing_time_ms",
    }
)


@pytest.fixture
def policy_runtime_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)


def _seed_secret_policy(
    db: Session,
    stream_id: int,
    *,
    name: str = "Secret Audit",
    enabled: bool = True,
) -> None:
    create_policy_rule(
        db,
        stream_id=stream_id,
        name=name,
        enabled=enabled,
        condition_json={"sensitivity_class": "secret"},
        action_type="audit_only",
    )
    db.commit()


def test_build_policy_evaluation_complete_payload_has_required_fields() -> None:
    from app.protection.policy_engine import PolicyBatchResult

    result = PolicyBatchResult(
        policy_count=2,
        matched_policy_count=1,
        audit_event_count=1,
        duration_ms=9,
    )
    payload = build_policy_evaluation_complete_payload(
        stream_id=42,
        result=result,
        cumulative_totals={"total_audit_events": 3, "total_matched_policies": 5},
    )
    assert payload["stage"] == POLICY_EVALUATION_COMPLETE_STAGE
    assert payload["stream_id"] == 42
    assert _REQUIRED_LOG_KEYS <= frozenset(payload.keys())
    assert payload["policy_count"] == 2
    assert payload["matched_policy_count"] == 1
    assert payload["audit_event_count"] == 1
    assert payload["processing_time_ms"] == 9
    assert payload["total_audit_events"] == 4
    assert payload["total_matched_policies"] == 6


def test_load_policy_runtime_metrics_prefers_latest_row(db_session: Session) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    for _ in range(30):
        db.add(
            DeliveryLog(
                stream_id=stream_id,
                stage="route_send_success",
                level="INFO",
                status="OK",
                message="route ok",
                payload_sample={"unrelated": True},
                retry_count=0,
            )
        )
    db.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=POLICY_EVALUATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="policy evaluation complete",
            payload_sample={
                "total_audit_events": 9,
                "total_matched_policies": 7,
                "matched_policy_count": 1,
            },
            retry_count=0,
        )
    )
    db.commit()
    metrics = load_policy_runtime_metrics(db, stream_id, total_policies=2)
    assert metrics["audit_events"] == 9
    assert metrics["matched_policies"] == 7
    assert metrics["last_evaluated_at"] is not None


def test_build_policy_summary_uses_bounded_metrics(db_session: Session) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    _seed_secret_policy(db, stream_id)
    db.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=POLICY_EVALUATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="policy evaluation complete",
            payload_sample={"total_audit_events": 2, "total_matched_policies": 4},
            retry_count=0,
        )
    )
    db.commit()
    summary = build_policy_summary(db, stream_id)
    assert summary["total_policies"] == 1
    assert summary["audit_events"] == 2
    assert summary["matched_policies"] == 4


def test_disabled_policy_not_evaluated(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    _seed_secret_policy(db_session, stream_id, name="Secret Audit", enabled=True)
    _seed_secret_policy(db_session, stream_id, name="Secret Disabled", enabled=False)
    findings = [{"sensitivity_class": "secret"}]
    result = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"api_key": "x"}],
        findings=findings,
    )
    assert result.policy_count == 1
    assert result.matched_policy_count == 1
    names = [m["name"] for m in result.matched_policies]
    assert "Secret Audit" in names
    assert "Secret Disabled" not in names


def test_preview_runtime_matched_policy_parity(
    db_session: Session,
    policy_runtime_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    _seed_secret_policy(db, stream_id)

    from app.mappings.models import Mapping

    mapping = db.query(Mapping).filter_by(stream_id=stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
        "message": "$.message",
    }
    db.commit()

    sample_payload = {"items": [{"api_key": "super-secret-token-value", "message": "hi", "vendor": "v"}]}
    preview = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            payload=sample_payload,
            event_array_path="$.items",
            field_mappings={"api_key": "$.api_key", "message": "$.message"},
            stream_id=stream_id,
        ),
        db=db,
    )
    assert len(preview.matched_policies) == 1
    assert preview.matched_policies[0].name == "Secret Audit"

    poller = _FakePoller(response=sample_payload)
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)
    db.commit()

    row = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == POLICY_EVALUATION_COMPLETE_STAGE,
        )
        .order_by(DeliveryLog.created_at.desc())
        .first()
    )
    assert row is not None
    sample = row.payload_sample if isinstance(row.payload_sample, dict) else {}
    assert int(sample.get("matched_policy_count") or 0) == 1
    for key in _REQUIRED_LOG_KEYS:
        assert key in sample


def test_runtime_enriched_payload_unchanged_by_policy(
    db_session: Session,
    policy_runtime_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    _seed_secret_policy(db, stream_id)

    from app.mappings.models import Mapping

    mapping = db.query(Mapping).filter_by(stream_id=stream_id).one()
    mapping.field_mappings_json = {**dict(mapping.field_mappings_json or {}), "api_key": "$.api_key"}
    db.commit()

    secret_value = "super-secret-token-value"
    events = [{"api_key": secret_value, "message": "hello", "vendor": "v"}]
    before = copy.deepcopy(events)

    logs: list[dict[str, Any]] = []

    def _capture(entry: dict[str, Any]) -> None:
        logs.append(entry)

    evaluate_policies_for_delivery(
        db,
        stream_id=stream_id,
        enriched_events=events,
        log_fn=_capture,
    )
    assert events == before
    assert logs
    assert logs[0]["matched_policy_count"] == 1


def test_invalid_action_types_rejected_via_api(
    policy_api_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    base = {
        "name": "Bad Policy",
        "enabled": True,
        "condition_json": {"sensitivity_class": "secret"},
    }
    for action in ("drop", "route"):
        resp = policy_api_client.post(
            f"/api/v1/runtime/streams/{stream_id}/policy-rules",
            json={**base, "action_type": action},
        )
        assert resp.status_code == 422 or resp.status_code == 400, action

    ok = policy_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/policy-rules",
        json={**base, "name": "Quarantine OK", "action_type": "quarantine"},
    )
    assert ok.status_code == 200
    assert ok.json()["rule"]["action_type"] == "quarantine"

    blocked = policy_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/policy-rules",
        json={
            **base,
            "name": "Block OK",
            "condition_json": {"classification_level": "CONFIDENTIAL"},
            "action_type": "block",
        },
    )
    assert blocked.status_code == 200
    assert blocked.json()["rule"]["action_type"] == "block"

    review = policy_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/policy-rules",
        json={
            **base,
            "name": "Review OK",
            "condition_json": {"classification_level": "RESTRICTED"},
            "action_type": "require_review",
        },
    )
    assert review.status_code == 200
    assert review.json()["rule"]["action_type"] == "require_review"


def test_load_cumulative_policy_totals_from_latest(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=POLICY_EVALUATION_COMPLETE_STAGE,
            level="INFO",
            status="OK",
            message="policy evaluation complete",
            payload_sample={"total_audit_events": 11, "total_matched_policies": 22},
            retry_count=0,
        )
    )
    db_session.commit()
    totals = load_cumulative_policy_totals(db_session, stream_id)
    assert totals["total_audit_events"] == 11
    assert totals["total_matched_policies"] == 22


def test_run_once_persists_full_policy_evaluation_complete_payload(
    db_session: Session,
    policy_runtime_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    _seed_secret_policy(db, stream_id)

    from app.mappings.models import Mapping

    mapping = db.query(Mapping).filter_by(stream_id=stream_id).one()
    mapping.field_mappings_json = {**dict(mapping.field_mappings_json or {}), "api_key": "$.api_key"}
    db.commit()

    poller = _FakePoller(
        response={"items": [{"id": "e1", "api_key": "secret-val-12345", "message": "hi", "vendor": "v"}]}
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db, stream_id)
    runner.run(ctx, db=db)
    db.commit()

    row = (
        db.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == POLICY_EVALUATION_COMPLETE_STAGE,
        )
        .order_by(DeliveryLog.created_at.desc())
        .first()
    )
    assert row is not None
    sample = row.payload_sample if isinstance(row.payload_sample, dict) else {}
    assert _REQUIRED_LOG_KEYS <= frozenset(sample.keys())
    assert int(sample.get("policy_count") or 0) >= 1
    assert "total_audit_events" in sample
    assert "total_matched_policies" in sample
    assert json.dumps(sample)
