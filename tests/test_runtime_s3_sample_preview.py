"""P2-1 — S3 sample fetch reuses S3ObjectPollingAdapter (no synthetic preview objects)."""

from __future__ import annotations

import pytest

from app.runtime.errors import SourceFetchError
from app.runtime.preview_service import PreviewRequestError, run_http_api_test
from app.runtime.schemas import HttpApiTestRequest
from app.sources.adapters.s3_object_polling import S3ObjectPollingAdapter


def _s3_source() -> dict:
    return {
        "source_type": "S3_OBJECT_POLLING",
        "endpoint_url": "http://127.0.0.1:9000",
        "bucket": "lab",
        "prefix": "events/",
        "access_key": "k",
        "secret_key": "s",
        "region": "us-east-1",
        "path_style_access": True,
        "use_ssl": False,
    }


def test_run_http_api_test_s3_returns_actual_parsed_events(monkeypatch: pytest.MonkeyPatch) -> None:
    actual = [
        {
            "user": "alice",
            "email": "alice@example.com",
            "source_ip": "10.1.1.1",
            "s3_bucket": "lab",
            "s3_key": "events/alice.ndjson",
        }
    ]

    def _fetch(self, source_config, stream_config, checkpoint):  # noqa: ANN001
        assert source_config["bucket"] == "lab"
        assert int(stream_config["max_objects_per_run"]) <= 10
        return actual

    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", _fetch)

    result = run_http_api_test(
        HttpApiTestRequest(
            source_config=_s3_source(),
            stream_config={"max_objects_per_run": 20},
            fetch_sample=True,
        )
    )

    assert result.ok is True
    assert result.request.method == "S3_OBJECT_POLLING"
    assert result.s3_event_count == 1
    assert result.s3_sample_keys == ["events/alice.ndjson"]
    parsed = result.response.parsed_json if result.response else None
    assert isinstance(parsed, list) and parsed[0]["user"] == "alice"
    assert parsed[0]["email"] == "alice@example.com"
    assert parsed[0]["source_ip"] == "10.1.1.1"
    blob = str(parsed)
    assert "s3-wizard-preview" not in blob
    assert "Use a field path from your NDJSON" not in blob


def test_run_http_api_test_s3_empty_returns_no_synthetic_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", lambda self, *a, **k: [])

    result = run_http_api_test(
        HttpApiTestRequest(
            source_config=_s3_source(),
            stream_config={"max_objects_per_run": 5},
            fetch_sample=True,
        )
    )

    assert result.ok is True
    assert result.s3_event_count == 0
    assert result.response is not None
    assert result.response.parsed_json == []
    assert result.s3_sample_keys == []


def test_run_http_api_test_s3_fetch_error_is_sample_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(self, *a, **k):  # noqa: ANN001
        raise SourceFetchError("S3 ListObjectsV2 failed")

    monkeypatch.setattr(S3ObjectPollingAdapter, "fetch", _boom)

    with pytest.raises(PreviewRequestError) as exc:
        run_http_api_test(
            HttpApiTestRequest(
                source_config=_s3_source(),
                stream_config={"max_objects_per_run": 5},
                fetch_sample=True,
            )
        )
    assert exc.value.detail["error_type"] == "s3_sample_fetch_failed"
    assert exc.value.detail["ok"] is False
