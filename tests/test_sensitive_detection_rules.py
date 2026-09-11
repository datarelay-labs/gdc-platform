"""M5 sensitive detection — field-name rules and false-positive policy."""

from __future__ import annotations

import pytest

from app.sensitive_detection.path_rules import evaluate_field_name_rules, leaf_segment
from app.sensitive_detection.pattern_rules import evaluate_pattern_rules


def test_leaf_segment_strips_array_markers() -> None:
    assert leaf_segment("$.items[].password") == "password"


def test_fp1_standalone_id_no_match() -> None:
    assert evaluate_field_name_rules("$.id") == []
    assert evaluate_field_name_rules("$.uuid") == []


def test_fp2_user_id_no_secret() -> None:
    assert evaluate_field_name_rules("$.user_id") == []


def test_fp4_session_token_no_secret() -> None:
    assert evaluate_field_name_rules("$.session_token") == []


def test_fp4_access_token_tier_a() -> None:
    hits = evaluate_field_name_rules("$.access_token")
    assert any(h["sensitivity_class"] == "secret" for h in hits)


def test_fp6_cookie_count_no_match() -> None:
    assert evaluate_field_name_rules("$.cookie_count") == []


def test_fp6_cookie_exact_secret() -> None:
    hits = evaluate_field_name_rules("$.cookie")
    assert any(h["sensitivity_class"] == "secret" for h in hits)


def test_fp7_user_alone_no_pii() -> None:
    assert evaluate_field_name_rules("$.user") == []


def test_pii_compound_user_email() -> None:
    hits = evaluate_field_name_rules("$.user_email")
    assert any(h["sensitivity_class"] == "pii" for h in hits)


def test_security_metadata_auth_exact() -> None:
    hits = evaluate_field_name_rules("$.auth")
    assert any(h["sensitivity_class"] == "security_metadata" for h in hits)


def test_security_metadata_author_no_match() -> None:
    assert evaluate_field_name_rules("$.author") == []


def test_secret_tier_b_apikey_substring() -> None:
    hits = evaluate_field_name_rules("$.vendor_apikey")
    assert any(h["sensitivity_class"] == "secret" for h in hits)


def test_pattern_pem_secret() -> None:
    pem = "-----BEGIN RSA PRIVATE KEY-----\nX\n-----END RSA PRIVATE KEY-----"
    hit = evaluate_pattern_rules("$.tls_key_pem", inferred_type="string", sample_value=pem)
    assert hit is not None
    assert hit["sensitivity_class"] == "secret"
    assert hit["matched_rule"] == "pattern.pem"


def test_pattern_email_requires_pii_leaf() -> None:
    hit = evaluate_pattern_rules(
        "$.user_id",
        inferred_type="string",
        sample_value="user@example.com",
    )
    assert hit is None


def test_pattern_email_on_email_leaf() -> None:
    hit = evaluate_pattern_rules(
        "$.email",
        inferred_type="string",
        sample_value="ops@example.com",
    )
    assert hit is not None
    assert hit["matched_rule"] == "pattern.email"


@pytest.mark.parametrize(
    "path,expected_class",
    [
        ("$.password", "secret"),
        ("$.roles", "security_metadata"),
        ("$.email_verified", "pii"),
        ("$.credit_card", "pii"),
        ("$.card_number", "pii"),
    ],
)
def test_field_name_classes(path: str, expected_class: str) -> None:
    hits = evaluate_field_name_rules(path)
    assert any(h["sensitivity_class"] == expected_class for h in hits)
