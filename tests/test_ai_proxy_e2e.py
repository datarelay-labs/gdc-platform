"""Integration: AI_PROXY_RECEIVER -> StreamRunner -> AI_PROVIDER_POST -> Mock Provider."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

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


def test_ai_proxy_full_pipeline(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="e2e-chat")
    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={
            "messages": [{"role": "user", "content": "integration hello"}],
            "temperature": 0.5,
        },
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["provider"] == "MOCK"
    assert body["content"] == "Mock response"

    stages = [
        str(row.stage)
        for row in db_session.query(DeliveryLog)
        .filter(DeliveryLog.stream_id == stack["stream_id"])
        .order_by(DeliveryLog.id.asc())
        .all()
    ]
    assert "route_send_success" in stages
