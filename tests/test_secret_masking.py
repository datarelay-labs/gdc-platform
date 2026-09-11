"""Unit tests for secret masking and masked-placeholder preservation."""

from app.security.secrets import (
    SECRET_MASK,
    mask_http_headers,
    mask_secrets,
    mask_secrets_and_pem,
    preserve_masked_secrets,
)


def test_mask_secrets_masks_nested_sensitive_values():
    payload = {
        "basic_password": "pw",
        "auth": {
            "token": "abc",
            "client_secret": "secret",
            "normal": "ok",
        },
        "items": [{"api_key_value": "k"}, {"password": "p"}],
    }
    out = mask_secrets(payload)
    assert out["basic_password"] == "********"
    assert out["auth"]["token"] == "********"
    assert out["auth"]["client_secret"] == "********"
    assert out["auth"]["normal"] == "ok"
    assert out["items"][0]["api_key_value"] == "********"
    assert out["items"][1]["password"] == "********"


def test_mask_secrets_masks_access_key():
    out = mask_secrets({"access_key": "AKIAIOSFODNN7EXAMPLE"})
    assert out["access_key"] == "********"


def test_mask_secrets_masks_authorization_and_headers():
    payload = {
        "api_key": "k-real",
        "password": "pw-real",
        "headers": {
            "Authorization": "Bearer REAL_SECRET_VALUE",
            "X-API-Key": "header-key",
            "Accept": "application/json",
        },
    }
    out = mask_secrets(payload)
    assert out["api_key"] == SECRET_MASK
    assert out["password"] == SECRET_MASK
    assert out["headers"]["Authorization"] == SECRET_MASK
    assert out["headers"]["X-API-Key"] == SECRET_MASK
    assert out["headers"]["Accept"] == "application/json"
    assert "REAL_SECRET_VALUE" not in str(out)
    assert "header-key" not in str(out)


def test_mask_secrets_and_pem_strips_inline_pem():
    pem = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----"
    out = mask_secrets_and_pem({"note": pem, "x": 1})
    assert out["note"] == "********"
    assert out["x"] == 1


def test_mask_http_headers_masks_sensitive_headers():
    masked = mask_http_headers(
        {
            "Authorization": "Bearer secret-token",
            "Cookie": "session=abc",
            "X-API-Key": "super-secret",
            "Accept": "application/json",
        }
    )
    assert masked["Authorization"] == "********"
    assert masked["Cookie"] == "********"
    assert masked["X-API-Key"] == "********"
    assert masked["Accept"] == "application/json"


def test_preserve_masked_secrets_keeps_nested_authorization():
    existing = {
        "url": "https://hook.example",
        "headers": {"Authorization": "Bearer REAL_SECRET", "Accept": "application/json"},
        "api_key": "KEY-1",
    }
    incoming = {
        "url": "https://hook.example",
        "headers": {"Authorization": SECRET_MASK, "Accept": "application/json"},
        "api_key": SECRET_MASK,
    }
    out = preserve_masked_secrets(incoming, existing)
    assert out["headers"]["Authorization"] == "Bearer REAL_SECRET"
    assert out["api_key"] == "KEY-1"
    assert out["headers"]["Accept"] == "application/json"


def test_preserve_masked_secrets_replaces_with_new_values():
    existing = {"password": "OLD", "headers": {"Authorization": "Bearer OLD"}}
    incoming = {"password": "NEW_PASSWORD", "headers": {"Authorization": "Bearer NEW"}}
    out = preserve_masked_secrets(incoming, existing)
    assert out["password"] == "NEW_PASSWORD"
    assert out["headers"]["Authorization"] == "Bearer NEW"
