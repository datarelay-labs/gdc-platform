"""AI policy CRUD API tests (M22)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

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
    token, _ = issue_access_token(username=f"{role.lower()}-policy", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def test_ai_policy_crud(client: TestClient, db_session: Session) -> None:
    stack = seed_ai_stream_for_policy(db_session, slug="policy-crud")
    headers = _bearer("OPERATOR")
    create_resp = client.post(
        "/api/v1/ai-policy-rules/",
        headers=headers,
        json={
            "ai_stream_id": stack["ai_stream_id"],
            "name": "block-keyword",
            "enabled": True,
            "target": "prompt",
            "inspection_type": "keyword",
            "condition_json": {"keyword": "secret"},
            "action_type": "block",
        },
    )
    assert create_resp.status_code == 201, create_resp.text
    rule_id = create_resp.json()["id"]

    list_resp = client.get(f"/api/v1/ai-policy-rules/?ai_stream_id={stack['ai_stream_id']}", headers=_bearer("VIEWER"))
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1

    patch_resp = client.patch(
        f"/api/v1/ai-policy-rules/{rule_id}",
        headers=headers,
        json={"enabled": False},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["enabled"] is False

    delete_resp = client.delete(f"/api/v1/ai-policy-rules/{rule_id}", headers=headers)
    assert delete_resp.status_code == 204


def test_viewer_cannot_create_policy(client: TestClient, db_session: Session) -> None:
    stack = seed_ai_stream_for_policy(db_session, slug="policy-rbac")
    resp = client.post(
        "/api/v1/ai-policy-rules/",
        headers=_bearer("VIEWER"),
        json={
            "ai_stream_id": stack["ai_stream_id"],
            "name": "deny",
            "enabled": True,
            "target": "prompt",
            "inspection_type": "keyword",
            "condition_json": {"keyword": "x"},
            "action_type": "block",
        },
    )
    assert resp.status_code == 403
