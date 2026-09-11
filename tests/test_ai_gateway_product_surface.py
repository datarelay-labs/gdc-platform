"""Current product API must not expose AI Gateway operator or proxy ingest routes."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.ai_gateway.product_mount import AI_GATEWAY_API_PATH_MARKERS
from app.main import app


def _route_paths() -> list[str]:
    paths: list[str] = []
    for route in app.routes:
        path = getattr(route, "path", "") or ""
        if path:
            paths.append(path)
    return paths


def test_product_app_does_not_register_ai_gateway_routes() -> None:
    joined = " ".join(_route_paths())
    for marker in AI_GATEWAY_API_PATH_MARKERS:
        assert marker not in joined, f"product app still exposes {marker}"


def test_product_app_returns_404_for_ai_gateway_endpoints() -> None:
    client = TestClient(app)
    for path in (
        "/api/v1/ai-gateway/summary",
        "/api/v1/ai-providers/",
        "/api/v1/ai-streams/",
        "/api/v1/ai-policy-rules/",
        "/api/v1/ai-audit-events/",
        "/api/v1/ai-governance/dashboard/summary",
        "/api/v1/ingest/ai/example/v1/chat/completions",
    ):
        method = "post" if path.endswith("completions") else "get"
        resp = getattr(client, method)(path)
        assert resp.status_code in {404, 405}, f"{path} returned {resp.status_code}"
