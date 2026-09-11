"""P2-3 — DATABASE_QUERY sample fetch reuses preview_limited_rows (no synthetic rows)."""

from __future__ import annotations

import pytest

from app.runtime.errors import SourceFetchError
from app.runtime.preview_service import PreviewRequestError, run_http_api_test
from app.runtime.schemas import HttpApiTestRequest


def _db_source() -> dict:
    return {
        "source_type": "DATABASE_QUERY",
        "db_type": "POSTGRESQL",
        "host": "db.internal",
        "database": "app",
        "username": "gdc",
        "password": "secret",
    }


def test_run_http_api_test_database_returns_actual_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    actual = [{"id": 1, "email": "a@example.com", "created_at": "2026-01-01T00:00:00Z"}]

    def _preview(*, source_config, stream_config, limit):  # noqa: ANN001
        assert source_config["database"] == "app"
        assert stream_config["query"] == "SELECT id, email, created_at FROM users"
        assert limit == 25
        return actual

    monkeypatch.setattr("app.runtime.preview_service.preview_limited_rows", _preview)

    result = run_http_api_test(
        HttpApiTestRequest(
            source_config=_db_source(),
            stream_config={"query": "SELECT id, email, created_at FROM users", "query_timeout_seconds": 15},
            fetch_sample=True,
        )
    )

    assert result.ok is True
    assert result.request.method == "DATABASE_QUERY"
    assert result.database_query_row_count == 1
    assert result.database_query_sample_rows == actual
    parsed = result.response.parsed_json if result.response else None
    assert parsed == actual
    assert "synthetic" not in str(parsed).lower()


def test_run_http_api_test_database_empty_returns_no_synthetic_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.runtime.preview_service.preview_limited_rows",
        lambda **kwargs: [],
    )

    result = run_http_api_test(
        HttpApiTestRequest(
            source_config=_db_source(),
            stream_config={"query": "SELECT id FROM empty_table"},
            fetch_sample=True,
        )
    )

    assert result.ok is True
    assert result.database_query_row_count == 0
    assert result.database_query_sample_rows == []
    assert result.response is not None
    assert result.response.parsed_json == []


def test_run_http_api_test_database_query_required() -> None:
    with pytest.raises(PreviewRequestError) as exc:
        run_http_api_test(
            HttpApiTestRequest(
                source_config=_db_source(),
                stream_config={},
                fetch_sample=True,
            )
        )
    assert exc.value.detail["code"] == "QUERY_REQUIRED"


def test_run_http_api_test_database_fetch_error_is_sample_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(**kwargs):  # noqa: ANN001
        raise SourceFetchError("connection refused")

    monkeypatch.setattr("app.runtime.preview_service.preview_limited_rows", _boom)

    with pytest.raises(PreviewRequestError) as exc:
        run_http_api_test(
            HttpApiTestRequest(
                source_config=_db_source(),
                stream_config={"query": "SELECT 1"},
                fetch_sample=True,
            )
        )
    assert exc.value.detail["error_type"] == "database_query_failed"
    assert exc.value.detail["ok"] is False
