"""API schemas for Stream policy endpoints (M8)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

PolicyActionType = Literal["audit_only", "quarantine", "block", "require_review"]
PolicySensitivityClass = Literal["secret", "pii", "security_metadata"]
PolicyClassificationLevel = Literal["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]


class PolicyConditionJson(BaseModel):
    sensitivity_class: PolicySensitivityClass | None = None
    classification_level: PolicyClassificationLevel | None = None

    @model_validator(mode="after")
    def _require_condition(self) -> PolicyConditionJson:
        if self.sensitivity_class is None and self.classification_level is None:
            raise ValueError("sensitivity_class or classification_level is required")
        return self


class PolicyRuleEntry(BaseModel):
    id: int
    stream_id: int
    name: str
    enabled: bool
    condition_json: dict[str, Any]
    action_type: str
    created_at: datetime
    updated_at: datetime


class StreamPolicyRulesResponse(BaseModel):
    stream_id: int
    rules: list[PolicyRuleEntry] = Field(default_factory=list)
    rule_count: int = 0


class StreamPolicySummaryResponse(BaseModel):
    stream_id: int
    total_policies: int = 0
    matched_policies: int = 0
    audit_events: int = 0
    enabled_policy_count: int = 0
    disabled_policy_count: int = 0
    last_evaluated_at: datetime | None = None


class PolicyRuleCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True
    condition_json: PolicyConditionJson
    action_type: PolicyActionType = "audit_only"


class PolicyRulePatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None
    condition_json: PolicyConditionJson | None = None
    action_type: PolicyActionType | None = None


class PolicyRuleResponse(BaseModel):
    rule: PolicyRuleEntry


class MatchedPolicyPreviewItem(BaseModel):
    name: str
