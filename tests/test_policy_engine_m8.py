"""M8 policy engine — evaluation, API, runtime, preview, observability."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.logs.models import DeliveryLog
from app.protection.models import StreamPolicyRule
from app.protection.policy_engine import evaluate_batch, evaluate_event
from app.protection.policy_metrics import (
    POLICY_EVALUATION_COMPLETE_STAGE,
    build_policy_evaluation_complete_payload,
    load_policy_runtime_metrics,
)
from app.protection.policy_operator_workflow import (
    PolicyRuleValidationError,
    build_policy_summary,
    create_policy_rule,
    list_policy_rules,
    patch_policy_rule,
)
from app.protection.policy_schemas import (
    PolicyRuleCreateRequest,
    PolicyRulePatchRequest,
    PolicyRuleResponse,
    StreamPolicyRulesResponse,
    StreamPolicySummaryResponse,
)
from app.protection.policy_service import evaluate_policies_for_delivery, evaluate_policies_for_preview
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context


def _policy_test_app() -> FastAPI:
    from app.streams.repository import get_stream_by_id

    router = APIRouter()

    @router.get("/streams/{stream_id}/policy-rules", response_model=StreamPolicyRulesResponse)
    async def get_rules(
        stream_id: int,
        enabled_only: bool = Query(False),
        db: Session = Depends(get_db_read_bounded),
    ) -> StreamPolicyRulesResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        rules = list_policy_rules(db, stream_id, enabled_only=enabled_only)
        return StreamPolicyRulesResponse(stream_id=stream_id, rules=rules, rule_count=len(rules))

    @router.get("/streams/{stream_id}/policy/summary", response_model=StreamPolicySummaryResponse)
    async def get_summary(stream_id: int, db: Session = Depends(get_db_read_bounded)) -> StreamPolicySummaryResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        return StreamPolicySummaryResponse.model_validate(build_policy_summary(db, stream_id))

    @router.post("/streams/{stream_id}/policy-rules", response_model=PolicyRuleResponse)
    async def post_rule(
        stream_id: int,
        body: PolicyRuleCreateRequest,
        db: Session = Depends(get_db),
    ) -> PolicyRuleResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        try:
            rule = create_policy_rule(
                db,
                stream_id=stream_id,
                name=body.name,
                enabled=body.enabled,
                condition_json=body.condition_json.model_dump(),
                action_type=body.action_type,
            )
            db.commit()
        except PolicyRuleValidationError as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        entries = list_policy_rules(db, stream_id)
        entry = next(e for e in entries if e["id"] == rule.id)
        return PolicyRuleResponse(rule=entry)  # type: ignore[arg-type]

    @router.patch("/streams/{stream_id}/policy-rules/{rule_id}", response_model=PolicyRuleResponse)
    async def patch_rule(
        stream_id: int,
        rule_id: int,
        body: PolicyRulePatchRequest,
        db: Session = Depends(get_db),
    ) -> PolicyRuleResponse:
        try:
            patch_policy_rule(
                db,
                stream_id=stream_id,
                rule_id=rule_id,
                name=body.name,
                enabled=body.enabled,
                condition_json=body.condition_json.model_dump() if body.condition_json is not None else None,
                action_type=body.action_type,
            )
            db.commit()
        except PolicyRuleValidationError as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        entries = list_policy_rules(db, stream_id)
        entry = next(e for e in entries if e["id"] == rule_id)
        return PolicyRuleResponse(rule=entry)  # type: ignore[arg-type]

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/runtime")
    return app


@pytest.fixture
def policy_api_client(db_session: Session) -> TestClient:
    app = _policy_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


def test_create_policy_rule(db_session: Session, policy_api_client: TestClient) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    resp = policy_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/policy-rules",
        json={
            "name": "Secret Audit",
            "enabled": True,
            "condition_json": {"sensitivity_class": "secret"},
            "action_type": "audit_only",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["rule"]["name"] == "Secret Audit"
    assert body["rule"]["action_type"] == "audit_only"


def test_policy_evaluation_matches_secret(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Secret Audit",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="audit_only",
    )
    db_session.commit()
    events = [{"api_key": "super-secret-token", "message": "hello"}]
    findings = [{"field_path": "$.api_key", "sensitivity_class": "secret", "detection_method": "field_name"}]
    result = evaluate_batch(db_session, stream_id=stream_id, events=events, findings=findings)
    assert result.matched_policy_count == 1
    assert result.matched_policies == [{"name": "Secret Audit"}]
    evals = evaluate_event(stream_id, findings, events[0], list(db_session.query(StreamPolicyRule)))
    assert any(e["matched"] for e in evals)


def test_policy_evaluation_no_match(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="PII Audit",
        enabled=True,
        condition_json={"sensitivity_class": "pii"},
        action_type="audit_only",
    )
    db_session.commit()
    findings = [{"field_path": "$.api_key", "sensitivity_class": "secret"}]
    result = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"api_key": "x"}],
        findings=findings,
    )
    assert result.matched_policy_count == 0


def test_preview_matched_policies(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Secret Audit",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="audit_only",
    )
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
    names = [p.name for p in preview.matched_policies]
    assert "Secret Audit" in names


def test_runtime_policy_evaluation_log(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Secret Audit",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="audit_only",
    )
    db_session.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-1",
                    "api_key": "super-secret-token-value",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db_session, stream_id)
    runner.run(ctx, db=db_session)

    rows = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == POLICY_EVALUATION_COMPLETE_STAGE,
        )
        .all()
    )
    assert rows
    sample = rows[-1].payload_sample or {}
    assert int(sample.get("policy_count") or 0) >= 1
    for key in (
        "stream_id",
        "policy_count",
        "matched_policy_count",
        "audit_event_count",
        "processing_time_ms",
    ):
        assert key in sample


def test_build_policy_summary_and_observability(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Secret Audit",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="audit_only",
    )
    db_session.commit()
    result = evaluate_batch(
        db_session,
        stream_id=stream_id,
        events=[{"password": "x"}],
        findings=[{"sensitivity_class": "secret"}],
    )
    payload = build_policy_evaluation_complete_payload(stream_id=stream_id, result=result)
    db_session.add(
        DeliveryLog(
            stream_id=stream_id,
            stage=POLICY_EVALUATION_COMPLETE_STAGE,
            status="ok",
            message="policy evaluation complete",
            payload_sample=payload,
        )
    )
    db_session.commit()
    summary = build_policy_summary(db_session, stream_id)
    assert summary["total_policies"] == 1
    metrics = load_policy_runtime_metrics(db_session, stream_id, total_policies=1)
    assert metrics["audit_events"] >= 1


def test_policy_api_summary(policy_api_client: TestClient, db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    policy_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/policy-rules",
        json={
            "name": "PII Audit",
            "condition_json": {"sensitivity_class": "pii"},
            "action_type": "audit_only",
        },
    )
    summary = policy_api_client.get(f"/api/v1/runtime/streams/{stream_id}/policy/summary")
    assert summary.status_code == 200
    assert summary.json()["total_policies"] == 1


def test_invalid_action_rejected(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    with pytest.raises(PolicyRuleValidationError):
        create_policy_rule(
            db_session,
            stream_id=stream_id,
            name="Bad",
            enabled=True,
            condition_json={"sensitivity_class": "secret"},
            action_type="invalid_action",
        )


def test_evaluate_policies_for_delivery_logs(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Secret Audit",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="audit_only",
    )
    db_session.commit()
    logs: list[dict[str, Any]] = []

    def _capture(entry: dict[str, Any]) -> None:
        logs.append(entry)

    evaluate_policies_for_delivery(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"api_key": "secret123456789"}],
        log_fn=_capture,
    )
    assert logs
    assert logs[0]["stage"] == POLICY_EVALUATION_COMPLETE_STAGE
    for key in (
        "stream_id",
        "policy_count",
        "matched_policy_count",
        "audit_event_count",
        "processing_time_ms",
    ):
        assert key in logs[0]


def test_preview_service_helper(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Secret Audit",
        enabled=True,
        condition_json={"sensitivity_class": "secret"},
        action_type="audit_only",
    )
    db_session.commit()
    matched = evaluate_policies_for_preview(
        db_session,
        stream_id=stream_id,
        enriched_events=[{"api_key": "secret1234567890"}],
    )
    assert matched == [{"name": "Secret Audit"}]
