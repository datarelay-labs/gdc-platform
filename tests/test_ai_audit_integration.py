"""Integration: prompt block and response mask produce audit events (M23)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_audit.models import AI_AUDIT_EVENT_PROMPT_BLOCKED, AI_AUDIT_EVENT_RESPONSE_MASKED, AiAuditEvent
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


def test_prompt_block_creates_audit_event(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="audit-block")
    ai_stream_id = _ai_stream_id(db_session, stack["stream_id"])
    create_ai_policy_rule(
        db_session,
        ai_stream_id=ai_stream_id,
        name="audit-block-keyword",
        enabled=True,
        target=AI_POLICY_TARGET_PROMPT,
        inspection_type=AI_POLICY_INSPECTION_KEYWORD,
        condition_json={"keyword": "audit-block-me"},
        action_type=AI_POLICY_ACTION_BLOCK,
    )
    db_session.commit()

    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "audit-block-me"}]},
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 403, resp.text
    request_id = resp.json()["detail"]["request_id"]
    assert request_id

    rows = (
        db_session.query(AiAuditEvent)
        .filter(AiAuditEvent.request_id == request_id)
        .all()
    )
    assert len(rows) == 1
    row = rows[0]
    assert row.event_type == AI_AUDIT_EVENT_PROMPT_BLOCKED
    assert row.action == "block"
    assert row.matched_rule == "audit-block-keyword"
    assert row.matched_pattern == "audit-block-me"
    assert row.provider == "MOCK"
    assert row.stream_id == stack["stream_id"]


def test_response_mask_creates_audit_event(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.ai_providers.adapters.mock import MockProviderAdapter
    from app.ai_providers.adapters.types import ProviderSendResult

    def _pii_response(self: MockProviderAdapter, request: Any, *, timeout_seconds: float) -> ProviderSendResult:
        _ = self, timeout_seconds
        return ProviderSendResult(
            success=True,
            status_code=200,
            latency_ms=0,
            provider_response_id="mock-audit-pii",
            normalized_response={
                "id": "mock-audit-pii",
                "provider": "MOCK",
                "model": "mock-model",
                "content": "Contact audit-mask@example.com",
            },
        )

    monkeypatch.setattr(MockProviderAdapter, "send_request", _pii_response)

    stack = _seed_ai_proxy_stack(db_session, slug="audit-mask")
    ai_stream_id = _ai_stream_id(db_session, stack["stream_id"])
    create_ai_policy_rule(
        db_session,
        ai_stream_id=ai_stream_id,
        name="audit-mask-email",
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
    request_id = resp.json().get("request_id") or resp.json().get("id")
    # ingress attaches request_id on detail for errors; success body may use provider id — fetch from audit
    rows = db_session.query(AiAuditEvent).filter(AiAuditEvent.stream_id == stack["stream_id"]).all()
    assert rows
    mask_rows = [r for r in rows if r.event_type == AI_AUDIT_EVENT_RESPONSE_MASKED]
    assert len(mask_rows) == 1
    row = mask_rows[0]
    assert row.action == "mask"
    assert row.matched_rule == "audit-mask-email"
    assert row.request_id
