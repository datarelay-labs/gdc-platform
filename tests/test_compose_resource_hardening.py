"""Compose hardening: logging rotation and E2E fixture resource limits must stay wired."""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def _load_compose(rel: str) -> dict:
    path = ROOT / rel
    raw = path.read_text(encoding="utf-8")
    return yaml.safe_load(raw)


def test_test_compose_wiremock_has_logging_and_resource_limits() -> None:
    doc = _load_compose("docker-compose.test.yml")
    wm = doc["services"]["wiremock-test"]
    assert wm["logging"]["driver"] == "json-file"
    assert wm["logging"]["options"]["max-size"] in {"20m", "10m"}
    assert int(wm["logging"]["options"]["max-file"]) <= 3
    assert "512m" in str(wm.get("mem_limit", ""))
    assert wm.get("pids_limit") is not None
    assert "cpus" in wm
    cmd = " ".join(wm.get("command") or [])
    assert "--verbose" not in cmd
    assert "max-request-journal-entries" in cmd


def test_platform_compose_wiremock_logging_and_no_verbose() -> None:
    doc = _load_compose("docker-compose.platform.yml")
    wm = doc["services"]["gdc-wiremock-test"]
    assert wm["logging"]["options"]["max-size"] == "20m"
    assert wm["mem_limit"] == "512m"
    assert wm.get("pids_limit") == 512
    cmd = " ".join(wm.get("command") or [])
    assert "--verbose" not in cmd


def test_full_e2e_collectors_keep_strict_or_equal_logging() -> None:
    doc = _load_compose("e2e/lab/docker-compose.full-e2e.yml")
    for name in ("webhook-collector", "syslog-collector"):
        opts = doc["services"][name]["logging"]["options"]
        assert opts["max-size"] in {"10m", "20m"}
        assert int(opts["max-file"]) <= 3
