"""Field-name sensitive detection rules and false-positive policy (M5)."""

from __future__ import annotations

from app.security.secrets import SENSITIVE_FIELD_NAMES
from app.sensitive_detection.models import (
    DETECTION_METHOD_FIELD_NAME,
    SENSITIVITY_CLASS_PII,
    SENSITIVITY_CLASS_SECRET,
    SENSITIVITY_CLASS_SECURITY_METADATA,
)

SECRET_TIER_B_SUBSTRINGS = (
    "passwd",
    "credential",
    "privatekey",
    "apikey",
    "authorization",
    "set_cookie",
    "x-api-key",
)

PII_EXACT_LEAVES = frozenset(
    {
        "email",
        "e_mail",
        "mail_address",
        "phone",
        "mobile",
        "msisdn",
        "ssn",
        "social_security",
        "national_id",
        "date_of_birth",
        "dob",
        "birth_date",
        "full_name",
        "first_name",
        "last_name",
        "given_name",
        "family_name",
        "street_address",
        "home_address",
        "postal_code",
        "zip_code",
        "credit_card",
        "card_number",
    }
)

PII_COMPOUND_LEAVES = frozenset(
    {
        "user_email",
        "customer_email",
        "billing_email",
    }
)

SECURITY_METADATA_EXACT_LEAVES = frozenset({"auth"})

SECURITY_METADATA_TERMS = (
    "auth_method",
    "authentication",
    "permission",
    "permissions",
    "role",
    "roles",
    "mfa",
    "mfa_enabled",
    "tls_version",
    "cipher",
    "ciphersuite",
    "security_level",
    "acl",
    "scopes",
    "oauth_scope",
    "grant_type",
)

SECURITY_METADATA_SESSION_ALLOWED = frozenset({"session_auth", "session_security"})

FP_STANDALONE_ID_LEAVES = frozenset({"id", "ids", "uuid", "guid", "uid"})

FP_ID_SUFFIXES = ("_id", "_ids", "_uuid", "_guid")

FP_METRIC_SUBSTRINGS = (
    "count",
    "total",
    "num",
    "size",
    "length",
    "version",
    "type",
    "status",
    "enabled",
    "flag",
)

FP_TOKEN_ALLOWED_LEAVES = frozenset(
    {
        "access_token",
        "refresh_token",
        "id_token",
        "bearer_token",
        "api_key",
        "auth_token",
        "oauth_token",
        "token",
    }
)

FP_COOKIE_SECRET_LEAVES = frozenset({"cookie", "set_cookie", "cookies"})


def leaf_segment(field_path: str) -> str:
    """Last path component, normalized (strip [], lower case)."""

    if field_path == "$":
        return ""
    if field_path.startswith("$."):
        remainder = field_path[2:]
    elif field_path.startswith("$"):
        remainder = field_path[1:].lstrip(".")
    else:
        remainder = field_path
    if not remainder:
        return ""
    parts = remainder.split(".")
    last = parts[-1] if parts else remainder
    return last.replace("[]", "").lower()


def _fp1_blocks(leaf: str) -> bool:
    return leaf in FP_STANDALONE_ID_LEAVES


def _fp2_blocks_secret_pii(leaf: str) -> bool:
    for suffix in FP_ID_SUFFIXES:
        if leaf.endswith(suffix):
            return True
    return False


def _fp3_blocks_tier_b(leaf: str) -> bool:
    return any(sub in leaf for sub in FP_METRIC_SUBSTRINGS)


def _fp4_allows_token(leaf: str) -> bool:
    if leaf in FP_TOKEN_ALLOWED_LEAVES:
        return True
    if "token" in leaf:
        return False
    return True


def _fp5_blocks_secret(leaf: str) -> bool:
    if "session" not in leaf:
        return False
    return leaf not in SECURITY_METADATA_SESSION_ALLOWED


def _fp6_allows_cookie_secret(leaf: str) -> bool:
    if "cookie" not in leaf:
        return True
    return leaf in FP_COOKIE_SECRET_LEAVES


def _fp7_blocks_user(leaf: str) -> bool:
    if "user" not in leaf:
        return True
    return leaf in PII_COMPOUND_LEAVES


