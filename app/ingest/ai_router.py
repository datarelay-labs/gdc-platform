"""AI proxy ingest — not mounted on the Data Relay OSS product app."""

from __future__ import annotations

import asyncio
from functools import partial

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.runners.ai_proxy_receiver import AiProxyReceiver, AiProxyReceiverError

router = APIRouter()


@router.post("/ai/{stream_slug}/v1/chat/completions")
async def ingest_ai_chat_completions(
    stream_slug: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """OpenAI-compatible sync ingress for AI proxy streams."""

    body = await request.body()
    receiver = AiProxyReceiver()
    client_ip = request.client.host if request.client is not None else ""
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            partial(
                receiver.dispatch,
                db,
                stream_slug=stream_slug,
                headers=dict(request.headers),
                body=body,
                content_type=request.headers.get("content-type"),
                client_ip=client_ip,
            ),
        )
    except AiProxyReceiverError as exc:
        detail: dict[str, object] = {"error_code": exc.error_code, "message": str(exc)}
        request_id = getattr(exc, "request_id", None)
        if request_id:
            detail["request_id"] = request_id
        policy_stage = getattr(exc, "stage", None)
        if policy_stage:
            detail["policy_stage"] = policy_stage
        policy_name = getattr(exc, "policy_name", None)
        if policy_name:
            detail["policy_name"] = policy_name
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc

    return dict(result["provider_response"])
