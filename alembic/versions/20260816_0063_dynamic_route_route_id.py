"""Bind stream_dynamic_routes to existing routes.

Revision ID: 20260816_0063
Revises: 20260804_0062
Create Date: 2026-08-16
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260816_0063_dyn_route_id"
down_revision = "20260804_0062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "stream_dynamic_routes",
        sa.Column("route_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_stream_dynamic_routes_route_id",
        "stream_dynamic_routes",
        "routes",
        ["route_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_stream_dynamic_routes_route_id",
        "stream_dynamic_routes",
        ["route_id"],
    )
    op.execute(
        sa.text(
            """
            UPDATE stream_dynamic_routes AS dr
            SET route_id = uniq.route_id
            FROM (
                SELECT stream_id, destination_id, MIN(id) AS route_id
                FROM routes
                GROUP BY stream_id, destination_id
                HAVING COUNT(*) = 1
            ) AS uniq
            WHERE dr.stream_id = uniq.stream_id
              AND dr.destination_id = uniq.destination_id
              AND dr.route_id IS NULL
            """
        )
    )


def downgrade() -> None:
    op.drop_index("ix_stream_dynamic_routes_route_id", table_name="stream_dynamic_routes")
    op.drop_constraint("fk_stream_dynamic_routes_route_id", "stream_dynamic_routes", type_="foreignkey")
    op.drop_column("stream_dynamic_routes", "route_id")
