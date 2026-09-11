"""Stream governance Contract v1 API — route protection overrides (Phase 1 backend)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database import get_db, get_db_read_bounded
from app.main import app
from app.protection.models import PROTECTION_MODE_FULL_MASK, PROTECTION_MODE_PARTIAL_MASK, StreamProtectionRule
from app.route_protection.resolver import resolve_route_protection_config
from app.sensitive_detection.models import SENSITIVITY_CLASS_PII
from app.streams.models import Stream

from tests.test_stream_runner_e2e import _seed_stream_runtime


@pytest.fixture
def governance_client(db_session: Session) -> TestClient:
    def _override_read() -> Any:
        yield db_session

    def _override_write() -> Any:
        yield db_session

    app.dependency_overrides[get_db_read_bounded] = _override_read
    app.dependency_overrides[get_db] = _override_write
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db_read_bounded, None)
        app.dependency_overrides.pop(get_db, None)


def _api_detail(body: dict[str, Any]) -> dict[str, Any]:
    detail = body.get("detail")
    if isinstance(detail, dict):
        return detail
    if isinstance(detail, list) and detail:
        first = detail[0]
        if isinstance(first, dict):
            return first
    return {}


def _put_governance(client: TestClient, stream_id: int, payload: dict[str, Any]) -> Any:
    return client.put(f"/api/v1/runtime/streams/{stream_id}/governance", json=payload)


def _get_effective(client: TestClient, stream_id: int) -> Any:
    return client.get(f"/api/v1/runtime/streams/{stream_id}/governance/effective-protection")


def test_as1_default_audit_route_overrides_mask_tokenize_default(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    """AS-1: Default Audit; Route A Mask; Route B Tokenize; Route C Default."""
    fixture = _seed_stream_runtime(
        db_session,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = fixture["stream_id"]
    route_a, route_b, route_c = fixture["route_ids"]

    payload = {
        "enabled": True,
        "rules": [
            {
                "field_path": "$.user.email",
                "default_protection_action": "audit",
                "default_delivery_behavior": "continue",
                "enabled": True,
            }
        ],
        "route_overrides": [
            {
                "field_path": "$.user.email",
                "route_id": route_a,
                "protection_action": "mask_partial",
                "enabled": True,
            },
            {
                "field_path": "$.user.email",
                "route_id": route_b,
                "protection_action": "tokenize",
                "enabled": True,
            },
        ],
    }
    put = _put_governance(governance_client, stream_id, payload)
    assert put.status_code == 200
    body = put.json()
    assert len(body["route_overrides"]) == 2

    effective = _get_effective(governance_client, stream_id)
    assert effective.status_code == 200
    fields = effective.json()["fields"]
    email_field = next(f for f in fields if f["field_path"] == "$.user.email")
    assert email_field["stream_default"]["protection_action"] == "audit"

    by_route = {item["route_id"]: item for item in email_field["per_route"]}
    assert by_route[route_a]["effective"]["protection_action"] == "mask_partial"
    assert by_route[route_a]["effective"]["source"] == "route_override"
    assert by_route[route_b]["effective"]["protection_action"] == "tokenize"
    assert by_route[route_b]["effective"]["source"] == "route_override"
    assert by_route[route_c]["effective"]["protection_action"] == "audit"
    assert by_route[route_c]["effective"]["source"] == "stream_default"
    assert by_route[route_c]["effective"]["mutates_field"] is False


def test_as2_override_audit_removes_base_mutation(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    """AS-2: Stream mask base + route audit override."""
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    db_session.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.email",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_PARTIAL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db_session.commit()

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.email",
                    "route_id": route_id,
                    "protection_action": "audit",
                    "enabled": True,
                }
            ],
        },
    )
    assert put.status_code == 200

    config = resolve_route_protection_config(
        route_id=route_id,
        stream_id=stream_id,
        stream_protection_rules=db_session.query(StreamProtectionRule)
        .filter(StreamProtectionRule.stream_id == stream_id)
        .all(),
        route_overrides=put.json()["route_overrides"],
    )
    assert config.rules == ()
    assert config.audit_only_paths == ("$.email",)

    effective = _get_effective(governance_client, stream_id).json()
    email_field = next(f for f in effective["fields"] if f["field_path"] == "$.email")
    route_eff = next(item for item in email_field["per_route"] if item["route_id"] == route_id)
    assert route_eff["effective"]["protection_action"] == "audit"
    assert route_eff["effective"]["mutates_field"] is False


def test_as3_duplicate_override_rejected(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    """AS-3: duplicate (field_path, route_id) → 422."""
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.email",
                    "route_id": route_id,
                    "protection_action": "mask_partial",
                    "enabled": True,
                },
                {
                    "field_path": "$.email",
                    "route_id": route_id,
                    "protection_action": "tokenize",
                    "enabled": True,
                },
            ],
        },
    )
    assert put.status_code == 422
    detail = _api_detail(put.json())
    assert detail["error_code"] == "INVALID_ROUTE_OVERRIDE_DUPLICATE"


def test_as4_disabled_override_inherits_stream_default(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    """AS-4: disabled override ignored; stream default applies."""
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    db_session.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.cc",
            sensitivity_class=SENSITIVITY_CLASS_PII,
            protection_mode=PROTECTION_MODE_FULL_MASK,
            enabled=True,
            created_by="test",
        )
    )
    db_session.commit()

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.cc",
                    "route_id": route_id,
                    "protection_action": "audit",
                    "enabled": False,
                }
            ],
        },
    )
    assert put.status_code == 200

    config = resolve_route_protection_config(
        route_id=route_id,
        stream_id=stream_id,
        stream_protection_rules=db_session.query(StreamProtectionRule)
        .filter(StreamProtectionRule.stream_id == stream_id)
        .all(),
        route_overrides=put.json()["route_overrides"],
    )
    assert len(config.rules) == 1
    assert config.rules[0].protection_mode == PROTECTION_MODE_FULL_MASK

    effective = _get_effective(governance_client, stream_id).json()
    cc_field = next(f for f in effective["fields"] if f["field_path"] == "$.cc")
    route_eff = next(item for item in cc_field["per_route"] if item["route_id"] == route_id)
    assert route_eff["effective"]["protection_action"] == "mask_full"
    assert route_eff["effective"]["source"] == "stream_default"


def test_as5_override_only_without_stream_base(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    """AS-5: override creates effective rule when stream base absent."""
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.api_key",
                    "route_id": route_id,
                    "protection_action": "mask_full",
                    "enabled": True,
                }
            ],
        },
    )
    assert put.status_code == 200

    config = resolve_route_protection_config(
        route_id=route_id,
        stream_id=stream_id,
        stream_protection_rules=[],
        route_overrides=put.json()["route_overrides"],
    )
    assert len(config.rules) == 1
    assert config.rules[0].field_path == "$.api_key"
    assert config.rules[0].source == "route_override"

    effective = _get_effective(governance_client, stream_id).json()
    field = next(f for f in effective["fields"] if f["field_path"] == "$.api_key")
    route_eff = next(item for item in field["per_route"] if item["route_id"] == route_id)
    assert route_eff["effective"]["protection_action"] == "mask_full"
    assert route_eff["effective"]["source"] == "route_override"


def test_as6_invalid_route_id_rejected(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    """AS-6: orphan route_id → 422."""
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.email",
                    "route_id": 999999,
                    "protection_action": "mask_partial",
                    "enabled": True,
                }
            ],
        },
    )
    assert put.status_code == 422
    assert _api_detail(put.json())["error_code"] == "INVALID_ROUTE_OVERRIDE_ROUTE"


def test_missing_action_when_enabled(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.email",
                    "route_id": route_id,
                    "enabled": True,
                }
            ],
        },
    )
    assert put.status_code == 422
    assert _api_detail(put.json())["error_code"] == "ROUTE_OVERRIDE_MISSING_ACTION"


def test_invalid_protection_action_rejected(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.email",
                    "route_id": route_id,
                    "protection_action": "remove",
                    "enabled": True,
                }
            ],
        },
    )
    assert put.status_code == 422
    assert _api_detail(put.json())["error_code"] == "INVALID_PROTECTION_ACTION"


def test_get_governance_round_trip(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    payload = {
        "enabled": True,
        "rules": [
            {
                "field_path": "$.user.email",
                "default_protection_action": "audit",
                "enabled": True,
            }
        ],
        "route_overrides": [
            {
                "field_path": "$.user.email",
                "route_id": route_id,
                "protection_action": "hash",
                "enabled": True,
            }
        ],
    }
    assert _put_governance(governance_client, stream_id, payload).status_code == 200

    get_resp = governance_client.get(f"/api/v1/runtime/streams/{stream_id}/governance")
    assert get_resp.status_code == 200
    body = get_resp.json()
    assert body["stream_id"] == stream_id
    assert len(body["rules"]) == 1
    assert len(body["route_overrides"]) == 1
    assert body["route_overrides"][0]["protection_action"] == "hash"

    stream = db_session.query(Stream).filter(Stream.id == stream_id).one()
    stored = stream.config_json["governance"]["route_overrides"]
    assert len(stored) == 1
    assert stored[0]["field_path"] == "$.user.email"


def test_nested_rule_overrides_flattened_on_save(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [
                {
                    "field_path": "$.phone",
                    "default_protection_action": "audit",
                    "route_overrides": [
                        {
                            "route_id": route_id,
                            "protection_action": "mask_partial",
                            "enabled": True,
                        }
                    ],
                }
            ],
            "route_overrides": [],
        },
    )
    assert put.status_code == 200
    flat = put.json()["route_overrides"]
    assert len(flat) == 1
    assert flat[0]["field_path"] == "$.phone"
    assert flat[0]["route_id"] == route_id

    stream = db_session.query(Stream).filter(Stream.id == stream_id).one()
    assert len(stream.config_json["governance"]["route_overrides"]) == 1


def test_classification_level_route_override_persisted(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    """Route-level classification floor override persists without field_path."""
    fixture = _seed_stream_runtime(
        db_session,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {"route_id": route_a, "classification_level": "INTERNAL", "enabled": True},
                {"route_id": route_b, "classification_level": "RESTRICTED", "enabled": True},
            ],
        },
    )
    assert put.status_code == 200
    body = put.json()
    assert len(body["route_overrides"]) == 2
    levels = {item["route_id"]: item["classification_level"] for item in body["route_overrides"]}
    assert levels[route_a] == "INTERNAL"
    assert levels[route_b] == "RESTRICTED"


def test_invalid_classification_level_rejected(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {"route_id": route_id, "classification_level": "TOP_SECRET", "enabled": True},
            ],
        },
    )
    assert put.status_code == 422
    detail = _api_detail(put.json())
    assert detail["error_code"] == "INVALID_CLASSIFICATION_LEVEL"


def test_duplicate_classification_override_rejected(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {"route_id": route_id, "classification_level": "INTERNAL", "enabled": True},
                {"route_id": route_id, "classification_level": "RESTRICTED", "enabled": True},
            ],
        },
    )
    assert put.status_code == 422
    detail = _api_detail(put.json())
    assert detail["error_code"] == "INVALID_ROUTE_OVERRIDE_DUPLICATE"


def test_policy_only_delivery_behavior_override_accepted(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {"route_id": route_id, "delivery_behavior": "quarantine", "enabled": True},
            ],
        },
    )
    assert put.status_code == 200
    body = put.json()
    assert len(body["route_overrides"]) == 1
    assert body["route_overrides"][0]["delivery_behavior"] == "quarantine"
    assert body["route_overrides"][0]["classification_level"] is None
    assert body["route_overrides"][0]["protection_action"] is None


def test_classification_only_override_still_accepted(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {"route_id": route_id, "classification_level": "RESTRICTED", "enabled": True},
            ],
        },
    )
    assert put.status_code == 200
    assert put.json()["route_overrides"][0]["classification_level"] == "RESTRICTED"


def test_combined_classification_and_policy_override_accepted(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {"route_id": route_id, "classification_level": "RESTRICTED", "enabled": True},
                {"route_id": route_id, "delivery_behavior": "block", "enabled": True},
            ],
        },
    )
    assert put.status_code == 200
    overrides = put.json()["route_overrides"]
    assert len(overrides) == 2
    assert {item.get("classification_level") for item in overrides} == {"RESTRICTED", None}
    assert {item.get("delivery_behavior") for item in overrides} == {None, "block"}


def test_protection_override_still_accepted(
    governance_client: TestClient,
    db_session: Session,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = fixture["stream_id"]
    route_id = fixture["route_ids"][0]

    put = _put_governance(
        governance_client,
        stream_id,
        {
            "enabled": True,
            "rules": [],
            "route_overrides": [
                {
                    "field_path": "$.email",
                    "route_id": route_id,
                    "protection_action": "mask_partial",
                    "enabled": True,
                },
            ],
        },
    )
    assert put.status_code == 200
    assert put.json()["route_overrides"][0]["protection_action"] == "mask_partial"
