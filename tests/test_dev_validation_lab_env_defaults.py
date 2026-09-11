"""Tests for non-production dev-validation lab environment defaults."""

from __future__ import annotations

import os

import pytest

from app.config import Settings
from app.dev_validation_lab.env_defaults import apply_dev_validation_lab_env_defaults, lab_slice_defaults_active


def test_lab_slice_defaults_active_matrix() -> None:
    assert lab_slice_defaults_active(enable_lab=False, app_env="development") is False
    assert lab_slice_defaults_active(enable_lab=True, app_env="production") is False
    assert lab_slice_defaults_active(enable_lab=True, app_env="prod") is False
    assert lab_slice_defaults_active(enable_lab=True, app_env="development") is True


def test_apply_defaults_enables_slices_when_lab_on(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "ENABLE_DEV_VALIDATION_LAB",
        "ENABLE_DEV_VALIDATION_S3",
        "ENABLE_DEV_VALIDATION_DATABASE_QUERY",
        "ENABLE_DEV_VALIDATION_REMOTE_FILE",
        "MINIO_ACCESS_KEY",
        "MINIO_SECRET_KEY",
        "DEV_VALIDATION_SFTP_PASSWORD",
    ):
        monkeypatch.delenv(key, raising=False)

    s = Settings(ENABLE_DEV_VALIDATION_LAB=True, APP_ENV="development")
    meta = apply_dev_validation_lab_env_defaults(s)
    assert meta["applied"] is True
    assert s.ENABLE_DEV_VALIDATION_S3 is True
    assert s.ENABLE_DEV_VALIDATION_DATABASE_QUERY is True
    assert s.ENABLE_DEV_VALIDATION_REMOTE_FILE is True
    assert s.MINIO_ACCESS_KEY == "gdcminioaccess"
    assert s.DEV_VALIDATION_SFTP_PASSWORD == "devlab123"


def test_apply_defaults_skipped_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ENABLE_DEV_VALIDATION_S3", raising=False)
    s = Settings(
        ENABLE_DEV_VALIDATION_LAB=True,
        APP_ENV="production",
        REQUIRE_AUTH=True,
        AUTH_DEV_HEADER_TRUST=False,
        JWT_SECRET_KEY="A" * 32,
        SECRET_KEY="B" * 32,
        ENCRYPTION_KEY="C" * 32,
        GDC_PROXY_RELOAD_TOKEN="D" * 32,
        DATABASE_URL="postgresql://gdc:strong-production-db-password-ok@postgres:5432/gdc",
    )
    meta = apply_dev_validation_lab_env_defaults(s)
    assert meta["applied"] is False
    assert s.ENABLE_DEV_VALIDATION_S3 is False


def test_docker_fixture_endpoints_use_service_hostnames(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.dev_validation_lab.env_defaults._in_docker",
        lambda: True,
    )
    s = Settings(ENABLE_DEV_VALIDATION_LAB=True, APP_ENV="development")
    apply_dev_validation_lab_env_defaults(s)
    assert "gdc-platform-wiremock-test" in s.DEV_VALIDATION_WIREMOCK_BASE_URL
    assert "gdc-webhook-receiver-test" in s.DEV_VALIDATION_WEBHOOK_BASE_URL
    assert "gdc-minio-test" in s.MINIO_ENDPOINT


def test_explicit_slice_false_respected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENABLE_DEV_VALIDATION_S3", "false")
    s = Settings(ENABLE_DEV_VALIDATION_LAB=True, APP_ENV="development")
    assert s.ENABLE_DEV_VALIDATION_S3 is False

