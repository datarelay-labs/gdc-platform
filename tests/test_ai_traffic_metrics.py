"""Traffic metrics tests for AI Gateway (M21.4)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.ai_providers.traffic_metrics import build_ai_traffic_summary
from app.auth.jwt_service import issue_access_token
from app.database import get_db, get_db_read_bounded
from app.destinations.models import Destination
from app.logs.models import DeliveryLog
from tests.ai_gateway_http import build_ai_gateway_test_app
from tests.test_ai_proxy_receiver import _seed_ai_proxy_stack

app = build_ai_gateway_test_app()


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.dependency_overrides[get_db_read_bounded] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _bearer(role: str) -> dict[str, str]:
    token, _ = issue_access_token(username=f"{role.lower()}-traffic", user_id=1, role=role, token_version=1)
    return {"Authorization": f"Bearer {token}"}


def test_traffic_summary_aggregates_provider_metrics(db_session: Session) -> None:
    stack = _seed_ai_proxy_stack(db_session, slug="metrics-chat")
    destination = (
        db_session.query(Destination)
        .filter(Destination.destination_type == "AI_PROVIDER_POST")
        .order_by(Destination.id.desc())
        .first()
    )
    assert destination is not None
    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            DeliveryLog(
                stream_id=stack["stream_id"],
                destination_id=int(destination.id),
                stage="route_send_success",
                level="INFO",
                message="ok",
                payload_sample={},
                latency_ms=120,
                created_at=now,
            ),
            DeliveryLog(
                stream_id=stack["stream_id"],
                destination_id=int(destination.id),
                stage="route_send_failed",
                level="ERROR",
                message="fail",
                payload_sample={},
                latency_ms=80,
                created_at=now,
            ),
        ]
    )
    db_session.commit()

    summary = build_ai_traffic_summary(db_session, hours=24, stream_id=stack["stream_id"])
    assert summary["requests"] == 2
    assert summary["success_count"] == 1
    assert summary["failure_count"] == 1
    assert summary["avg_latency_ms"] == 100
    assert summary["top_providers"]


def test_viewer_can_read_traffic_api(client: TestClient, db_session: Session) -> None:
    _seed_ai_proxy_stack(db_session, slug="api-metrics-chat")
    resp = client.get("/api/v1/ai-providers/traffic/summary", headers=_bearer("VIEWER"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "requests" in body
    assert "success_rate" in body


def test_validate_credentials_returns_valid_for_mock(client: TestClient, db_session: Session) -> None:
    from app.ai_providers.models import AiProvider

    provider = AiProvider(
        name="mock-validate",
        provider_type="MOCK",
        enabled=True,
        endpoint_url="mock://local",
        auth_json={},
        default_model="mock-model",
        timeout_seconds=30,
    )
    db_session.add(provider)
    db_session.commit()
    resp = client.post(
        f"/api/v1/ai-providers/{provider.id}/validate-credentials",
        headers=_bearer("OPERATOR"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "VALID"
