"""Toxiproxy helpers for TCP-level fault injection in front of WireMock.

Place Toxiproxy only where WireMock/docker-stop cannot express the fault:
latency/timeout, connection reset, and connection unavailable (proxy disabled).
"""

from __future__ import annotations

import json
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

TOXIPROXY_API_URL = os.getenv("TOXIPROXY_API_URL", "http://127.0.0.1:28474").rstrip("/")
TOXIPROXY_SOURCE_BASE_URL = os.getenv("TOXIPROXY_SOURCE_BASE_URL", "http://127.0.0.1:28081").rstrip("/")
TOXIPROXY_DEST_BASE_URL = os.getenv("TOXIPROXY_DEST_BASE_URL", "http://127.0.0.1:28082").rstrip("/")
WIREMOCK_BASE_URL = os.getenv("WIREMOCK_BASE_URL", "http://127.0.0.1:28080").rstrip("/")
# Same docker network as toxiproxy-test (container_name DNS). host.docker.internal is unreliable here.
_WIREMOCK_UPSTREAM_DEFAULT = (
    f"{os.getenv('GDC_TEST_CONTAINER_PREFIX', 'gdc')}-wiremock-test:8080"
)
WIREMOCK_TOXIPROXY_UPSTREAM = os.getenv("WIREMOCK_TOXIPROXY_UPSTREAM", _WIREMOCK_UPSTREAM_DEFAULT)

# Listen ports inside the toxiproxy container (mapped to host SOURCE/DEST ports).
_SOURCE_LISTEN = "0.0.0.0:18080"
_DEST_LISTEN = "0.0.0.0:18081"

PROXY_SOURCE = "gdc-http-source"
PROXY_DEST = "gdc-http-dest"


def toxiproxy_reachable(api_url: str | None = None) -> bool:
    url = api_url or TOXIPROXY_API_URL
    try:
        p = urlparse(url)
        host = p.hostname or "127.0.0.1"
        port = p.port or 8474
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def _wiremock_upstream_hostport(wiremock_base: str | None = None) -> str:
    """Upstream as seen from the Toxiproxy container (shared compose network).

    Prefer container DNS (``{prefix}-wiremock-test:8080``). ``wiremock_base`` is
    accepted for API symmetry but host ports are not reachable via
    host.docker.internal reliably on this lab network.
    """

    _ = wiremock_base  # host URL is for clients; upstream stays on the docker network
    return WIREMOCK_TOXIPROXY_UPSTREAM


