"""P0-5 — Union Schema is Schema Drift Stream Baseline Source of Truth."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.main import app
from app.runtime.control_service import start_stream
from app.schema_drift_policy.schemas import DEFAULT_UNKNOWN_NORMAL_POLICY, load_schema_drift_policy
from app.schema_observation.models import (
    DRIFT_CATEGORY_FIELD_ADDED,
    DRIFT_CATEGORY_FIELD_REMOVED,
    DRIFT_CATEGORY_FIELD_TYPE_CHANGED,
    StreamObservedSchema,
    StreamSchemaFieldDrift,
)
from app.schema_observation.service import observe_extracted_events
from app.schema_observation.union_schema_baseline import (
    establish_baseline_from_union_schema,
    paths_from_union_schema,
)
from app.streams.models import Stream
from tests.test_stream_runner_e2e import _seed_stream_runtime


def _union_schema(*fields: tuple[str, str]) -> dict[str, Any]:
    return {
        "total_events": 20,
        "fields": [
            {
                "field_path": path,
                "field_type": typ,
                "occurrence_count": 20,
                "sample_values": [],
            }
            for path, typ in fields
        ],
        "snapshot_at": "2026-08-13T00:00:00Z",
    }


def _set_union_schema(db: Session, stream_id: int, union_schema: dict[str, Any]) -> None:
    stream = db.get(Stream, stream_id)
    assert stream is not None
    cfg = dict(stream.config_json or {})
    cfg["union_schema"] = union_schema
    stream.config_json = cfg
    db.commit()


def _open_findings(db: Session, stream_id: int) -> list[StreamSchemaFieldDrift]:
    return list(
        db.execute(
            select(StreamSchemaFieldDrift).where(
                StreamSchemaFieldDrift.stream_id == stream_id,
                StreamSchemaFieldDrift.status == "open",
            )
        ).scalars()
    )


def _baseline_paths(db: Session, stream_id: int) -> dict[str, Any]:
    row = db.get(StreamObservedSchema, stream_id)
    assert row is not None
    assert row.baseline_paths_json is not None
    paths = row.baseline_paths_json.get("paths") or {}
    assert isinstance(paths, dict)
    return paths


@pytest.fixture
def drift_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_OBSERVATION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_DETECTION_ENABLED", True)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_BASELINE_MIN_RUNS", 2)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_BASELINE_MIN_EVENTS", 1)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_ADDED_CONFIRM_RUNS", 2)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_REMOVED_ABSENT_RUNS", 3)
    monkeypatch.setattr("app.config.settings.GDC_SCHEMA_DRIFT_TYPE_CHANGE_CONFIRM_RUNS", 3)


@pytest.fixture
def streams_client(db_session: Session) -> TestClient:
    def _override_db() -> Any:
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_paths_from_union_schema_maps_field_path_and_type() -> None:
    paths = paths_from_union_schema(
        _union_schema(("$.user", "string"), ("$.email", "string"), ("$.nested.obj", "object"))
    )
    assert paths == {
        "$.user": {"type": "string"},
        "$.email": {"type": "string"},
        "$.nested.obj": {"type": "object"},
    }


def test_scenario_a_deploy_establishes_baseline_from_union_schema(
    db_session: Session,
    streams_client: TestClient,
    drift_settings: None,
) -> None:
    """Sample → Union Schema → Deploy(start) → Stream Baseline matches Union Schema."""

    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    schema = _union_schema(("$.user", "string"), ("$.email", "string"))
    _set_union_schema(db_session, stream_id, schema)

    assert db_session.get(StreamObservedSchema, stream_id) is None

    # API Test / sample persist alone must not confirm baseline.
    assert establish_baseline_from_union_schema(db_session, stream_id, union_schema=None) is False

    r = streams_client.post(f"/api/v1/runtime/streams/{stream_id}/start")
    assert r.status_code == 200

    paths = _baseline_paths(db_session, stream_id)
    assert set(paths.keys()) == {"$.user", "$.email"}
    assert paths["$.user"]["type"] == "string"
    assert paths["$.email"]["type"] == "string"
    row = db_session.get(StreamObservedSchema, stream_id)
    assert row is not None
    assert row.baseline_established_at is not None
    assert int(row.observation_run_count or 0) == 0


def test_scenario_b_new_field_observed_then_confirmed(
    db_session: Session,
    drift_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _set_union_schema(db_session, stream_id, _union_schema(("$.user", "string"), ("$.email", "string")))
    start_stream(db_session, stream_id)

    # First observation of phone → Observed only (not Confirmed Drift).
    observe_extracted_events(db_session, stream_id, [{"user": "a", "email": "a@x", "phone": "1"}])
    db_session.commit()
    assert _open_findings(db_session, stream_id) == []
    row = db_session.get(StreamObservedSchema, stream_id)
    assert row is not None
    phone_meta = (row.paths_json or {}).get("paths", {}).get("$.phone") or {}
    assert int(phone_meta.get("add_confirm_runs") or 0) == 1

    # Second consecutive observation → Confirmed Drift (field_added open finding).
    observe_extracted_events(db_session, stream_id, [{"user": "b", "email": "b@x", "phone": "2"}])
    db_session.commit()
    findings = _open_findings(db_session, stream_id)
    added = [f for f in findings if f.category == DRIFT_CATEGORY_FIELD_ADDED]
    assert any(f.field_path == "$.phone" for f in added)


def test_scenario_c_type_change_observed_then_confirmed(
    db_session: Session,
    drift_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _set_union_schema(db_session, stream_id, _union_schema(("$.email", "string")))
    start_stream(db_session, stream_id)

    for i in range(2):
        observe_extracted_events(db_session, stream_id, [{"email": {"addr": f"u{i}@x"}}])
        db_session.commit()
        assert not any(
            f.category == DRIFT_CATEGORY_FIELD_TYPE_CHANGED for f in _open_findings(db_session, stream_id)
        )

    observe_extracted_events(db_session, stream_id, [{"email": {"addr": "final@x"}}])
    db_session.commit()
    findings = _open_findings(db_session, stream_id)
    assert any(
        f.category == DRIFT_CATEGORY_FIELD_TYPE_CHANGED and f.field_path == "$.email" for f in findings
    )


def test_scenario_d_field_removed_lifecycle(
    db_session: Session,
    drift_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _set_union_schema(
        db_session,
        stream_id,
        _union_schema(("$.keep", "integer"), ("$.drop_me", "string")),
    )
    start_stream(db_session, stream_id)

    observe_extracted_events(db_session, stream_id, [{"keep": 1, "drop_me": "gone"}])
    db_session.commit()

    for _ in range(2):
        observe_extracted_events(db_session, stream_id, [{"keep": 2}])
        db_session.commit()
        assert not any(
            f.category == DRIFT_CATEGORY_FIELD_REMOVED for f in _open_findings(db_session, stream_id)
        )

    observe_extracted_events(db_session, stream_id, [{"keep": 3}])
    db_session.commit()
    findings = _open_findings(db_session, stream_id)
    assert any(f.category == DRIFT_CATEGORY_FIELD_REMOVED and f.field_path == "$.drop_me" for f in findings)


def test_scenario_e_routes_share_one_stream_baseline(
    db_session: Session,
    drift_settings: None,
) -> None:
    """1 Stream / multiple routes → one StreamObservedSchema baseline (no route_id)."""

    fixture = _seed_stream_runtime(
        db_session,
        failure_policies=["LOG_AND_CONTINUE", "LOG_AND_CONTINUE", "LOG_AND_CONTINUE"],
    )
    stream_id = int(fixture["stream_id"])
    assert len(fixture["route_ids"]) == 3

    _set_union_schema(db_session, stream_id, _union_schema(("$.user", "string"), ("$.email", "string")))
    start_stream(db_session, stream_id)

    rows = list(
        db_session.execute(
            select(StreamObservedSchema).where(StreamObservedSchema.stream_id == stream_id)
        ).scalars()
    )
    assert len(rows) == 1
    assert not hasattr(rows[0], "route_id") or getattr(rows[0], "route_id", None) is None
    paths = _baseline_paths(db_session, stream_id)
    assert set(paths.keys()) == {"$.user", "$.email"}


def test_scenario_f_unknown_normal_default_pass_through(db_session: Session) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    stream = db_session.get(Stream, stream_id)
    assert stream is not None
    policy = load_schema_drift_policy(stream.config_json if isinstance(stream.config_json, dict) else {})
    assert policy.unknown_normal_field_policy == DEFAULT_UNKNOWN_NORMAL_POLICY
    assert DEFAULT_UNKNOWN_NORMAL_POLICY == "pass_through"


def test_observation_fallback_uses_union_schema_not_runtime_volume(
    db_session: Session,
    drift_settings: None,
) -> None:
    """If activation missed seeding, first observation still prefers Union Schema baseline."""

    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    _set_union_schema(db_session, stream_id, _union_schema(("$.user", "string"), ("$.email", "string")))

    # Runtime event has extra phone — must NOT become baseline.
    observe_extracted_events(
        db_session,
        stream_id,
        [{"user": "a", "email": "a@x", "phone": "1"}],
    )
    db_session.commit()

    paths = _baseline_paths(db_session, stream_id)
    assert set(paths.keys()) == {"$.user", "$.email"}
    assert "$.phone" not in paths
    assert _open_findings(db_session, stream_id) == []


def test_start_without_union_schema_leaves_baseline_unset(
    db_session: Session,
    streams_client: TestClient,
    drift_settings: None,
) -> None:
    fixture = _seed_stream_runtime(db_session)
    stream_id = int(fixture["stream_id"])
    r = streams_client.post(f"/api/v1/runtime/streams/{stream_id}/start")
    assert r.status_code == 200
    assert db_session.get(StreamObservedSchema, stream_id) is None
