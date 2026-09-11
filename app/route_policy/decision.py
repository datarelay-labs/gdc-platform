"""Route policy decision merge — precedence quarantine > block > require_review > audit > allow."""

from __future__ import annotations

from app.protection.models import (
    POLICY_ACTION_AUDIT_ONLY,
    POLICY_ACTION_BLOCK,
    POLICY_ACTION_QUARANTINE,
    POLICY_ACTION_REQUIRE_REVIEW,
)
from app.protection.policy_engine import PolicyBatchResult
from app.quarantine.policy_integration import matched_quarantine_evaluations
from app.route_policy.config import PolicyDecision, RoutePolicyConfig


_DECISION_PRECEDENCE: dict[PolicyDecision, int] = {
    "allow": 1,
    "audit": 2,
    "require_review": 3,
    "block": 4,
    "quarantine": 5,
}


def _pick_strongest(candidates: list[PolicyDecision]) -> PolicyDecision:
    if not candidates:
        return "allow"
    return max(candidates, key=lambda item: _DECISION_PRECEDENCE.get(item, 0))


def merge_route_policy_decision(
    policy_batch_result: PolicyBatchResult,
    config: RoutePolicyConfig,
) -> tuple[PolicyDecision, str]:
    """Merge engine result, governance override, and shared drift signals."""

    candidates: list[PolicyDecision] = ["allow"]
    reasons: list[str] = []

    if matched_quarantine_evaluations(policy_batch_result):
        candidates.append("quarantine")
        reasons.append("matched_policy_quarantine")

    audit_matches = [
        item
        for item in policy_batch_result.evaluations
        if item.matched and str(item.action_type) == POLICY_ACTION_AUDIT_ONLY
    ]
    if audit_matches:
        candidates.append("audit")
        reasons.append("matched_policy_audit")

    block_matches = [
        item
        for item in policy_batch_result.evaluations
        if item.matched and str(item.action_type) == POLICY_ACTION_BLOCK
    ]
    if block_matches:
        candidates.append("block")
        reasons.append("matched_policy_block")

    review_matches = [
        item
        for item in policy_batch_result.evaluations
        if item.matched and str(item.action_type) == POLICY_ACTION_REQUIRE_REVIEW
    ]
    if review_matches:
        candidates.append("require_review")
        reasons.append("matched_policy_require_review")

    override = config.override_delivery_behavior
    if override == "block":
        candidates.append("block")
        reasons.append("delivery_behavior_block")
    elif override == "quarantine":
        candidates.append("quarantine")
        reasons.append("delivery_behavior_quarantine")
    elif override == "require_review":
        candidates.append("require_review")
        reasons.append("delivery_behavior_require_review")

    if config.resolution.drift_quarantine_required:
        candidates.append("quarantine")
        reasons.append("schema_drift_quarantine")
    if config.resolution.drift_review_required:
        candidates.append("require_review")
        reasons.append("schema_drift_require_review")

    decision = _pick_strongest(candidates)
    if not reasons:
        reasons.append("default_allow")
    return decision, ";".join(reasons)


def delivery_allowed_for_decision(decision: PolicyDecision) -> bool:
    return decision in ("allow", "audit")
