"""Connected Credential foundation: credentials table + sources.credential_id.

Revision ID: 20260823_0064_credentials
Revises: 20260816_0063_dyn_route_id
Create Date: 2026-08-23
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260823_0064_credentials"
down_revision = "20260816_0063_dyn_route_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "credentials",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("connector_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("auth_type", sa.String(length=64), nullable=False),
        sa.Column("auth_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False, server_default="CONNECTED"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["connector_id"], ["connectors.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_credentials_id"), "credentials", ["id"], unique=False)
    op.create_index(op.f("ix_credentials_connector_id"), "credentials", ["connector_id"], unique=False)

    op.add_column("sources", sa.Column("credential_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_sources_credential_id",
        "sources",
        "credentials",
        ["credential_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_sources_credential_id", "sources", ["credential_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_sources_credential_id", table_name="sources")
    op.drop_constraint("fk_sources_credential_id", "sources", type_="foreignkey")
    op.drop_column("sources", "credential_id")

    op.drop_index(op.f("ix_credentials_connector_id"), table_name="credentials")
    op.drop_index(op.f("ix_credentials_id"), table_name="credentials")
    op.drop_table("credentials")
