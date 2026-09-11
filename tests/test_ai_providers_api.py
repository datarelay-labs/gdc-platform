"""AI Provider API and RBAC tests (M21.2)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.jwt_service import issue_access_token
from app.database import get_db, get_db_read_bounded
from tests.ai_gateway_http import build_ai_gateway_test_app

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
    token, _ = issue_access_token(username=f"{role.lower()}-ai", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def test_operator_can_create_ai_provider(client: TestClient) -> None:
    headers = _bearer("OPERATOR")
    resp = client.post(
        "/api/v1/ai-providers/",
        headers=headers,
        json={
            "name": "mock-provider",
            "provider_type": "MOCK",
            "endpoint_url": "mock://local",
            "enabled": True,
            "timeout_seconds": 30,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["provider_type"] == "MOCK"
    assert body["auth_json"] == {}


def test_openai_provider_requires_api_key(client: TestClient) -> None:
    headers = _bearer("OPERATOR")
    resp = client.post(
        "/api/v1/ai-providers/",
        headers=headers,
        json={
            "name": "openai-provider",
            "provider_type": "OPENAI",
            "endpoint_url": "https://api.openai.com",
            "default_model": "gpt-4o",
        },
    )
    assert resp.status_code == 422


def test_viewer_cannot_create_ai_provider(client: TestClient) -> None:
    headers = _bearer("VIEWER")
    resp = client.post(
        "/api/v1/ai-providers/",
        headers=headers,
        json={
            "name": "blocked",
            "provider_type": "MOCK",
            "endpoint_url": "mock://local",
        },
    )
    assert resp.status_code == 403


def test_viewer_can_list_ai_providers(client: TestClient) -> None:
    admin_headers = _bearer("ADMINISTRATOR")
    create = client.post(
        "/api/v1/ai-providers/",
        headers=admin_headers,
        json={
            "name": "listed-mock",
            "provider_type": "MOCK",
            "endpoint_url": "mock://local",
        },
    )
    assert create.status_code == 201
    viewer_headers = _bearer("VIEWER")
    resp = client.get("/api/v1/ai-providers/", headers=viewer_headers)
    assert resp.status_code == 200
    assert any(row["name"] == "listed-mock" for row in resp.json())


def test_mock_provider_models_endpoint(client: TestClient) -> None:
    headers = _bearer("OPERATOR")
    created = client.post(
        "/api/v1/ai-providers/",
        headers=headers,
        json={
            "name": "models-mock",
            "provider_type": "MOCK",
            "endpoint_url": "mock://local",
        },
    )
    provider_id = created.json()["id"]
    resp = client.get(f"/api/v1/ai-providers/{provider_id}/models", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["models"] == ["mock-model"]


def test_ai_provider_auth_json_masked_on_read(client: TestClient) -> None:
    headers = _bearer("OPERATOR")
    created = client.post(
        "/api/v1/ai-providers/",
        headers=headers,
        json={
            "name": "masked-openai",
            "provider_type": "OPENAI",
            "endpoint_url": "https://api.openai.com",
            "default_model": "gpt-4o",
            "auth_json": {"api_key": "sk-secret-value"},
        },
    )
    assert created.status_code == 201
    assert created.json()["auth_json"]["api_key"] == "********"
