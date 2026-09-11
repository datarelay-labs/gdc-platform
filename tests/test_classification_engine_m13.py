"""M13 Classification Engine MVP — rules, runtime, policy, routing, quarantine, preview."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.classification.engine import (
    classify_batch,
    evaluate_batch,
    resolve_classification_level,
    rule_condition_matches,
)
from app.classification.field_keys import (
    CLASSIFICATION_LEVEL_FIELD,
    CLASSIFICATION_LEVEL_GDC_FIELD,
    read_classification_level,
    stamp_classification_level,
)
from app.classification.metrics import (
    CLASSIFICATION_COMPLETE_STAGE,
    build_classification_complete_payload,
)
from app.classification.models import StreamClassificationRule
from app.classification.operator_workflow import (
    ClassificationRuleValidationError,
    build_classification_summary,
    create_classification_rule,
    list_classification_rules,
)
from app.classification.schemas import (
    ClassificationRuleCreateRequest,
    ClassificationRuleResponse,
    StreamClassificationRulesResponse,
    StreamClassificationSummaryResponse,
)
from app.classification.service import classify_events_for_preview
from app.database import get_db, get_db_read_bounded
from app.dynamic_routing.dynamic_routing_engine import evaluate_batch as evaluate_dynamic_batch
from app.logs.models import DeliveryLog
from app.protection.policy_engine import evaluate_batch as evaluate_policy_batch
from app.protection.policy_operator_workflow import create_policy_rule
from app.protection.policy_service import would_quarantine_for_preview
from app.quarantine.policy_integration import should_quarantine_batch
from app.runtime.preview_service import run_final_event_draft_preview
from app.runtime.schemas import FinalEventDraftPreviewRequest
from app.sensitive_detection.models import (
    SENSITIVITY_CLASS_PII,
    SENSITIVITY_CLASS_SECRET,
    SENSITIVITY_CLASS_SECURITY_METADATA,
)
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _add_enabled_route_for_destination,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context


def _classification_test_app() -> FastAPI:
    from app.classification.operator_workflow import (
        ClassificationRuleNotFoundError,
        patch_classification_rule,
    )
    from app.streams.repository import get_stream_by_id

    router = APIRouter()

    @router.get("/streams/{stream_id}/classification-rules", response_model=StreamClassificationRulesResponse)
    async def get_rules(
        stream_id: int,
        enabled_only: bool = Query(False),
        db: Session = Depends(get_db_read_bounded),
    ) -> StreamClassificationRulesResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        rules = list_classification_rules(db, stream_id, enabled_only=enabled_only)
        return StreamClassificationRulesResponse(stream_id=stream_id, rules=rules, rule_count=len(rules))

    @router.get("/streams/{stream_id}/classification/summary", response_model=StreamClassificationSummaryResponse)
    async def get_summary(stream_id: int, db: Session = Depends(get_db_read_bounded)) -> StreamClassificationSummaryResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        return StreamClassificationSummaryResponse.model_validate(build_classification_summary(db, stream_id))

    @router.post("/streams/{stream_id}/classification-rules", response_model=ClassificationRuleResponse)
    async def post_rule(
        stream_id: int,
        body: ClassificationRuleCreateRequest,
        db: Session = Depends(get_db),
    ) -> ClassificationRuleResponse:
        if get_stream_by_id(db, stream_id) is None:
            raise HTTPException(status_code=404, detail="stream not found")
        try:
            rule = create_classification_rule(
                db,
                stream_id=stream_id,
                name=body.name,
                enabled=body.enabled,
                condition_json=body.condition_json.model_dump(),
                classification_level=body.classification_level,
            )
            db.commit()
        except ClassificationRuleValidationError as exc:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        entries = list_classification_rules(db, stream_id)
        entry = next(e for e in entries if e["id"] == rule.id)
        return ClassificationRuleResponse(rule=entry)  # type: ignore[arg-type]

    @router.patch("/streams/{stream_id}/classification-rules/{rule_id}", response_model=ClassificationRuleResponse)
    async def patch_rule(
        stream_id: int,
        rule_id: int,
        body: dict[str, Any],
        db: Session = Depends(get_db),
    ) -> ClassificationRuleResponse:
        try:
            patch_classification_rule(
                db,
                stream_id=stream_id,
                rule_id=rule_id,
                enabled=body.get("enabled"),
            )
            db.commit()
        except ClassificationRuleNotFoundError:
            db.rollback()
            raise HTTPException(status_code=404, detail="not found") from None
        entries = list_classification_rules(db, stream_id)
        entry = next(e for e in entries if e["id"] == rule_id)
        return ClassificationRuleResponse(rule=entry)  # type: ignore[arg-type]

    app = FastAPI()
    app.include_router(router, prefix="/api/v1/runtime")
    return app


@pytest.fixture
def classification_api_client(db_session: Session) -> TestClient:
    app = _classification_test_app()

    def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    return TestClient(app)


@pytest.fixture
def classification_runtime_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_CLASSIFICATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SENSITIVE_DETECTION_ENABLED", True)


def test_no_finding_defaults_internal() -> None:
    level, matched = resolve_classification_level(finding_classes=set(), rules=[])
    assert level == "INTERNAL"
    assert matched == 0


def test_secret_restricted() -> None:
    level, _ = resolve_classification_level(finding_classes={SENSITIVITY_CLASS_SECRET}, rules=[])
    assert level == "RESTRICTED"


def test_pii_confidential() -> None:
    level, _ = resolve_classification_level(finding_classes={SENSITIVITY_CLASS_PII}, rules=[])
    assert level == "CONFIDENTIAL"


def test_security_metadata_internal() -> None:
    level, _ = resolve_classification_level(
        finding_classes={SENSITIVITY_CLASS_SECURITY_METADATA},
        rules=[],
    )
    assert level == "INTERNAL"


def test_explicit_rule_override(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    rule = StreamClassificationRule(
        stream_id=stream_id,
        name="PII public override",
        enabled=True,
        condition_json={"sensitivity_class": SENSITIVITY_CLASS_PII},
        classification_level="PUBLIC",
    )
    level, matched = resolve_classification_level(
        finding_classes={SENSITIVITY_CLASS_PII},
        rules=[rule],
    )
    assert level == "PUBLIC"
    assert matched == 1


def test_highest_level_selection() -> None:
    rules = [
        StreamClassificationRule(
            stream_id=1,
            name="a",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_SECRET},
            classification_level="CONFIDENTIAL",
        ),
        StreamClassificationRule(
            stream_id=1,
            name="b",
            enabled=True,
            condition_json={"sensitivity_class": SENSITIVITY_CLASS_SECRET},
            classification_level="RESTRICTED",
        ),
    ]
    level, matched = resolve_classification_level(finding_classes={SENSITIVITY_CLASS_SECRET}, rules=rules)
    assert level == "RESTRICTED"
    assert matched == 2


def test_classification_level_gdc_fallback() -> None:
    event = {CLASSIFICATION_LEVEL_FIELD: "PUBLIC", "message": "x"}
    stamp_classification_level(event, "RESTRICTED")
    assert event[CLASSIFICATION_LEVEL_FIELD] == "PUBLIC"
    assert event[CLASSIFICATION_LEVEL_GDC_FIELD] == "RESTRICTED"
    assert read_classification_level(event) == "RESTRICTED"


def test_policy_classification_matching(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Restricted quarantine",
        enabled=True,
        condition_json={"classification_level": "RESTRICTED"},
        action_type="quarantine",
    )
    db_session.commit()
    events = [{"api_key": "x"}]
    classify_batch(events, stream_id=stream_id, rules=[], findings=[{"sensitivity_class": SENSITIVITY_CLASS_SECRET}])
    result = evaluate_policy_batch(db_session, stream_id=stream_id, events=events)
    assert result.matched_policy_count == 1
    assert should_quarantine_batch(result)


def test_quarantine_classification_matching(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Q",
        enabled=True,
        condition_json={"classification_level": "CONFIDENTIAL"},
        action_type="quarantine",
    )
    db_session.commit()
    events = [{"email": "a@b.c"}]
    classify_batch(events, stream_id=stream_id, rules=[], findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    result = evaluate_policy_batch(db_session, stream_id=stream_id, events=events)
    assert should_quarantine_batch(result)


def test_dynamic_routing_classification_matching(db_session: Session) -> None:
    from app.destinations.models import Destination
    from app.dynamic_routing.operator_workflow import create_dynamic_route

    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    dest = Destination(
        name="Security Webhook",
        destination_type="WEBHOOK_POST",
        config_json={"url": "https://security-webhook.example.com/events"},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db_session.add(dest)
    db_session.flush()
    _add_enabled_route_for_destination(db_session, stream_id, int(dest.id))
    create_dynamic_route(
        db_session,
        stream_id=stream_id,
        name="Confidential route",
        enabled=True,
        condition_json={"classification_level": "CONFIDENTIAL"},
        destination_id=int(dest.id),
    )
    db_session.commit()
    events = [{"email": "a@b.c"}]
    classify_batch(events, stream_id=stream_id, rules=[], findings=[{"sensitivity_class": SENSITIVITY_CLASS_PII}])
    dyn = evaluate_dynamic_batch(db_session, stream_id=stream_id, events=events)
    assert dyn.matched_dynamic_route_count == 1


def test_preview_classification(db_session: Session, classification_runtime_settings: None) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    resp = run_final_event_draft_preview(
        FinalEventDraftPreviewRequest(
            stream_id=stream_id,
            payload={"items": [{"api_key": "secret-value-12345", "message": "hi"}]},
            event_array_path="$.items",
            field_mappings={"api_key": "$.api_key", "message": "$.message"},
            enrichment={},
            max_events=1,
        ),
        db=db_session,
    )
    assert resp.classification_level == "RESTRICTED"
    assert resp.final_events[0].get("classification_level") == "RESTRICTED"


def test_classification_complete_observability() -> None:
    from app.classification.engine import ClassificationBatchResult

    payload = build_classification_complete_payload(
        stream_id=7,
        result=ClassificationBatchResult(
            classification_level="INTERNAL",
            matched_rule_count=0,
            duration_ms=4,
        ),
        cumulative_distribution={
            "public_count": 0,
            "internal_count": 2,
            "confidential_count": 0,
            "restricted_count": 0,
        },
    )
    assert payload["stage"] == CLASSIFICATION_COMPLETE_STAGE
    assert payload["stream_id"] == 7
    assert payload["classification_level"] == "INTERNAL"
    assert payload["matched_rule_count"] == 0
    assert payload["processing_time_ms"] == 4
    assert payload["total_internal_count"] == 3


def test_summary_api(db_session: Session, classification_api_client: TestClient) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_classification_rule(
        db_session,
        stream_id=stream_id,
        name="Secret restricted",
        enabled=True,
        condition_json={"sensitivity_class": SENSITIVITY_CLASS_SECRET},
        classification_level="RESTRICTED",
    )
    db_session.commit()
    resp = classification_api_client.get(f"/api/v1/runtime/streams/{stream_id}/classification/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_rules"] == 1
    assert body["restricted_count"] == 0


def test_runtime_classification_log_and_stamp(
    db_session: Session,
    classification_runtime_settings: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-1",
                    "password": "super-secret-token-value",
                    "message": "hello",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    ctx = load_stream_context(db_session, stream_id)
    runner = _build_runner(poller=poller, webhook_sender=sender)
    runner.run(ctx, db=db_session)
    logs = (
        db_session.query(DeliveryLog)
        .filter(
            DeliveryLog.stream_id == stream_id,
            DeliveryLog.stage == CLASSIFICATION_COMPLETE_STAGE,
        )
        .all()
    )
    assert logs
    sample = logs[-1].payload_sample or {}
    assert sample.get("classification_level") in {"RESTRICTED", "INTERNAL", "CONFIDENTIAL", "PUBLIC"}


def test_create_classification_rule_api(
    db_session: Session,
    classification_api_client: TestClient,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    resp = classification_api_client.post(
        f"/api/v1/runtime/streams/{stream_id}/classification-rules",
        json={
            "name": "PII confidential",
            "enabled": True,
            "condition_json": {"sensitivity_class": "pii"},
            "classification_level": "CONFIDENTIAL",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["rule"]["classification_level"] == "CONFIDENTIAL"


def test_classify_events_stamps_batch() -> None:
    events = [{"message": "hello"}]
    result = classify_batch(events, stream_id=1, rules=[])
    assert result.classification_level == "INTERNAL"
    assert events[0]["classification_level"] == "INTERNAL"


def test_rule_condition_matches_secret() -> None:
    assert rule_condition_matches(
        {"sensitivity_class": SENSITIVITY_CLASS_SECRET},
        finding_classes={SENSITIVITY_CLASS_SECRET},
    )


def test_evaluate_batch_with_db(db_session: Session, classification_runtime_settings: None) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    events = [{"password": "x"}]
    result = evaluate_batch(db_session, stream_id=stream_id, events=events)
    assert result.classification_level == "RESTRICTED"
    assert events[0]["classification_level"] == "RESTRICTED"


def test_preview_would_quarantine_with_classification(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    create_policy_rule(
        db_session,
        stream_id=stream_id,
        name="Restricted Q",
        enabled=True,
        condition_json={"classification_level": "RESTRICTED"},
        action_type="quarantine",
    )
    db_session.commit()
    events = [{"api_key": "secret-value"}]
    classify_events_for_preview(db_session, stream_id=stream_id, enriched_events=events)
    assert would_quarantine_for_preview(db_session, stream_id=stream_id, enriched_events=events)
