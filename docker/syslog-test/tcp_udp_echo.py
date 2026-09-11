#!/usr/bin/env python3
"""Minimal TCP/UDP sink for compose isolation (development only; not RFC5424 validation)."""

from __future__ import annotations

import socket
import threading


def _serve_udp() -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", 5514))
    count = 0
    while True:
        data, addr = s.recvfrom(65535)
        count += 1
        # Sample to avoid json-file fill under lab EPS; keep periodic visibility.
        if count == 1 or count % 100 == 0:
            print(f"UDP {addr!r} bytes={len(data)} total={count}", flush=True)


def _serve_tcp() -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", 5514))
    s.listen(16)
    count = 0
    while True:
        conn, addr = s.accept()
        try:
            data = conn.recv(65535)
            count += 1
            if count == 1 or count % 100 == 0:
                print(f"TCP {addr!r} bytes={len(data)} total={count}", flush=True)
        finally:
            conn.close()


def main() -> None:
    threading.Thread(target=_serve_udp, daemon=True).start()
    _serve_tcp()


if __name__ == "__main__":
    main()
