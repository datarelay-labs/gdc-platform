"""E2E: violation workflow and dashboard aggregation (M24)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_policy.models import (
    AI_POLICY_ACTION_BLOCK,
    AI_POLICY_INSPECTION_KEYWORD,
    AI_POLICY_TARGET_PROMPT,
)
from app.ai_policy.service import create_ai_policy_rule
from app.ai_streams.models import AiStream
from app.auth.jwt_service import issue_access_token
from app.database import get_db, get_db_read_bounded
from tests.ai_gateway_http import build_ai_gateway_test_app
from tests.test_ai_proxy_receiver import _seed_ai_proxy_stack

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
    token, _ = issue_access_token(username=f"{role.lower()}-gov-e2e", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _ai_stream_id(db: Session, stream_id: int) -> int:
    row = db.query(AiStream).filter(AiStream.stream_id == stream_id).one()
    return int(row.id)


def test_block_to_acknowledge_to_resolve_and_dashboard(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="gov-e2e")
    ai_stream_id = _ai_stream_id(db_session, stack["stream_id"])
    create_ai_policy_rule(
        db_session,
        ai_stream_id=ai_stream_id,
        name="gov-e2e-block",
        enabled=True,
        target=AI_POLICY_TARGET_PROMPT,
        inspection_type=AI_POLICY_INSPECTION_KEYWORD,
        condition_json={"keyword": "gov-e2e-block"},
        action_type=AI_POLICY_ACTION_BLOCK,
    )
    db_session.commit()

    block_resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "gov-e2e-block"}]},
        headers={"Content-Type": "application/json"},
    )
    assert block_resp.status_code == 403, block_resp.text
    request_id = block_resp.json()["detail"]["request_id"]

    list_resp = client.get(
        "/api/v1/ai-governance/violations",
        headers=_bearer("VIEWER"),
        params={"request_id": request_id},
    )
    assert list_resp.status_code == 200, list_resp.text
    violations = list_resp.json()["violations"]
    assert len(violations) == 1
    violation_id = violations[0]["id"]

    ack_resp = client.post(
        f"/api/v1/ai-governance/violations/{violation_id}/acknowledge",
        headers=_bearer("OPERATOR"),
        json={"note": "triaged"},
    )
    assert ack_resp.status_code == 200, ack_resp.text
    assert ack_resp.json()["status"] == "ACKNOWLEDGED"

    resolve_resp = client.post(
        f"/api/v1/ai-governance/violations/{violation_id}/resolve",
        headers=_bearer("OPERATOR"),
        json={"note": "closed"},
    )
    assert resolve_resp.status_code == 200, resolve_resp.text
    assert resolve_resp.json()["status"] == "RESOLVED"

    dash_resp = client.get("/api/v1/ai-governance/dashboard/summary", headers=_bearer("VIEWER"))
    assert dash_resp.status_code == 200, dash_resp.text
    dash = dash_resp.json()
    assert dash["policy_violations"] >= 1
    assert dash["policy_blocks"] >= 1
    assert dash["resolved_violations"] >= 1
    assert any(item["count"] >= 1 for item in dash["top_violated_policies"])
