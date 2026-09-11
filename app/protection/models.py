"""Persistence for per-Stream protection rules."""

from __future__ import annotations

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, utcnow

POLICY_ACTION_AUDIT_ONLY = "audit_only"
POLICY_ACTION_QUARANTINE = "quarantine"
POLICY_ACTION_BLOCK = "block"
POLICY_ACTION_REQUIRE_REVIEW = "require_review"
POLICY_ACTION_TYPES = (
    POLICY_ACTION_AUDIT_ONLY,
    POLICY_ACTION_QUARANTINE,
    POLICY_ACTION_BLOCK,
    POLICY_ACTION_REQUIRE_REVIEW,
)

PROTECTION_MODE_FULL_MASK = "full_mask"
PROTECTION_MODE_PARTIAL_MASK = "partial_mask"
PROTECTION_MODE_HASH = "hash"
PROTECTION_MODE_TOKENIZATION = "tokenization"
PROTECTION_MODE_DROP_FIELD = "drop_field"

PROTECTION_MODES = (
    PROTECTION_MODE_FULL_MASK,
    PROTECTION_MODE_PARTIAL_MASK,
    PROTECTION_MODE_HASH,
    PROTECTION_MODE_TOKENIZATION,
    PROTECTION_MODE_DROP_FIELD,
)


class StreamProtectionRule(Base):
    """Enabled field-level mask rule for outbound delivery on a Stream."""

    __tablename__ = "stream_protection_rules"
    __table_args__ = (
        UniqueConstraint(
            "stream_id",
            "field_path",
            name="uq_stream_protection_rules_stream_path",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    stream_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("streams.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    field_path: Mapped[str] = mapped_column(Text, nullable=False)
    sensitivity_class: Mapped[str] = mapped_column(String(32), nullable=False)
    protection_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_finding_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("stream_sensitive_findings.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
    )


class IdentityVaultEntry(Base):
    """Reversible token mapping; stores hash only (never plaintext values)."""

    __tablename__ = "identity_vault_entries"
    __table_args__ = (
        UniqueConstraint(
            "stream_id",
            "field_path",
            "original_value_hash",
            name="uq_identity_vault_stream_path_hash",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    stream_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("streams.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    field_path: Mapped[str] = mapped_column(Text, nullable=False)
    original_value_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    token_value: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class StreamPolicyRule(Base):
    """Per-Stream policy rules evaluated after protection (M8; audit-only MVP)."""

    __tablename__ = "stream_policy_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    stream_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("streams.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    condition_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    action_type: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
    )
