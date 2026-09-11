"""Bounded parallel Full E2E Matrix scheduler.

Does not change product runtime. Workers reuse run-all-shards.sh with
per-worker namespaces (run/worker/shard/generation) so shards do not share
result files, product names, S3 prefixes, or collector channels.

Execution classes:
  PARALLEL_SAFE      — no global mutable service state
  RESOURCE_ISOLATED  — needs worker namespace (applied to all normal shards)
  GLOBAL_FAULT       — stops/restarts shared lab services
  SERIAL_ONLY        — reserved; only when isolation is impossible
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional

# Fault types that invoke e2e/lab/fault-inject.sh against shared lab services.
GLOBAL_FAULT_TYPES = frozenset(
    {
        "db_disconnect",
        "s3_unavailable",
        "sftp_unavailable",
        "api_restart",
        "runtime_restart",
        "webhook_destination_down",
        "syslog_destination_down",
        "tls_certificate_error",
    }
)

DEFAULT_NORMAL_WORKERS = 2
DEFAULT_FAULT_WORKERS = 1
COORDINATOR_STATE_NAME = "parallel-coordinator-state.json"
COORDINATOR_LOCK_NAME = "coordinator-publish.lock"
FAULT_EXCLUSIVE_LOCK_NAME = "fault-exclusive.lock"
SHARD_COMPLETE_MARKER = "shard-complete.json"


def utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def atomic_write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(doc, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def is_fault_shard(shard_id: str) -> bool:
    sid = str(shard_id or "")
    return sid.startswith("xp-fault-") or "/xp-fault-" in sid


def classify_scenario_axes(axes: Optional[dict[str, Any]]) -> str:
    """Classify one combination. SERIAL_ONLY only for true global mutable state."""
    axes = axes or {}
    fault = str(axes.get("fault_type") or "NONE")
    if fault in GLOBAL_FAULT_TYPES:
        return "GLOBAL_FAULT"
    if fault != "NONE":
        # http_401 / malformed_response / partial_route_failure: no docker stop.
        return "RESOURCE_ISOLATED"
    return "PARALLEL_SAFE"


def classify_shard(shard: dict[str, Any]) -> str:
    """Shard-level class. Fault shards are GLOBAL_FAULT; others PARALLEL_SAFE.

    Resource isolation is applied to every parallel worker (names/S3/collector),
    so normal shards do not need a SERIAL_ONLY downgrade.
    """
    sid = str(shard.get("shard_id") or "")
    if shard.get("isolated_compose") or is_fault_shard(sid):
        return "GLOBAL_FAULT"
    if int(shard.get("fault_count") or 0) > 0:
        return "GLOBAL_FAULT"
    return "PARALLEL_SAFE"


def load_shard_plan(plan_path: Path) -> dict[str, Any]:
    plan = read_json(Path(plan_path), {}) or {}
    shards = list(plan.get("shards") or [])
    if not shards:
        raise ValueError(f"FAILED_PREFLIGHT_ZERO_SHARDS: {plan_path}")
    return plan


def classify_shard_plan(plan: dict[str, Any]) -> dict[str, Any]:
    shards = list(plan.get("shards") or [])
    classified = []
    by_class: dict[str, list[str]] = {
        "PARALLEL_SAFE": [],
        "RESOURCE_ISOLATED": [],
        "GLOBAL_FAULT": [],
        "SERIAL_ONLY": [],
    }
    seen: set[str] = set()
    duplicates: list[str] = []
    combo_ids: list[str] = []
    for s in shards:
        sid = str(s.get("shard_id") or "")
        if sid in seen:
            duplicates.append(sid)
            continue
        seen.add(sid)
        klass = classify_shard(s)
        ids = list(s.get("combination_ids") or [])
        expected = int(s.get("expected_count") or len(ids) or 0)
        entry = {
            "shard_id": sid,
            "execution_class": klass,
            "expected_count": expected,
            "combination_ids": ids,
            "isolated_compose": bool(s.get("isolated_compose")),
        }
        classified.append(entry)
        by_class[klass].append(sid)
        combo_ids.extend(ids)

    unique_combos = set(combo_ids)
    return {
        "ok": not duplicates,
        "shard_count": len(classified),
        "total_combinations": len(combo_ids),
        "unique_combinations": len(unique_combos),
        "duplicate_combination_count": len(combo_ids) - len(unique_combos),
        "duplicate_shards": duplicates,
        "PARALLEL_SAFE_SHARDS": by_class["PARALLEL_SAFE"],
        "RESOURCE_ISOLATED_SHARDS": by_class["RESOURCE_ISOLATED"],
        "GLOBAL_FAULT_SHARDS": by_class["GLOBAL_FAULT"],
        "SERIAL_ONLY_SHARDS": by_class["SERIAL_ONLY"],
        "shards": classified,
    }


def load_combination_route_index(path: Path) -> dict[str, str]:
    """Map combination_id → axes.route_runtime from the VALID catalog."""
    idx: dict[str, str] = {}
    catalog = Path(path)
    if not catalog.is_file():
        return idx
    with catalog.open(encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            cid = row.get("combination_id")
            rr = (row.get("axes") or {}).get("route_runtime")
            if cid and rr:
                idx[str(cid)] = str(rr)
    return idx


def apply_route_runtime_scope(
    classified: dict[str, Any],
    *,
    route_runtime: str,
    route_index: dict[str, str],
) -> dict[str, Any]:
    """Restrict shard combination_ids to the active route_runtime (ROUTE_ON/OFF)."""
    if not route_runtime:
        return classified
    total = 0
    unique: set[str] = set()
    for s in classified.get("shards") or []:
        ids = [i for i in (s.get("combination_ids") or []) if route_index.get(i) == route_runtime]
        s["combination_ids"] = ids
        s["expected_count"] = len(ids)
        s["route_runtime"] = route_runtime
        total += len(ids)
        unique.update(ids)
    classified["total_combinations"] = total
    classified["unique_combinations"] = len(unique)
    classified["route_runtime_scope"] = route_runtime
    return classified


def worker_resource_name_prefix(*, worker_id: str, generation_id: str) -> str:
    return f"[FULL E2E][w-{worker_id}][g-{generation_id}]"


def worker_s3_prefix(*, worker_id: str, generation_id: str) -> str:
    return f"full-e2e/w-{worker_id}/g-{generation_id}/"


def worker_collector_channel(*, worker_id: str, generation_id: str) -> str:
    # Syslog APP-NAME tokens cannot contain spaces; keep this filesystem-safe.
    safe_w = str(worker_id).replace("/", "-")
    safe_g = str(generation_id).replace("/", "-")[:24]
    return f"xpw{safe_w}g{safe_g}"


def worker_sftp_directory(*, worker_id: str, generation_id: str) -> str:
    return f"/upload/full-e2e/w-{worker_id}/g-{generation_id}"


def format_worker_side_run_id(
    run_id: str,
    attempt: str,
    shard_id: str,
    generation_id: str,
    worker_id: str,
) -> str:
    return (
        f"{run_id}__{attempt}__shard-{shard_id}__worker-{worker_id}"
        f"__generation-{generation_id}"
    )


def build_parallel_execution_plan(
    shards: list[str],
    *,
    classified: Optional[dict[str, Any]] = None,
    normal_workers: int = DEFAULT_NORMAL_WORKERS,
    fault_workers: int = DEFAULT_FAULT_WORKERS,
    allow_fault_with_normal: bool = False,
) -> dict[str, Any]:
    """Split shards into Normal vs Fault queues with bounded worker caps."""
    normal_workers = max(1, int(normal_workers))
    fault_workers = max(1, int(fault_workers))
    class_by_id: dict[str, str] = {}
    if classified:
        for s in classified.get("shards") or []:
            class_by_id[str(s["shard_id"])] = str(s["execution_class"])

    normal: list[str] = []
    fault: list[str] = []
    serial: list[str] = []
    seen: set[str] = set()
    duplicates: list[str] = []
    for sid in shards:
        if sid in seen:
            duplicates.append(sid)
            continue
        seen.add(sid)
        klass = class_by_id.get(sid) or ("GLOBAL_FAULT" if is_fault_shard(sid) else "PARALLEL_SAFE")
        if klass == "SERIAL_ONLY":
            serial.append(sid)
        elif klass == "GLOBAL_FAULT":
            fault.append(sid)
        else:
            normal.append(sid)

    errors: list[str] = []
    if duplicates:
        errors.append(f"duplicate_shards={duplicates}")
    if serial:
        # Isolation should have converted these; surface but do not auto-skip.
        errors.append(f"serial_only_shards={serial}")

    if not allow_fault_with_normal and normal and fault:
        concurrent_policy = "SERIALIZE_FAULT_AFTER_NORMAL"
    elif allow_fault_with_normal:
        concurrent_policy = "ALLOW_MIXED"
    else:
        concurrent_policy = "NORMAL_ONLY_OR_FAULT_ONLY"

    return {
        "ok": not errors,
        "errors": errors,
        "normal_workers": normal_workers,
        "fault_workers": fault_workers,
        "pending_normal": normal,
        "pending_fault": fault,
        "pending_serial": serial,
        "concurrent_policy": concurrent_policy,
        "duplicate_shards": duplicates,
        "fault_policy": "SEQUENTIAL_AFTER_NORMAL"
        if concurrent_policy == "SERIALIZE_FAULT_AFTER_NORMAL"
        else concurrent_policy,
    }


class CoordinatorLock:
    """Exclusive flock around coordinator state / result publish."""

    def __init__(self, attempt_dir: Path, *, name: str = COORDINATOR_LOCK_NAME, timeout_sec: float = 120.0):
        self.attempt_dir = Path(attempt_dir)
        self.timeout_sec = timeout_sec
        self.path = self.attempt_dir / "locks" / name
        self._fh = None

    def __enter__(self):
        import fcntl

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a+", encoding="utf-8")
        deadline = time.time() + self.timeout_sec
        while True:
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() >= deadline:
                    self._fh.close()
                    self._fh = None
                    raise TimeoutError(f"coordinator lock timeout: {self.path}")
                time.sleep(0.05)
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(json.dumps({"pid": os.getpid(), "acquired_at": utc_now()}, indent=2) + "\n")
        self._fh.flush()
        os.fsync(self._fh.fileno())
        return self

    def __exit__(self, exc_type, exc, tb):
        import fcntl

        if self._fh is not None:
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            finally:
                self._fh.close()
                self._fh = None
        return False


def coordinator_state_path(attempt_dir: Path) -> Path:
    return Path(attempt_dir) / COORDINATOR_STATE_NAME


def load_coordinator_state(attempt_dir: Path) -> dict[str, Any]:
    return read_json(coordinator_state_path(attempt_dir), {}) or {}


def init_coordinator_state(
    attempt_dir: Path,
    *,
    run_id: str,
    attempt: str,
    plan: dict[str, Any],
    harness_version: str,
    commit: str,
    reports_root: Optional[Path] = None,
    route_runtime: str = "ROUTE_ON",
) -> dict[str, Any]:
    existing = load_coordinator_state(attempt_dir)
    resume_statuses = {
        "RUNNING",
        "READY_TO_FINALIZE",
        "COMPLETE",
        "FAILED_WITH_PRESERVED_RESULTS",
        "FAILED",
    }
    if existing.get("status") in resume_statuses and existing.get("run_id") == run_id:
        # Resume: re-validate completed shards; re-queue failed and untrusted complete.
        completed_map = dict(existing.get("completed") or {})
        failed_map = dict(existing.get("failed") or {})
        demoted: list[str] = []
        if reports_root is not None:
            run_dir = Path(reports_root) / run_id
            for sid, summary in list(completed_map.items()):
                art = run_dir / f"{sid}-{route_runtime}"
                expected = 0
                ids_path = attempt_dir / "combination-ids" / f"{sid}.ids"
                if ids_path.is_file():
                    expected = sum(1 for line in ids_path.read_text(encoding="utf-8").splitlines() if line.strip())
                if expected <= 0:
                    detail = (summary or {}).get("detail") or {}
                    validation = detail.get("validation") or {}
                    expected = int(validation.get("expected") or 0)
                if expected <= 0:
                    continue
                check = trusted_complete_marker_ok(
                    art,
                    expected_count=expected,
                    expected_harness=harness_version,
                    expected_commit=commit,
                )
                if not check.get("reuse"):
                    demoted.append(sid)
                    completed_map.pop(sid, None)
        completed = set(completed_map.keys())
        pending_normal = [
            s for s in plan.get("pending_normal") or [] if s not in completed
        ]
        pending_fault = [
            s for s in plan.get("pending_fault") or [] if s not in completed
        ]
        for sid in failed_map.keys():
            if sid not in completed:
                if sid in pending_normal or sid in pending_fault:
                    continue
                if sid.startswith("xp-fault-"):
                    if sid not in pending_fault:
                        pending_fault.append(sid)
                elif sid not in pending_normal:
                    pending_normal.append(sid)
        for sid in demoted:
            if sid.startswith("xp-fault-"):
                if sid not in pending_fault:
                    pending_fault.append(sid)
            elif sid not in pending_normal:
                pending_normal.append(sid)
        existing["completed"] = completed_map
        existing["failed"] = {}
        existing["pending_normal"] = pending_normal
        existing["pending_fault"] = pending_fault
        existing["resume_at"] = utc_now()
        existing["assignment_stopped"] = False
        existing["assignment_stop_reason"] = None
        existing["status"] = "RUNNING"
        existing["phase"] = "FAULT" if pending_fault and not pending_normal else existing.get("phase") or "NORMAL"
        existing["harness_version"] = harness_version
        existing["commit"] = commit
        existing["demoted_completed_shards"] = demoted
        existing["updated_at"] = utc_now()
        atomic_write_json(coordinator_state_path(attempt_dir), existing)
        return existing

    state = {
        "run_id": run_id,
        "attempt": attempt,
        "status": "RUNNING",
        "phase": "NORMAL",
        "active_phase": "normal",
        "harness_version": harness_version,
        "commit": commit,
        "normal_workers": plan.get("normal_workers"),
        "fault_workers": plan.get("fault_workers"),
        "concurrent_policy": plan.get("concurrent_policy"),
        "pending_normal": list(plan.get("pending_normal") or []),
        "pending_fault": list(plan.get("pending_fault") or []),
        "running": {},
        "completed": {},
        "failed": {},
        "assignment_stopped": False,
        "finalize_allowed": False,
        "finalize_blocked": True,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "shards_executed": 0,
    }
    atomic_write_json(coordinator_state_path(attempt_dir), state)
    return state


def trusted_complete_marker_ok(
    art_dir: Path,
    *,
    expected_count: int,
    expected_harness: Optional[str] = None,
    expected_commit: Optional[str] = None,
) -> dict[str, Any]:
    """Accept reuse only when shard evidence is complete, unique, and matching."""
    art_dir = Path(art_dir)
    marker = art_dir / SHARD_COMPLETE_MARKER
    jsonl = art_dir / "cross-product-results.jsonl"
    reasons: list[str] = []
    if not jsonl.is_file():
        return {"ok": False, "reuse": False, "reason": "FAILED_RESULT_MISSING"}
    rows = []
    for line in jsonl.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            reasons.append("corrupt_jsonl_line")
            return {"ok": False, "reuse": False, "reason": "CORRUPT_RESULT", "errors": reasons}
    ids = [r.get("combination_id") for r in rows if r.get("combination_id")]
    unique = len(set(ids))
    dup = len(ids) - unique
    fail_n = sum(1 for r in rows if str(r.get("status") or "").upper() == "FAIL")
    if not rows:
        reasons.append("empty_jsonl")
    if len(rows) != expected_count or unique != expected_count:
        reasons.append(f"count_mismatch executed={len(rows)} unique={unique} expected={expected_count}")
    if dup:
        reasons.append(f"duplicates={dup}")
    if fail_n:
        reasons.append(f"FAIL={fail_n}")

    man = read_json(art_dir / "shard-manifest.json", {}) or {}
    if expected_harness and man.get("harness_version") and man.get("harness_version") != expected_harness:
        reasons.append("harness_version_mismatch")
    if expected_commit:
        got = man.get("git_commit") or man.get("commit")
        if got and got != expected_commit:
            reasons.append("commit_mismatch")

    if marker.is_file():
        mk = read_json(marker, {}) or {}
        if int(mk.get("expected") or 0) != expected_count:
            reasons.append("marker_plan_mismatch")
        if str(mk.get("status") or "").upper() != "PASS":
            reasons.append("marker_not_pass")

    ok = not reasons and dup == 0 and fail_n == 0 and len(rows) == expected_count == unique
    return {
        "ok": ok,
        "reuse": ok,
        "reason": None if ok else (reasons[0] if reasons else "INCOMPLETE_EXECUTION"),
        "errors": reasons,
        "executed": len(rows),
        "unique": unique,
        "expected": expected_count,
        "duplicates": dup,
        "FAIL": fail_n,
        "PASS": sum(1 for r in rows if str(r.get("status") or "").upper() == "PASS"),
        "combination_ids": ids,
    }


def publish_shard_result(
    *,
    src_art_dir: Path,
    dest_art_dir: Path,
    validation: dict[str, Any],
) -> dict[str, Any]:
    """Coordinator-only publish of a worker shard into the run result tree.

    Never appends to an existing JSONL. Replaces only after validation.
    """
    src_art_dir = Path(src_art_dir)
    dest_art_dir = Path(dest_art_dir)
    src_jsonl = src_art_dir / "cross-product-results.jsonl"
    if not src_jsonl.is_file():
        return {"ok": False, "reason": "FAILED_RESULT_MISSING"}
    if not validation.get("ok"):
        return {"ok": False, "reason": "REFUSE_UNVALIDATED_PUBLISH"}
    dest_art_dir.mkdir(parents=True, exist_ok=True)
    dest_jsonl = dest_art_dir / "cross-product-results.jsonl"
    tmp = dest_art_dir / f".cross-product-results.{os.getpid()}.tmp"
    tmp.write_bytes(src_jsonl.read_bytes())
    tmp.replace(dest_jsonl)
    for name in ("shard-manifest.json", "harness-manifest.json", SHARD_COMPLETE_MARKER):
        src = src_art_dir / name
        if src.is_file():
            (dest_art_dir / name).write_bytes(src.read_bytes())
    write_shard_complete_marker(dest_art_dir, validation)
    return {"ok": True, "dest": str(dest_art_dir), "published": True}


def write_shard_complete_marker(art_dir: Path, validation: dict[str, Any]) -> Path:
    path = Path(art_dir) / SHARD_COMPLETE_MARKER
    doc = {
        "status": "PASS" if validation.get("ok") else "FAIL",
        "expected": validation.get("expected"),
        "executed": validation.get("executed"),
        "unique": validation.get("unique"),
        "duplicates": validation.get("duplicates"),
        "FAIL": validation.get("FAIL"),
        "written_at": utc_now(),
    }
    atomic_write_json(path, doc)
    return path


def assign_next_shard(
    attempt_dir: Path,
    *,
    worker_id: str,
    queue: str,
    generation_id: str,
    pid: Optional[int] = None,
) -> dict[str, Any]:
    with CoordinatorLock(attempt_dir):
        state = load_coordinator_state(attempt_dir)
        if state.get("assignment_stopped"):
            return {
                "ok": False,
                "reason": state.get("assignment_stop_reason") or "ASSIGNMENT_STOPPED",
                "shard": None,
            }
        running = dict(state.get("running") or {})
        if worker_id in running:
            return {"ok": False, "reason": "WORKER_ALREADY_RUNNING", "running": running[worker_id]}

        policy = str(state.get("concurrent_policy") or "")
        if queue == "fault" and policy == "SERIALIZE_FAULT_AFTER_NORMAL":
            if state.get("pending_normal") or any(v.get("queue") == "normal" for v in running.values()):
                return {"ok": False, "reason": "FAULT_WAITS_FOR_NORMAL", "shard": None}

        pending_key = "pending_fault" if queue == "fault" else "pending_normal"
        pending = list(state.get(pending_key) or [])
        if not pending:
            return {"ok": False, "reason": "QUEUE_EMPTY", "shard": None}
        shard_id = pending.pop(0)

        assigned = {v.get("shard") for v in running.values()}
        completed = set((state.get("completed") or {}).keys())
        if shard_id in assigned or shard_id in completed:
            state["assignment_stopped"] = True
            state["assignment_stop_reason"] = "DUPLICATE_SHARD_ASSIGNMENT_BLOCKED"
            atomic_write_json(coordinator_state_path(attempt_dir), state)
            return {"ok": False, "reason": "DUPLICATE_SHARD_ASSIGNMENT_BLOCKED", "shard": shard_id}

        running[worker_id] = {
            "worker_id": worker_id,
            "shard": shard_id,
            "queue": queue,
            "generation_id": generation_id,
            "pid": pid or os.getpid(),
            "started_at": utc_now(),
            "status": "RUNNING",
        }
        state[pending_key] = pending
        state["running"] = running
        state["phase"] = "RUNNING"
        state["status"] = "RUNNING"
        state["updated_at"] = utc_now()
        atomic_write_json(coordinator_state_path(attempt_dir), state)
        return {"ok": True, "worker_id": worker_id, "shard": shard_id, "queue": queue, "state": state}


def record_worker_result(
    attempt_dir: Path,
    *,
    worker_id: str,
    shard_id: str,
    status: str,
    generation_id: Optional[str] = None,
    detail: Optional[dict[str, Any]] = None,
    stop_assignment_on_failure: bool = False,
) -> dict[str, Any]:
    status_u = str(status).upper()
    with CoordinatorLock(attempt_dir):
        state = load_coordinator_state(attempt_dir)
        running = dict(state.get("running") or {})
        entry = running.pop(worker_id, None)
        if entry and entry.get("shard") != shard_id:
            return {
                "ok": False,
                "reason": "WORKER_SHARD_MISMATCH",
                "expected": entry.get("shard"),
                "got": shard_id,
            }
        summary = {
            "worker_id": worker_id,
            "shard": shard_id,
            "status": status_u,
            "generation_id": generation_id or (entry or {}).get("generation_id"),
            "finished_at": utc_now(),
            "detail": detail or {},
            "preserved": True,
        }
        if status_u in {"COMPLETE", "PASS", "PUBLISHED"}:
            completed = dict(state.get("completed") or {})
            completed[shard_id] = summary
            state["completed"] = completed
            state["shards_executed"] = int(state.get("shards_executed") or 0) + 1
        else:
            failed = dict(state.get("failed") or {})
            failed[shard_id] = summary
            state["failed"] = failed
            if stop_assignment_on_failure:
                state["assignment_stopped"] = True
                state["assignment_stop_reason"] = f"WORKER_FAILED:{shard_id}:{status_u}"
        state["running"] = running
        pending_left = len(state.get("pending_normal") or []) + len(state.get("pending_fault") or [])
        if not running and pending_left == 0 and not state.get("failed"):
            state["finalize_blocked"] = False
            state["finalize_allowed"] = True
            state["phase"] = "READY_TO_FINALIZE"
            state["status"] = "ALL_SHARDS_COMPLETE"
            state["active_phase"] = None
        elif not running and pending_left == 0 and state.get("failed"):
            state["finalize_blocked"] = True
            state["finalize_allowed"] = False
            state["phase"] = "FAILED"
            state["status"] = "FAILED_WITH_PRESERVED_RESULTS"
            state["active_phase"] = None
        state["updated_at"] = utc_now()
        atomic_write_json(coordinator_state_path(attempt_dir), state)
        return {"ok": True, "state": state, "summary": summary}


def detect_cross_worker_contamination(*, worker_results: list[dict[str, Any]]) -> dict[str, Any]:
    errors: list[str] = []
    jsonl_paths: dict[str, str] = {}
    scenario_owners: dict[str, str] = {}
    generation_owners: dict[str, str] = {}
    channels: dict[str, str] = {}
    prefixes: dict[str, str] = {}
    for wr in worker_results:
        wid = str(wr.get("worker_id"))
        gen = str(wr.get("generation_id") or "")
        jsonl = str(wr.get("jsonl_path") or "")
        channel = str(wr.get("collector_channel") or "")
        prefix = str(wr.get("name_prefix") or "")
        if gen:
            if gen in generation_owners and generation_owners[gen] != wid:
                errors.append(f"generation_shared:{gen}")
            generation_owners[gen] = wid
        if jsonl:
            if jsonl in jsonl_paths and jsonl_paths[jsonl] != wid:
                errors.append(f"jsonl_shared:{jsonl}")
            jsonl_paths[jsonl] = wid
        if channel:
            if channel in channels and channels[channel] != wid:
                errors.append(f"collector_channel_shared:{channel}")
            channels[channel] = wid
        if prefix:
            if prefix in prefixes and prefixes[prefix] != wid:
                errors.append(f"name_prefix_shared:{prefix}")
            prefixes[prefix] = wid
        for cid in wr.get("combination_ids") or []:
            if cid in scenario_owners and scenario_owners[cid] != wid:
                errors.append(f"scenario_duplicate:{cid}")
            scenario_owners[cid] = wid
        gens = wr.get("generation_ids_in_jsonl") or ([gen] if gen else [])
        if len(set(gens)) > 1:
            errors.append(f"worker_multi_generation:{wid}")
        owners = wr.get("writer_owners") or []
        if len(set(owners)) > 1:
            errors.append(f"multi_writer_owner:{wid}")

    contamination = len(errors)
    return {
        "ok": contamination == 0,
        "cross_worker_contamination": contamination,
        "errors": errors,
        "scenario_duplicate": sum(1 for e in errors if e.startswith("scenario_duplicate:")),
        "resource_collisions": sum(
            1 for e in errors if e.startswith(("collector_channel_shared:", "name_prefix_shared:", "jsonl_shared:"))
        ),
    }


def merge_worker_jsonl(
    *,
    jsonl_paths: list[Path],
    expected_ids: Optional[set[str]] = None,
    expected_harness: Optional[str] = None,
) -> dict[str, Any]:
    """Coordinator-only merge. Rejects corrupt rows, duplicates, and harness mismatch."""
    rows: list[dict[str, Any]] = []
    corrupt = 0
    harnesses: set[str] = set()
    for p in jsonl_paths:
        if not Path(p).is_file():
            continue
        for line in Path(p).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                corrupt += 1
                continue
            rows.append(row)
            if row.get("harness_version"):
                harnesses.add(str(row["harness_version"]))

    ids = [r.get("combination_id") for r in rows if r.get("combination_id")]
    unique = set(ids)
    dup = len(ids) - len(unique)
    by_status: dict[str, int] = {}
    for r in rows:
        st = str(r.get("status") or "UNKNOWN")
        by_status[st] = by_status.get(st, 0) + 1

    missing: list[str] = []
    extra: list[str] = []
    if expected_ids is not None:
        missing = sorted(expected_ids - unique)
        extra = sorted(unique - expected_ids)

    harness_mismatch = bool(expected_harness and any(h != expected_harness for h in harnesses))
    mixed_harness = len(harnesses) > 1
    ok = (
        corrupt == 0
        and dup == 0
        and not missing
        and not extra
        and not harness_mismatch
        and not mixed_harness
    )
    return {
        "ok": ok,
        "expected": len(expected_ids) if expected_ids is not None else None,
        "executed": len(rows),
        "unique": len(unique),
        "duplicates": dup,
        "missing": len(missing),
        "missing_ids": missing[:50],
        "extra": len(extra),
        "corrupt": corrupt,
        "PASS": by_status.get("PASS", 0),
        "FAIL": by_status.get("FAIL", 0),
        "by_status": by_status,
        "harness_mismatch": harness_mismatch or mixed_harness,
        "harnesses": sorted(harnesses),
    }


def select_resume_shards(
    *,
    all_shards: list[dict[str, Any]],
    reports_root: Path,
    run_id: str,
    route_runtime: str = "ROUTE_ON",
    expected_harness: Optional[str] = None,
    expected_commit: Optional[str] = None,
) -> dict[str, Any]:
    """Reuse trusted complete shards; rerun failed/missing/corrupt only."""
    reuse: list[str] = []
    rerun: list[str] = []
    details: list[dict[str, Any]] = []
    for s in all_shards:
        sid = s["shard_id"]
        expected = int(s.get("expected_count") or len(s.get("combination_ids") or []) or 0)
        art = Path(reports_root) / run_id / f"{sid}-{route_runtime}"
        check = trusted_complete_marker_ok(
            art,
            expected_count=expected,
            expected_harness=expected_harness,
            expected_commit=expected_commit,
        )
        check["shard_id"] = sid
        details.append(check)
        if check.get("reuse"):
            reuse.append(sid)
        else:
            rerun.append(sid)
    return {
        "ok": True,
        "reuse_shards": reuse,
        "rerun_shards": rerun,
        "reuse_count": len(reuse),
        "rerun_count": len(rerun),
        "shards": details,
    }


def recommend_workers(*, nproc: Optional[int] = None, measured_stable: Optional[int] = None) -> int:
    """Default workers from measurement, not CPU count alone."""
    if measured_stable is not None:
        return max(1, int(measured_stable))
    cpu = int(nproc if nproc is not None else (os.cpu_count() or 2))
    # Shared lab saturates before CPU: cap at 2 unless a measurement says otherwise.
    return max(1, min(DEFAULT_NORMAL_WORKERS, cpu))
