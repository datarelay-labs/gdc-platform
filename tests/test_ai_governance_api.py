"""AI governance API and RBAC tests (M24)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_governance.models import VIOLATION_STATUS_OPEN, AiPolicyViolation
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
    token, _ = issue_access_token(username=f"{role.lower()}-gov", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _seed_violation(db: Session, *, request_id: str = "api-gov-1") -> dict[str, Any]:
    stack = seed_ai_stream_for_policy(db, slug=f"api-gov-{request_id}")
    row = AiPolicyViolation(
        request_id=request_id,
        stream_id=stack["stream_id"],
        ai_provider_id=stack["provider_id"],
        ai_stream_id=stack["ai_stream_id"],
        policy_rule_id=None,
        provider="MOCK",
        ai_stream=stack["slug"],
        rule_id="block-keyword",
        action="block",
        severity="HIGH",
        status=VIOLATION_STATUS_OPEN,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"stack": stack, "violation_id": int(row.id)}


def test_list_violations(client: TestClient, db_session: Session) -> None:
    seeded = _seed_violation(db_session, request_id="api-list")
    resp = client.get("/api/v1/ai-governance/violations", headers=_bearer("VIEWER"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] >= 1
    assert any(v["request_id"] == "api-list" for v in body["violations"])
    assert seeded["violation_id"] > 0


def test_get_violation_detail(client: TestClient, db_session: Session) -> None:
    seeded = _seed_violation(db_session, request_id="api-detail")
    resp = client.get(
        f"/api/v1/ai-governance/violations/{seeded['violation_id']}",
        headers=_bearer("VIEWER"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["request_id"] == "api-detail"


def test_acknowledge_and_resolve(client: TestClient, db_session: Session) -> None:
    seeded = _seed_violation(db_session, request_id="api-workflow")
    vid = seeded["violation_id"]
    ack = client.post(
        f"/api/v1/ai-governance/violations/{vid}/acknowledge",
        headers=_bearer("OPERATOR"),
        json={"note": "seen"},
    )
    assert ack.status_code == 200, ack.text
    assert ack.json()["status"] == "ACKNOWLEDGED"

    resolved = client.post(
        f"/api/v1/ai-governance/violations/{vid}/resolve",
        headers=_bearer("OPERATOR"),
        json={"note": "done"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["status"] == "RESOLVED"


def test_dashboard_summary(client: TestClient, db_session: Session) -> None:
    _seed_violation(db_session, request_id="api-dash")
    resp = client.get("/api/v1/ai-governance/dashboard/summary", headers=_bearer("VIEWER"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["policy_violations"] >= 1
    assert "mask_events" in body
    assert "policy_impact" in body


def test_policy_impact_endpoint(client: TestClient, db_session: Session) -> None:
    _seed_violation(db_session, request_id="api-impact")
    resp = client.get("/api/v1/ai-governance/policy-impact", headers=_bearer("VIEWER"))
    assert resp.status_code == 200, resp.text
    assert isinstance(resp.json(), list)


def test_viewer_cannot_mutate(client: TestClient, db_session: Session) -> None:
    seeded = _seed_violation(db_session, request_id="api-rbac")
    resp = client.post(
        f"/api/v1/ai-governance/violations/{seeded['violation_id']}/acknowledge",
        headers=_bearer("VIEWER"),
        json={},
    )
    assert resp.status_code == 403, resp.text


def test_governance_auditor_cannot_read(client: TestClient, db_session: Session) -> None:
    _seed_violation(db_session, request_id="api-gov-auditor")
    resp = client.get("/api/v1/ai-governance/violations", headers=_bearer("GOVERNANCE_AUDITOR"))
    assert resp.status_code == 403, resp.text
