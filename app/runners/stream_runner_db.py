"""Short-lived SQLAlchemy sessions for StreamRunner (avoid idle-in-transaction)."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Generator, TypeVar

from sqlalchemy import text
from sqlalchemy.orm import Session, object_session

from app.database import SessionLocal

T = TypeVar("T")


@dataclass
class ParkedCallerPending:
    """Caller-owned pending units parked so a txn can end without committing them."""

    new: list[Any] = field(default_factory=list)
    dirty: list[Any] = field(default_factory=list)
    deleted: list[Any] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.new or self.dirty or self.deleted)


@contextmanager
def short_db_session(*, commit: bool = False, read_only: bool | None = None) -> Generator[Session, None, None]:
    """Open a DB session, optionally commit on success, always close on exit."""

    use_read_only = read_only if read_only is not None else not commit
    db = SessionLocal()
    try:
        if use_read_only:
            db.execute(text("SET TRANSACTION READ ONLY"))
        yield db
        if commit:
            db.commit()
    except Exception:
        if db.in_transaction():
            db.rollback()
        raise
    finally:
        if db.in_transaction():
            db.rollback()
        db.close()


def run_with_db(fn: Callable[[Session], T], *, commit: bool = False) -> T:
    """Run ``fn(db)`` inside a short-lived session."""

    with short_db_session(commit=commit) as db:
        return fn(db)


def _expunge_if_present(db: Session, obj: Any) -> None:
    if obj is None:
        return
    try:
        if object_session(obj) is db:
            db.expunge(obj)
    except Exception:
        return


def expunge_runtime_orm_graph(db: Session, runtime_stream: Any, stream_arg: Any = None) -> None:
    """Detach loaded runtime ORM rows so ending the caller txn cannot force lazy-loads."""

    if not isinstance(db, Session) or not hasattr(db, "expunge"):
        return

    candidates: list[Any] = []
    if isinstance(runtime_stream, dict):
        for key in ("mapping_row", "enrichment_row", "source"):
            candidates.append(runtime_stream.get(key))
        for key in ("stream_protection_rules", "stream_classification_rules", "stream_policy_rules"):
            raw = runtime_stream.get(key)
            if isinstance(raw, list):
                candidates.extend(raw)
        for route in list(runtime_stream.get("routes") or []):
            if not isinstance(route, dict):
                continue
            for key in ("route_mapping_row", "route_enrichment_row"):
                candidates.append(route.get(key))
            for key in ("route_protection_rules", "route_classification_rules", "route_policy_rules"):
                raw = route.get(key)
                if isinstance(raw, list):
                    candidates.extend(raw)

    from app.runtime.stream_context import StreamContext

    if isinstance(stream_arg, StreamContext):
        candidates.extend([stream_arg.source, stream_arg.mapping, stream_arg.enrichment])
        dest_map = getattr(stream_arg, "destinations_by_route", None) or {}
        if isinstance(dest_map, dict):
            candidates.extend(dest_map.values())

    for obj in candidates:
        if isinstance(obj, list):
            for item in obj:
                _expunge_if_present(db, item)
        else:
            _expunge_if_present(db, obj)


def session_has_pending_changes(db: Session) -> bool:
    """True when the Session has uncommitted new/dirty/deleted state."""

    try:
        return bool(db.new or db.dirty or db.deleted)
    except Exception:
        return False


def park_caller_pending(db: Session) -> ParkedCallerPending | None:
    """Detach pending units so ending the transaction cannot commit or discard caller intent.

    Objects keep their in-memory attribute values after expunge. Caller must
    ``restore_parked_caller_pending`` after destination I/O (not before).
    """

    if not isinstance(db, Session):
        return None
    deleted = list(db.deleted)
    dirty = [obj for obj in list(db.dirty) if obj not in db.deleted]
    new = list(db.new)
    if not (deleted or dirty or new):
        return None
    for obj in deleted + dirty + new:
        _expunge_if_present(db, obj)
    return ParkedCallerPending(new=new, dirty=dirty, deleted=deleted)


def restore_parked_caller_pending(db: Session | None, parked: ParkedCallerPending | None) -> None:
    """Re-attach parked pending units onto the caller Session (still uncommitted)."""

    if db is None or not isinstance(db, Session) or not parked:
        return
    for obj in parked.new:
        try:
            db.add(obj)
        except Exception:
            continue
    for obj in parked.dirty:
        try:
            db.add(obj)
        except Exception:
            continue
    for obj in parked.deleted:
        try:
            db.delete(obj)
        except Exception:
            continue


def merge_parked_caller_pending(
    existing: ParkedCallerPending | None,
    incoming: ParkedCallerPending | None,
) -> ParkedCallerPending | None:
    if not existing:
        return incoming
    if not incoming:
        return existing
    return ParkedCallerPending(
        new=[*existing.new, *incoming.new],
        dirty=[*existing.dirty, *incoming.dirty],
        deleted=[*existing.deleted, *incoming.deleted],
    )


def release_caller_transaction(
    db: Session | None,
    *,
    runtime_stream: Any = None,
    stream_arg: Any = None,
    end_with: str = "rollback",
) -> ParkedCallerPending | None:
    """End an open caller transaction without committing caller-owned pending work.

    Used so destination network I/O does not run while a request session is
    idle-in-transaction. Does not close or replace the caller-owned Session.

    Pending new/dirty/deleted units are parked and returned for restore after I/O.
    The open transaction is always ended with ``rollback`` — never ``commit`` —
    so unrelated caller changes cannot be auto-committed. ``end_with`` is retained
    for call-site compatibility and ignored for commit semantics.
    """

    _ = end_with
    if db is None or not isinstance(db, Session):
        return None
    in_txn = getattr(db, "in_transaction", None)
    try:
        active = bool(in_txn()) if callable(in_txn) else False
    except Exception:
        active = False
    if not active:
        return None
    # Park caller pending before runtime-graph expunge so dirty caller-owned
    # rows that also appear in the loaded graph are not dropped without restore.
    parked = park_caller_pending(db)
    if runtime_stream is not None or stream_arg is not None:
        expunge_runtime_orm_graph(db, runtime_stream, stream_arg)
    try:
        still_active = bool(in_txn()) if callable(in_txn) else False
    except Exception:
        still_active = False
    if still_active and hasattr(db, "rollback"):
        try:
            db.rollback()
        except Exception:
            return parked
    return parked
