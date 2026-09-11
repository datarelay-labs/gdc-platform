#!/usr/bin/env python3
"""Lab collector ids must stay unique after the in-memory ring buffer wraps."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def load(name: str):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def check_append(mod, label: str) -> None:
    original_max = mod.MAX_MESSAGES
    try:
        mod.MAX_MESSAGES = 8
        mod.MESSAGES.clear()
        mod.NEXT_ID = 0
        ids: list[int] = []
        for i in range(20):
            entry = {"payload": i}
            with mod.LOCK:
                mod.append_message(entry)
            ids.append(int(entry["id"]))
        assert_true(ids == list(range(1, 21)), f"{label}: ids must be monotonic 1..20, got {ids}")
        assert_true(len(mod.MESSAGES) == 8, f"{label}: ring cap")
        kept = [int(m["id"]) for m in mod.MESSAGES]
        assert_true(kept == list(range(13, 21)), f"{label}: remaining ids after wrap, got {kept}")
        assert_true(len(set(kept)) == 8, f"{label}: remaining ids unique")
    finally:
        mod.MAX_MESSAGES = original_max
        mod.MESSAGES.clear()
        mod.NEXT_ID = 0


def main() -> int:
    syslog = load("syslog_collector.py")
    webhook = load("webhook_collector.py")
    check_append(syslog, "syslog")
    check_append(webhook, "webhook")
    print('{"ok": true, "monotonic_ids_after_wrap": true}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
