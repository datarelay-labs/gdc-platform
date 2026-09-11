"""Union Schema sensitive suggestions — reuse detect_hits_for_batch (no new engine).

Suggestion-only: never persists findings and never creates protection rules.
"""

from __future__ import annotations

from typing import Any

from app.sensitive_detection.detection import detect_hits_for_batch
from app.sensitive_detection.models import (
    SENSITIVITY_CLASS_PII,
    SENSITIVITY_CLASS_SECRET,
    SENSITIVITY_CLASS_SECURITY_METADATA,
)
from app.sensitive_detection.path_rules import leaf_segment

DETECTION_SOURCE = "sensitive_detection_engine"

_CLASS_PRIORITY = {
    SENSITIVITY_CLASS_SECRET: 0,
    SENSITIVITY_CLASS_PII: 1,
    SENSITIVITY_CLASS_SECURITY_METADATA: 2,
}

_LEAF_LABELS = {
    "email": "Likely Email",
    "e_mail": "Likely Email",
    "mail_address": "Likely Email",
    "user_email": "Likely Email",
    "customer_email": "Likely Email",
    "billing_email": "Likely Email",
    "email_verified": "Likely Email",
    "email_domain": "Likely Email",
    "credit_card": "Likely Credit Card",
    "card_number": "Likely Credit Card",
    "api_key": "Likely API Key",
    "apikey": "Likely API Key",
    "access_key": "Likely API Key",
    "secret_key": "Likely API Key",
    "api_key_value": "Likely API Key",
    "password": "Likely Password",
    "passwd": "Likely Password",
    "pwd": "Likely Password",
    "login_password": "Likely Password",
    "basic_password": "Likely Password",
    "token": "Likely Token",
    "access_token": "Likely Token",
    "refresh_token": "Likely Token",
    "id_token": "Likely Token",
    "bearer_token": "Likely Token",
    "auth_token": "Likely Token",
    "oauth_token": "Likely Token",
    "private_key": "Likely Private Key",
    "tls_key_pem": "Likely Private Key",
    "certificate_pem": "Likely Private Key",
    "phone": "Likely Phone",
    "mobile": "Likely Phone",
    "msisdn": "Likely Phone",
}


def suggested_sensitive_type_for_hit(hit: dict[str, Any]) -> str:
    """Map an existing engine hit to a display label. Not a detector."""

    pattern = str(hit.get("pattern") or "")
    if pattern == "email":
        return "Likely Email"
    if pattern == "pem":
        return "Likely Private Key"

    leaf = leaf_segment(str(hit.get("field_path") or ""))
    segment = str(hit.get("matched_segment") or leaf).lower()
    for key in (leaf, segment):
        label = _LEAF_LABELS.get(key)
        if label:
            return label

    compact = leaf.replace("_", "").replace("-", "")
    if "apikey" in compact or "api_key" in leaf:
        return "Likely API Key"
    if "token" in leaf:
        return "Likely Token"
    if "password" in leaf or "passwd" in leaf:
        return "Likely Password"

    sensitivity_class = str(hit.get("sensitivity_class") or "")
    if sensitivity_class == SENSITIVITY_CLASS_PII:
        return "Likely PII"
    if sensitivity_class == SENSITIVITY_CLASS_SECRET:
        return "Likely Secret"
    if sensitivity_class == SENSITIVITY_CLASS_SECURITY_METADATA:
        return "Likely Security Metadata"
    return "Likely Sensitive"


def _hit_priority(hit: dict[str, Any]) -> tuple[int, int]:
    cls = str(hit.get("sensitivity_class") or "")
    method = str(hit.get("detection_method") or "")
    class_rank = _CLASS_PRIORITY.get(cls, 9)
    method_rank = 0 if method == "field_name" else 1
    return (class_rank, method_rank)


def suggest_sensitive_fields_for_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Run the existing Sensitive Detection Engine and return suggestion-only rows."""

    dict_events = [event for event in events if isinstance(event, dict)]
    if not dict_events:
        return []

    hits = detect_hits_for_batch(dict_events)
    by_path: dict[str, dict[str, Any]] = {}
    for hit in hits:
        field_path = str(hit.get("field_path") or "").strip()
        if not field_path:
            continue
        current = by_path.get(field_path)
        if current is None or _hit_priority(hit) < _hit_priority(current):
            by_path[field_path] = hit

    suggestions: list[dict[str, Any]] = []
    for field_path in sorted(by_path):
        hit = by_path[field_path]
        detection_method = str(hit.get("detection_method") or "")
        suggestions.append(
            {
                "field_path": field_path,
                "suggested_sensitive_type": suggested_sensitive_type_for_hit(hit),
                "sensitivity_class": str(hit.get("sensitivity_class") or ""),
                "detection_method": detection_method,
                "matched_rule": hit.get("matched_rule"),
                "detection_source": DETECTION_SOURCE,
                "confidence": detection_method or None,
            }
        )
    return suggestions
