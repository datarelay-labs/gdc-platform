"""Secret masking helpers for API responses and masked-update preservation."""

from __future__ import annotations

from typing import Any

# Exported for export/import integrity checks (backup bundles, audit views).
SENSITIVE_FIELD_NAMES: frozenset[str] = frozenset(
    {
        "secret_key",
        "access_key",
        "password",
        "basic_password",
        "token",
        "bearer_token",
        "api_key_value",
        "client_secret",
        "oauth_client_secret",
        "oauth2_client_secret",
        "login_password",
        "refresh_token",
        "access_token",
        "id_token",
        "api_key",
        "apikey",
        "secret",
        "private_key",
        "tls_key_pem",
        "certificate_pem",
        "authorization",
        "db_password",
        "remote_password",
        "remote_private_key",
        "remote_private_key_passphrase",
        "webhook_shared_secret",
        "webhook_bearer_token",
    }
)

_SENSITIVE_HEADER_NAMES = frozenset(
    {
        "authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
    }
)

_HEADER_CONTAINER_KEYS = frozenset(
    {
        "headers",
        "preflight_headers",
        "common_headers",
        "request_headers",
        "response_headers",
        "extra_headers",
    }
)

SECRET_MASK = "********"
_MASK = SECRET_MASK


def _normalize_field_key(key: Any) -> str:
    return str(key).lower().replace("-", "_")


def is_sensitive_field_name(key: Any) -> bool:
    """Return True when ``key`` is a known credential field name."""

    nk = _normalize_field_key(key)
    if nk in SENSITIVE_FIELD_NAMES:
        return True
    compacted = nk.replace("_", "")
    return any(compacted == s.replace("_", "") for s in SENSITIVE_FIELD_NAMES)


def is_secret_mask(value: Any) -> bool:
    """True when ``value`` is the standard masked placeholder."""

    if value is None:
        return False
    return str(value) == _MASK


def mask_http_headers(headers: dict[str, str]) -> dict[str, str]:
    """Mask Authorization, Cookie, API keys, and similar headers for API responses."""

    out: dict[str, str] = {}
    for key, item in headers.items():
        lk = str(key).lower()
        if lk in _SENSITIVE_HEADER_NAMES:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        low_key = lk.replace("_", "-")
        if "secret" in lk:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        if low_key.endswith("-token") or "token" in lk or "password" in lk:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        if "api-key" in low_key or low_key.endswith("apikey") or "api_key" in lk:
            out[str(key)] = _MASK if item not in (None, "") else str(item)
            continue
        out[str(key)] = str(item)
    return out


def _mask_header_mapping(item: dict[str, Any]) -> dict[str, Any]:
    """Mask sensitive values in a header-like string map; preserve empty/null."""

    prepared: dict[str, str] = {}
    empty_keys: dict[str, Any] = {}
    for key, value in item.items():
        if value in (None, ""):
            empty_keys[str(key)] = value
            continue
        prepared[str(key)] = str(value)
    masked = mask_http_headers(prepared)
    out: dict[str, Any] = dict(masked)
    out.update(empty_keys)
    return out


def mask_secrets(value: Any) -> Any:
    """Recursively mask known secret fields in dict/list payloads."""

    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            key_str = str(key).lower()
            if key_str in _HEADER_CONTAINER_KEYS and isinstance(item, dict):
                out[key] = _mask_header_mapping(item)
                continue
            if is_sensitive_field_name(key):
                out[key] = _MASK if item not in (None, "") else item
                continue
            out[key] = mask_secrets(item)
        return out
    if isinstance(value, list):
        return [mask_secrets(item) for item in value]
    return value


def redact_pem_literals(value: Any) -> Any:
    """Replace string values that contain PEM blocks (certs/keys) with the standard mask."""

    if isinstance(value, str):
        if "-----BEGIN" in value and "-----END" in value:
            return _MASK
        return value
    if isinstance(value, dict):
        return {k: redact_pem_literals(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_pem_literals(item) for item in value]
    return value


def mask_secrets_and_pem(value: Any) -> Any:
    """Apply :func:`mask_secrets` then strip PEM material from any remaining strings."""

    return redact_pem_literals(mask_secrets(value))


def preserve_masked_secrets(incoming: Any, existing: Any) -> Any:
    """Keep existing secret values when the client resubmits the masked placeholder.

    Semantics:
    - ``********`` at any path replaces with the existing value when one exists
    - a real new value replaces the existing value
    - omitted keys stay omitted (caller owns full-object replace vs merge)
    - nested dicts/lists are walked recursively by key / index
    """

    if is_secret_mask(incoming):
        if existing not in (None, ""):
            return existing
        return incoming

    if isinstance(incoming, dict):
        prev = existing if isinstance(existing, dict) else {}
        out: dict[str, Any] = {}
        for key, value in incoming.items():
            out[key] = preserve_masked_secrets(value, prev.get(key))
        return out

    if isinstance(incoming, list):
        prev_list = existing if isinstance(existing, list) else []
        out_list: list[Any] = []
        for idx, value in enumerate(incoming):
            prev_item = prev_list[idx] if idx < len(prev_list) else None
            out_list.append(preserve_masked_secrets(value, prev_item))
        return out_list

    return incoming
