"""Append-only audit trail and monotonic config version markers (same-transaction helpers)."""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.audit.service import record_audit_log
from app.platform_admin.models import PlatformAuditEvent, PlatformConfigVersion

# Serialize monotonic version allocation across concurrent config mutations.
# Unlocked max(version)+1 races on platform_config_versions.version (UniqueViolation → HTTP 500).
_CONFIG_VERSION_ADVISORY_LOCK_KEY = "gdc:platform_config_versions.version"


def record_audit_event(
    db: Session,
    *,
    action: str,
    actor_username: str = "system",
    entity_type: str | None = None,
    entity_id: int | None = None,
    entity_name: str | None = None,
    details: dict[str, Any] | None = None,
    result: str = "success",
    actor_user_id: int | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    request: Any = None,
) -> None:
    meta = dict(details or {})
    if entity_name:
        meta["entity_name"] = entity_name
    record_audit_log(
        db,
        action=action,
        result=result,
        actor_user_id=actor_user_id,
        actor_username=actor_username,
        entity_type=entity_type,
        entity_id=entity_id,
        metadata=meta,
        ip_address=ip_address,
        user_agent=user_agent,
        request=request,
    )
    # Legacy admin UI still reads platform_audit_events until fully migrated.
    db.add(
        PlatformAuditEvent(
            actor_username=actor_username,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            details_json=dict(details or {}),
        )
    )
    db.flush()


def record_config_version(
    db: Session,
    *,
    entity_type: str,
    entity_id: int,
    entity_name: str | None = None,
    changed_by: str = "system",
    summary: str | None = None,
    snapshot_before: dict[str, Any] | None = None,
    snapshot_after: dict[str, Any] | None = None,
) -> int:
    bind = db.get_bind()
    if bind is not None and bind.dialect.name == "postgresql":
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
            {"lock_key": _CONFIG_VERSION_ADVISORY_LOCK_KEY},
        )
    cur = db.scalar(select(func.coalesce(func.max(PlatformConfigVersion.version), 0)))
    nxt = int(cur or 0) + 1
    db.add(
        PlatformConfigVersion(
            version=nxt,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            changed_by=changed_by,
            summary=summary,
            snapshot_before_json=copy.deepcopy(snapshot_before) if snapshot_before is not None else None,
            snapshot_after_json=copy.deepcopy(snapshot_after) if snapshot_after is not None else None,
        )
    )
    db.flush()
    return nxt
