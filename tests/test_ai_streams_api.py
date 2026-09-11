"""AI Stream API and RBAC tests (M21.3)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_providers.models import AiProvider
from app.auth.jwt_service import issue_access_token
from app.connectors.models import Connector
from app.database import get_db, get_db_read_bounded
from app.sources.models import Source
from app.streams.models import Stream
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
    token, _ = issue_access_token(username=f"{role.lower()}-ai-stream", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def _seed_refs(db_session: Session) -> dict[str, int]:
    provider = AiProvider(
        name="api-provider",
        provider_type="MOCK",
        enabled=True,
        endpoint_url="mock://local",
        auth_json={},
        default_model="mock-model",
        timeout_seconds=120,
    )
    connector = Connector(name="api-connector", description="", status="RUNNING")
    db_session.add_all([provider, connector])
    db_session.flush()
    source = Source(
        connector_id=connector.id,
        source_type="AI_PROXY_RECEIVER",
        config_json={},
        auth_json={},
        enabled=True,
    )
    db_session.add(source)
    db_session.flush()
    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="api-stream",
        stream_type="AI_PROXY_RECEIVER",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={},
    )
    db_session.add(stream)
    db_session.commit()
    return {"stream_id": int(stream.id), "provider_id": int(provider.id)}


def test_operator_can_create_ai_stream(client: TestClient, db_session: Session) -> None:
    refs = _seed_refs(db_session)
    resp = client.post(
        "/api/v1/ai-streams/",
        headers=_bearer("OPERATOR"),
        json={
            "stream_id": refs["stream_id"],
            "provider_id": refs["provider_id"],
            "slug": "api-created",
            "model": "mock-model",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["slug"] == "api-created"


def test_viewer_can_list_ai_streams(client: TestClient, db_session: Session) -> None:
    refs = _seed_refs(db_session)
    create = client.post(
        "/api/v1/ai-streams/",
        headers=_bearer("ADMINISTRATOR"),
        json={
            "stream_id": refs["stream_id"],
            "provider_id": refs["provider_id"],
            "slug": "listed-slug",
            "model": "mock-model",
        },
    )
    assert create.status_code == 201
    resp = client.get("/api/v1/ai-streams/", headers=_bearer("VIEWER"))
    assert resp.status_code == 200
    assert any(row["slug"] == "listed-slug" for row in resp.json())


def test_viewer_cannot_create_ai_stream(client: TestClient, db_session: Session) -> None:
    refs = _seed_refs(db_session)
    resp = client.post(
        "/api/v1/ai-streams/",
        headers=_bearer("VIEWER"),
        json={
            "stream_id": refs["stream_id"],
            "provider_id": refs["provider_id"],
            "slug": "blocked-slug",
            "model": "mock-model",
        },
    )
    assert resp.status_code == 403


def test_ai_stream_crud_lifecycle(client: TestClient, db_session: Session) -> None:
    refs = _seed_refs(db_session)
    headers = _bearer("ADMINISTRATOR")
    create = client.post(
        "/api/v1/ai-streams/",
        headers=headers,
        json={
            "stream_id": refs["stream_id"],
            "provider_id": refs["provider_id"],
            "slug": "lifecycle-slug",
            "model": "mock-model",
        },
    )
    assert create.status_code == 201
    ai_stream_id = create.json()["id"]

    get_resp = client.get(f"/api/v1/ai-streams/{ai_stream_id}", headers=_bearer("VIEWER"))
    assert get_resp.status_code == 200

    patch_resp = client.patch(
        f"/api/v1/ai-streams/{ai_stream_id}",
        headers=headers,
        json={"enabled": False},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["enabled"] is False

    delete_resp = client.delete(f"/api/v1/ai-streams/{ai_stream_id}", headers=headers)
    assert delete_resp.status_code == 204
