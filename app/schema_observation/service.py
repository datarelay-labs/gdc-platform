"""Record and read per-Stream observed schema from extracted events."""

from __future__ import annotations

import logging
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.schema_observation.drift_detection import (
    detect_field_changes,
    ensure_pending_add_tracking,
    maybe_establish_baseline,
    schema_drift_detection_enabled,
    update_path_presence_streaks,
    update_type_change_streaks,
)
from app.schema_observation.models import StreamObservedSchema
from app.schema_observation.path_walker import collect_paths_from_events, merge_inferred_types

logger = logging.getLogger(__name__)


def schema_observation_enabled() -> bool:
    return bool(settings.GDC_SCHEMA_OBSERVATION_ENABLED)


def _paths_from_row(paths_json: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    raw = paths_json if isinstance(paths_json, dict) else {}
    paths = raw.get("paths")
    if not isinstance(paths, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for path, meta in paths.items():
        if not isinstance(path, str) or not isinstance(meta, dict):
            continue
        typ = meta.get("type")
        if isinstance(typ, str):
            out[path] = {
                "type": typ,
                "observation_count": int(meta.get("observation_count") or 0),
                "runs_since_seen": int(meta.get("runs_since_seen") or 0),
                "add_confirm_runs": int(meta.get("add_confirm_runs") or 0),
                "type_change_confirm_runs": int(meta.get("type_change_confirm_runs") or 0),
            }
    return out


def _serialize_paths(paths: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {"paths": deepcopy(paths)}


def merge_path_inventories(
    existing: dict[str, dict[str, Any]],
    batch_paths: dict[str, str],
    *,
    events_in_batch: int,
) -> dict[str, dict[str, Any]]:
    merged = deepcopy(existing)
    for path, typ in batch_paths.items():
        entry = merged.get(path)
        if entry is None:
            merged[path] = {
                "type": typ,
                "observation_count": events_in_batch,
                "runs_since_seen": 0,
                "add_confirm_runs": 0,
                "type_change_confirm_runs": 0,
            }
        else:
            entry["type"] = merge_inferred_types(str(entry.get("type")), typ)
            entry["observation_count"] = int(entry.get("observation_count") or 0) + events_in_batch
    return merged


def observe_extracted_events(
    db: Session,
    stream_id: int,
    events: list[Any],
) -> None:
    """Merge schema paths from extracted events into the Stream observed schema store.

    Non-blocking: callers should catch exceptions. No-op when disabled or events empty.
    """

    if not schema_observation_enabled() or not events:
        return

    max_events = max(1, int(settings.GDC_SCHEMA_OBSERVATION_MAX_EVENTS_PER_RUN))
    max_paths = max(100, int(settings.GDC_SCHEMA_OBSERVATION_MAX_PATHS))
    max_depth = max(4, int(settings.GDC_SCHEMA_OBSERVATION_MAX_DEPTH))

    sample = [ev for ev in events if isinstance(ev, dict)][:max_events]
    if not sample:
        return

    batch_paths = collect_paths_from_events(
        sample,
        max_depth=max_depth,
        max_paths=max_paths,
        max_events=max_events,
    )
    if not batch_paths:
        return

    now = datetime.now(timezone.utc)
    row = db.get(StreamObservedSchema, stream_id)
    if row is None:
        initial_paths = {
            p: {
                "type": t,
                "observation_count": len(sample),
                "runs_since_seen": 0,
                "add_confirm_runs": 1,
                "type_change_confirm_runs": 0,
            }
            for p, t in batch_paths.items()
        }
        row = StreamObservedSchema(
            stream_id=stream_id,
            paths_json=_serialize_paths(initial_paths),
            total_events_observed=len(sample),
            observation_run_count=1,
            last_observation_at=now,
        )
        db.add(row)
        _finalize_observation_row(db, stream_id=stream_id, row=row, merged_paths=initial_paths, batch_paths=batch_paths)
        return

    existing_paths = _paths_from_row(row.paths_json)
    merged_paths = merge_path_inventories(existing_paths, batch_paths, events_in_batch=len(sample))
    row.paths_json = _serialize_paths(merged_paths)
    row.total_events_observed = int(row.total_events_observed or 0) + len(sample)
    row.observation_run_count = int(row.observation_run_count or 0) + 1
    row.last_observation_at = now
    row.updated_at = now
    _finalize_observation_row(db, stream_id=stream_id, row=row, merged_paths=merged_paths, batch_paths=batch_paths)


def _load_stream_union_schema(db: Session, stream_id: int) -> Any | None:
    from app.streams.models import Stream

    stream = db.get(Stream, stream_id)
    if stream is None:
        return None
    config = stream.config_json if isinstance(stream.config_json, dict) else None
    if not isinstance(config, dict):
        return None
    return config.get("union_schema")


def _finalize_observation_row(
    db: Session,
    *,
    stream_id: int,
    row: StreamObservedSchema,
    merged_paths: dict[str, dict[str, Any]],
    batch_paths: dict[str, str],
) -> None:
    if not schema_drift_detection_enabled():
        return

    update_path_presence_streaks(merged_paths, batch_paths)
    union_schema = _load_stream_union_schema(db, stream_id) if row.baseline_paths_json is None else None
    established = maybe_establish_baseline(row, merged_paths, union_schema=union_schema)
    baseline_raw = row.baseline_paths_json if isinstance(row.baseline_paths_json, dict) else {}
    baseline_paths = baseline_raw.get("paths") if isinstance(baseline_raw.get("paths"), dict) else {}
    if established and baseline_paths:
        # Same-run Union Schema baseline: treat non-baseline batch paths as first Observed only.
        for path, entry in merged_paths.items():
            if path in baseline_paths:
                continue
            entry["add_confirm_runs"] = 1 if path in batch_paths else 0
            entry["type_change_confirm_runs"] = 0
            entry.pop("type_change_last_batch_type", None)
    ensure_pending_add_tracking(merged_paths, baseline_paths, batch_paths)
    update_type_change_streaks(merged_paths, baseline_paths, batch_paths)
    row.paths_json = _serialize_paths(merged_paths)
    try:
        detect_field_changes(
            db,
            stream_id=stream_id,
            row=row,
            observed_paths=merged_paths,
            batch_paths=batch_paths,
        )
    except Exception:
        logger.exception("schema_drift_detection_failed stream_id=%s", stream_id)


def get_observed_schema_row(db: Session, stream_id: int) -> StreamObservedSchema | None:
    return db.get(StreamObservedSchema, stream_id)


def get_field_drifts_for_stream(
    db: Session,
    stream_id: int,
    *,
    status_filter: str | None = None,
) -> dict[str, Any]:
    from app.schema_observation.operator_workflow import (
        get_field_drifts_read_payload,
        normalize_status_filter,
    )

    return get_field_drifts_read_payload(
        db,
        stream_id,
        status_filter=normalize_status_filter(status_filter),
    )


def build_observed_schema_read_model(
    *,
    stream_id: int,
    row: StreamObservedSchema | None,
) -> dict[str, Any]:
    paths_map = _paths_from_row(row.paths_json if row is not None else None)
    entries = [
        {"path": path, "type": meta["type"], "observation_count": meta.get("observation_count", 0)}
        for path, meta in sorted(paths_map.items(), key=lambda item: item[0])
    ]
    return {
        "stream_id": stream_id,
        "observation_enabled": schema_observation_enabled(),
        "paths": entries,
        "path_count": len(entries),
        "total_events_observed": int(row.total_events_observed) if row is not None else 0,
        "observation_run_count": int(row.observation_run_count) if row is not None else 0,
        "last_observation_at": row.last_observation_at if row is not None else None,
        "updated_at": row.updated_at if row is not None else None,
    }
