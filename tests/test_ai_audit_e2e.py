"""E2E: request_id correlation across audit events and delivery logs (M23)."""

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
from app.logs.models import DeliveryLog
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
    token, _ = issue_access_token(username=f"{role.lower()}-audit-e2e", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _ai_stream_id(db: Session, stream_id: int) -> int:
    row = db.query(AiStream).filter(AiStream.stream_id == stream_id).one()
    return int(row.id)


def test_e2e_request_correlation(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="audit-corr-e2e")
    ai_stream_id = _ai_stream_id(db_session, stack["stream_id"])
    create_ai_policy_rule(
        db_session,
        ai_stream_id=ai_stream_id,
        name="corr-block",
        enabled=True,
        target=AI_POLICY_TARGET_PROMPT,
        inspection_type=AI_POLICY_INSPECTION_KEYWORD,
        condition_json={"keyword": "corr-token"},
        action_type=AI_POLICY_ACTION_BLOCK,
    )
    db_session.commit()

    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "corr-token"}]},
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 403, resp.text
    request_id = resp.json()["detail"]["request_id"]

    corr = client.get(
        f"/api/v1/ai-audit-events/correlation/{request_id}",
        headers=_bearer("VIEWER"),
    )
    assert corr.status_code == 200, corr.text
    body = corr.json()
    assert body["request_id"] == request_id
    assert body["stream_id"] == stack["stream_id"]
    assert body["ai_stream_id"] == ai_stream_id
    assert body["policy_rule_ids"]
    assert body["events"][0]["event_type"] == "PROMPT_BLOCKED"

    from sqlalchemy import select

    delivery_rows = list(
        db_session.execute(
            select(DeliveryLog).where(
                DeliveryLog.stream_id == stack["stream_id"],
                DeliveryLog.payload_sample.op("->>")("request_id") == request_id,
            )
        ).scalars()
    )
    assert delivery_rows
    assert any(str(row.stage) == "ai_policy_prompt" for row in delivery_rows)
    assert body["delivery_logs"]
    assert any(log["stage"] == "ai_policy_prompt" for log in body["delivery_logs"])
