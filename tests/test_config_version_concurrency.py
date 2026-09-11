"""Concurrent config-version allocation must not UniqueViolation or HTTP 500.

Production ``record_config_version`` used SELECT max(version)+1 without a
transaction lock. Parallel POST /streams or /destinations then collide on
``platform_config_versions.version``.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.connectors.models import Connector
from app.database import get_db
from app.destinations.models import Destination
from app.main import app
from app.platform_admin import journal
from app.platform_admin.models import PlatformConfigVersion
from app.sources.models import Source
from app.streams.models import Stream

WORKERS = 8
ROUNDS = 5


def _session_factory(db_engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=db_engine, autocommit=False, autoflush=False, expire_on_commit=False)


def _naive_allocate_version(db: Session, *, entity_id: int, name: str) -> int:
    """Pre-fix max+1 allocation — documents the race, not used in production."""

    cur = db.scalar(select(func.coalesce(func.max(PlatformConfigVersion.version), 0)))
    nxt = int(cur or 0) + 1
    time.sleep(0.03)
    db.add(
        PlatformConfigVersion(
            version=nxt,
            entity_type="STREAM_CONFIG",
            entity_id=entity_id,
            entity_name=name,
            changed_by="concurrency-test",
            summary="naive allocate",
        )
    )
    db.flush()
    return nxt


def _run_concurrent_allocators(
    db_engine: Engine,
    *,
    workers: int,
    allocate,
) -> list[Any]:
    factory = _session_factory(db_engine)
    barrier = threading.Barrier(workers)
    results: list[Any] = []

    def _one(idx: int) -> Any:
        db = factory()
        try:
            barrier.wait(timeout=10)
            version = allocate(db, idx)
            db.commit()
            return ("ok", version)
        except Exception as exc:
            db.rollback()
            return ("err", exc)
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(_one, i) for i in range(workers)]
        for fut in as_completed(futs):
            results.append(fut.result())
    return results


def test_naive_max_plus_one_hits_unique_violation(reset_db: None, db_engine: Engine) -> None:
    """Harness-independent proof that unlocked max+1 collides under concurrency."""

    def allocate(db: Session, idx: int) -> int:
        return _naive_allocate_version(db, entity_id=idx + 1, name=f"naive-{idx}")

    errors = []
    for _ in range(ROUNDS):
        for kind, payload in _run_concurrent_allocators(db_engine, workers=WORKERS, allocate=allocate):
            if kind == "err":
                errors.append(payload)
        if errors:
            break

    assert errors, "expected UniqueViolation from unlocked max(version)+1"
    assert any(isinstance(exc, IntegrityError) for exc in errors)
    messages = " ".join(str(exc) for exc in errors)
    assert "platform_config_versions" in messages or "UniqueViolation" in messages or "duplicate key" in messages.lower()


def test_record_config_version_concurrent_commits(reset_db: None, db_engine: Engine) -> None:
    def allocate(db: Session, idx: int) -> int:
        return journal.record_config_version(
            db,
            entity_type="STREAM_CONFIG",
            entity_id=idx + 1,
            entity_name=f"stream-{idx}",
            changed_by="concurrency-test",
            summary="concurrent allocate",
        )

    versions: list[int] = []
    for _ in range(ROUNDS):
        for kind, payload in _run_concurrent_allocators(db_engine, workers=WORKERS, allocate=allocate):
            assert kind == "ok", payload
            versions.append(int(payload))

    assert len(versions) == WORKERS * ROUNDS
    assert len(set(versions)) == len(versions)
    db = _session_factory(db_engine)()
    try:
        rows = db.query(PlatformConfigVersion).all()
        persisted = sorted(int(r.version) for r in rows)
        assert persisted == sorted(versions)
        assert len(persisted) == len(set(persisted))
    finally:
        db.close()


def _seed_connector_source(db_engine: Engine) -> tuple[int, int]:
    db = _session_factory(db_engine)()
    try:
        connector = Connector(name="cfg-ver-concurrency-connector", description=None, status="RUNNING")
        db.add(connector)
        db.flush()
        source = Source(
            connector_id=connector.id,
            source_type="HTTP_API_POLLING",
            config_json={},
            auth_json={},
            enabled=True,
        )
        db.add(source)
        db.commit()
        db.refresh(connector)
        db.refresh(source)
        return int(connector.id), int(source.id)
    finally:
        db.close()


def _live_client() -> TestClient:
    app.dependency_overrides.pop(get_db, None)
    # Production uvicorn turns unhandled UniqueViolation into HTTP 500.
    return TestClient(app, raise_server_exceptions=False)


def _post_many(path: str, payloads: list[dict[str, Any]]) -> list[tuple[int, str, dict[str, Any] | None]]:
    client = _live_client()
    barrier = threading.Barrier(len(payloads))

    def _one(body: dict[str, Any]) -> tuple[int, str, dict[str, Any] | None]:
        barrier.wait(timeout=10)
        res = client.post(path, json=body)
        parsed: dict[str, Any] | None = None
        try:
            parsed = res.json()
        except Exception:
            parsed = None
        return res.status_code, res.text, parsed

    out: list[tuple[int, str, dict[str, Any] | None]] = []
    with ThreadPoolExecutor(max_workers=len(payloads)) as pool:
        futs = [pool.submit(_one, body) for body in payloads]
        for fut in as_completed(futs):
            out.append(fut.result())
    return out


def test_concurrent_post_streams_no_http_500(reset_db: None, db_engine: Engine) -> None:
    connector_id, source_id = _seed_connector_source(db_engine)
    statuses: list[int] = []
    for round_i in range(ROUNDS):
        payloads = [
            {
                "name": f"cfg-ver-stream-r{round_i}-w{i}",
                "connector_id": connector_id,
                "source_id": source_id,
                "polling_interval": 30,
                "enabled": True,
                "status": "STOPPED",
                "stream_type": "HTTP_API_POLLING",
                "config_json": {"endpoint": "/events"},
                "rate_limit_json": {},
            }
            for i in range(WORKERS)
        ]
        for status, text, _body in _post_many("/api/v1/streams/", payloads):
            assert status != 500, text
            assert "UniqueViolation" not in text
            assert "duplicate key" not in text.lower()
            assert status == 201, text
            statuses.append(status)

    db = _session_factory(db_engine)()
    try:
        stream_count = db.query(Stream).count()
        version_count = db.query(PlatformConfigVersion).count()
        versions = [int(v) for (v,) in db.query(PlatformConfigVersion.version).all()]
        assert stream_count == WORKERS * ROUNDS
        assert version_count == WORKERS * ROUNDS
        assert len(versions) == len(set(versions))
        assert 500 not in statuses
    finally:
        db.close()


def test_concurrent_post_destinations_no_http_500(reset_db: None, db_engine: Engine) -> None:
    statuses: list[int] = []
    for round_i in range(ROUNDS):
        payloads = [
            {
                "name": f"cfg-ver-dest-r{round_i}-w{i}",
                "destination_type": "WEBHOOK_POST",
                "config_json": {"url": f"https://receiver.example/hook/{round_i}-{i}"},
                "rate_limit_json": {},
                "enabled": True,
            }
            for i in range(WORKERS)
        ]
        for status, text, _body in _post_many("/api/v1/destinations/", payloads):
            assert status != 500, text
            assert "UniqueViolation" not in text
            assert "duplicate key" not in text.lower()
            assert status == 201, text
            statuses.append(status)

    db = _session_factory(db_engine)()
    try:
        dest_count = db.query(Destination).count()
        version_count = db.query(PlatformConfigVersion).count()
        versions = [int(v) for (v,) in db.query(PlatformConfigVersion.version).all()]
        assert dest_count == WORKERS * ROUNDS
        assert version_count == WORKERS * ROUNDS
        assert len(versions) == len(set(versions))
        assert 500 not in statuses
    finally:
        db.close()


def test_concurrent_mixed_stream_and_destination_mutations(reset_db: None, db_engine: Engine) -> None:
    connector_id, source_id = _seed_connector_source(db_engine)
    client = _live_client()
    n = WORKERS
    barrier = threading.Barrier(n)

    def _one(idx: int) -> tuple[str, int, str]:
        barrier.wait(timeout=10)
        if idx % 2 == 0:
            res = client.post(
                "/api/v1/streams/",
                json={
                    "name": f"cfg-ver-mix-stream-{idx}",
                    "connector_id": connector_id,
                    "source_id": source_id,
                    "polling_interval": 30,
                    "enabled": True,
                    "status": "STOPPED",
                    "stream_type": "HTTP_API_POLLING",
                    "config_json": {},
                    "rate_limit_json": {},
                },
            )
            return ("stream", res.status_code, res.text)
        res = client.post(
            "/api/v1/destinations/",
            json={
                "name": f"cfg-ver-mix-dest-{idx}",
                "destination_type": "WEBHOOK_POST",
                "config_json": {"url": f"https://receiver.example/mix/{idx}"},
                "rate_limit_json": {},
                "enabled": True,
            },
        )
        return ("dest", res.status_code, res.text)

    results: list[tuple[str, int, str]] = []
    with ThreadPoolExecutor(max_workers=n) as pool:
        futs = [pool.submit(_one, i) for i in range(n)]
        for fut in as_completed(futs):
            results.append(fut.result())

    for kind, status, text in results:
        assert status != 500, f"{kind}: {text}"
        assert "UniqueViolation" not in text
        assert status == 201, f"{kind}: {text}"

    db = _session_factory(db_engine)()
    try:
        stream_count = db.query(Stream).count()
        dest_count = db.query(Destination).count()
        version_count = db.query(PlatformConfigVersion).count()
        versions = [int(v) for (v,) in db.query(PlatformConfigVersion.version).all()]
        assert stream_count + dest_count == n
        assert version_count == n
        assert len(versions) == len(set(versions))
    finally:
        db.close()
