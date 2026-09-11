"""Marketplace package install lifecycle table (M29.3).

Revision ID: 20260825_0067_marketplace_pkg
Revises: 20260824_0066_oauth_states
Create Date: 2026-08-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260825_0067_marketplace_pkg"
down_revision = "20260824_0066_oauth_states"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "marketplace_package_installs",
        sa.Column("package_id", sa.String(length=255), nullable=False),
        sa.Column("package_kind", sa.String(length=64), nullable=False),
        sa.Column("pack_version", sa.String(length=128), nullable=False),
        sa.Column("origin", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("digest", sa.String(length=128), nullable=False),
        sa.Column("installed_path", sa.Text(), nullable=False),
        sa.Column("previous_version", sa.String(length=128), nullable=True),
        sa.Column("previous_digest", sa.String(length=128), nullable=True),
        sa.Column("installed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("package_id"),
    )
    op.create_index(
        op.f("ix_marketplace_package_installs_status"),
        "marketplace_package_installs",
        ["status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_marketplace_package_installs_status"),
        table_name="marketplace_package_installs",
    )
    op.drop_table("marketplace_package_installs")
