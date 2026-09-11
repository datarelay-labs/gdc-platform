#!/usr/bin/env python3
"""Queryable syslog UDP/TCP/TLS collector for Full E2E Lab (test-only).

Listen:
  UDP/TCP :5514
  TLS     :6514 (optional; uses /certs/server.crt + server.key when present)

Query API (:8080):
  GET  /health
  POST /reset
  GET  /messages
  GET  /messages/by-correlation/{correlation_id}
  GET  /count
"""

from __future__ import annotations

import json
import os
import re
import socket
import ssl
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

LOCK = threading.Lock()
MESSAGES: list[dict[str, Any]] = []
MAX_MESSAGES = 5000
NEXT_ID = 0
TLS_LISTENER_READY = False
TLS_LISTENER_ERROR: str | None = None

CORRELATION_RE = re.compile(r'"e2e_correlation_id"\s*:\s*"([^"]+)"')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_correlation(parsed: Any, text: str) -> str | None:
    if isinstance(parsed, dict):
        correlation = parsed.get("e2e_correlation_id")
        if correlation is not None:
            return str(correlation)
        message = parsed.get("message")
        if isinstance(message, dict) and message.get("e2e_correlation_id") is not None:
            return str(message.get("e2e_correlation_id"))
        data = parsed.get("data")
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and item.get("e2e_correlation_id") is not None:
                    return str(item.get("e2e_correlation_id"))
        nested = parsed.get("nested")
        if isinstance(nested, dict) and nested.get("e2e_correlation_id") is not None:
            return str(nested.get("e2e_correlation_id"))
    m = CORRELATION_RE.search(text)
    if m:
        return m.group(1)
    return None


def _store(
    *,
    protocol: str,
    remote: str,
    raw: bytes,
    tls_client_subject: str | None = None,
) -> None:
    text = raw.decode("utf-8", errors="replace")
    parsed: Any = None
    parsed_ok = False
    # Syslog often prefixes JSON with <pri>HEADER
    json_start = text.find("{")
    if json_start >= 0:
        try:
            parsed = json.loads(text[json_start:])
            parsed_ok = True
        except json.JSONDecodeError:
            parsed = None
    correlation = _extract_correlation(parsed, text)

    entry = {
        "id": 0,
        "timestamp": _now(),
        "protocol": protocol,
        "remote_address": remote,
        "raw_message": text,
        "parsed_json": parsed,
        "parsed_json_ok": parsed_ok,
        "correlation_id": str(correlation) if correlation is not None else None,
        "tls_client_subject": tls_client_subject,
    }
    with LOCK:
        append_message(entry)
    print(f"[syslog-collector] {protocol} from {remote} bytes={len(raw)} cid={entry['correlation_id']}", flush=True)


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


def _serve_udp(port: int) -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    while True:
        data, addr = s.recvfrom(65535)
        _store(protocol="UDP", remote=f"{addr[0]}:{addr[1]}", raw=data)


def _handle_tcp_conn(conn: socket.socket, addr: tuple[Any, ...], protocol: str, tls_subject: str | None) -> None:
    """Read newline-delimited syslog frames until idle timeout or peer close.

    Runtime TLS/TCP senders often reuse one socket for a whole batch. Reading only the
    first frame then closing drops the remaining events and breaks correlation waits.
    """
    try:
        # Keep pooled Runtime connections alive across destination-test → run-once gaps.
        conn.settimeout(60.0)
        buffer = b""
        remote = f"{addr[0]}:{addr[1]}"
        while True:
            try:
                part = conn.recv(65535)
            except socket.timeout:
                break
            if not part:
                break
            buffer += part
            while True:
                nl = buffer.find(b"\n")
                if nl < 0:
                    break
                frame = buffer[: nl + 1]
                buffer = buffer[nl + 1 :]
                if frame.strip():
                    _store(
                        protocol=protocol,
                        remote=remote,
                        raw=frame,
                        tls_client_subject=tls_subject,
                    )
        # Trailing frame without newline (flush on close/idle).
        if buffer.strip():
            _store(
                protocol=protocol,
                remote=remote,
                raw=buffer,
                tls_client_subject=tls_subject,
            )
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _serve_tcp(port: int) -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    s.listen(32)
    while True:
        conn, addr = s.accept()
        threading.Thread(
            target=_handle_tcp_conn,
            args=(conn, addr, "TCP", None),
            daemon=True,
        ).start()


