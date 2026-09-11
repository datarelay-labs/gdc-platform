#!/usr/bin/env python3
"""Queryable webhook destination collector for Full E2E Lab (test-only).

HTTP API:
  GET  /health
  POST /reset
  GET  /messages
  GET  /messages/by-correlation/{correlation_id}
  GET  /count
  POST /collect   (and any other path) — stores inbound webhook deliveries
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

LOCK = threading.Lock()
MESSAGES: list[dict[str, Any]] = []
MAX_MESSAGES = 5000
NEXT_ID = 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_message(entry: dict[str, Any]) -> dict[str, Any]:
    """Assign a never-reused id, then cap the in-memory ring buffer.

    Callers must hold LOCK. Reusing id=len(MESSAGES) after wrap made every new
    row look like the baseline in waitForNew collector correlation.
    """
    global NEXT_ID
    NEXT_ID += 1
    entry["id"] = NEXT_ID
    MESSAGES.append(entry)
    overflow = len(MESSAGES) - MAX_MESSAGES
    if overflow > 0:
        del MESSAGES[:overflow]
    return entry


def _extract_correlation(headers: dict[str, str], body: Any) -> str | None:
    for key in ("x-e2e-correlation-id", "e2e-correlation-id"):
        if key in headers and headers[key]:
            return headers[key]
    if isinstance(body, dict):
        for key in ("e2e_correlation_id", "correlation_id", "id"):
            val = body.get(key)
            if val is not None and str(val).strip():
                return str(val)
        # nested event shapes
        data = body.get("data")
        if isinstance(data, list) and data and isinstance(data[0], dict):
            val = data[0].get("e2e_correlation_id")
            if val is not None:
                return str(val)
    if isinstance(body, list) and body and isinstance(body[0], dict):
        val = body[0].get("e2e_correlation_id")
        if val is not None:
            return str(val)
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        print(f"[webhook-collector] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, code: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)

        if path in ("/health", "/"):
            self._send(200, {"ok": True, "service": "webhook-collector", "count": len(MESSAGES)})
            return
        if path == "/count":
            with LOCK:
                self._send(200, {"count": len(MESSAGES)})
            return
        if path == "/messages":
            limit = int((qs.get("limit") or ["200"])[0])
            with LOCK:
                items = list(MESSAGES[-limit:])
            self._send(200, {"messages": items, "count": len(MESSAGES)})
            return
        if path.startswith("/messages/by-correlation/"):
            cid = path.split("/messages/by-correlation/", 1)[1]
            with LOCK:
                matches = [m for m in MESSAGES if m.get("correlation_id") == cid]
            self._send(200, {"messages": matches, "count": len(matches)})
            return
        self._send(404, {"error": "not_found", "path": path})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        raw = self._read_body()
        headers = {k.lower(): v for k, v in self.headers.items()}

        if path == "/reset":
            with LOCK:
                MESSAGES.clear()
            self._send(200, {"ok": True, "count": 0})
            return

        body: Any
        try:
            body = json.loads(raw.decode("utf-8") or "null")
        except json.JSONDecodeError:
            body = raw.decode("utf-8", errors="replace")

        entry = {
            "id": 0,
            "timestamp": _now(),
            "method": "POST",
            "path": parsed.path,
            "headers": headers,
            "body": body,
            "raw_body": raw.decode("utf-8", errors="replace"),
            "correlation_id": _extract_correlation(headers, body),
            "status_response": 200,
        }
        with LOCK:
            append_message(entry)

        self._send(200, {"ok": True, "received_id": entry["id"], "correlation_id": entry["correlation_id"]})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/reset":
            with LOCK:
                MESSAGES.clear()
            self._send(200, {"ok": True, "count": 0})
            return
        self._send(404, {"error": "not_found"})


def main() -> None:
    host = "0.0.0.0"
    port = int(__import__("os").environ.get("WEBHOOK_COLLECTOR_PORT", "8080"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[webhook-collector] listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
