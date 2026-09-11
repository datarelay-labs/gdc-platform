"""Stream-scoped replay events (protected delivery payload snapshots)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

REPLAY_STATUS_PENDING = "pending"
REPLAY_STATUS_IN_PROGRESS = "in_progress"
REPLAY_STATUS_REPLAYED = "replayed"
REPLAY_STATUS_FAILED = "failed"
REPLAY_STATUS_DISCARDED = "discarded"

REPLAY_STATUSES = frozenset(
    {
        REPLAY_STATUS_PENDING,
        REPLAY_STATUS_IN_PROGRESS,
        REPLAY_STATUS_REPLAYED,
        REPLAY_STATUS_FAILED,
        REPLAY_STATUS_DISCARDED,
    }
)

REPLAY_TERMINAL_STATUSES = frozenset({REPLAY_STATUS_REPLAYED, REPLAY_STATUS_DISCARDED})

DELIVERY_KIND_BASE_ROUTE = "base_route"
DELIVERY_KIND_FAILOVER_SECONDARY = "failover_secondary"
DELIVERY_KIND_DYNAMIC_ROUTE = "dynamic_route"

DELIVERY_KINDS = frozenset(
    {
        DELIVERY_KIND_BASE_ROUTE,
        DELIVERY_KIND_FAILOVER_SECONDARY,
        DELIVERY_KIND_DYNAMIC_ROUTE,
    }
)


class StreamReplayEvent(Base):
    __tablename__ = "stream_replay_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("streams.id", ondelete="CASCADE"), nullable=False)
    destination_id: Mapped[int] = mapped_column(ForeignKey("destinations.id", ondelete="RESTRICT"), nullable=False)
    route_id: Mapped[int | None] = mapped_column(ForeignKey("routes.id", ondelete="SET NULL"), nullable=True)
    dynamic_route_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failover_route_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    delivery_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=REPLAY_STATUS_PENDING)
    protected_payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    delivery_context_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    error_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_replay_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