def _serve_tls(port: int, certfile: Path, keyfile: Path) -> None:
    global TLS_LISTENER_READY, TLS_LISTENER_ERROR
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(certfile), keyfile=str(keyfile))
        # Accept clients without requiring client certs (mTLS optional for lab).
        context.verify_mode = ssl.CERT_NONE

        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", port))
        s.listen(32)
        TLS_LISTENER_READY = True
        TLS_LISTENER_ERROR = None
        print(f"[syslog-collector] TLS listener ready on {port}", flush=True)
    except Exception as exc:  # noqa: BLE001
        TLS_LISTENER_READY = False
        TLS_LISTENER_ERROR = str(exc)
        print(f"[syslog-collector] TLS listener failed: {exc}", flush=True)
        return
    while True:
        conn, addr = s.accept()
        try:
            tls_conn = context.wrap_socket(conn, server_side=True)
            subject = None
            try:
                peer = tls_conn.getpeercert()
                if peer:
                    subject = str(peer.get("subject"))
            except ssl.SSLError:
                subject = None
            threading.Thread(
                target=_handle_tcp_conn,
                args=(tls_conn, addr, "TLS", subject),
                daemon=True,
            ).start()
        except ssl.SSLError as exc:
            print(f"[syslog-collector] TLS handshake failed from {addr}: {exc}", flush=True)
            try:
                conn.close()
            except OSError:
                pass


class ApiHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        print(f"[syslog-collector-api] {fmt % args}", flush=True)

    def _send(self, code: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        if path in ("/health", "/"):
            self._send(
                200,
                {
                    "ok": True,
                    "service": "syslog-collector",
                    "count": len(MESSAGES),
                    "tls_ready": TLS_LISTENER_READY,
                    "tls_error": TLS_LISTENER_ERROR,
                },
            )
            return
        if path == "/ready/tls":
            code = 200 if TLS_LISTENER_READY else 503
            self._send(
                code,
                {
                    "ok": TLS_LISTENER_READY,
                    "tls_ready": TLS_LISTENER_READY,
                    "tls_error": TLS_LISTENER_ERROR,
                    "count": len(MESSAGES),
                },
            )
            return
        if path == "/count":
            with LOCK:
                self._send(200, {"count": len(MESSAGES)})
            return
        if path == "/messages":
            limit = int((qs.get("limit") or ["200"])[0])
            protocol = (qs.get("protocol") or [None])[0]
            with LOCK:
                items = list(MESSAGES)
            if protocol:
                items = [m for m in items if str(m.get("protocol")).upper() == protocol.upper()]
            self._send(200, {"messages": items[-limit:], "count": len(items)})
            return
        if path.startswith("/messages/by-correlation/"):
            cid = path.split("/messages/by-correlation/", 1)[1]
            protocol = (qs.get("protocol") or [None])[0]
            with LOCK:
                matches = [m for m in MESSAGES if m.get("correlation_id") == cid]
            if protocol:
                matches = [m for m in matches if str(m.get("protocol")).upper() == protocol.upper()]
            self._send(200, {"messages": matches, "count": len(matches)})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/reset":
            with LOCK:
                MESSAGES.clear()
            self._send(200, {"ok": True, "count": 0})
            return
        self._send(404, {"error": "not_found"})

    def do_DELETE(self) -> None:  # noqa: N802
        self.do_POST()


def main() -> None:
    syslog_port = int(os.environ.get("SYSLOG_LISTEN_PORT", "5514"))
    tls_port = int(os.environ.get("SYSLOG_TLS_PORT", "6514"))
    api_port = int(os.environ.get("SYSLOG_API_PORT", "8080"))
    cert = Path(os.environ.get("SYSLOG_TLS_CERT", "/certs/server.crt"))
    key = Path(os.environ.get("SYSLOG_TLS_KEY", "/certs/server.key"))

    threading.Thread(target=_serve_udp, args=(syslog_port,), daemon=True).start()
    threading.Thread(target=_serve_tcp, args=(syslog_port,), daemon=True).start()
    if cert.is_file() and key.is_file():
        threading.Thread(target=_serve_tls, args=(tls_port, cert, key), daemon=True).start()
        print(f"[syslog-collector] TLS enabled on {tls_port}", flush=True)
    else:
        print(f"[syslog-collector] TLS disabled (missing {cert} or {key})", flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", api_port), ApiHandler)
    print(f"[syslog-collector] UDP/TCP:{syslog_port} API:{api_port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
