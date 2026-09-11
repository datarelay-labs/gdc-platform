"""Route policy effective config API."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.main import app
from app.protection.models import StreamPolicyRule
from app.route_policy.models import RoutePolicyRule
from app.streams.models import Stream
from tests.test_runtime_logs_page_endpoint import _seed_stream_two_routes


@pytest.fixture
def route_policy_effective_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def test_route_policy_effective_inherited(
    route_policy_effective_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    db_session.add(
        StreamPolicyRule(
            stream_id=h["stream_id"],
            name="pii-audit",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            action_type="audit_only",
        )
    )
    db_session.commit()

    r = route_policy_effective_client.get(f"/api/v1/runtime/routes/{h['route_a_id']}/policy/effective")
    assert r.status_code == 200
    body = r.json()
    assert body["persisted_source"] == "stream"
    assert body["fallback_used"] is True
    assert body["rule_count"] == 1
    assert body["processing_status"] == "Inherited"


def test_route_policy_effective_overridden(
    route_policy_effective_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    db_session.add(
        StreamPolicyRule(
            stream_id=h["stream_id"],
            name="pii-audit",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            action_type="audit_only",
        )
    )
    db_session.add(
        RoutePolicyRule(
            route_id=h["route_a_id"],
            name="secret-quarantine",
            enabled=True,
            condition_json={"sensitivity_class": "secret"},
            action_type="quarantine",
        )
    )
    db_session.commit()

    r = route_policy_effective_client.get(f"/api/v1/runtime/routes/{h['route_a_id']}/policy/effective")
    body = r.json()
    assert body["persisted_source"] == "route"
    assert body["fallback_used"] is False
    assert body["processing_status"] == "Mixed"
    assert body["rule_count"] == 2


def test_route_policy_effective_mixed_disabled_route_rows(
    route_policy_effective_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    db_session.add(
        StreamPolicyRule(
            stream_id=h["stream_id"],
            name="pii-audit",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            action_type="audit_only",
        )
    )
    db_session.add(
        RoutePolicyRule(
            route_id=h["route_a_id"],
            name="secret-quarantine",
            enabled=False,
            condition_json={"sensitivity_class": "secret"},
            action_type="quarantine",
        )
    )
    db_session.commit()

    r = route_policy_effective_client.get(f"/api/v1/runtime/routes/{h['route_a_id']}/policy/effective")
    body = r.json()
    assert body["persisted_source"] == "stream"
    assert body["fallback_used"] is True
    assert body["processing_status"] == "Mixed"
    assert body["rule_count"] == 1


def _set_governance_route_overrides(db_session: Session, stream_id: int, overrides: list[dict]) -> None:
    stream = db_session.get(Stream, stream_id)
    assert stream is not None
    config = dict(stream.config_json or {})
    config["governance"] = {"route_overrides": overrides}
    stream.config_json = config
    db_session.commit()


def test_route_policy_effective_mixed_governance_override_on_stream_rules(
    route_policy_effective_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    db_session.add(
        StreamPolicyRule(
            stream_id=h["stream_id"],
            name="pii-audit",
            enabled=True,
            condition_json={"sensitivity_class": "pii"},
            action_type="audit_only",
        )
    )
    db_session.commit()
    _set_governance_route_overrides(
        db_session,
        h["stream_id"],
        [
            {
                "route_id": h["route_a_id"],
                "delivery_behavior": "quarantine",
                "enabled": True,
            }
        ],
    )

    r = route_policy_effective_client.get(f"/api/v1/runtime/routes/{h['route_a_id']}/policy/effective")
    body = r.json()
    assert body["persisted_source"] == "stream"
    assert body["processing_status"] == "Mixed"
    assert body["rule_count"] == 1


def test_route_policy_effective_overridden_governance_only(
    route_policy_effective_client: TestClient,
    db_session: Session,
) -> None:
    h = _seed_stream_two_routes(db_session)
    _set_governance_route_overrides(
        db_session,
        h["stream_id"],
        [
            {
                "route_id": h["route_a_id"],
                "delivery_behavior": "quarantine",
                "enabled": True,
            }
        ],
    )

    r = route_policy_effective_client.get(f"/api/v1/runtime/routes/{h['route_a_id']}/policy/effective")
    body = r.json()
    assert body["persisted_source"] == "stream"
    assert body["processing_status"] == "Overridden"
    assert body["rule_count"] == 0
