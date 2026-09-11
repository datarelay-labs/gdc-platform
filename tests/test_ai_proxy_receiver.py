"""Ingress tests for AI_PROXY_RECEIVER (M21.3)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_providers.models import AiProvider
from app.ai_streams.models import AiStream
from app.checkpoints.models import Checkpoint
from app.connectors.models import Connector
from app.database import get_db, get_db_read_bounded
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.routes.models import Route
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


def _seed_ai_proxy_stack(
    db: Session,
    *,
    slug: str = "test-chat",
    enabled: bool = True,
    provider_type: str = "MOCK",
) -> dict[str, Any]:
    provider = AiProvider(
        name="ingress-provider",
        provider_type=provider_type,
        enabled=True,
        endpoint_url="mock://local",
        auth_json={},
        default_model="mock-model",
        timeout_seconds=120,
    )
    connector = Connector(name="ingress-connector", description="", status="RUNNING")
    db.add_all([provider, connector])
    db.flush()

    source = Source(
        connector_id=connector.id,
        source_type="AI_PROXY_RECEIVER",
        config_json={},
        auth_json={"auth_mode": "no_auth"},
        enabled=True,
    )
    db.add(source)
    db.flush()

    stream = Stream(
        connector_id=connector.id,
        source_id=source.id,
        name="ingress-stream",
        stream_type="AI_PROXY_RECEIVER",
        config_json={},
        polling_interval=60,
        enabled=True,
        status="RUNNING",
        rate_limit_json={"max_requests": 100, "per_seconds": 60},
    )
    db.add(stream)
    db.flush()

    mapping = Mapping(
        stream_id=stream.id,
        event_array_path=None,
        field_mappings_json={"provider_request": "$.ai.body"},
        raw_payload_mode="JSON",
    )
    enrichment = Enrichment(stream_id=stream.id, enrichment_json={}, override_policy="KEEP_EXISTING", enabled=True)
    destination = Destination(
        name="ingress-dest",
        destination_type="AI_PROVIDER_POST",
        config_json={"provider_id": int(provider.id), "retry_count": 0},
        rate_limit_json={"max_events": 100, "per_seconds": 1},
        enabled=True,
    )
    db.add_all([mapping, enrichment, destination])
    db.flush()

    route = Route(
        stream_id=stream.id,
        destination_id=destination.id,
        enabled=True,
        failure_policy="LOG_AND_CONTINUE",
        formatter_config_json={},
        rate_limit_json={},
        status="ENABLED",
    )
    db.add(route)
    db.add(
        Checkpoint(
            stream_id=stream.id,
            checkpoint_type="AI_PROXY_PUSH",
            checkpoint_value_json={"last_request_id": None},
        )
    )
    ai_stream = AiStream(
        stream_id=int(stream.id),
        provider_id=int(provider.id),
        slug=slug,
        model="mock-model",
        enabled=enabled,
    )
    db.add(ai_stream)
    db.commit()
    return {"slug": slug, "stream_id": int(stream.id)}


def _chat_payload(**overrides: Any) -> dict[str, Any]:
    body = {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
        "temperature": 0.2,
    }
    body.update(overrides)
    return body


def test_chat_completions_success(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session)
    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json=_chat_payload(),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == "mock-response"
    assert body["content"] == "Mock response"


def test_stream_true_rejected(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session)
    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json=_chat_payload(stream=True),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error_code"] == "AI_STREAMING_NOT_SUPPORTED"


def test_unknown_slug_404(client: TestClient, db_session: Session) -> None:
    _seed_ai_proxy_stack(db_session)
    resp = client.post(
        "/api/v1/ingest/ai/missing-slug/v1/chat/completions",
        json=_chat_payload(),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"]["error_code"] == "AI_STREAM_NOT_FOUND"


def test_disabled_stream_409(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="disabled-chat", enabled=False)
    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json=_chat_payload(),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["error_code"] == "AI_STREAM_DISABLED"


def test_invalid_payload_422(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session)
    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json={"model": "mock-model"},
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["error_code"] == "AI_PROXY_INVALID_PAYLOAD"


def test_metadata_accepted(client: TestClient, db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="meta-chat")
    resp = client.post(
        f"/api/v1/ingest/ai/{stack['slug']}/v1/chat/completions",
        json=_chat_payload(metadata={"tenant_id": "t-1", "trace_id": "trace-1"}),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 200, resp.text
