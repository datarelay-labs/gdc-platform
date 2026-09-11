"""Production secret fail-closed: runtime, installer contract, and compose interpolation."""

from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.production_security import (
    MIN_PRODUCTION_SECRET_LENGTH,
    ProductionSecurityConfigError,
    secret_is_insecure,
    validate_production_security_settings,
)

ROOT = Path(__file__).resolve().parents[1]
PRODUCTION_COMPOSE_FILES = (
    "deploy/docker-compose.https.yml",
    "deploy/docker-compose.offline.yml",
    "scripts/offline/templates/offline_install/docker-compose.offline.yml",
)

_STRONG = "A" * MIN_PRODUCTION_SECRET_LENGTH


def _production_ok(**overrides: object) -> SimpleNamespace:
    payload = {
        "APP_ENV": "production",
        "REQUIRE_AUTH": True,
        "AUTH_DEV_HEADER_TRUST": False,
        "JWT_SECRET_KEY": _STRONG,
        "SECRET_KEY": _STRONG.replace("A", "B"),
        "ENCRYPTION_KEY": _STRONG.replace("A", "C"),
        "GDC_PROXY_RELOAD_TOKEN": _STRONG.replace("A", "D"),
        "DATABASE_URL": "postgresql://gdc:strong-production-db-password-ok@postgres:5432/gdc",
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


def test_development_defaults_remain_compatible() -> None:
    s = Settings(APP_ENV="development")
    validate_production_security_settings(s)


def test_production_rejects_empty_jwt_secret() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="JWT_SECRET_KEY"):
        validate_production_security_settings(_production_ok(JWT_SECRET_KEY=""))


def test_production_rejects_whitespace_jwt_secret() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="JWT_SECRET_KEY"):
        validate_production_security_settings(_production_ok(JWT_SECRET_KEY="   "))


def test_production_rejects_known_jwt_placeholder() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="JWT_SECRET_KEY"):
        validate_production_security_settings(
            _production_ok(JWT_SECRET_KEY="change-me-in-production")
        )


def test_production_rejects_proxy_devtoken() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="GDC_PROXY_RELOAD_TOKEN"):
        validate_production_security_settings(_production_ok(GDC_PROXY_RELOAD_TOKEN="devtoken"))


def test_production_rejects_placeholder_encryption_key() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="ENCRYPTION_KEY"):
        validate_production_security_settings(
            _production_ok(ENCRYPTION_KEY="replace-with-fernet-or-aes-key-placeholder")
        )


def test_production_rejects_default_postgres_password_in_database_url() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="DATABASE_URL password"):
        validate_production_security_settings(
            _production_ok(DATABASE_URL="postgresql://gdc:gdc@postgres:5432/gdc")
        )


def test_production_rejects_short_secret() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="JWT_SECRET_KEY"):
        validate_production_security_settings(_production_ok(JWT_SECRET_KEY="too-short"))


def test_production_rejects_auth_disabled() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="REQUIRE_AUTH"):
        validate_production_security_settings(_production_ok(REQUIRE_AUTH=False))


def test_production_rejects_dev_header_trust() -> None:
    with pytest.raises(ProductionSecurityConfigError, match="AUTH_DEV_HEADER_TRUST"):
        validate_production_security_settings(_production_ok(AUTH_DEV_HEADER_TRUST=True))


def test_production_accepts_generated_strong_secrets() -> None:
    jwt = secrets.token_urlsafe(48)
    secret = secrets.token_urlsafe(48)
    enc = secrets.token_urlsafe(32)
    proxy = secrets.token_urlsafe(32)
    pg = secrets.token_urlsafe(24)
    validate_production_security_settings(
        _production_ok(
            JWT_SECRET_KEY=jwt,
            SECRET_KEY=secret,
            ENCRYPTION_KEY=enc,
            GDC_PROXY_RELOAD_TOKEN=proxy,
            DATABASE_URL=f"postgresql://gdc:{pg}@postgres:5432/gdc",
        )
    )
    for value in (jwt, secret, enc, proxy, pg):
        assert secret_is_insecure(value) is None


def test_settings_constructor_fail_closed_in_production() -> None:
    with pytest.raises((ProductionSecurityConfigError, ValidationError)):
        Settings(
            APP_ENV="production",
            JWT_SECRET_KEY="change-me-in-production",
            SECRET_KEY=_STRONG,
            ENCRYPTION_KEY=_STRONG,
            GDC_PROXY_RELOAD_TOKEN=_STRONG,
            REQUIRE_AUTH=True,
            DATABASE_URL="postgresql://gdc:strong-production-db-password-ok@postgres:5432/gdc",
        )


def test_settings_constructor_accepts_production_with_strong_secrets() -> None:
    s = Settings(
        APP_ENV="production",
        REQUIRE_AUTH=True,
        AUTH_DEV_HEADER_TRUST=False,
        JWT_SECRET_KEY=_STRONG,
        SECRET_KEY=_STRONG.replace("A", "B"),
        ENCRYPTION_KEY=_STRONG.replace("A", "C"),
        GDC_PROXY_RELOAD_TOKEN=_STRONG.replace("A", "D"),
        DATABASE_URL="postgresql://gdc:strong-production-db-password-ok@postgres:5432/gdc",
    )
    assert s.APP_ENV == "production"


