from __future__ import annotations

import os
from pathlib import Path

# RBAC-lite (spec 020): most integration tests call the API without a bearer token
# and rely on the anonymous ADMINISTRATOR fallback when REQUIRE_AUTH is false.
# A developer/CI shell or `.env` setting REQUIRE_AUTH=true would otherwise 401 the
# entire suite. Tests that need an authenticated gate use monkeypatch on
# ``app.config.settings`` (see tests/test_jwt_session_auth.py).
os.environ["REQUIRE_AUTH"] = "false"
# Production secret validation is fail-closed; pytest must stay on the development contract
# unless a test constructs Settings(APP_ENV="production", ...) with explicit strong secrets.
os.environ["APP_ENV"] = "development"

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_ONTOLOGY_ENV_FILE = _PROJECT_ROOT / ".env.test.ontology"


def _parse_simple_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'").strip('"')
    return values


def _load_ontology_test_env() -> dict[str, str]:
    """Use the explicit ontology test env when ontology validation is requested."""

    if not _ONTOLOGY_ENV_FILE.exists():
        return {}
    values = _parse_simple_env_file(_ONTOLOGY_ENV_FILE)
    if values.get("TEST_METRIC_ONTOLOGY") != "true":
        raise RuntimeError(f"{_ONTOLOGY_ENV_FILE} must set TEST_METRIC_ONTOLOGY=true")
    # Only switch the whole pytest process to the ontology catalog when explicitly requested.
    should_pin_to_ontology = os.environ.get("TEST_METRIC_ONTOLOGY") == "true"
    if should_pin_to_ontology:
        for key, value in values.items():
            os.environ[key] = value
        os.environ["TEST_DATABASE_URL"] = values.get("TEST_DATABASE_URL") or values["DATABASE_URL"]
        os.environ["DATABASE_URL"] = values["DATABASE_URL"]
    return values


_ONTOLOGY_TEST_ENV = _load_ontology_test_env()

from tests.db_test_policy import (
    DEFAULT_PYTEST_DATABASE_URL,
    catalog_name_from_database_url,
    validate_host_pytest_catalog,
)


def _pin_pytest_database_url_before_engine() -> str:
    """Force SessionLocal onto the pytest catalog before ``app.database`` imports.

    StreamRunner protection/policy paths use ``run_with_db`` → ``SessionLocal``.
    Fixtures use ``db_engine`` from ``TEST_DATABASE_URL``. If only a developer
    ``.env`` ``DATABASE_URL`` (e.g. compose ``postgres:5432/gdc`` → host
    ``127.0.0.1:55432/gdc``) is visible at import time, SessionLocal binds to the
    platform catalog while fixtures truncate ``gdc_pytest`` — legacy protection
    OFF-path then loads zero rules and silently passthroughs.
    """

    if os.environ.get("TEST_METRIC_ONTOLOGY") == "true":
        url = (
            os.environ.get("TEST_DATABASE_URL")
            or _ONTOLOGY_TEST_ENV.get("TEST_DATABASE_URL")
            or _ONTOLOGY_TEST_ENV.get("DATABASE_URL")
        )
        if not url:
            raise RuntimeError(f"TEST_METRIC_ONTOLOGY=true requires {_ONTOLOGY_ENV_FILE}")
    else:
        url = os.environ.get("TEST_DATABASE_URL")
        if not url:
            candidate = os.environ.get("DATABASE_URL") or DEFAULT_PYTEST_DATABASE_URL
            try:
                validate_host_pytest_catalog(catalog_name_from_database_url(candidate))
                url = candidate
            except RuntimeError:
                url = DEFAULT_PYTEST_DATABASE_URL
        validate_host_pytest_catalog(catalog_name_from_database_url(url))
    os.environ["TEST_DATABASE_URL"] = url
    os.environ["DATABASE_URL"] = url
    return url


# Model imports below load app.database and create the global SQLAlchemy engine.
# Pin both URLs first so SessionLocal and db_session share the same catalog.
_pin_pytest_database_url_before_engine()

import threading
import time

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.checkpoints import models as _checkpoint_models  # noqa: F401
from app.connectors import models as _connector_models  # noqa: F401
from app.destinations import models as _dest_models  # noqa: F401
from app.enrichments import models as _enrich_models  # noqa: F401
from app.logs import models as _log_models  # noqa: F401
from app.mappings import models as _map_models  # noqa: F401
from app.routes import models as _route_models  # noqa: F401
from app.sources import models as _source_models  # noqa: F401
from app.streams import models as _stream_models  # noqa: F401
from app.validation import models as _validation_models  # noqa: F401
from app.backfill import models as _backfill_models  # noqa: F401
from app.platform_admin import models as _platform_admin_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.runtime import models as _runtime_models  # noqa: F401
from app.schema_observation import models as _schema_observation_models  # noqa: F401
from app.sensitive_detection import models as _sensitive_detection_models  # noqa: F401
from app.protection import models as _protection_models  # noqa: F401
from app.ai_gateway import models as _ai_gateway_models  # noqa: F401

