"""Contract v1 enums for stream governance."""

from __future__ import annotations

ALLOWED_PROTECTION_ACTIONS = frozenset(
    {
        "audit",
        "mask_partial",
        "mask_full",
        "tokenize",
        "hash",
        "drop_field",
    }
)

ALLOWED_DELIVERY_BEHAVIORS = frozenset(
    {
        "continue",
        "quarantine",
        "block",
        "require_review",
    }
)

ALLOWED_CLASSIFICATION_LEVELS = frozenset(
    {
        "PUBLIC",
        "INTERNAL",
        "CONFIDENTIAL",
        "RESTRICTED",
    }
)
