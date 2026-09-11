"""Credential OAuth2 authorization-code state table (one-time state + PKCE).

Revision ID: 20260824_0066_oauth_states
Revises: 20260823_0065_delivery_queue
Create Date: 2026-08-24
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260824_0066_oauth_states"
down_revision = "20260823_0065_delivery_queue"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "credential_oauth_states",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=128), nullable=False),
        sa.Column("credential_id", sa.Integer(), nullable=False),
        sa.Column("code_verifier", sa.String(length=128), nullable=True),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["credential_id"], ["credentials.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("state", name="uq_credential_oauth_states_state"),
    )
    op.create_index(op.f("ix_credential_oauth_states_id"), "credential_oauth_states", ["id"], unique=False)
    op.create_index(
        op.f("ix_credential_oauth_states_credential_id"),
        "credential_oauth_states",
        ["credential_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_credential_oauth_states_credential_id"), table_name="credential_oauth_states")
    op.drop_index(op.f("ix_credential_oauth_states_id"), table_name="credential_oauth_states")
    op.drop_table("credential_oauth_states")
