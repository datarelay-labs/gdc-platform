"""M6 protection — StreamRunner integration."""

from __future__ import annotations

import json
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.protection.models import StreamProtectionRule
from tests.test_stream_runner_e2e import (
    _FakePoller,
    _FakeWebhookSender,
    _build_runner,
    _seed_stream_runtime,
)
from app.runners.stream_loader import load_stream_context


@pytest.fixture
def protection_runtime_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_PROTECTION_HASH_SALT", "test-runtime-salt")


def test_run_masks_delivery_but_checkpoint_keeps_enriched(
    db_session: Session,
    protection_runtime_settings: None,
) -> None:
    db = db_session
    fixture = _seed_stream_runtime(db)
    stream_id = fixture["stream_id"]
    secret_value = "super-secret-token-value"

    from app.mappings.models import Mapping

    mapping = db.query(Mapping).filter_by(stream_id=stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
    }
    db.flush()

    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.api_key",
            sensitivity_class="secret",
            protection_mode="full_mask",
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-1",
                    "api_key": secret_value,
                    "s3_key": "object-1",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db, stream_id)
    summary = runner.run(ctx, db=db)
    assert summary.get("delivered_batch_event_count") == 1
    assert sender.calls
    delivered = sender.calls[0]["events"][0]
    assert delivered["api_key"] == "********"
    assert secret_value not in json.dumps(delivered)

    from app.checkpoints.models import Checkpoint

    cp = db.query(Checkpoint).filter_by(stream_id=stream_id).one()
    last = (cp.checkpoint_value_json or {}).get("last_success_event") or {}
    assert last.get("api_key") == secret_value
    assert last.get("s3_key") == "object-1"


def test_masked_route_does_not_pollute_stream_checkpoint(
    db_session: Session,
    protection_runtime_settings: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Route B mask must not overwrite stream checkpoint with a protected copy."""

    from app.config import settings

    monkeypatch.setattr(settings, "GDC_ROUTE_PROCESSING_ENABLED", True)
    db = db_session
    fixture = _seed_stream_runtime(db, failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE"])
    stream_id = fixture["stream_id"]
    route_a, route_b = fixture["route_ids"]
    secret_value = "super-secret-token-value"

    from app.mappings.models import Mapping
    from app.streams.models import Stream

    mapping = db.query(Mapping).filter_by(stream_id=stream_id).one()
    mapping.field_mappings_json = {
        **dict(mapping.field_mappings_json or {}),
        "api_key": "$.api_key",
    }
    stream = db.query(Stream).filter_by(id=stream_id).one()
    config = dict(stream.config_json or {})
    config["governance"] = {
        "route_overrides": [
            {
                "route_id": route_a,
                "field_path": "$.api_key",
                "protection_action": "audit_only",
                "enabled": True,
            },
            {
                "route_id": route_b,
                "field_path": "$.api_key",
                "protection_action": "mask_full",
                "enabled": True,
            },
        ]
    }
    stream.config_json = config
    db.add(
        StreamProtectionRule(
            stream_id=stream_id,
            field_path="$.api_key",
            sensitivity_class="secret",
            protection_mode="full_mask",
            enabled=True,
            created_by="test",
        )
    )
    db.commit()

    poller = _FakePoller(
        response={
            "items": [
                {
                    "id": "evt-iso",
                    "api_key": secret_value,
                    "s3_key": "object-iso",
                    "message": "hello",
                    "vendor": "v",
                }
            ]
        }
    )
    sender = _FakeWebhookSender()
    runner = _build_runner(poller=poller, webhook_sender=sender)
    ctx = load_stream_context(db, stream_id)
    summary = runner.run(ctx, db=db)
    assert summary.get("delivered_batch_event_count") == 1
    assert len(sender.calls) == 2
    delivered_keys = {call["events"][0]["api_key"] for call in sender.calls}
    assert secret_value in delivered_keys
    assert "********" in delivered_keys

    from app.checkpoints.models import Checkpoint

    cp = db.query(Checkpoint).filter_by(stream_id=stream_id).one()
    last = (cp.checkpoint_value_json or {}).get("last_success_event") or {}
    assert last.get("api_key") == secret_value
    assert last.get("s3_key") == "object-iso"