def test_prod_alias_is_treated_as_production() -> None:
    with pytest.raises(ProductionSecurityConfigError):
        validate_production_security_settings(_production_ok(APP_ENV="prod", JWT_SECRET_KEY=""))


def test_install_sh_replaces_known_placeholders_only() -> None:
    text = (ROOT / "scripts/release/install.sh").read_text(encoding="utf-8")
    assert "change-me-in-production" in text
    assert "devtoken" in text
    assert '"gdc"' in text
    assert "if not val or val in PLACEHOLDER_GENERIC:" in text
    assert "if not pg_pw or pg_pw in PLACEHOLDER_POSTGRES:" in text
    assert "token(48)" in text
    assert "token(32)" in text
    assert "token(24)" in text


def test_install_generated_secret_lengths_pass_production_validation() -> None:
    """Mirrors scripts/release/install.sh token() = secrets.token_urlsafe(max(24, n))."""

    jwt = secrets.token_urlsafe(max(24, 48))
    secret = secrets.token_urlsafe(max(24, 48))
    enc = secrets.token_urlsafe(max(24, 32))
    proxy = secrets.token_urlsafe(max(24, 32))
    pg = secrets.token_urlsafe(max(24, 24))
    validate_production_security_settings(
        _production_ok(
            JWT_SECRET_KEY=jwt,
            SECRET_KEY=secret,
            ENCRYPTION_KEY=enc,
            GDC_PROXY_RELOAD_TOKEN=proxy,
            DATABASE_URL=f"postgresql://gdc:{pg}@postgres:5432/gdc",
        )
    )


def test_existing_secure_env_values_are_not_placeholders() -> None:
    secure = secrets.token_urlsafe(48)
    assert secret_is_insecure(secure) is None
    text = (ROOT / "scripts/release/install.sh").read_text(encoding="utf-8")
    assert "if not val or val in PLACEHOLDER_GENERIC:" in text


def test_production_compose_has_no_insecure_secret_fallbacks() -> None:
    insecure_fallback = re.compile(
        r"\$\{(JWT_SECRET_KEY|SECRET_KEY|ENCRYPTION_KEY|GDC_PROXY_RELOAD_TOKEN|POSTGRES_PASSWORD):-[^}]+\}"
    )
    for rel in PRODUCTION_COMPOSE_FILES:
        text = (ROOT / rel).read_text(encoding="utf-8")
        assert insecure_fallback.search(text) is None, rel
        assert "APP_ENV: production" in text
        assert "${JWT_SECRET_KEY:?JWT_SECRET_KEY is required}" in text
        assert "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" in text
        assert "${GDC_PROXY_RELOAD_TOKEN:?GDC_PROXY_RELOAD_TOKEN is required}" in text
        assert "REQUIRE_AUTH: \"true\"" in text or "REQUIRE_AUTH: 'true'" in text


def test_lab_platform_compose_keeps_development_fallbacks() -> None:
    text = (ROOT / "docker-compose.platform.yml").read_text(encoding="utf-8")
    assert "APP_ENV: ${APP_ENV:-development}" in text
    assert "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-gdc}" in text
    assert "JWT_SECRET_KEY: ${JWT_SECRET_KEY:-change-me-in-production}" in text
    assert "GDC_PROXY_RELOAD_TOKEN: ${GDC_PROXY_RELOAD_TOKEN:-devtoken}" in text


def _docker_compose_available() -> bool:
    return shutil.which("docker") is not None and subprocess.run(
        ["docker", "compose", "version"],
        check=False,
        capture_output=True,
    ).returncode == 0


@pytest.mark.skipif(not _docker_compose_available(), reason="docker compose not available")
def test_production_compose_config_fails_without_jwt_secret() -> None:
    env = os.environ.copy()
    strong = secrets.token_urlsafe(48)
    env.update(
        {
            "POSTGRES_PASSWORD": secrets.token_urlsafe(24),
            "JWT_SECRET_KEY": "",
            "SECRET_KEY": strong,
            "ENCRYPTION_KEY": secrets.token_urlsafe(32),
            "GDC_PROXY_RELOAD_TOKEN": secrets.token_urlsafe(32),
        }
    )
    completed = subprocess.run(
        ["docker", "compose", "-f", str(ROOT / "deploy/docker-compose.https.yml"), "config", "-q"],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode != 0
    combined = f"{completed.stdout}\n{completed.stderr}"
    assert "JWT_SECRET_KEY" in combined


@pytest.mark.skipif(not _docker_compose_available(), reason="docker compose not available")
def test_production_compose_config_passes_with_required_secrets() -> None:
    env = os.environ.copy()
    env.update(
        {
            "POSTGRES_PASSWORD": secrets.token_urlsafe(24),
            "JWT_SECRET_KEY": secrets.token_urlsafe(48),
            "SECRET_KEY": secrets.token_urlsafe(48),
            "ENCRYPTION_KEY": secrets.token_urlsafe(32),
            "GDC_PROXY_RELOAD_TOKEN": secrets.token_urlsafe(32),
            "GDC_ENTRY_HTTP_PORT": "18080",
            "GDC_ENTRY_HTTPS_PORT": "18443",
        }
    )
    completed = subprocess.run(
        ["docker", "compose", "-f", str(ROOT / "deploy/docker-compose.https.yml"), "config", "-q"],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
