"""Marketplace remote/private registry configuration (M29.9).

Revision ID: 20260826_0070_registries
Revises: 20260825_0069_pkg_trust
Create Date: 2026-08-26
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260826_0070_registries"
down_revision = "20260825_0069_pkg_trust"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "marketplace_registries",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("registry_type", sa.String(length=32), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enabled_for_browse", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("enabled_for_install", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("authentication_reference", sa.String(length=255), nullable=True),
        sa.Column("auth_secret_json", sa.JSON(), nullable=True),
        sa.Column("trusted_key_policy", sa.JSON(), nullable=True),
        sa.Column("network_policy", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_marketplace_registries_registry_type"),
        "marketplace_registries",
        ["registry_type"],
        unique=False,
    )
    op.create_index(
        op.f("ix_marketplace_registries_enabled"),
        "marketplace_registries",
        ["enabled"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_marketplace_registries_enabled"), table_name="marketplace_registries")
    op.drop_index(op.f("ix_marketplace_registries_registry_type"), table_name="marketplace_registries")
    op.drop_table("marketplace_registries")