pytest_plugins = ("tests.e2e_syslog_helpers", "tests.runtime_read_fixtures")

_schema_ddl_lock = threading.Lock()


def _resolve_test_database_url() -> str:
    """Prefer the explicit ontology env when enabled; otherwise require an allowed PostgreSQL test catalog."""

    if os.getenv("TEST_METRIC_ONTOLOGY") == "true":
        url = _ONTOLOGY_TEST_ENV.get("TEST_DATABASE_URL") or _ONTOLOGY_TEST_ENV.get("DATABASE_URL")
        if not url:
            raise RuntimeError(f"TEST_METRIC_ONTOLOGY=true requires {_ONTOLOGY_ENV_FILE}")
        return url
    return os.getenv("TEST_DATABASE_URL") or os.getenv("DATABASE_URL") or DEFAULT_PYTEST_DATABASE_URL


def _validate_test_database_url(url: str) -> None:
    validate_host_pytest_catalog(catalog_name_from_database_url(url))


def _guard_destructive_db_ops(test_db_url: str) -> None:
    """Re-check before TRUNCATE / DROP SCHEMA (session env must not drift to a live catalog)."""

    validate_host_pytest_catalog(catalog_name_from_database_url(test_db_url))


def pytest_configure() -> None:
    """Pin the whole test process to the explicit PostgreSQL test database."""

    url = _resolve_test_database_url()
    _validate_test_database_url(url)
    os.environ["TEST_DATABASE_URL"] = url
    os.environ["DATABASE_URL"] = url
    # Prevent indefinite waits on DB locks in test subprocesses.
    os.environ.setdefault("PGOPTIONS", "-c lock_timeout=5000 -c statement_timeout=120000")
    # Fixtures that reset schema terminate other connections to the same DB; avoid sharing the
    # default DATABASE_URL with a live uvicorn instance or migrations may appear flaky.

    # Isolate stream run locks from host /tmp leftovers and parallel worktrees.
    if not (os.environ.get("GDC_STREAM_RUN_LOCK_DIR") or "").strip():
        worker = os.environ.get("PYTEST_XDIST_WORKER") or "main"
        lock_root = Path(os.environ.get("TMPDIR") or "/tmp") / "gdc-pytest-stream-run-locks" / worker
        lock_root.mkdir(parents=True, exist_ok=True)
        os.environ["GDC_STREAM_RUN_LOCK_DIR"] = str(lock_root)


@pytest.fixture(autouse=True)
def _cleanup_unowned_stream_run_locks() -> None:
    """Drop orphaned lock files and release any process-local lock handles."""

    try:
        from app.runners import stream_runtime_lock

        stream_runtime_lock.release_all_held()
        stream_runtime_lock.cleanup_unowned_lock_files()
    except Exception:
        pass
    yield
    try:
        from app.runners import stream_runtime_lock

        stream_runtime_lock.release_all_held()
        stream_runtime_lock.cleanup_unowned_lock_files()
    except Exception:
        pass


@pytest.fixture(scope="session")
def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def test_db_url() -> str:
    return _resolve_test_database_url()


@pytest.fixture(scope="session")
def db_engine(test_db_url: str) -> Engine:
    # NullPool: avoid reusing pooled connections across DROP SCHEMA / TRUNCATE boundaries
    # (stale sockets and "server closed the connection unexpectedly" during DDL).
    engine = create_engine(
        test_db_url,
        poolclass=NullPool,
        pool_pre_ping=True,
        connect_args={"application_name": "pytest-gdc"},
    )
    try:
        yield engine
    finally:
        engine.dispose()


def _terminate_other_connections(engine: Engine, db_url: str) -> None:
    db_name = catalog_name_from_database_url(db_url)
    if not db_name:
        return
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(
            text(
                "SELECT pg_terminate_backend(pid) "
                "FROM pg_stat_activity "
                "WHERE datname = :db_name "
                "AND pid <> pg_backend_pid()"
            ),
            {"db_name": db_name},
        )


def _reset_public_schema(engine: Engine) -> None:
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))


