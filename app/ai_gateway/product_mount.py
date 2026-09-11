"""Optional AI Gateway HTTP surface.

Data Relay OSS does not mount these routers on the product FastAPI app.
Historical AI Gateway tests may call ``mount_ai_gateway_apis`` on an isolated app.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.ai_audit.router import router as ai_audit_router
from app.ai_gateway.router import router as ai_gateway_router
from app.ai_governance.router import router as ai_governance_router
from app.ai_policy.router import router as ai_policy_router
from app.ai_providers.router import router as ai_providers_router
from app.ai_streams.router import router as ai_streams_router
from app.config import settings
from app.ingest.ai_router import router as ai_ingest_router

AI_GATEWAY_API_PATH_MARKERS = (
    "/ai-providers",
    "/ai-streams",
    "/ai-policy-rules",
    "/ai-audit-events",
    "/ai-governance",
    "/ai-gateway",
    "/ingest/ai/",
)


def mount_ai_gateway_apis(application: FastAPI, *, api_prefix: str | None = None) -> None:
    """Attach AI Gateway operator and ingest routes to ``application``."""

    prefix = api_prefix if api_prefix is not None else settings.API_PREFIX
    application.include_router(ai_providers_router, prefix=f"{prefix}/ai-providers", tags=["ai-providers"])
    application.include_router(ai_streams_router, prefix=f"{prefix}/ai-streams", tags=["ai-streams"])
    application.include_router(ai_policy_router, prefix=f"{prefix}/ai-policy-rules", tags=["ai-policy-rules"])
    application.include_router(ai_audit_router, prefix=f"{prefix}/ai-audit-events", tags=["ai-audit-events"])
    application.include_router(ai_governance_router, prefix=f"{prefix}/ai-governance", tags=["ai-governance"])
    application.include_router(ai_gateway_router, prefix=f"{prefix}/ai-gateway", tags=["ai-gateway"])
    application.include_router(ai_ingest_router, prefix=f"{prefix}/ingest", tags=["ingest"])
