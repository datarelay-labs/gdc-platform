"""AI audit API and RBAC tests (M23)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_audit.models import AI_AUDIT_EVENT_PROMPT_BLOCKED, AiAuditEvent
from app.auth.jwt_service import issue_access_token
from app.database import get_db, get_db_read_bounded
from tests.ai_gateway_http import build_ai_gateway_test_app
from tests.ai_policy_test_helpers import seed_ai_stream_for_policy

app = build_ai_gateway_test_app()


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.dependency_overrides[get_db_read_bounded] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _bearer(role: str) -> dict[str, str]:
    token, _ = issue_access_token(username=f"{role.lower()}-audit", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _seed_event(db: Session, *, request_id: str = "api-req-1") -> dict[str, Any]:
    stack = seed_ai_stream_for_policy(db, slug=f"audit-api-{request_id[:6]}")
    db.add(
        AiAuditEvent(
            stream_id=stack["stream_id"],
            ai_provider_id=stack["provider_id"],
            ai_stream_id=stack["ai_stream_id"],
            request_id=request_id,
            event_type=AI_AUDIT_EVENT_PROMPT_BLOCKED,
            policy_rule_id=None,
            action="block",
            matched_rule="block-keyword",
            matched_pattern="forbidden",
            provider="MOCK",
            model="mock-model",
            created_at=datetime.now(timezone.utc),
        )
    )
    db.commit()
    return stack


def test_ai_audit_list_filters(client: TestClient, db_session: Session) -> None:
    stack = _seed_event(db_session, request_id="api-req-filter")
    resp = client.get(
        "/api/v1/ai-audit-events/",
        headers=_bearer("VIEWER"),
        params={"stream": stack["stream_id"], "event_type": AI_AUDIT_EVENT_PROMPT_BLOCKED},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    assert body["events"][0]["request_id"] == "api-req-filter"
    assert body["events"][0]["matched_rule"] == "block-keyword"


def test_ai_audit_correlation_endpoint(client: TestClient, db_session: Session) -> None:
    _seed_event(db_session, request_id="api-req-corr")
    resp = client.get("/api/v1/ai-audit-events/correlation/api-req-corr", headers=_bearer("OPERATOR"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["request_id"] == "api-req-corr"
    assert body["policy_rule_ids"] == []
    assert len(body["events"]) == 1


def test_ai_audit_metrics_endpoint(client: TestClient, db_session: Session) -> None:
    _seed_event(db_session, request_id="api-req-metrics")
    resp = client.get("/api/v1/ai-audit-events/metrics/summary", headers=_bearer("VIEWER"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["totals"]["blocked_count"] >= 1


def test_ai_audit_forbidden_without_capability(client: TestClient, db_session: Session) -> None:
    _seed_event(db_session, request_id="api-req-rbac")
    token, _ = issue_access_token(
        username="gov-auditor",
        user_id=2,
        role="GOVERNANCE_AUDITOR",
        token_version=1,
    )
    resp = client.get(
        "/api/v1/ai-audit-events/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403
