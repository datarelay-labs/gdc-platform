"""Stream runtime deduplication at in-memory queue insert (post-extract, pre-transform)."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.sql import text

from app.checkpoints.repository import get_checkpoint_by_stream_id
from app.logs.models import DeliveryLog
from app.parsers.jsonpath_parser import extract_one
from app.runtime.copy_utils import copy_event_dict

logger = logging.getLogger(__name__)

DEDUP_REGISTRY_STAGE = "dedup_registry"
REGISTRY_RECORD_STAGE = "delivery_success"
GDC_DEDUP_KEY_META = "__gdc_dedup_key"
GDC_DEDUP_QUEUE_ID_META = "__gdc_dedup_queue_id"

# Bound last-summary scans on large partitioned delivery_logs (timeout-safe degrade).
_LAST_DEDUP_LOOKBACK = timedelta(hours=24)
_LAST_DEDUP_STATEMENT_TIMEOUT_MS = 5000

_KEY_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "event_id": ("event_id",),
    "stellar_uuid": ("stellar_uuid", "stellarUuid"),
    "id": ("id",),
}


@dataclass(slots=True)
class StreamDedupConfig:
    enabled: bool = False
    key_field: str = "event_id"
    custom_jsonpath: str | None = None
    duplicate_handling: str = "skip_duplicate"
    scope: str = "current_run"
    window_hours: int | None = None


@dataclass(slots=True)
class DedupQueueEntry:
    queue_id: int
    dedup_key: str
    event: dict[str, Any]
    key_source: str


@dataclass
class DedupSummary:
    total_events: int = 0
    inserted: int = 0
    duplicate_events: int = 0
    duplicate_by_event_id: int = 0
    duplicate_by_stellar_uuid: int = 0
    duplicate_by_id: int = 0
    duplicate_by_custom_key: int = 0
    duplicate_handling: str = "skip_duplicate"
    dedup_scope: str = "current_run"
    inserted_keys: list[str] = field(default_factory=list)
    registry_seed_duplicates: int = 0
    current_run_duplicates: int = 0
    registry_recorded: int = 0
    registry_skipped: int = 0
    registry_record_stage: str | None = None
    recorded_registry_keys: set[str] = field(default_factory=set, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_events": self.total_events,
            "inserted": self.inserted,
            "duplicate_events": self.duplicate_events,
            "duplicate_by_event_id": self.duplicate_by_event_id,
            "duplicate_by_stellar_uuid": self.duplicate_by_stellar_uuid,
            "duplicate_by_custom_key": self.duplicate_by_custom_key,
            "duplicate_by_id": self.duplicate_by_id,
            "duplicate_handling": self.duplicate_handling,
            "dedup_scope": self.dedup_scope,
            "registry_seed_duplicates": self.registry_seed_duplicates,
            "current_run_duplicates": self.current_run_duplicates,
            "registry_recorded": self.registry_recorded,
            "registry_skipped": self.registry_skipped,
            "registry_record_stage": self.registry_record_stage,
        }


def parse_dedup_config(stream_config: dict[str, Any] | None) -> StreamDedupConfig:
    raw = (stream_config or {}).get("deduplication")
    if not isinstance(raw, dict):
        return StreamDedupConfig()
    handling = str(raw.get("duplicate_handling") or "skip_duplicate")
    if handling not in ("skip_duplicate", "keep_latest", "keep_first"):
        handling = "skip_duplicate"
    scope = str(raw.get("scope") or "current_run")
    if scope not in ("current_run", "checkpoint_window", "last_n_hours"):
        scope = "current_run"
    key_field = str(raw.get("key_field") or "event_id").strip() or "event_id"
    custom = raw.get("custom_jsonpath")
    custom_path = str(custom).strip() if isinstance(custom, str) and custom.strip() else None
    window_hours = raw.get("window_hours")
    wh = int(window_hours) if isinstance(window_hours, int) and window_hours > 0 else None
    return StreamDedupConfig(
        enabled=bool(raw.get("enabled")),
        key_field=key_field,
        custom_jsonpath=custom_path,
        duplicate_handling=handling,
        scope=scope,
        window_hours=wh,
    )


def _normalize_key_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        text = str(value).strip()
        return text if text else None
    return None


def extract_dedup_key(event: dict[str, Any], config: StreamDedupConfig) -> tuple[str | None, str | None]:
    """Return (dedup_key, key_source) or (None, None) when key cannot be resolved."""

    if not isinstance(event, dict):
        return None, None

    key_field = config.key_field.strip()
    if key_field == "custom_jsonpath":
        path = config.custom_jsonpath
        if not path:
            return None, None
        try:
            raw = extract_one(event, path, default=None)
        except Exception:
            return None, None
        normalized = _normalize_key_value(raw)
        return (normalized, "custom_jsonpath") if normalized else (None, None)

    for alias in _KEY_FIELD_ALIASES.get(key_field, (key_field,)):
        normalized = _normalize_key_value(event.get(alias))
        if normalized:
            return normalized, key_field

    # JSONPath fallback for dotted field names stored as nested paths.
    if "." in key_field or key_field.startswith("$"):
        try:
            path = key_field if key_field.startswith("$") else f"$.{key_field}"
            raw = extract_one(event, path, default=None)
            normalized = _normalize_key_value(raw)
            return (normalized, key_field) if normalized else (None, None)
        except Exception:
            return None, None

    return None, None


def _scope_since(
    config: StreamDedupConfig,
    *,
    checkpoint: dict[str, Any] | None,
    checkpoint_updated_at: datetime | None,
) -> datetime | None:
    if config.scope == "current_run":
        return None
    if config.scope == "checkpoint_window":
        if checkpoint_updated_at is not None:
            return checkpoint_updated_at
        if isinstance(checkpoint, dict):
            updated = checkpoint.get("updated_at")
            if isinstance(updated, str) and updated.strip():
                try:
                    text = updated.strip()
                    if text.endswith("Z"):
                        text = text[:-1] + "+00:00"
                    return datetime.fromisoformat(text)
                except ValueError:
                    pass
        return None
    if config.scope == "last_n_hours":
        hours = config.window_hours if config.window_hours and config.window_hours > 0 else 24
        return datetime.now(timezone.utc) - timedelta(hours=hours)
    return None


def load_dedup_seed_keys(
    db: Session | None,
    *,
    stream_id: int,
    config: StreamDedupConfig,
    checkpoint: dict[str, Any] | None = None,
    checkpoint_updated_at: datetime | None = None,
) -> set[str]:
    """Load dedup keys from prior run registry rows for scoped dedup."""

    if db is None or config.scope == "current_run":
        return set()

    since = _scope_since(config, checkpoint=checkpoint, checkpoint_updated_at=checkpoint_updated_at)
    if since is None and config.scope == "checkpoint_window" and db is not None:
        row = get_checkpoint_by_stream_id(db, stream_id)
        if row is not None and getattr(row, "updated_at", None) is not None:
            since = row.updated_at
    query = db.query(DeliveryLog).filter(
        DeliveryLog.stream_id == int(stream_id),
        DeliveryLog.stage == DEDUP_REGISTRY_STAGE,
    )
    if since is not None:
        query = query.filter(DeliveryLog.created_at >= since)

    keys: set[str] = set()
    for row in query.order_by(DeliveryLog.id.desc()).limit(500).all():
        payload = row.payload_sample if isinstance(row.payload_sample, dict) else {}
        raw_keys = payload.get("dedup_keys")
        if not isinstance(raw_keys, list):
            continue
        for item in raw_keys:
            text = str(item).strip()
            if text:
                keys.add(text)
    return keys


def _inc_duplicate_counter(summary: DedupSummary, key_source: str | None) -> None:
    summary.duplicate_events += 1
    if key_source == "event_id":
        summary.duplicate_by_event_id += 1
    elif key_source == "stellar_uuid":
        summary.duplicate_by_stellar_uuid += 1
    elif key_source == "id":
        summary.duplicate_by_id += 1
    elif key_source == "custom_jsonpath":
        summary.duplicate_by_custom_key += 1


class StreamDedupQueue:
    """In-memory processing queue keyed by dedup key."""

    def __init__(
        self,
        *,
        config: StreamDedupConfig,
        seed_keys: set[str] | None = None,
        log_fn: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._config = config
        self._seed_keys = set(seed_keys or ())
        self._key_to_index: dict[str, int] = {}
        self._entries: list[DedupQueueEntry] = []
        self._next_queue_id = 1
        self._log_fn = log_fn
        self.summary = DedupSummary(
            duplicate_handling=config.duplicate_handling,
            dedup_scope=config.scope,
        )

    def _log_duplicate(
        self,
        *,
        dedup_key: str,
        reason: str,
        handling: str,
        queue_id: int | None,
        key_source: str | None,
    ) -> None:
        payload = {
            "stage": "dedup_duplicate",
            "dedup_key": dedup_key,
            "reason": reason,
            "handling": handling,
            "queue_id": queue_id,
            "key_source": key_source,
        }
        logger.debug("%s", payload)
        if self._log_fn is not None:
            self._log_fn({**payload, "level": "DEBUG", "message": f"duplicate suppressed: {dedup_key}"})

    def _attach_dedup_metadata(self, event: dict[str, Any], dedup_key: str | None, queue_id: int) -> None:
        if dedup_key:
            event[GDC_DEDUP_KEY_META] = dedup_key
            event[GDC_DEDUP_QUEUE_ID_META] = queue_id

    def _insert_new(self, event: dict[str, Any], dedup_key: str | None, key_source: str | None) -> None:
        queue_id = self._next_queue_id
        copied = copy_event_dict(event)
        self._attach_dedup_metadata(copied, dedup_key, queue_id)
        entry = DedupQueueEntry(
            queue_id=queue_id,
            dedup_key=dedup_key or f"__no_key_{queue_id}",
            event=copied,
            key_source=key_source or "none",
        )
        self._next_queue_id += 1
        self._entries.append(entry)
        if dedup_key:
            self._key_to_index[dedup_key] = len(self._entries) - 1
            self.summary.inserted_keys.append(dedup_key)
        self.summary.inserted += 1

    def ingest(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        self.summary.total_events = len(events)
        handling = self._config.duplicate_handling

        for event in events:
            if not isinstance(event, dict):
                self._insert_new(event if isinstance(event, dict) else {"value": event}, None, None)
                continue

            dedup_key, key_source = extract_dedup_key(event, self._config)
            if dedup_key is None:
                self._insert_new(event, None, None)
                continue

            in_run = dedup_key in self._key_to_index
            in_seed = dedup_key in self._seed_keys
            is_duplicate = in_run or in_seed

            if not is_duplicate:
                self._insert_new(event, dedup_key, key_source)
                continue

            queue_id = self._key_to_index.get(dedup_key)
            reason = "key_in_current_run" if in_run else "key_in_scope_registry"
            _inc_duplicate_counter(self.summary, key_source)
            if in_seed:
                self.summary.registry_seed_duplicates += 1
            if in_run:
                self.summary.current_run_duplicates += 1

            if handling == "keep_latest" and in_run and queue_id is not None:
                idx = self._key_to_index[dedup_key]
                replaced = copy_event_dict(event)
                self._attach_dedup_metadata(replaced, dedup_key, self._entries[idx].queue_id)
                self._entries[idx] = DedupQueueEntry(
                    queue_id=self._entries[idx].queue_id,
                    dedup_key=dedup_key,
                    event=replaced,
                    key_source=key_source or self._entries[idx].key_source,
                )
                self._log_duplicate(
                    dedup_key=dedup_key,
                    reason="keep_latest_replace",
                    handling=handling,
                    queue_id=self._entries[idx].queue_id,
                    key_source=key_source,
                )
                continue

            self._log_duplicate(
                dedup_key=dedup_key,
                reason=reason,
                handling=handling,
                queue_id=queue_id,
                key_source=key_source,
            )

        return [entry.event for entry in self._entries]


def apply_stream_dedup(
    events: list[dict[str, Any]],
    *,
    stream_config: dict[str, Any] | None,
    stream_id: int,
    db: Session | None = None,
    checkpoint: dict[str, Any] | None = None,
    checkpoint_updated_at: datetime | None = None,
    dry_run: bool = False,
    apply_dedup: bool = True,
    log_fn: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[list[dict[str, Any]], DedupSummary | None]:
    """Apply dedup at queue-insert time. Returns filtered events and optional summary."""

    config = parse_dedup_config(stream_config)
    if not apply_dedup or not config.enabled or not events:
        return events, None

    if db is None and config.scope != "current_run":
        from app.runners.stream_runner_db import run_with_db

        seed_keys = run_with_db(
            lambda session: load_dedup_seed_keys(
                session,
                stream_id=stream_id,
                config=config,
                checkpoint=checkpoint,
                checkpoint_updated_at=checkpoint_updated_at,
            ),
            commit=False,
        )
    else:
        seed_keys = load_dedup_seed_keys(
            db,
            stream_id=stream_id,
            config=config,
            checkpoint=checkpoint,
            checkpoint_updated_at=checkpoint_updated_at,
        )
    queue = StreamDedupQueue(config=config, seed_keys=seed_keys, log_fn=log_fn)
    filtered = queue.ingest([e for e in events if isinstance(e, dict)])
    return filtered, queue.summary


def propagate_dedup_metadata(raw_event: dict[str, Any], enriched_event: dict[str, Any]) -> None:
    """Copy internal dedup metadata from raw extracted event to transformed event."""

    for key in (GDC_DEDUP_KEY_META, GDC_DEDUP_QUEUE_ID_META):
        if key in raw_event and key not in enriched_event:
            enriched_event[key] = raw_event[key]


def extract_delivered_dedup_entries(events: list[dict[str, Any]]) -> list[tuple[str, int | None]]:
    entries: list[tuple[str, int | None]] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        dedup_key = event.get(GDC_DEDUP_KEY_META)
        if not isinstance(dedup_key, str) or not dedup_key.strip():
            continue
        queue_id_raw = event.get(GDC_DEDUP_QUEUE_ID_META)
        queue_id = int(queue_id_raw) if isinstance(queue_id_raw, int) else None
        entries.append((dedup_key.strip(), queue_id))
    return entries


def _log_registry_debug(
    *,
    log_fn: Callable[[dict[str, Any]], None] | None,
    payload: dict[str, Any],
) -> None:
    logger.debug("%s", payload)
    if log_fn is not None:
        log_fn({**payload, "level": "DEBUG"})


def record_dedup_registry_after_delivery(
    *,
    stream_id: int,
    successful_events: list[dict[str, Any]],
    summary: DedupSummary | None,
    destination: str | None,
    dry_run: bool,
    log_fn: Callable[[dict[str, Any]], None] | None = None,
) -> DedupSummary | None:
    """Record dedup registry only after destination delivery success."""

    if summary is None:
        return None

    pending_entries = extract_delivered_dedup_entries(successful_events)
    if not pending_entries and summary.inserted_keys:
        pending_entries = [(key, None) for key in summary.inserted_keys]

    if dry_run:
        summary.registry_recorded = 0
        summary.registry_skipped = len(pending_entries)
        summary.registry_record_stage = None
        for dedup_key, queue_id in pending_entries:
            _log_registry_debug(
                log_fn=log_fn,
                payload={
                    "stage": "dedup_registry_skip",
                    "stream_id": stream_id,
                    "dedup_key": dedup_key,
                    "queue_id": queue_id,
                    "reason": "dry_run",
                    "delivery_success": False,
                    "registry_recorded": False,
                },
            )
        return summary

    if not successful_events:
        summary.registry_recorded = 0
        summary.registry_skipped = len(pending_entries)
        summary.registry_record_stage = None
        if pending_entries:
            for dedup_key, queue_id in pending_entries:
                _log_registry_debug(
                    log_fn=log_fn,
                    payload={
                        "stage": "dedup_registry_skip",
                        "stream_id": stream_id,
                        "dedup_key": dedup_key,
                        "queue_id": queue_id,
                        "reason": "delivery_failed",
                        "delivery_success": False,
                        "registry_recorded": False,
                    },
                )
        else:
            _log_registry_debug(
                log_fn=log_fn,
                payload={
                    "stage": "dedup_registry_skip",
                    "stream_id": stream_id,
                    "reason": "delivery_failed",
                    "delivery_success": False,
                    "registry_recorded": False,
                },
            )
        return summary

    delivered = extract_delivered_dedup_entries(successful_events)
    if not delivered:
        summary.registry_recorded = 0
        summary.registry_skipped = len(summary.inserted_keys)
        summary.registry_record_stage = None
        return summary

    dedup_keys = [key for key, _ in delivered]
    summary.registry_recorded = len(dedup_keys)
    summary.registry_skipped = 0
    summary.registry_record_stage = REGISTRY_RECORD_STAGE

    for dedup_key, queue_id in delivered:
        _log_registry_debug(
            log_fn=log_fn,
            payload={
                "stage": "dedup_registry_record",
                "stream_id": stream_id,
                "dedup_key": dedup_key,
                "queue_id": queue_id,
                "destination": destination,
                "delivery_success": True,
                "registry_recorded": True,
            },
        )

    registry_payload = build_dedup_registry_log_payload(summary, dedup_keys=dedup_keys)
    registry_payload["stream_id"] = stream_id
    if log_fn is not None:
        log_fn(registry_payload)
    return summary


def record_dedup_registry_for_route_success(
    *,
    stream_id: int,
    route_events: list[dict[str, Any]],
    summary: DedupSummary,
    destination: str | None,
    destination_id: int | None = None,
    route_id: int | None = None,
    log_fn: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    """Record dedup registry for one successful route/destination delivery."""

    delivered = extract_delivered_dedup_entries(route_events)
    # Route transform may drop internal meta keys; fall back to keys inserted this run.
    if not delivered and summary.inserted_keys:
        delivered = [(key, None) for key in summary.inserted_keys]
    if not delivered:
        return

    dedup_keys = [key for key, _ in delivered]
    summary.recorded_registry_keys.update(dedup_keys)
    summary.registry_recorded = len(summary.recorded_registry_keys)
    summary.registry_record_stage = REGISTRY_RECORD_STAGE
    summary.registry_skipped = max(0, len(summary.inserted_keys) - summary.registry_recorded)

    for dedup_key, queue_id in delivered:
        _log_registry_debug(
            log_fn=log_fn,
            payload={
                "stage": "dedup_registry_record",
                "stream_id": stream_id,
                "route_id": route_id,
                "destination_id": destination_id,
                "dedup_key": dedup_key,
                "queue_id": queue_id,
                "destination": destination,
                "delivery_success": True,
                "registry_recorded": True,
            },
        )

    registry_payload = build_dedup_registry_log_payload(summary, dedup_keys=dedup_keys)
    registry_payload["stream_id"] = stream_id
    if route_id is not None:
        registry_payload["route_id"] = route_id
    if destination_id is not None:
        registry_payload["destination_id"] = destination_id
    if log_fn is not None:
        log_fn(registry_payload)


def finalize_dedup_registry_summary(
    *,
    stream_id: int,
    successful_events: list[dict[str, Any]],
    summary: DedupSummary | None,
    dry_run: bool,
    log_fn: Callable[[dict[str, Any]], None] | None = None,
) -> DedupSummary | None:
    """Emit skip debug logs at run end; route successes record registry incrementally."""

    if summary is None:
        return None

    pending_entries = extract_delivered_dedup_entries(successful_events)
    if not pending_entries and summary.inserted_keys:
        pending_entries = [(key, None) for key in summary.inserted_keys]

    if dry_run:
        summary.registry_recorded = 0
        summary.registry_skipped = len(pending_entries)
        summary.registry_record_stage = None
        for dedup_key, queue_id in pending_entries:
            _log_registry_debug(
                log_fn=log_fn,
                payload={
                    "stage": "dedup_registry_skip",
                    "stream_id": stream_id,
                    "dedup_key": dedup_key,
                    "queue_id": queue_id,
                    "reason": "dry_run",
                    "delivery_success": False,
                    "registry_recorded": False,
                },
            )
        return summary

    if summary.registry_recorded == 0:
        summary.registry_skipped = len(pending_entries)
        summary.registry_record_stage = None
        for dedup_key, queue_id in pending_entries:
            _log_registry_debug(
                log_fn=log_fn,
                payload={
                    "stage": "dedup_registry_skip",
                    "stream_id": stream_id,
                    "dedup_key": dedup_key,
                    "queue_id": queue_id,
                    "reason": "delivery_failed",
                    "delivery_success": False,
                    "registry_recorded": False,
                },
            )
    else:
        summary.registry_skipped = max(0, len(summary.inserted_keys) - summary.registry_recorded)

    return summary


def build_dedup_registry_log_payload(
    summary: DedupSummary,
    *,
    dedup_keys: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "stage": DEDUP_REGISTRY_STAGE,
        "dedup_keys": list(dedup_keys if dedup_keys is not None else summary.inserted_keys),
        "dedup_summary": summary.to_dict(),
    }


def last_dedup_runtime_stats(db: Session, stream_id: int) -> dict[str, Any] | None:
    """Most recent dedup summary from dedup_queue_insert or dedup_registry logs.

    Scoped to the last 24h of ``delivery_logs`` and a short ``statement_timeout`` so
    large partitions degrade to ``{"degraded": True}`` instead of blocking configuration APIs.
    """

    since = datetime.now(timezone.utc) - _LAST_DEDUP_LOOKBACK
    rows: list[Any] = []
    try:
        db.execute(text(f"SET LOCAL statement_timeout = '{int(_LAST_DEDUP_STATEMENT_TIMEOUT_MS)}ms'"))
        rows = (
            db.query(DeliveryLog)
            .filter(
                DeliveryLog.stream_id == int(stream_id),
                DeliveryLog.stage.in_(("dedup_queue_insert", DEDUP_REGISTRY_STAGE, "run_complete")),
                DeliveryLog.created_at >= since,
            )
            .order_by(DeliveryLog.id.desc())
            .limit(50)
            .all()
        )
    except OperationalError:
        db.rollback()
        logger.warning(
            "last_dedup_runtime_stats_degraded",
            extra={"stage": "last_dedup_runtime_stats_degraded", "stream_id": int(stream_id)},
        )
        return {"degraded": True}
    finally:
        try:
            db.execute(text("SET LOCAL statement_timeout = '0'"))
        except OperationalError:
            db.rollback()

    for item in rows:
        payload = item.payload_sample if isinstance(item.payload_sample, dict) else {}
        recorded_at = None
        created = getattr(item, "created_at", None)
        if created is not None:
            try:
                recorded_at = created.isoformat()
            except Exception:
                recorded_at = str(created)

        if item.stage == "dedup_queue_insert":
            return {
                "total_events": payload.get("total_events"),
                "inserted": payload.get("inserted"),
                "duplicate_events": payload.get("duplicate_events"),
                "duplicate_by_event_id": payload.get("duplicate_by_event_id"),
                "duplicate_by_stellar_uuid": payload.get("duplicate_by_stellar_uuid"),
                "duplicate_by_custom_key": payload.get("duplicate_by_custom_key"),
                "duplicate_by_id": payload.get("duplicate_by_id"),
                "duplicate_handling": payload.get("duplicate_handling"),
                "dedup_scope": payload.get("dedup_scope"),
                "recorded_at": recorded_at,
                "degraded": False,
            }
        summary = payload.get("dedup_summary")
        if isinstance(summary, dict):
            out = dict(summary)
            out.setdefault("recorded_at", recorded_at)
            out["degraded"] = False
            return out
    return None
