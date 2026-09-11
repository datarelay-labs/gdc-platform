"""DATABASE_QUERY PostgreSQL execute path: true read-only transaction enforcement."""

from __future__ import annotations

import os
import socket
from typing import Any
from unittest.mock import MagicMock

import pytest

from app.runtime.errors import SourceFetchError
from app.sources.database_query.execute import _fetch_postgres, fetch_database_rows
from app.sources.database_query.query_validator import validate_select_query

PG_FIXTURE_HOST = os.getenv("SOURCE_E2E_PG_FIXTURE_HOST", "127.0.0.1")
PG_FIXTURE_PORT = int(os.getenv("SOURCE_E2E_PG_FIXTURE_PORT", "55433"))
PG_FIXTURE_DB = "gdc_query_fixture"
PG_FIXTURE_USER = "gdc_fixture"
PG_FIXTURE_PASSWORD = "gdc_fixture_pw"


def _pg_fixture_open() -> bool:
    try:
        with socket.create_connection((PG_FIXTURE_HOST, PG_FIXTURE_PORT), timeout=0.5):
            return True
    except OSError:
        return False


skip_no_pg_fixture = pytest.mark.skipif(not _pg_fixture_open(), reason="postgres-query-test fixture not reachable")


def _source_config() -> dict[str, Any]:
    return {
        "db_type": "POSTGRESQL",
        "host": PG_FIXTURE_HOST,
        "port": PG_FIXTURE_PORT,
        "database": PG_FIXTURE_DB,
        "username": PG_FIXTURE_USER,
        "password": PG_FIXTURE_PASSWORD,
        "ssl_mode": "DISABLE",
        "connection_timeout_seconds": 10,
    }


def test_string_validation_accepts_select_rejects_dml() -> None:
    validate_select_query("SELECT 1 AS x")
    for bad in (
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET x = 1",
        "DELETE FROM t",
    ):
        with pytest.raises(SourceFetchError):
            validate_select_query(bad)


def test_fetch_postgres_sets_read_only_before_user_sql(monkeypatch: pytest.MonkeyPatch) -> None:
    executed: list[str] = []
    cursor = MagicMock()

    def _execute(sql: Any, params: Any = None) -> None:
        executed.append(str(sql))
        if "SET TRANSACTION" in str(sql).upper():
            return
        cursor.fetchall.return_value = [{"gdc_ok": 1}]

    cursor.execute.side_effect = _execute
    cursor_cm = MagicMock()
    cursor_cm.__enter__.return_value = cursor
    cursor_cm.__exit__.return_value = False

    conn = MagicMock()
    conn.cursor.return_value = cursor_cm
    monkeypatch.setattr("app.sources.database_query.execute.psycopg2.connect", lambda **kw: conn)

    rows = _fetch_postgres(
        host="127.0.0.1",
        port=5432,
        database="db",
        user="u",
        password="p",
        ssl_mode="DISABLE",
        connect_timeout=5,
        statement_ms=5000,
        sql_text="SELECT 1 AS gdc_ok",
        bind=None,
    )
    assert rows == [{"gdc_ok": 1}]
    assert len(executed) >= 2
    assert executed[0].strip().upper() == "SET TRANSACTION READ ONLY"
    assert "SELECT 1" in executed[1].upper()
    conn.rollback.assert_called()
    conn.close.assert_called()


def test_fetch_postgres_releases_connection_on_query_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = MagicMock()

    def _execute(sql: Any, params: Any = None) -> None:
        if "SET TRANSACTION" in str(sql).upper():
            return
        raise RuntimeError("boom")

    cursor.execute.side_effect = _execute
    cursor_cm = MagicMock()
    cursor_cm.__enter__.return_value = cursor
    cursor_cm.__exit__.return_value = False

    conn = MagicMock()
    conn.cursor.return_value = cursor_cm
    monkeypatch.setattr("app.sources.database_query.execute.psycopg2.connect", lambda **kw: conn)

    with pytest.raises(SourceFetchError, match="query failed"):
        _fetch_postgres(
            host="127.0.0.1",
            port=5432,
            database="db",
            user="u",
            password="p",
            ssl_mode="DISABLE",
            connect_timeout=5,
            statement_ms=5000,
            sql_text="SELECT 1",
            bind=None,
        )
    conn.rollback.assert_called()
    conn.close.assert_called()


