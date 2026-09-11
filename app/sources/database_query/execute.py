"""Execute wrapped DATABASE_QUERY SELECT and return list[dict]."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from app.runtime.errors import SourceFetchError
from app.sources.database_query.query_validator import coerce_query_params, validate_select_query
from app.sources.database_query.row_codec import json_safe_row
from app.sources.database_query.sql_builder import build_wrapped_select

logger = logging.getLogger(__name__)


def _get(cfg: dict[str, Any], key: str, default: Any = None) -> Any:
    if isinstance(cfg, dict):
        return cfg.get(key, default)
    return getattr(cfg, key, default)


def _ssl_mode_pg(mode: str) -> str:
    m = str(mode or "PREFER").strip().upper()
    allowed = {"DISABLE", "PREFER", "REQUIRE", "VERIFY_CA", "VERIFY_FULL"}
    if m not in allowed:
        raise SourceFetchError(f"unsupported ssl_mode for PostgreSQL: {mode}")
    return m.lower().replace("_", "-")


def _parse_replay_bound(raw: Any) -> Any:
    """Parse ISO-8601 replay bound from stream_config (string)."""

    if raw is None:
        raise SourceFetchError("replay bound is required")
    s = str(raw).strip()
    if not s:
        raise SourceFetchError("replay bound is required")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError as exc:
        raise SourceFetchError(f"invalid replay ISO timestamp: {raw!r}") from exc


def fetch_database_rows(
    *,
    source_config: dict[str, Any],
    stream_config: dict[str, Any],
    checkpoint: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    db_type = str(_get(source_config, "db_type") or "").strip().upper()
    if db_type != "POSTGRESQL":
        raise SourceFetchError("source_config.db_type must be POSTGRESQL")

    inner = validate_select_query(str(_get(stream_config, "query") or ""))
    max_rows = int(_get(stream_config, "max_rows_per_run", 100) or 100)
    if max_rows < 1:
        max_rows = 1

    q_timeout = int(_get(stream_config, "query_timeout_seconds", 30) or 30)
    if q_timeout < 1:
        q_timeout = 1
    if q_timeout > 3600:
        q_timeout = 3600

    params = coerce_query_params(_get(stream_config, "query_params"))

    ck_mode = str(_get(stream_config, "checkpoint_mode") or "NONE").strip().upper()
    ck_col = _get(stream_config, "checkpoint_column")
    ck_ord = _get(stream_config, "checkpoint_order_column")

    rlow_raw = _get(stream_config, "gdc_replay_start_iso")
    rhigh_raw = _get(stream_config, "gdc_replay_end_iso")
    replay_low: Any | None = None
    replay_high: Any | None = None
    if rlow_raw is not None and str(rlow_raw).strip() and rhigh_raw is not None and str(rhigh_raw).strip():
        replay_low = _parse_replay_bound(rlow_raw)
        replay_high = _parse_replay_bound(rhigh_raw)

    sql_text, bind = build_wrapped_select(
        inner_sql=inner,
        db_kind=db_type,
        query_params=params,
        checkpoint_mode=ck_mode,
        checkpoint_column=str(ck_col).strip() if ck_col is not None else None,
        checkpoint_order_column=str(ck_ord).strip() if ck_ord is not None else None,
        max_rows=max_rows,
        checkpoint_value=checkpoint if isinstance(checkpoint, dict) else None,
        replay_low=replay_low,
        replay_high=replay_high,
    )

    host = str(_get(source_config, "host") or "").strip()
    port = int(_get(source_config, "port") or 0)
    database = str(_get(source_config, "database") or "").strip()
    user = str(_get(source_config, "username") or "").strip()
    password = str(_get(source_config, "password") or "")
    conn_timeout = int(_get(source_config, "connection_timeout_seconds", 15) or 15)
    if conn_timeout < 1:
        conn_timeout = 1

    if not host or not database or not user:
        raise SourceFetchError("host, database, and username are required in source_config")
    if port <= 0:
        raise SourceFetchError("port must be a positive integer")

    stmt_ms = min(q_timeout * 1000, 3_600_000)

    logger.info(
        "%s",
        {
            "stage": "database_query_execute",
            "db_type": db_type,
            "host": host,
            "port": port,
            "database": database,
            "ssl_mode": str(_get(source_config, "ssl_mode") or ""),
        },
    )

    return _fetch_postgres(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password,
        ssl_mode=str(_get(source_config, "ssl_mode") or "PREFER"),
        connect_timeout=conn_timeout,
        statement_ms=stmt_ms,
        sql_text=sql_text,
        bind=bind,
    )


def _fetch_postgres(
    *,
    host: str,
    port: int,
    database: str,
    user: str,
    password: str,
    ssl_mode: str,
    connect_timeout: int,
    statement_ms: int,
    sql_text: str,
    bind: tuple | dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Connect to the external source PostgreSQL and run ``sql_text`` in a read-only transaction.

    Read-only is enforced at the PostgreSQL transaction level (``SET TRANSACTION READ ONLY``)
    in the same transaction as the user query. Application/checkpoint DB sessions are untouched.
    """

    sslmode = _ssl_mode_pg(ssl_mode)
    conn = None
    rows: list[Any] = []
    try:
        conn = psycopg2.connect(
            host=host,
            port=port,
            dbname=database,
            user=user,
            password=password,
            connect_timeout=connect_timeout,
            sslmode=sslmode,
            options=f"-c statement_timeout={int(statement_ms)}",
        )
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Same transaction as the user query: SET TRANSACTION must run before any DML/SELECT work.
            cur.execute("SET TRANSACTION READ ONLY")
            cur.execute(sql_text, bind)
            rows = cur.fetchall()
    except Exception as exc:
        if conn is None:
            raise SourceFetchError(f"PostgreSQL connection failed: {exc}") from exc
        raise SourceFetchError(f"PostgreSQL query failed: {exc}") from exc
    finally:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:  # pragma: no cover
                pass
            try:
                conn.close()
            except Exception:  # pragma: no cover
                pass

    out: list[dict[str, Any]] = []
    for r in rows:
        if isinstance(r, dict):
            out.append(json_safe_row(dict(r)))
    return out


