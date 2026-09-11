"""Connector registry generation singleton (M29.4).

Revision ID: 20260825_0068_registry_gen
Revises: 20260825_0067_marketplace_pkg
Create Date: 2026-08-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260825_0068_registry_gen"
down_revision = "20260825_0067_marketplace_pkg"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "connector_registry_version",
        sa.Column("id", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("generation", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("id = 1", name="ck_connector_registry_version_singleton"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(
        sa.text(
            "INSERT INTO connector_registry_version (id, generation) VALUES (1, 0)"
        )
    )


def downgrade() -> None:
    op.drop_table("connector_registry_version")