def wait_toxiproxy_ready(*, timeout_seconds: float = 45.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_err = ""
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{TOXIPROXY_API_URL}/version", timeout=1.0)
            if r.status_code == 200:
                return
            last_err = f"HTTP {r.status_code}"
        except Exception as exc:  # noqa: BLE001 — poll until ready
            last_err = str(exc)
        time.sleep(0.25)
    raise TimeoutError(f"Toxiproxy API not ready at {TOXIPROXY_API_URL}: {last_err}")


def delete_proxy(name: str) -> None:
    httpx.delete(f"{TOXIPROXY_API_URL}/proxies/{name}", timeout=5.0)


def ensure_proxy(
    name: str,
    *,
    listen: str,
    upstream: str | None = None,
    enabled: bool = True,
) -> dict[str, Any]:
    wait_toxiproxy_ready()
    up = upstream or _wiremock_upstream_hostport()
    delete_proxy(name)
    body = {"name": name, "listen": listen, "upstream": up, "enabled": enabled}
    r = httpx.post(f"{TOXIPROXY_API_URL}/proxies", json=body, timeout=10.0)
    if r.status_code not in (200, 201):
        raise AssertionError(f"create proxy {name} failed: {r.status_code} {r.text}")
    return r.json()


def ensure_source_and_dest_proxies(*, enabled: bool = True) -> dict[str, dict[str, Any]]:
    return {
        "source": ensure_proxy(PROXY_SOURCE, listen=_SOURCE_LISTEN, enabled=enabled),
        "dest": ensure_proxy(PROXY_DEST, listen=_DEST_LISTEN, enabled=enabled),
    }


def set_proxy_enabled(name: str, enabled: bool) -> dict[str, Any]:
    r = httpx.post(
        f"{TOXIPROXY_API_URL}/proxies/{name}",
        json={"enabled": enabled},
        timeout=5.0,
    )
    if r.status_code != 200:
        raise AssertionError(f"set_proxy_enabled {name}={enabled} failed: {r.status_code} {r.text}")
    return r.json()


def clear_toxics(name: str) -> None:
    r = httpx.get(f"{TOXIPROXY_API_URL}/proxies/{name}/toxics", timeout=5.0)
    if r.status_code != 200:
        return
    for toxic in r.json() or []:
        tname = toxic.get("name")
        if tname:
            httpx.delete(f"{TOXIPROXY_API_URL}/proxies/{name}/toxics/{tname}", timeout=5.0)


def add_toxic(
    proxy_name: str,
    *,
    toxic_type: str,
    attributes: dict[str, Any],
    stream: str = "downstream",
    toxicity: float = 1.0,
    name: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": toxic_type,
        "stream": stream,
        "toxicity": toxicity,
        "attributes": attributes,
    }
    if name:
        body["name"] = name
    r = httpx.post(
        f"{TOXIPROXY_API_URL}/proxies/{proxy_name}/toxics",
        json=body,
        timeout=10.0,
    )
    if r.status_code not in (200, 201):
        raise AssertionError(f"add_toxic {toxic_type} on {proxy_name} failed: {r.status_code} {r.text}")
    return r.json()


def inject_latency(proxy_name: str, *, latency_ms: int, jitter_ms: int = 0) -> dict[str, Any]:
    clear_toxics(proxy_name)
    return add_toxic(
        proxy_name,
        toxic_type="latency",
        name=f"{proxy_name}-latency",
        attributes={"latency": int(latency_ms), "jitter": int(jitter_ms)},
    )


def inject_reset_peer(proxy_name: str, *, timeout_ms: int = 0) -> dict[str, Any]:
    clear_toxics(proxy_name)
    return add_toxic(
        proxy_name,
        toxic_type="reset_peer",
        name=f"{proxy_name}-reset",
        attributes={"timeout": int(timeout_ms)},
    )


def inject_unavailable(proxy_name: str) -> dict[str, Any]:
    clear_toxics(proxy_name)
    return set_proxy_enabled(proxy_name, False)


def remove_fault(proxy_name: str) -> None:
    clear_toxics(proxy_name)
    set_proxy_enabled(proxy_name, True)


def wait_until(
    predicate: Any,
    *,
    timeout_seconds: float,
    interval_seconds: float = 0.2,
    description: str = "condition",
) -> None:
    deadline = time.monotonic() + timeout_seconds
    last: Any = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return
        time.sleep(interval_seconds)
    raise TimeoutError(f"Timed out waiting for {description}; last={last!r}")


def wait_http_ok(url: str, *, timeout_seconds: float = 30.0) -> None:
    def _ok() -> bool:
        try:
            r = httpx.get(url, timeout=1.5)
            return r.status_code < 500
        except Exception:
            return False

    wait_until(_ok, timeout_seconds=timeout_seconds, description=f"HTTP OK {url}")


def inject_connection_interrupt(proxy_name: str, *, bytes_limit: int = 1) -> dict[str, Any]:
    """Cut the client→server stream early so the upstream never sees a full HTTP request."""

    clear_toxics(proxy_name)
    set_proxy_enabled(proxy_name, True)
    return add_toxic(
        proxy_name,
        toxic_type="limit_data",
        name=f"{proxy_name}-limit-up",
        stream="upstream",
        attributes={"bytes": int(bytes_limit)},
    )


def wait_http_transport_failure(url: str, *, timeout_seconds: float = 20.0) -> None:
    """Observable: HTTP through the proxy fails (disconnect / reset / protocol error)."""

    def _failed() -> bool:
        try:
            httpx.get(url, timeout=1.5)
            return False
        except (httpx.TransportError, httpx.TimeoutException):
            return True

    wait_until(_failed, timeout_seconds=timeout_seconds, description=f"HTTP transport failure {url}")


def wait_tcp_refused(host: str, port: int, *, timeout_seconds: float = 20.0) -> None:
    def _refused() -> bool:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return False
        except ConnectionRefusedError:
            return True
        except OSError:
            return True

    wait_until(_refused, timeout_seconds=timeout_seconds, description=f"TCP refused {host}:{port}")


def wait_proxy_path_ok(base_url: str, path: str = "/__admin/mappings", *, timeout_seconds: float = 30.0) -> None:
    wait_http_ok(f"{base_url.rstrip('/')}{path}", timeout_seconds=timeout_seconds)


def write_evidence(name: str, payload: dict[str, Any]) -> Path:
    root = Path(__file__).resolve().parents[1] / ".test-history" / "artifacts" / "toxiproxy"
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{name}.json"
    doc = {
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