def probe_database_connection(source_config: dict[str, Any]) -> dict[str, Any]:
    """Non-destructive connectivity probe (SELECT 1). Returns structured fields for API."""

    cfg = dict(source_config or {})
    db_type = str(cfg.get("db_type") or "").strip().upper()
    if db_type != "POSTGRESQL":
        return {"ok": False, "error_type": "invalid_db_type", "message": "db_type must be POSTGRESQL"}

    try:
        rows = _fetch_postgres(
            host=str(cfg.get("host") or "").strip(),
            port=int(cfg.get("port") or 5432),
            database=str(cfg.get("database") or "").strip(),
            user=str(cfg.get("username") or "").strip(),
            password=str(cfg.get("password") or ""),
            ssl_mode=str(cfg.get("ssl_mode") or "PREFER"),
            connect_timeout=int(cfg.get("connection_timeout_seconds", 15) or 15),
            statement_ms=5_000,
            sql_text="SELECT 1 AS gdc_ok",
            bind=None,
        )
    except SourceFetchError as exc:
        msg = str(exc)
        et = "auth_failed" if "Access denied" in msg or "password authentication failed" in msg.lower() else "connection_failed"
        return {"ok": False, "error_type": et, "message": msg}

    ok = bool(rows) and rows[0].get("gdc_ok") == 1
    return {"ok": ok, "message": "SELECT 1 succeeded" if ok else "unexpected probe result", "db_auth_ok": ok, "db_reachable": True}


def preview_limited_rows(
    *,
    source_config: dict[str, Any],
    stream_config: dict[str, Any],
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Run user SELECT with optional params; ``max_rows_per_run`` caps preview rows (no checkpoint)."""

    validate_select_query(str(_get(stream_config, "query") or ""))
    lim = max(1, min(int(limit or 5), 50))
    merged = {**dict(stream_config or {}), "max_rows_per_run": lim, "checkpoint_mode": "NONE"}
    return fetch_database_rows(source_config=source_config, stream_config=merged, checkpoint=None)
