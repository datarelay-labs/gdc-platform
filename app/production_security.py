"""Fail-closed production secret and auth configuration checks.

Production must not start with missing, placeholder, or known development
default secrets. Development, lab, and pytest keep existing defaults.
"""

from __future__ import annotations

from typing import Any

# Values taken from committed templates, compose fallbacks, and runtime defaults.
KNOWN_INSECURE_SECRETS: frozenset[str] = frozenset(
    {
        "change-me-in-production",
        "change-me-in-production-use-long-random-string",
        "replace-with-fernet-or-aes-key-placeholder",
        "change-me-long-random-token",
        "change-me-strong-db-password",
        "devtoken",
        "insecure-dev-secret",
        "gdc",
    }
)

# install.sh uses secrets.token_urlsafe(24|32|48); token_urlsafe(24) is 32 characters.
MIN_PRODUCTION_SECRET_LENGTH = 32

_JWT_SECRET_FIELDS = ("JWT_SECRET_KEY", "SECRET_KEY", "ENCRYPTION_KEY", "GDC_PROXY_RELOAD_TOKEN")


class ProductionSecurityConfigError(ValueError):
    """Raised when production configuration is missing or uses a known-insecure secret."""


def is_production_app_env(app_env: str | None) -> bool:
    return str(app_env or "").strip().lower() in {"production", "prod"}


def secret_is_insecure(value: str | None, *, min_length: int = MIN_PRODUCTION_SECRET_LENGTH) -> str | None:
    """Return a reason if ``value`` is empty, a known placeholder, or too short."""

    raw = "" if value is None else str(value)
    stripped = raw.strip()
    if not stripped:
        return "empty"
    if stripped.casefold() in KNOWN_INSECURE_SECRETS:
        return "known placeholder or development default"
    if len(stripped) < min_length:
        return f"shorter than {min_length} characters"
    return None


def _database_password(database_url: str | None) -> str | None:
    raw = str(database_url or "").strip()
    if not raw:
        return None
    try:
        from sqlalchemy.engine import make_url

        return make_url(raw).password
    except Exception:
        return None


def validate_production_security_settings(settings_obj: Any) -> None:
    """Raise ``ProductionSecurityConfigError`` when production secrets/auth are unsafe.

    No-op when ``APP_ENV`` is not production/prod.
    """

    app_env = getattr(settings_obj, "APP_ENV", None)
    if not is_production_app_env(app_env):
        return

    errors: list[str] = []

    for field in _JWT_SECRET_FIELDS:
        reason = secret_is_insecure(getattr(settings_obj, field, None))
        if reason:
            errors.append(f"{field} is {reason}")

    db_password = _database_password(getattr(settings_obj, "DATABASE_URL", None))
    db_reason = secret_is_insecure(db_password)
    if db_reason:
        errors.append(f"DATABASE_URL password is {db_reason}")

    if not bool(getattr(settings_obj, "REQUIRE_AUTH", False)):
        errors.append("REQUIRE_AUTH must be true in production")

    if bool(getattr(settings_obj, "AUTH_DEV_HEADER_TRUST", False)):
        errors.append("AUTH_DEV_HEADER_TRUST must be false in production")

    if errors:
        joined = "; ".join(errors)
        raise ProductionSecurityConfigError(
            "Production configuration rejected: "
            f"{joined}. Set unique secrets (install.sh generates them) and keep auth enabled."
        )


def ensure_production_security_settings(settings_obj: Any) -> None:
    """Same as ``validate_production_security_settings`` (explicit startup entry)."""

    validate_production_security_settings(settings_obj)
