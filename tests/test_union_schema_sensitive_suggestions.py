"""Union Schema sensitive suggestions reuse the existing Sensitive Detection Engine."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.sensitive_detection.detection import detect_hits_for_batch
from app.sensitive_detection.path_rules import evaluate_field_name_rules
from app.sensitive_detection.suggestions import (
    DETECTION_SOURCE,
    suggest_sensitive_fields_for_events,
    suggested_sensitive_type_for_hit,
)


def test_credit_card_field_name_is_pii() -> None:
    hits = evaluate_field_name_rules("$.credit_card")
    assert any(h["sensitivity_class"] == "pii" for h in hits)
    hits = evaluate_field_name_rules("$.billing.card_number")
    assert any(h["sensitivity_class"] == "pii" for h in hits)


def test_suggestions_reuse_detect_hits_for_batch() -> None:
    events = [
        {
            "email": "ops@example.com",
            "credit_card": "4111111111111111",
            "api_key": "sk-test",
            "status": "ok",
        }
    ]
    engine_hits = detect_hits_for_batch(events)
    suggestions = suggest_sensitive_fields_for_events(events)
    engine_paths = {hit["field_path"] for hit in engine_hits}
    suggestion_paths = {row["field_path"] for row in suggestions}
    assert suggestion_paths <= engine_paths
    assert "$.status" not in suggestion_paths


def test_suggestions_cover_email_credit_card_api_key_and_skip_normal() -> None:
    events = [
        {
            "email": "ops@example.com",
            "credit_card": "4111111111111111",
            "api_key": "sk-test",
            "status": "ok",
        }
    ]
    by_path = {row["field_path"]: row for row in suggest_sensitive_fields_for_events(events)}
    assert by_path["$.email"]["suggested_sensitive_type"] == "Likely Email"
    assert by_path["$.email"]["sensitivity_class"] == "pii"
    assert by_path["$.credit_card"]["suggested_sensitive_type"] == "Likely Credit Card"
    assert by_path["$.api_key"]["suggested_sensitive_type"] == "Likely API Key"
    assert by_path["$.api_key"]["sensitivity_class"] == "secret"
    assert "$.status" not in by_path
    for row in by_path.values():
        assert row["detection_source"] == DETECTION_SOURCE


def test_suggestions_do_not_imply_protection_action() -> None:
    events = [{"email": "ops@example.com"}]
    row = suggest_sensitive_fields_for_events(events)[0]
    assert "protection" not in row
    assert "mask" not in str(row["suggested_sensitive_type"]).lower()
    assert suggested_sensitive_type_for_hit(
        {"field_path": "$.email", "sensitivity_class": "pii", "matched_rule": "pii.leaf.email"}
    ) == "Likely Email"


def test_preview_sensitive_detection_api_is_suggestion_only() -> None:
    client = TestClient(app)
    response = client.post(
        "/api/v1/runtime/preview/sensitive-detection",
        json={
            "events": [
                {
                    "email": "ops@example.com",
                    "credit_card": "4111111111111111",
                    "api_key": "sk-test",
                    "status": "ok",
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["auto_protection_applied"] is False
    by_path = {row["field_path"]: row for row in body["suggestions"]}
    assert by_path["$.email"]["suggested_sensitive_type"] == "Likely Email"
    assert by_path["$.credit_card"]["suggested_sensitive_type"] == "Likely Credit Card"
    assert by_path["$.api_key"]["suggested_sensitive_type"] == "Likely API Key"
    assert "$.status" not in by_path
    assert all(row["detection_source"] == DETECTION_SOURCE for row in body["suggestions"])


def test_preview_sensitive_detection_empty_events() -> None:
    client = TestClient(app)
    response = client.post("/api/v1/runtime/preview/sensitive-detection", json={"events": []})
    assert response.status_code == 200
    body = response.json()
    assert body["suggestions"] == []
    assert body["suggestion_count"] == 0
    assert body["auto_protection_applied"] is False