def _alembic_upgrade_head(test_db_url: str, project_root: Path) -> None:
    cfg = Config(str(project_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(project_root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", test_db_url)
    command.upgrade(cfg, "head")


def _restamp_alembic_head(test_db_url: str, project_root: Path) -> None:
    """Per-test TRUNCATE clears alembic_version; restamp to match existing DDL."""

    cfg = Config(str(project_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(project_root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", test_db_url)
    command.stamp(cfg, "head")


def _alembic_version_table_exists(engine: Engine) -> bool:
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'alembic_version' LIMIT 1"
            )
        ).first()
        return row is not None


def _alembic_applied_revision(engine: Engine) -> str | None:
    if not _alembic_version_table_exists(engine):
        return None
    with engine.connect() as conn:
        row = conn.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).scalar()
    return str(row) if row else None


def _public_schema_has_core_tables(engine: Engine) -> bool:
    with engine.connect() as conn:
        return bool(
            conn.execute(
                text(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_name = 'connectors')"
                )
            ).scalar()
        )


def _ensure_public_schema_at_revision_head(engine: Engine, test_db_url: str, project_root: Path) -> None:
    """Create schema via Alembic when missing; upgrade to head when revision is recorded."""

    _guard_destructive_db_ops(test_db_url)
    applied = _alembic_applied_revision(engine)
    if applied is None:
        if _public_schema_has_core_tables(engine) or not _alembic_version_table_exists(engine):
            _terminate_other_connections(engine, test_db_url)
            _reset_public_schema(engine)
        _alembic_upgrade_head(test_db_url, project_root)
        engine.dispose()
        return
    _alembic_upgrade_head(test_db_url, project_root)


def _quote_pg_ident(name: str) -> str:
    """Quote a PostgreSQL identifier (tablename from pg_catalog only)."""

    return '"' + str(name).replace('"', '""') + '"'


def _truncate_public_tables(engine: Engine) -> None:
    """Clear application data without dropping tables or indexes."""

    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
        ).fetchall()
    if not rows:
        return
    table_list = ", ".join(f"public.{_quote_pg_ident(str(r[0]))}" for r in rows)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE TABLE {table_list} RESTART IDENTITY CASCADE"))


def _clear_runtime_read_caches() -> None:
    """In-process caches must not survive TRUNCATE (delivery_log facts, dashboard TTL)."""

    try:
        from app.logs.incremental_aggregates import clear_incremental_delivery_log_aggregate_cache

        clear_incremental_delivery_log_aggregate_cache()
    except Exception:
        pass
    try:
        from app.runtime.dashboard_read_cache import clear_dashboard_read_cache

        clear_dashboard_read_cache()
    except Exception:
        pass
    try:
        from app.runtime.stats_health_bulk_cache import clear_stats_health_bulk_cache

        clear_stats_health_bulk_cache()
    except Exception:
        pass
    try:
        from app.runtime.observability_read_cache import clear_observability_summary_cache

        clear_observability_summary_cache()
    except Exception:
        pass


def _truncate_public_tables_with_retry(engine: Engine, *, attempts: int = 5) -> None:
    """Clear public data like :func:`_truncate_public_tables` with deadlock retries.

    ``TRUNCATE`` takes ``ACCESS EXCLUSIVE`` locks.  Another session on the same
    test database (stale ``uvicorn``, ad-hoc ``psql``) can still race; callers
    should invoke :func:`_terminate_other_connections` first.
    """

    delay_s = 0.05
    last: OperationalError | None = None
    for _ in range(attempts):
        try:
            _truncate_public_tables(engine)
            return
        except OperationalError as exc:
            last = exc
            if "deadlock" not in str(exc).lower():
                raise
            time.sleep(delay_s)
            delay_s = min(delay_s * 2, 1.0)
    assert last is not None
    raise last


@pytest.fixture()
def reset_db_schema(db_engine: Engine, test_db_url: str) -> None:
    """Full destructive reset (rare); callers must expect a cold public schema."""

    _guard_destructive_db_ops(test_db_url)
    with _schema_ddl_lock:
        _terminate_other_connections(db_engine, test_db_url)
        _reset_public_schema(db_engine)
        db_engine.dispose()


@pytest.fixture()
def reset_db(db_engine: Engine, test_db_url: str, project_root: Path) -> None:
    """Ensure migrated tables exist, then truncate (fast per-test isolation)."""

    _guard_destructive_db_ops(test_db_url)
    with _schema_ddl_lock:
        _ensure_public_schema_at_revision_head(db_engine, test_db_url, project_root)
        _terminate_other_connections(db_engine, test_db_url)
        _truncate_public_tables_with_retry(db_engine)
        _restamp_alembic_head(test_db_url, project_root)
        _clear_runtime_read_caches()


@pytest.fixture()
def db_session(reset_db: None, db_engine: Engine) -> Session:
    # expire_on_commit=False avoids flaky "Could not refresh instance" when route
    # handlers commit inside the same Session yielded to TestClient dependencies.
    session = sessionmaker(bind=db_engine, autocommit=False, autoflush=False, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def migrated_db_session(reset_db: None, db_engine: Engine) -> Session:
    """Same physical schema as ``db_session`` (Alembic head + truncated data)."""

    session = sessionmaker(bind=db_engine, autocommit=False, autoflush=False, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.rollback()
        session.close()
