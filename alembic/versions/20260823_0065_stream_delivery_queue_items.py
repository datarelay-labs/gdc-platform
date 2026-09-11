"""Phase 1: stream_delivery_queue_items table (Durable Delivery Queue DB foundation).

Revision ID: 20260823_0065_delivery_queue
Revises: 20260823_0064_credentials
Create Date: 2026-08-23
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260823_0065_delivery_queue"
down_revision = "20260823_0064_credentials"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "stream_delivery_queue_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("stream_id", sa.Integer(), nullable=False),
        sa.Column("route_id", sa.Integer(), nullable=False),
        sa.Column("destination_id", sa.Integer(), nullable=False),
        sa.Column("batch_id", sa.String(length=64), nullable=False),
        sa.Column("delivery_kind", sa.String(length=32), nullable=False),
        sa.Column("payload_json", JSONB(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="PENDING"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_owner", sa.String(length=128), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["stream_id"], ["streams.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["route_id"], ["routes.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["destination_id"], ["destinations.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_stream_delivery_queue_items_claim",
        "stream_delivery_queue_items",
        ["status", "available_at", "id"],
    )
    op.create_index(
        "ix_stream_delivery_queue_items_stream_status",
        "stream_delivery_queue_items",
        ["stream_id", "status"],
    )
    op.create_index(
        "ix_stream_delivery_queue_items_batch_id",
        "stream_delivery_queue_items",
        ["batch_id"],
    )
    op.create_index(
        "ix_stream_delivery_queue_items_route_status",
        "stream_delivery_queue_items",
        ["route_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_stream_delivery_queue_items_route_status", table_name="stream_delivery_queue_items")
    op.drop_index("ix_stream_delivery_queue_items_batch_id", table_name="stream_delivery_queue_items")
    op.drop_index("ix_stream_delivery_queue_items_stream_status", table_name="stream_delivery_queue_items")
    op.drop_index("ix_stream_delivery_queue_items_claim", table_name="stream_delivery_queue_items")
    op.drop_table("stream_delivery_queue_items")
