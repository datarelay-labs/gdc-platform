"""P2-3 — REMOTE_FILE_POLLING sample fetch reuses RemoteFilePollingAdapter (no synthetic events)."""

from __future__ import annotations

import pytest

from app.runtime.errors import SourceFetchError
from app.runtime.preview_service import PreviewRequestError, run_http_api_test
from app.runtime.schemas import HttpApiTestRequest
from app.sources.adapters.remote_file_polling import RemoteFilePollingAdapter


def _remote_source() -> dict:
    return {
        "source_type": "REMOTE_FILE_POLLING",
        "host": "files.example",
        "username": "gdc",
        "password": "secret",
        "protocol": "sftp",
    }


def test_run_http_api_test_remote_returns_actual_parsed_events(monkeypatch: pytest.MonkeyPatch) -> None:
    actual = [{"line": "a", "path": "/data/a.ndjson", "email": "a@example.com"}]

    def _fetch(self, source_config, stream_config, checkpoint):  # noqa: ANN001
        assert source_config["host"] == "files.example"
        assert stream_config["remote_directory"] == "/data"
        return actual

    monkeypatch.setattr(RemoteFilePollingAdapter, "fetch", _fetch)

    result = run_http_api_test(
        HttpApiTestRequest(
            source_config=_remote_source(),
            stream_config={"remote_directory": "/data", "file_pattern": "*.ndjson", "recursive": True},
            fetch_sample=True,
        )
    )

    assert result.ok is True
    assert result.request.method == "REMOTE_FILE_POLLING"
    assert result.remote_file_event_count == 1
    parsed = result.response.parsed_json if result.response else None
    assert isinstance(parsed, list) and parsed[0]["path"] == "/data/a.ndjson"
    assert parsed[0]["email"] == "a@example.com"
    assert "synthetic" not in str(parsed).lower()


def test_run_http_api_test_remote_empty_returns_no_synthetic_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(RemoteFilePollingAdapter, "fetch", lambda self, *a, **k: [])

    result = run_http_api_test(
        HttpApiTestRequest(
            source_config=_remote_source(),
            stream_config={"remote_directory": "/data", "file_pattern": "*.ndjson"},
            fetch_sample=True,
        )
    )

    assert result.ok is True
    assert result.remote_file_event_count == 0
    assert result.response is not None
    assert result.response.parsed_json == []


def test_run_http_api_test_remote_directory_required() -> None:
    with pytest.raises(PreviewRequestError) as exc:
        run_http_api_test(
            HttpApiTestRequest(
                source_config=_remote_source(),
                stream_config={},
                fetch_sample=True,
            )
        )
    assert exc.value.detail["code"] == "REMOTE_DIRECTORY_REQUIRED"


def test_run_http_api_test_remote_fetch_error_is_sample_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(self, *a, **k):  # noqa: ANN001
        raise SourceFetchError("sftp auth failed")

    monkeypatch.setattr(RemoteFilePollingAdapter, "fetch", _boom)

    with pytest.raises(PreviewRequestError) as exc:
        run_http_api_test(
            HttpApiTestRequest(
                source_config=_remote_source(),
                stream_config={"remote_directory": "/data"},
                fetch_sample=True,
            )
        )
    assert exc.value.detail["error_type"] == "remote_file_fetch_failed"
    assert exc.value.detail["ok"] is False
