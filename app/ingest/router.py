"""Runtime ingest endpoints for push-based sources."""

from __future__ import annotations

import asyncio
from functools import partial

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.runners.webhook_receiver import WebhookReceiver, WebhookReceiverError

router = APIRouter()


@router.post("/webhook/{receiver_key}")
async def ingest_webhook(
    receiver_key: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Receive an authenticated webhook event batch and run the stream pipeline."""

    body = await request.body()
    loop = asyncio.get_event_loop()
    try:
        summary = await loop.run_in_executor(
            None,
            partial(
                WebhookReceiver().dispatch,
                db,
                receiver_key=receiver_key,
                headers=dict(request.headers),
                body=body,
                content_type=request.headers.get("content-type"),
            ),
        )
    except WebhookReceiverError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"error_code": exc.error_code, "message": str(exc)},
        ) from exc
    # Same silent-no-op policy as run-once: lock contention is not a successful ingest.
    if str((summary or {}).get("outcome") or "") == "skipped_lock":
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": (summary or {}).get("error_code") or "RUN_ALREADY_ACTIVE",
                "message": (summary or {}).get("message") or "stream already running",
                "stream_id": (summary or {}).get("stream_id"),
                "runtime_run_id": (summary or {}).get("run_id"),
            },
        )
    return {"accepted": True, "summary": summary}
