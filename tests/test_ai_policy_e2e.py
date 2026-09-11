"""E2E: AI policy prompt block and response mask (M22)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_policy.models import (
    AI_POLICY_ACTION_BLOCK,
    AI_POLICY_ACTION_MASK,
    AI_POLICY_INSPECTION_KEYWORD,
    AI_POLICY_INSPECTION_PII,
    AI_POLICY_TARGET_PROMPT,
    AI_POLICY_TARGET_RESPONSE,
)
from app.ai_policy.service import create_ai_policy_rule
from app.ai_streams.models import AiStream
from app.database import get_db, get_db_read_bounded
from app.logs.models import DeliveryLog
from app.replay.models import StreamReplayEvent
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


def test_e2e_prompt_block(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="policy-block")
    ai_stream_id = _ai_stream_id(db_session, stack["stream_id"])
    create_ai_policy_rule(
        db_session,
        ai_stream_id=ai_stream_id,
        name="block-forbidden",
        enabled=True,
        target=AI_POLICY_TARGET_PROMPT,
        inspection_type=AI_POLICY_INSPECTION_KEYWORD,
        condition_json={"keyword": "forbidden-token"},
        action_type=AI_POLICY_ACTION_BLOCK,
    )
    db_session.commit()

    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "forbidden-token please"}]},
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["error_code"] == "AI_POLICY_BLOCKED"

    replay_rows = (
        db_session.query(StreamReplayEvent)
        .filter(StreamReplayEvent.stream_id == stack["stream_id"])
        .all()
    )
    assert replay_rows == []

    stages = [
        str(row.stage)
        for row in db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stack["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    ]
    assert "ai_policy_prompt" in stages


def test_e2e_response_mask(client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.ai_providers.adapters.mock import MockProviderAdapter
    from app.ai_providers.adapters.types import ProviderSendResult

    def _pii_response(self: MockProviderAdapter, request: Any, *, timeout_seconds: float) -> ProviderSendResult:
        _ = self, timeout_seconds
        return ProviderSendResult(
            success=True,
            status_code=200,
            latency_ms=0,
            provider_response_id="mock-pii",
            normalized_response={
                "id": "mock-pii",
                "provider": "MOCK",
                "model": "mock-model",
                "content": "Reach me at user@example.com",
            },
        )

    monkeypatch.setattr(MockProviderAdapter, "send_request", _pii_response)

    stack = _seed_ai_proxy_stack(db_session, slug="policy-mask")
    ai_stream_id = _ai_stream_id(db_session, stack["stream_id"])
    create_ai_policy_rule(
        db_session,
        ai_stream_id=ai_stream_id,
        name="mask-email-response",
        enabled=True,
        target=AI_POLICY_TARGET_RESPONSE,
        inspection_type=AI_POLICY_INSPECTION_PII,
        condition_json={},
        action_type=AI_POLICY_ACTION_MASK,
    )
    db_session.commit()

    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hello"}]},
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 200, resp.text
    content = str(resp.json().get("content") or "")
    assert "example.com" not in content
    assert "user@" not in content

    stages = [
        str(row.stage)
        for row in db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stack["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    ]
    assert "ai_policy_response" in stages