@skip_no_pg_fixture
def test_postgres_transaction_read_only_is_on() -> None:
    rows = _fetch_postgres(
        host=PG_FIXTURE_HOST,
        port=PG_FIXTURE_PORT,
        database=PG_FIXTURE_DB,
        user=PG_FIXTURE_USER,
        password=PG_FIXTURE_PASSWORD,
        ssl_mode="DISABLE",
        connect_timeout=10,
        statement_ms=5000,
        sql_text="SHOW transaction_read_only",
        bind=None,
    )
    assert rows, "expected SHOW transaction_read_only row"
    # psycopg2 RealDictCursor uses column name "transaction_read_only"
    val = str(rows[0].get("transaction_read_only") or "").strip().lower()
    assert val == "on"


@skip_no_pg_fixture
def test_postgres_select_query_passes() -> None:
    rows = fetch_database_rows(
        source_config=_source_config(),
        stream_config={
            "query": "SELECT 1 AS ok",
            "max_rows_per_run": 5,
            "checkpoint_mode": "NONE",
            "query_timeout_seconds": 10,
        },
        checkpoint=None,
    )
    assert rows == [{"ok": 1}]


@skip_no_pg_fixture
def test_postgres_select_with_write_side_effect_rejected_and_not_persisted() -> None:
    import psycopg2

    setup_sql = """
    CREATE TABLE IF NOT EXISTS gdc_dq_ro_probe (
      id SERIAL PRIMARY KEY,
      note TEXT NOT NULL
    );
    DELETE FROM gdc_dq_ro_probe;
    CREATE OR REPLACE FUNCTION gdc_dq_ro_probe_insert() RETURNS integer
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO gdc_dq_ro_probe(note) VALUES ('side-effect');
      RETURN 1;
    END;
    $$;
    """
    conn = psycopg2.connect(
        host=PG_FIXTURE_HOST,
        port=PG_FIXTURE_PORT,
        dbname=PG_FIXTURE_DB,
        user=PG_FIXTURE_USER,
        password=PG_FIXTURE_PASSWORD,
        connect_timeout=10,
        sslmode="disable",
    )
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(setup_sql)
            cur.execute("SELECT count(*) FROM gdc_dq_ro_probe")
            assert int(cur.fetchone()[0]) == 0
    finally:
        conn.close()

    # String validation allows SELECT … function(); DB must reject the write.
    validate_select_query("SELECT gdc_dq_ro_probe_insert() AS x")

    with pytest.raises(SourceFetchError, match="read-only|query failed"):
        fetch_database_rows(
            source_config=_source_config(),
            stream_config={
                "query": "SELECT gdc_dq_ro_probe_insert() AS x",
                "max_rows_per_run": 5,
                "checkpoint_mode": "NONE",
                "query_timeout_seconds": 10,
            },
            checkpoint=None,
        )

    conn2 = psycopg2.connect(
        host=PG_FIXTURE_HOST,
        port=PG_FIXTURE_PORT,
        dbname=PG_FIXTURE_DB,
        user=PG_FIXTURE_USER,
        password=PG_FIXTURE_PASSWORD,
        connect_timeout=10,
        sslmode="disable",
    )
    try:
        with conn2.cursor() as cur:
            cur.execute("SELECT count(*) FROM gdc_dq_ro_probe")
            assert int(cur.fetchone()[0]) == 0
    finally:
        conn2.close()


@skip_no_pg_fixture
def test_postgres_repeated_fetch_no_connection_leak() -> None:
    for _ in range(5):
        rows = fetch_database_rows(
            source_config=_source_config(),
            stream_config={
                "query": "SELECT 1 AS ok",
                "max_rows_per_run": 5,
                "checkpoint_mode": "NONE",
                "query_timeout_seconds": 10,
            },
            checkpoint=None,
        )
        assert rows == [{"ok": 1}]
