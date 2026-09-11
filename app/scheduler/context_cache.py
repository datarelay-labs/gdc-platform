"""TTL + version-fingerprint cache for scheduler stream context loads (S4-04)."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import func, inspect as sa_inspect
from sqlalchemy.orm import Session

from app.checkpoints.repository import get_checkpoint_by_stream_id
from app.destinations.models import Destination
from app.enrichments.models import Enrichment
from app.mappings.models import Mapping
from app.routes.models import Route
from app.runtime.copy_utils import copy_json_value
from app.runtime.stream_context import StreamContext
from app.runners.stream_loader import load_stream_context
from app.runners.stream_runner_db import expunge_runtime_orm_graph, run_with_db
from app.sources.models import Source
from app.streams.repository import get_stream_by_id

logger = logging.getLogger(__name__)

DEFAULT_TTL_SEC = 45.0


def _iso_ts(value: datetime | None) -> str:
    if value is None:
        return "none"
    if value.tzinfo is None:
        return value.isoformat()
    return value.astimezone().isoformat()


@dataclass
class ContextCacheMetrics:
    hits: int = 0
    misses: int = 0
    invalidations: int = 0
    version_invalidations: int = 0
    ttl_expirations: int = 0
    load_latency_ms_total: int = 0
    load_count: int = 0

    def snapshot(self) -> dict[str, int]:
        return {
            "hits": self.hits,
            "misses": self.misses,
            "invalidations": self.invalidations,
            "version_invalidations": self.version_invalidations,
            "ttl_expirations": self.ttl_expirations,
            "load_latency_ms_total": self.load_latency_ms_total,
            "load_count": self.load_count,
        }


@dataclass(slots=True)
class _CachedShell:
    fingerprint: str
    cached_at: float
    stream_runtime: dict[str, Any]
    routes: list[Any]
    destinations_by_route: dict[int, Any]
    source: Any
    mapping: Any
    enrichment: Any


_metrics = ContextCacheMetrics()
_cache: dict[int, _CachedShell] = {}
_lock = threading.Lock()


def context_cache_metrics() -> dict[str, int]:
    with _lock:
        return _metrics.snapshot()


def reset_context_cache_for_tests() -> None:
    """Clear process-local cache state (tests only)."""

    global _metrics
    with _lock:
        _cache.clear()
        _metrics = ContextCacheMetrics()


def invalidate_stream_context_cache(stream_id: int, *, reason: str = "explicit") -> None:
    """Drop cached config for one stream."""

    with _lock:
        removed = _cache.pop(int(stream_id), None) is not None
        if removed:
            _metrics.invalidations += 1
    if removed:
        logger.info(
            "%s",
            {
                "stage": "scheduler_context_cache_invalidate",
                "stream_id": int(stream_id),
                "reason": reason,
            },
        )


def compute_stream_config_fingerprint(db: Session, stream_id: int) -> str | None:
    """Lightweight config version token; None when stream is missing."""

    stream = get_stream_by_id(db, stream_id)
    if stream is None:
        return None

    source_ts = (
        db.query(func.max(Source.updated_at))
        .filter(Source.id == int(stream.source_id))
        .scalar()
    )
    mapping_ts = (
        db.query(func.max(Mapping.updated_at))
        .filter(Mapping.stream_id == stream_id)
        .scalar()
    )
    enrichment_ts = (
        db.query(func.max(Enrichment.updated_at))
        .filter(Enrichment.stream_id == stream_id)
        .scalar()
    )
    route_ts = (
        db.query(func.max(Route.updated_at))
        .filter(Route.stream_id == stream_id, Route.enabled.is_(True))
        .scalar()
    )
    destination_ts = (
        db.query(func.max(Destination.updated_at))
        .join(Route, Route.destination_id == Destination.id)
        .filter(Route.stream_id == stream_id, Route.enabled.is_(True))
        .scalar()
    )

    parts = [
        f"stream:{int(stream.id)}:{_iso_ts(stream.updated_at)}",
        f"enabled:{int(bool(stream.enabled))}",
        f"source:{int(stream.source_id)}:{_iso_ts(source_ts)}",
        f"mapping:{_iso_ts(mapping_ts)}",
        f"enrichment:{_iso_ts(enrichment_ts)}",
        f"routes:{_iso_ts(route_ts)}",
        f"destinations:{_iso_ts(destination_ts)}",
        f"polling:{int(stream.polling_interval or 60)}",
    ]
    return "|".join(parts)


def _load_fresh_checkpoint(db: Session, stream_id: int) -> dict[str, Any] | None:
    checkpoint_row = get_checkpoint_by_stream_id(db, stream_id)
    if checkpoint_row is None:
        return None
    return {
        "type": checkpoint_row.checkpoint_type,
        "value": checkpoint_row.checkpoint_value_json,
    }


def _eager_load_column_attrs(obj: Any) -> None:
    """Force-load mapped columns so a later Session.close() cannot expire them."""

    if obj is None:
        return
    try:
        insp = sa_inspect(obj)
        mapper = getattr(insp, "mapper", None)
        if mapper is None:
            return
        for attr in mapper.column_attrs:
            getattr(obj, attr.key, None)
    except Exception:
        return


def _prepare_context_for_cache(db: Session, context: StreamContext) -> None:
    """Detach runtime ORM rows with columns already loaded (production uses short sessions)."""

    runtime = context.stream if isinstance(context.stream, dict) else {}
    candidates: list[Any] = [context.source, context.mapping, context.enrichment]
    if isinstance(runtime, dict):
        candidates.extend([runtime.get("mapping_row"), runtime.get("enrichment_row")])
        for route in list(runtime.get("routes") or []):
            if not isinstance(route, dict):
                continue
            candidates.extend([route.get("route_mapping_row"), route.get("route_enrichment_row")])
    for obj in candidates:
        _eager_load_column_attrs(obj)
    expunge_runtime_orm_graph(db, context.stream, context)


def _shell_from_context(context: StreamContext, fingerprint: str) -> _CachedShell:
    return _CachedShell(
        fingerprint=fingerprint,
        cached_at=time.monotonic(),
        stream_runtime=copy_json_value(context.stream),
        routes=copy_json_value(context.routes),
        destinations_by_route=copy_json_value(context.destinations_by_route),
        source=context.source,
        mapping=context.mapping,
        enrichment=context.enrichment,
    )


def _context_from_shell(shell: _CachedShell, checkpoint: dict[str, Any] | None) -> StreamContext:
    return StreamContext(
        stream=copy_json_value(shell.stream_runtime),
        source=shell.source,
        mapping=shell.mapping,
        enrichment=shell.enrichment,
        routes=copy_json_value(shell.routes),
        destinations_by_route=copy_json_value(shell.destinations_by_route),
        checkpoint=copy_json_value(checkpoint) if checkpoint is not None else None,
        persist_checkpoint=True,
        replay_start=None,
        replay_end=None,
        dry_run=False,
    )


def load_scheduler_stream_context(
    stream_id: int,
    *,
    ttl_sec: float = DEFAULT_TTL_SEC,
    db: Session | None = None,
) -> StreamContext:
    """Load stream context with TTL + fingerprint cache (scheduler poll path).

    Checkpoint is always loaded fresh so Runtime Is Truth holds for cursor state.
    Config entities are reused when fingerprint is unchanged and TTL has not expired.
    Production scheduler passes ``db=None`` and uses short-lived sessions per query.
    """

    sid = int(stream_id)
    started = time.monotonic()

    def _fingerprint(active: Session) -> str | None:
        return compute_stream_config_fingerprint(active, sid)

    def _checkpoint(active: Session) -> dict[str, Any] | None:
        return _load_fresh_checkpoint(active, sid)

    if db is not None:
        fingerprint = _fingerprint(db)
        checkpoint = _checkpoint(db)
    else:
        fingerprint = run_with_db(_fingerprint)
        checkpoint = run_with_db(_checkpoint)

    if fingerprint is None:
        raise ValueError(f"stream not found: {sid}")

    now = time.monotonic()

    with _lock:
        entry = _cache.get(sid)
        if entry is not None:
            age = now - entry.cached_at
            if age <= ttl_sec and entry.fingerprint == fingerprint:
                _metrics.hits += 1
                latency_ms = max(0, int((time.monotonic() - started) * 1000))
                _metrics.load_latency_ms_total += latency_ms
                _metrics.load_count += 1
                logger.debug(
                    "%s",
                    {
                        "stage": "scheduler_context_cache_hit",
                        "stream_id": sid,
                        "cache_age_sec": round(age, 3),
                        "load_latency_ms": latency_ms,
                    },
                )
                return _context_from_shell(entry, checkpoint)
            if entry.fingerprint != fingerprint:
                _metrics.version_invalidations += 1
                _cache.pop(sid, None)
            elif age > ttl_sec:
                _metrics.ttl_expirations += 1
                _cache.pop(sid, None)

    def _load_fresh(active: Session) -> StreamContext:
        stream_row = get_stream_by_id(active, sid)
        ctx = load_stream_context(active, sid, preloaded_stream=stream_row)
        ctx.checkpoint = checkpoint
        _prepare_context_for_cache(active, ctx)
        return ctx

    if db is not None:
        context = _load_fresh(db)
    else:
        context = run_with_db(_load_fresh)

    with _lock:
        _cache[sid] = _shell_from_context(context, fingerprint)
        _metrics.misses += 1
        latency_ms = max(0, int((time.monotonic() - started) * 1000))
        _metrics.load_latency_ms_total += latency_ms
        _metrics.load_count += 1

    logger.debug(
        "%s",
        {
            "stage": "scheduler_context_cache_miss",
            "stream_id": sid,
            "load_latency_ms": latency_ms,
        },
    )
    return context
