"""Seed Schema Drift baseline from Stream Union Schema (design-time → confirmed baseline).

Union Schema (config_json) is the Source of Truth for the initial Stream baseline.
Baseline is established on Deploy/activation (start_stream), not on API Test alone.
Routes share one stream-level baseline — never destination/route-specific.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.schema_observation.drift_detection import _serialize_baseline
from app.schema_observation.models import StreamObservedSchema

logger = logging.getLogger(__name__)

# Align with frontend unionSchema / path_walker coarse types.
_ALLOWED_TYPES = frozenset(
    {"null", "boolean", "integer", "number", "string", "object", "array", "mixed"}
)


def normalize_union_schema_fields(union_schema: Any) -> list[dict[str, Any]]:
    """Accept wizard dict ``{fields: [...]}`` or legacy list of field entries."""

    if isinstance(union_schema, list):
        return [f for f in union_schema if isinstance(f, dict)]
    if isinstance(union_schema, dict):
        fields = union_schema.get("fields")
        if isinstance(fields, list):
            return [f for f in fields if isinstance(f, dict)]
    return []


def paths_from_union_schema(union_schema: Any) -> dict[str, dict[str, Any]]:
    """Convert Union Schema fields to baseline path inventory ``{path: {type}}``."""

    out: dict[str, dict[str, Any]] = {}
    for field in normalize_union_schema_fields(union_schema):
        path = field.get("field_path") or field.get("path")
        if not isinstance(path, str) or not path.strip():
            continue
        path = path.strip()
        raw_type = field.get("field_type") or field.get("type")
        if not isinstance(raw_type, str) or raw_type.strip() not in _ALLOWED_TYPES:
            continue
        out[path] = {"type": raw_type.strip()}
    return out


def union_schema_from_config(config_json: dict[str, Any] | None) -> Any:
    if not isinstance(config_json, dict):
        return None
    return config_json.get("union_schema")


def establish_baseline_from_union_schema(
    db: Session,
    stream_id: int,
    *,
    union_schema: Any = None,
    config_json: dict[str, Any] | None = None,
) -> bool:
    """Establish Stream baseline from Union Schema when no baseline exists yet.

    Returns True when baseline was newly established. Idempotent when baseline
    already present. No-op when Union Schema has no usable fields.
    """

    schema = union_schema if union_schema is not None else union_schema_from_config(config_json)
    paths = paths_from_union_schema(schema)
    if not paths:
        return False

    row = db.get(StreamObservedSchema, stream_id)
    if row is not None and row.baseline_paths_json is not None:
        return False

    now = datetime.now(timezone.utc)
    if row is None:
        row = StreamObservedSchema(
            stream_id=stream_id,
            paths_json={"paths": {}},
            total_events_observed=0,
            observation_run_count=0,
        )
        db.add(row)

    row.baseline_paths_json = _serialize_baseline(paths)
    row.baseline_established_at = now
    row.updated_at = now
    logger.info(
        "schema_baseline_established_from_union_schema stream_id=%s path_count=%s",
        stream_id,
        len(paths),
    )
    return True
