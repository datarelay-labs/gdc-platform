"""Source/Destination API secret masking and masked-update preservation."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.connectors.models import Connector
from app.database import get_db, get_db_read_bounded
from app.destinations.models import Destination
from app.main import app
from app.security.secrets import SECRET_MASK
from app.sources.models import Source


REAL_DEST_BEARER = "Bearer DEST_REAL_SECRET_VALUE_9f3a"
REAL_DEST_API_KEY = "DEST_API_KEY_REAL_VALUE_7c2b"
REAL_DEST_PASSWORD = "DEST_PASSWORD_REAL_VALUE_1a9e"
REAL_SOURCE_TOKEN = "SOURCE_TOKEN_REAL_VALUE_4d8e"
REAL_SOURCE_NESTED = "SOURCE_NESTED_SECRET_VALUE_2b6c"
NEW_DEST_BEARER = "Bearer DEST_NEW_SECRET_VALUE_8e1d"
NEW_SOURCE_TOKEN = "SOURCE_TOKEN_NEW_VALUE_5c7f"


@pytest.fixture
def client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_db_read_bounded] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_db_read_bounded, None)


def _seed_connector(db: Session) -> Connector:
    connector = Connector(name="secret-contract-connector", description=None, status="RUNNING")
    db.add(connector)
    db.commit()
    db.refresh(connector)
    return connector


def _assert_no_real_secrets(body_text: str, *secrets: str) -> None:
    for secret in secrets:
        assert secret not in body_text
    assert SECRET_MASK in body_text


def test_destination_create_list_detail_mask_secrets(client: TestClient, db_session: Session) -> None:
    created = client.post(
        "/api/v1/destinations/",
        json={
            "name": "secret-dest",
            "destination_type": "WEBHOOK_POST",
            "config_json": {
                "url": "https://receiver.example/hook",
                "api_key": REAL_DEST_API_KEY,
                "password": REAL_DEST_PASSWORD,
                "headers": {
                    "Authorization": REAL_DEST_BEARER,
                    "X-API-Key": REAL_DEST_API_KEY,
                    "Accept": "application/json",
                },
            },
            "rate_limit_json": {},
            "enabled": True,
        },
    )
    assert created.status_code == 201, created.text
    _assert_no_real_secrets(created.text, REAL_DEST_BEARER, REAL_DEST_API_KEY, REAL_DEST_PASSWORD)
    created_body = created.json()
    dest_id = created_body["id"]
    assert created_body["config_json"]["api_key"] == SECRET_MASK
    assert created_body["config_json"]["password"] == SECRET_MASK
    assert created_body["config_json"]["headers"]["Authorization"] == SECRET_MASK
    assert created_body["config_json"]["headers"]["X-API-Key"] == SECRET_MASK
    assert created_body["config_json"]["headers"]["Accept"] == "application/json"

    listed = client.get("/api/v1/destinations/")
    assert listed.status_code == 200
    _assert_no_real_secrets(listed.text, REAL_DEST_BEARER, REAL_DEST_API_KEY, REAL_DEST_PASSWORD)
    row = next(item for item in listed.json() if item["id"] == dest_id)
    assert row["config_json"]["headers"]["Authorization"] == SECRET_MASK

    detail = client.get(f"/api/v1/destinations/{dest_id}")
    assert detail.status_code == 200
    _assert_no_real_secrets(detail.text, REAL_DEST_BEARER, REAL_DEST_API_KEY, REAL_DEST_PASSWORD)
    assert detail.json()["config_json"]["password"] == SECRET_MASK

    db_session.expire_all()
    persisted = db_session.query(Destination).filter(Destination.id == dest_id).one()
    assert persisted.config_json["api_key"] == REAL_DEST_API_KEY
    assert persisted.config_json["password"] == REAL_DEST_PASSWORD
    assert persisted.config_json["headers"]["Authorization"] == REAL_DEST_BEARER


def test_destination_masked_update_preserves_nested_and_replaces_new(
    client: TestClient,
    db_session: Session,
) -> None:
    created = client.post(
        "/api/v1/destinations/",
        json={
            "name": "secret-dest-update",
            "destination_type": "WEBHOOK_POST",
            "config_json": {
                "url": "https://receiver.example/hook",
                "api_key": REAL_DEST_API_KEY,
                "headers": {"Authorization": REAL_DEST_BEARER, "Accept": "application/json"},
            },
            "enabled": True,
        },
    )
    assert created.status_code == 201, created.text
    dest_id = created.json()["id"]

    preserved = client.put(
        f"/api/v1/destinations/{dest_id}",
        json={
            "config_json": {
                "url": "https://receiver.example/hook",
                "api_key": SECRET_MASK,
                "headers": {"Authorization": SECRET_MASK, "Accept": "application/json"},
            }
        },
    )
    assert preserved.status_code == 200, preserved.text
    _assert_no_real_secrets(preserved.text, REAL_DEST_BEARER, REAL_DEST_API_KEY)
    assert preserved.json()["config_json"]["api_key"] == SECRET_MASK
    assert preserved.json()["config_json"]["headers"]["Authorization"] == SECRET_MASK

    db_session.expire_all()
    row = db_session.query(Destination).filter(Destination.id == dest_id).one()
    assert row.config_json["api_key"] == REAL_DEST_API_KEY
    assert row.config_json["headers"]["Authorization"] == REAL_DEST_BEARER

    replaced = client.put(
        f"/api/v1/destinations/{dest_id}",
        json={
            "config_json": {
                "url": "https://receiver.example/hook",
                "api_key": "DEST_API_KEY_REPLACED",
                "headers": {"Authorization": NEW_DEST_BEARER, "Accept": "application/json"},
            }
        },
    )
    assert replaced.status_code == 200, replaced.text
    assert NEW_DEST_BEARER not in replaced.text
    assert "DEST_API_KEY_REPLACED" not in replaced.text
    assert replaced.json()["config_json"]["headers"]["Authorization"] == SECRET_MASK

    db_session.expire_all()
    row = db_session.query(Destination).filter(Destination.id == dest_id).one()
    assert row.config_json["api_key"] == "DEST_API_KEY_REPLACED"
    assert row.config_json["headers"]["Authorization"] == NEW_DEST_BEARER


def test_destination_runtime_delivery_uses_real_credential(
    client: TestClient,
    db_session: Session,
) -> None:
    created = client.post(
        "/api/v1/destinations/",
        json={
            "name": "secret-dest-runtime",
            "destination_type": "WEBHOOK_POST",
            "config_json": {
                "url": "https://receiver.example/hook",
                "headers": {"Authorization": REAL_DEST_BEARER},
            },
            "enabled": True,
        },
    )
    dest_id = created.json()["id"]
    client.put(
        f"/api/v1/destinations/{dest_id}",
        json={
            "config_json": {
                "url": "https://receiver.example/hook",
                "headers": {"Authorization": SECRET_MASK},
            }
        },
    )
    db_session.expire_all()
    row = db_session.query(Destination).filter(Destination.id == dest_id).one()

    captured: dict[str, Any] = {}

    def _fake_send(self: Any, events: list[dict[str, Any]], config: dict[str, Any], **kwargs: Any) -> None:
        captured["headers"] = dict(config.get("headers") or {})
        captured["events"] = events

    with patch("app.destinations.adapters.webhook_post.WebhookSender.send", _fake_send):
        from app.destinations.adapters.webhook_post import WebhookPostDestinationAdapter

        WebhookPostDestinationAdapter().send([{"ok": True}], dict(row.config_json or {}))

    assert captured["headers"]["Authorization"] == REAL_DEST_BEARER
    assert SECRET_MASK not in str(captured["headers"]["Authorization"])


def test_source_list_detail_mask_and_masked_update_preserve(
    client: TestClient,
    db_session: Session,
) -> None:
    connector = _seed_connector(db_session)
    created = client.post(
        "/api/v1/sources/",
        json={
            "connector_id": connector.id,
            "source_type": "HTTP_API_POLLING",
            "config_json": {
                "endpoint": "/events",
                "headers": {"Authorization": f"Bearer {REAL_SOURCE_NESTED}"},
                "password": REAL_SOURCE_TOKEN,
            },
            "auth_json": {"token": REAL_SOURCE_TOKEN, "api_key": REAL_SOURCE_TOKEN},
            "enabled": True,
        },
    )
    assert created.status_code == 201, created.text
    _assert_no_real_secrets(created.text, REAL_SOURCE_TOKEN, REAL_SOURCE_NESTED)
    source_id = created.json()["id"]

    listed = client.get("/api/v1/sources/")
    assert listed.status_code == 200
    _assert_no_real_secrets(listed.text, REAL_SOURCE_TOKEN, REAL_SOURCE_NESTED)

    detail = client.get(f"/api/v1/sources/{source_id}")
    assert detail.status_code == 200
    _assert_no_real_secrets(detail.text, REAL_SOURCE_TOKEN, REAL_SOURCE_NESTED)
    assert detail.json()["auth_json"]["token"] == SECRET_MASK
    assert detail.json()["config_json"]["headers"]["Authorization"] == SECRET_MASK

    preserved = client.put(
        f"/api/v1/sources/{source_id}",
        json={
            "config_json": {
                "endpoint": "/events",
                "headers": {"Authorization": SECRET_MASK},
                "password": SECRET_MASK,
            },
            "auth_json": {"token": SECRET_MASK, "api_key": SECRET_MASK},
        },
    )
    assert preserved.status_code == 200, preserved.text
    _assert_no_real_secrets(preserved.text, REAL_SOURCE_TOKEN, REAL_SOURCE_NESTED)

    db_session.expire_all()
    row = db_session.query(Source).filter(Source.id == source_id).one()
    assert row.auth_json["token"] == REAL_SOURCE_TOKEN
    assert row.auth_json["api_key"] == REAL_SOURCE_TOKEN
    assert row.config_json["password"] == REAL_SOURCE_TOKEN
    assert row.config_json["headers"]["Authorization"] == f"Bearer {REAL_SOURCE_NESTED}"

    replaced = client.put(
        f"/api/v1/sources/{source_id}",
        json={"auth_json": {"token": NEW_SOURCE_TOKEN, "api_key": NEW_SOURCE_TOKEN}},
    )
    assert replaced.status_code == 200
    assert NEW_SOURCE_TOKEN not in replaced.text
    db_session.expire_all()
    row = db_session.query(Source).filter(Source.id == source_id).one()
    assert row.auth_json["token"] == NEW_SOURCE_TOKEN


def test_source_runtime_connection_uses_real_credential_after_masked_update(
    client: TestClient,
    db_session: Session,
) -> None:
    connector = _seed_connector(db_session)
    created = client.post(
        "/api/v1/sources/",
        json={
            "connector_id": connector.id,
            "source_type": "HTTP_API_POLLING",
            "config_json": {"endpoint": "/events"},
            "auth_json": {"token": REAL_SOURCE_TOKEN},
            "enabled": True,
        },
    )
    source_id = created.json()["id"]
    client.put(
        f"/api/v1/sources/{source_id}",
        json={"auth_json": {"token": SECRET_MASK}},
    )
    db_session.expire_all()
    row = db_session.query(Source).filter(Source.id == source_id).one()
    assert row.auth_json["token"] == REAL_SOURCE_TOKEN
    assert row.auth_json["token"] != SECRET_MASK
