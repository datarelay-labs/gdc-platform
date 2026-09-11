"""Route policy config resolution — dual-read + governance delivery_behavior (M13.5)."""

from __future__ import annotations

from typing import Any

from app.route_policy.config import (
    PersistedSource,
    RoutePolicyConfig,
    RoutePolicyResolution,
    RoutePolicyRuleEntry,
)
from app.route_policy.drift_gates import derive_drift_gates
from app.route_policy.governance_behavior import (
    normalize_delivery_behavior,
    resolve_effective_delivery_behavior,
)


def _rule_entry_from_row(row: Any, *, source: PersistedSource) -> RoutePolicyRuleEntry:
    return RoutePolicyRuleEntry(
        name=str(getattr(row, "name", "")),
        condition_json=dict(getattr(row, "condition_json", {}) or {}),
        action_type=str(getattr(row, "action_type", "audit_only")),
        enabled=bool(getattr(row, "enabled", True)),
        source=source,  # type: ignore[arg-type]
        id=int(row.id) if getattr(row, "id", None) is not None else None,
    )


def _extract_delivery_behavior(
    route_overrides: list[dict[str, Any]] | None,
    *,
    route_id: int,
    governance_rules: list[dict[str, Any]] | None = None,
) -> str | None:
    """Effective delivery_behavior: route override, else stream default."""

    return resolve_effective_delivery_behavior(
        route_id=route_id,
        route_overrides=route_overrides,
        governance_rules=governance_rules,
    )


def _count_delivery_behavior_overrides(
    route_overrides: list[dict[str, Any]] | None,
    *,
    route_id: int,
) -> int:
    count = 0
    for override in route_overrides or []:
        if int(override.get("route_id", -1)) != int(route_id):
            continue
        if not bool(override.get("enabled", True)):
            continue
        if normalize_delivery_behavior(override.get("delivery_behavior")) is not None:
            count += 1
    return count


def _policy_condition_key(row: Any) -> tuple[str, str]:
    raw = getattr(row, "condition_json", {}) or {}
    cond = raw if isinstance(raw, dict) else {}
    level = str(cond.get("classification_level") or "").strip().upper()
    sensitivity = str(cond.get("sensitivity_class") or "").strip().lower()
    return (level, sensitivity)


def _merge_stream_and_route_policy_rules(
    stream_rules: list[Any],
    route_rules: list[Any],
) -> tuple[list[RoutePolicyRuleEntry], PersistedSource]:
    """Route rules overlay matching stream conditions; unmatched stream rules stay inherited."""

    if not route_rules and not stream_rules:
        return [], "empty"
    if not route_rules:
        return [_rule_entry_from_row(row, source="stream") for row in stream_rules], "stream"
    if not stream_rules:
        return [_rule_entry_from_row(row, source="route") for row in route_rules], "route"

    overlay = {_policy_condition_key(row): row for row in route_rules}
    merged: list[RoutePolicyRuleEntry] = []
    used_keys: set[tuple[str, str]] = set()
    for stream_row in stream_rules:
        key = _policy_condition_key(stream_row)
        route_row = overlay.get(key)
        if route_row is not None:
            merged.append(_rule_entry_from_row(route_row, source="route"))
            used_keys.add(key)
        else:
            merged.append(_rule_entry_from_row(stream_row, source="stream"))
    for route_row in route_rules:
        key = _policy_condition_key(route_row)
        if key not in used_keys:
            merged.append(_rule_entry_from_row(route_row, source="route"))
    return merged, "route"


def resolve_route_policy_config(
    *,
    route_id: int,
    stream_id: int,
    route_policy_rules: list[Any] | None = None,
    stream_policy_rules: list[Any] | None = None,
    route_overrides: list[dict[str, Any]] | None = None,
    governance_rules: list[dict[str, Any]] | None = None,
    schema_drift_policy_result: Any | None = None,
) -> RoutePolicyConfig:
    """Dual-read persisted base; drift gates + delivery_behavior resolved at stage."""

    _ = stream_id
    route_rules = [r for r in (route_policy_rules or []) if bool(getattr(r, "enabled", True))]
    stream_rules = [r for r in (stream_policy_rules or []) if bool(getattr(r, "enabled", True))]
    persisted, persisted_source = _merge_stream_and_route_policy_rules(stream_rules, route_rules)

    override_delivery_behavior = _extract_delivery_behavior(
        route_overrides,
        route_id=route_id,
        governance_rules=governance_rules,
    )
    drift_review, drift_quarantine = derive_drift_gates(
        schema_drift_policy_result,
        route_id=route_id,
        route_overrides=route_overrides,
    )

    return RoutePolicyConfig(
        rules=tuple(persisted),
        override_delivery_behavior=override_delivery_behavior,
        resolution=RoutePolicyResolution(
            persisted_source=persisted_source,
            override_count=_count_delivery_behavior_overrides(route_overrides, route_id=route_id),
            fallback_used=persisted_source == "stream",
            drift_review_required=drift_review,
            drift_quarantine_required=drift_quarantine,
        ),
    )
