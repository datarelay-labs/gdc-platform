"""Pydantic schemas for dynamic routing APIs."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

SensitivityClass = Literal["secret", "pii", "security_metadata"]
ClassificationLevel = Literal["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]


class DynamicRouteConditionJson(BaseModel):
    sensitivity_class: SensitivityClass | None = None
    classification_level: ClassificationLevel | None = None

    @model_validator(mode="after")
    def _require_condition(self) -> DynamicRouteConditionJson:
        if self.sensitivity_class is None and self.classification_level is None:
            raise ValueError("sensitivity_class or classification_level is required")
        return self


class DynamicRouteItem(BaseModel):
    id: int
    stream_id: int
    name: str
    enabled: bool
    condition_json: dict[str, Any]
    route_id: int | None = None
    route_name: str | None = None
    destination_id: int
    destination_name: str | None = None
    created_at: datetime
    updated_at: datetime


class StreamDynamicRoutesResponse(BaseModel):
    stream_id: int
    routes: list[DynamicRouteItem]
    route_count: int


class DynamicRouteCreateRequest(BaseModel):
    name: str
    enabled: bool = True
    condition_json: DynamicRouteConditionJson
    route_id: int | None = None
    destination_id: int | None = None

    @model_validator(mode="after")
    def _require_binding(self) -> DynamicRouteCreateRequest:
        if self.route_id is None and self.destination_id is None:
            raise ValueError("route_id or destination_id is required")
        return self


class DynamicRoutePatchRequest(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    condition_json: DynamicRouteConditionJson | None = None
    route_id: int | None = None
    destination_id: int | None = None


class DynamicRouteResponse(BaseModel):
    route: DynamicRouteItem


class StreamDynamicRoutingSummaryResponse(BaseModel):
    stream_id: int
    total_dynamic_routes: int = 0
    matched_dynamic_routes: int = 0
    dynamic_deliveries: int = 0
    last_evaluated_at: datetime | None = None


class PlatformDynamicRoutingSummaryResponse(BaseModel):
    total_dynamic_routes: int = 0
    matched_dynamic_routes: int = 0
    dynamic_deliveries: int = 0
