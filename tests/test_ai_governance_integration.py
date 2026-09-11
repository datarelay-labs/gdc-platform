"""Integration: policy enforcement creates governance violations (M24)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_governance.models import AiPolicyViolation
from app.ai_policy.models import (
    AI_POLICY_ACTION_BLOCK,
    AI_POLICY_INSPECTION_KEYWORD,
    AI_POLICY_TARGET_PROMPT,
)
from app.ai_policy.service import create_ai_policy_rule
from app.ai_streams.models import AiStream
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


def _ai_stream_id(db: Session, stream_id: int) -> int:
    row = db.query(AiStream).filter(AiStream.stream_id == stream_id).one()
    return int(row.id)


def test_prompt_block_creates_violation(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="gov-block")
    ai_stream_id = _ai_stream_id(db_session, stack["stream_id"])
    create_ai_policy_rule(
        db_session,
        ai_stream_id=ai_stream_id,
        name="gov-block-keyword",
        enabled=True,
        target=AI_POLICY_TARGET_PROMPT,
        inspection_type=AI_POLICY_INSPECTION_KEYWORD,
        condition_json={"keyword": "gov-block-me"},
        action_type=AI_POLICY_ACTION_BLOCK,
    )
    db_session.commit()

    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "gov-block-me"}]},
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 403, resp.text
    request_id = resp.json()["detail"]["request_id"]
    assert request_id

    rows = (
        db_session.query(AiPolicyViolation)
        .filter(AiPolicyViolation.request_id == request_id)
        .all()
    )
    assert len(rows) == 1
    row = rows[0]
    assert row.action == "block"
    assert row.rule_id == "gov-block-keyword"
    assert row.status == "OPEN"
