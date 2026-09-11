"""Isolated FastAPI app for historical AI Gateway HTTP tests.

Do not mount these routes on ``app.main.app`` (OSS product surface).
"""

from __future__ import annotations

from fastapi import FastAPI

from app.ai_gateway.product_mount import mount_ai_gateway_apis
from app.auth.role_guard import role_guard_middleware


def build_ai_gateway_test_app() -> FastAPI:
    application = FastAPI()
    application.middleware("http")(role_guard_middleware)
    mount_ai_gateway_apis(application)
    return application