def apply_false_positive_policy(
    leaf: str,
    *,
    sensitivity_class: str,
    tier: str,
) -> bool:
    """Return True if the candidate match should proceed."""

    if not leaf:
        return False
    if _fp1_blocks(leaf):
        return False

    if tier == "tier_b" and _fp3_blocks_tier_b(leaf):
        return False

    if sensitivity_class == SENSITIVITY_CLASS_SECRET:
        if not _fp4_allows_token(leaf):
            return False
        if _fp5_blocks_secret(leaf):
            return False
        if not _fp6_allows_cookie_secret(leaf):
            return False

    if sensitivity_class in (SENSITIVITY_CLASS_SECRET, SENSITIVITY_CLASS_PII):
        if tier != "tier_a" and _fp2_blocks_secret_pii(leaf):
            return False
        if not _fp7_blocks_user(leaf):
            return False

    if sensitivity_class == SENSITIVITY_CLASS_SECURITY_METADATA:
        if tier != "tier_a" and _fp2_blocks_secret_pii(leaf):
            return False
        if "session" in leaf and leaf not in SECURITY_METADATA_SESSION_ALLOWED:
            return False

    return True


def _match_secret_field_name(leaf: str) -> tuple[str, str] | None:
    if leaf in FP_COOKIE_SECRET_LEAVES:
        if apply_false_positive_policy(leaf, sensitivity_class=SENSITIVITY_CLASS_SECRET, tier="tier_a"):
            return (f"secret.leaf.{leaf}", leaf)
    if leaf in SENSITIVE_FIELD_NAMES:
        if apply_false_positive_policy(leaf, sensitivity_class=SENSITIVITY_CLASS_SECRET, tier="tier_a"):
            return ("secret.leaf." + leaf, leaf)
    for sub in SECRET_TIER_B_SUBSTRINGS:
        variants = {sub, sub.replace("-", "_"), sub.replace("_", "-"), sub.replace("-", "")}
        if any(v in leaf or v in leaf.replace("_", "") for v in variants):
            if apply_false_positive_policy(leaf, sensitivity_class=SENSITIVITY_CLASS_SECRET, tier="tier_b"):
                return (f"secret.substring.{sub}", sub)
    return None


def _match_pii_field_name(leaf: str) -> tuple[str, str] | None:
    if leaf in PII_EXACT_LEAVES or leaf in PII_COMPOUND_LEAVES:
        if apply_false_positive_policy(leaf, sensitivity_class=SENSITIVITY_CLASS_PII, tier="tier_a"):
            return (f"pii.leaf.{leaf}", leaf)
    if leaf in ("email_verified", "email_domain"):
        if apply_false_positive_policy(leaf, sensitivity_class=SENSITIVITY_CLASS_PII, tier="tier_a"):
            return (f"pii.leaf.{leaf}", leaf)
    return None


def _match_security_metadata_field_name(leaf: str) -> tuple[str, str] | None:
    if leaf in SECURITY_METADATA_EXACT_LEAVES:
        if apply_false_positive_policy(
            leaf,
            sensitivity_class=SENSITIVITY_CLASS_SECURITY_METADATA,
            tier="tier_a",
        ):
            return ("security_metadata.leaf.auth", "auth")
    for term in SECURITY_METADATA_TERMS:
        if leaf == term or term in leaf:
            if term == "auth" and leaf != "auth":
                continue
            if apply_false_positive_policy(
                leaf,
                sensitivity_class=SENSITIVITY_CLASS_SECURITY_METADATA,
                tier="tier_b",
            ):
                return (f"security_metadata.term.{term}", term)
    if leaf in SECURITY_METADATA_SESSION_ALLOWED:
        return (f"security_metadata.leaf.{leaf}", leaf)
    return None


def evaluate_field_name_rules(field_path: str) -> list[dict[str, str]]:
    """Return detection hits for one path (multiple classes allowed)."""

    leaf = leaf_segment(field_path)
    if not leaf:
        return []

    hits: list[dict[str, str]] = []
    secret = _match_secret_field_name(leaf)
    if secret is not None:
        hits.append(
            {
                "sensitivity_class": SENSITIVITY_CLASS_SECRET,
                "detection_method": DETECTION_METHOD_FIELD_NAME,
                "matched_rule": secret[0],
                "matched_segment": secret[1],
            }
        )
    pii = _match_pii_field_name(leaf)
    if pii is not None:
        hits.append(
            {
                "sensitivity_class": SENSITIVITY_CLASS_PII,
                "detection_method": DETECTION_METHOD_FIELD_NAME,
                "matched_rule": pii[0],
                "matched_segment": pii[1],
            }
        )
    meta = _match_security_metadata_field_name(leaf)
    if meta is not None:
        hits.append(
            {
                "sensitivity_class": SENSITIVITY_CLASS_SECURITY_METADATA,
                "detection_method": DETECTION_METHOD_FIELD_NAME,
                "matched_rule": meta[0],
                "matched_segment": meta[1],
            }
        )
    return hits


def leaf_allows_pattern_pii(leaf: str) -> bool:
    """Pattern email allowed only when field-name PII rules would allow the leaf."""

    return _match_pii_field_name(leaf) is not None
