#!/usr/bin/env python3
"""Bounded parallel Full E2E Matrix coordinator.

Usage:
  python3 e2e/cross-product/parallel-matrix-coordinator.py \\
    --run-id <id> --workers 2 --fault-workers 1

Workers execute isolated side-runs via run-parallel-shard-worker.sh.
Fault shards never overlap the normal pool unless --allow-fault-with-normal.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "e2e"
XP = E2E / "cross-product"
sys.path.insert(0, str(XP))

from parallel_lib import (  # noqa: E402
    DEFAULT_FAULT_WORKERS,
    DEFAULT_NORMAL_WORKERS,
    apply_route_runtime_scope,
    assign_next_shard,
    atomic_write_json,
    build_parallel_execution_plan,
    classify_shard_plan,
    detect_cross_worker_contamination,
    load_combination_route_index,
    init_coordinator_state,
    load_coordinator_state,
    load_shard_plan,
    merge_worker_jsonl,
    publish_shard_result,
    recommend_workers,
    record_worker_result,
    select_resume_shards,
    utc_now,
)
from recovery_lib import (  # noqa: E402
    compute_harness_version,
    new_generation_id,
    resolve_reports_root,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Parallel Full E2E Matrix coordinator")
    p.add_argument("--run-id", default=os.environ.get("GDC_E2E_RUN_ID") or f"xp_parallel_{time.strftime('%Y%m%d_%H%M%S')}")
    p.add_argument("--attempt", default=os.environ.get("GDC_XP_ATTEMPT") or "parallel-attempt-001")
    p.add_argument("--workers", type=int, default=int(os.environ.get("GDC_XP_WORKERS") or DEFAULT_NORMAL_WORKERS))
    p.add_argument("--normal-workers", type=int, default=None)
    p.add_argument("--fault-workers", type=int, default=int(os.environ.get("GDC_XP_FAULT_WORKERS") or DEFAULT_FAULT_WORKERS))
    p.add_argument("--shard-plan", default=os.environ.get("GDC_XP_SHARD_PLAN_PATH") or str(XP / "generated" / "shard-plan.json"))
    p.add_argument("--reports-root", default=os.environ.get("GDC_E2E_REPORTS_ROOT") or "")
    p.add_argument("--route-runtime", default=os.environ.get("GDC_XP_ROUTE_RUNTIME") or "ROUTE_ON")
    p.add_argument("--only-shard", action="append", default=[])
    p.add_argument("--resume", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--allow-fault-with-normal", action="store_true")
    p.add_argument("--stop-on-failure", action="store_true")
    p.add_argument("--limit-shards", type=int, default=0, help="Cap selected shards (measurement subsets)")
    return p.parse_args()


def run_worker(
    *,
    root: Path,
    e2e: Path,
    reports_root: Path,
    run_id: str,
    attempt: str,
    attempt_dir: Path,
    shard: str,
    worker_id: str,
    exp_commit: str,
    exp_hv: str,
    ids_file: Path,
    shard_plan: Path,
    exp_count: int,
    route_runtime: str,
    queue: str,
) -> dict:
    worker_dir = attempt_dir / "workers" / worker_id
    worker_dir.mkdir(parents=True, exist_ok=True)
    result_path = worker_dir / f"result-{shard}.json"
    if result_path.is_file():
        result_path.unlink()
    env = os.environ.copy()
    env.update(
        {
            "ROOT": str(root),
            "E2E": str(e2e),
            "REPORTS_ROOT": str(reports_root),
            "RUN_ID": run_id,
            "ATTEMPT": attempt,
            "ATTEMPT_DIR": str(attempt_dir),
            "SHARD": shard,
            "WORKER_ID": worker_id,
            "EXP_COMMIT": exp_commit,
            "EXP_HV": exp_hv,
            "IDS_FILE": str(ids_file),
            "SHARD_PLAN_RUNTIME": str(shard_plan),
            "EXP_COUNT": str(exp_count),
            "WORKER_RESULT_PATH": str(result_path),
            "GDC_XP_ROUTE_RUNTIME": route_runtime,
            "GDC_XP_QUEUE": queue,
        }
    )
    script = e2e / "cross-product" / "run-parallel-shard-worker.sh"
    proc = subprocess.run(["bash", str(script)], env=env, cwd=str(e2e))
    doc = {}
    if result_path.is_file():
        try:
            doc = json.loads(result_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            doc = {"ok": False, "reason": "WORKER_RESULT_CORRUPT"}
    doc["rc"] = proc.returncode
    if proc.returncode != 0:
        doc["ok"] = False
    else:
        doc.setdefault("ok", proc.returncode == 0)
    doc.setdefault("worker_id", worker_id)
    doc.setdefault("shard", shard)
    return doc


def drain_queue(
    *,
    queue: str,
    workers: int,
    attempt_dir: Path,
    run_dir: Path,
    route_runtime: str,
    run_worker_kwargs: dict,
    shard_meta: dict[str, dict],
    ids_dir: Path,
    stop_on_failure: bool,
) -> list[dict]:
    results: list[dict] = []
    if workers <= 0:
        return results

    def one_worker(wid: str) -> list[dict]:
        local: list[dict] = []
        while True:
            gen = new_generation_id()
            assigned = assign_next_shard(
                attempt_dir,
                worker_id=wid,
                queue=queue,
                generation_id=gen,
            )
            if not assigned.get("ok"):
                reason = assigned.get("reason")
                if reason in {"QUEUE_EMPTY", "FAULT_WAITS_FOR_NORMAL", "ASSIGNMENT_STOPPED"}:
                    break
                local.append({"ok": False, "worker_id": wid, "reason": reason, "shard": assigned.get("shard")})
                break
            shard = assigned["shard"]
            meta = shard_meta[shard]
            ids_file = ids_dir / f"{shard}.ids"
            if not ids_file.is_file():
                ids_file.write_text("\n".join(meta.get("combination_ids") or []) + "\n", encoding="utf-8")
            wr = run_worker(
                shard=shard,
                worker_id=wid,
                ids_file=ids_file,
                exp_count=int(meta.get("expected_count") or 0),
                queue=queue,
                **run_worker_kwargs,
            )
            rec = record_worker_result(
                attempt_dir,
                worker_id=wid,
                shard_id=shard,
                status="PASS" if wr.get("ok") else "FAIL",
                generation_id=wr.get("generation_id") or gen,
                detail=wr,
                stop_assignment_on_failure=stop_on_failure,
            )
            if wr.get("ok") and wr.get("art_dir"):
                pub = publish_shard_result(
                    src_art_dir=Path(wr["art_dir"]),
                    dest_art_dir=run_dir / f"{shard}-{route_runtime}",
                    validation=wr.get("validation") or {"ok": True, **{k: wr.get(k) for k in ("expected", "executed", "unique")}},
                )
                wr["published"] = pub
                if not pub.get("ok"):
                    wr["ok"] = False
                    wr["publish_reason"] = pub.get("reason")
            wr["record"] = {"ok": rec.get("ok"), "reason": rec.get("reason")}
            local.append(wr)
            if stop_on_failure and not wr.get("ok"):
                break
        return local

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(one_worker, f"{queue}-{i:02d}") for i in range(workers)]
        for fut in as_completed(futs):
            results.extend(fut.result())
    return results


def main() -> int:
    args = parse_args()
    reports_root = resolve_reports_root(args.reports_root or None, repo_root=ROOT)
    reports_root = Path(reports_root)
    run_id = args.run_id
    attempt = args.attempt
    run_dir = reports_root / run_id
    attempt_dir = run_dir / attempt
    attempt_dir.mkdir(parents=True, exist_ok=True)

    plan_raw = load_shard_plan(Path(args.shard_plan))
    classified = classify_shard_plan(plan_raw)
    catalog = XP / "generated" / "valid-combinations.jsonl"
    apply_route_runtime_scope(
        classified,
        route_runtime=args.route_runtime,
        route_index=load_combination_route_index(catalog),
    )
    shard_meta = {s["shard_id"]: s for s in classified["shards"]}
    selected = list(args.only_shard) if args.only_shard else [s["shard_id"] for s in classified["shards"]]
    if args.limit_shards and args.limit_shards > 0:
        selected = selected[: args.limit_shards]
    planned_shards = list(selected)
    reused_shards: list[str] = []

    commit = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    live = compute_harness_version(root=ROOT, commit=commit)
    harness = str(live.get("harness_version") or "")

    if args.resume:
        resume = select_resume_shards(
            all_shards=[shard_meta[s] for s in selected if s in shard_meta],
            reports_root=reports_root,
            run_id=run_id,
            route_runtime=args.route_runtime,
            expected_harness=harness,
            expected_commit=commit,
        )
        reused_shards = list(resume["reuse_shards"])
        selected = resume["rerun_shards"]
        atomic_write_json(attempt_dir / "resume-selection.json", resume)
        print(json.dumps({"event": "RESUME_SELECTION", **{k: resume[k] for k in ("reuse_count", "rerun_count", "reuse_shards", "rerun_shards")}}, indent=2))

    normal_workers = args.normal_workers if args.normal_workers is not None else args.workers
    exec_plan = build_parallel_execution_plan(
        selected,
        classified=classified,
        normal_workers=normal_workers,
        fault_workers=args.fault_workers,
        allow_fault_with_normal=args.allow_fault_with_normal,
    )
    atomic_write_json(attempt_dir / "parallel-execution-plan.json", {"classified": classified, "plan": exec_plan})

    if args.dry_run:
        print(json.dumps({"ok": exec_plan.get("ok"), "dry_run": True, "plan": exec_plan, "classified": {
            "PARALLEL_SAFE_SHARDS": classified["PARALLEL_SAFE_SHARDS"],
            "GLOBAL_FAULT_SHARDS": classified["GLOBAL_FAULT_SHARDS"],
            "SERIAL_ONLY_SHARDS": classified["SERIAL_ONLY_SHARDS"],
            "shard_count": classified["shard_count"],
            "total_combinations": classified["total_combinations"],
        }}, indent=2))
        return 0 if exec_plan.get("ok") else 2

    state = init_coordinator_state(
        attempt_dir,
        run_id=run_id,
        attempt=attempt,
        plan=exec_plan,
        harness_version=harness,
        commit=commit,
        reports_root=reports_root,
        route_runtime=args.route_runtime,
    )
    ids_dir = attempt_dir / "combination-ids"
    ids_dir.mkdir(parents=True, exist_ok=True)
    for sid in selected:
        meta = shard_meta[sid]
        (ids_dir / f"{sid}.ids").write_text("\n".join(meta.get("combination_ids") or []) + "\n", encoding="utf-8")

    worker_kwargs = {
        "root": ROOT,
        "e2e": E2E,
        "reports_root": reports_root,
        "run_id": run_id,
        "attempt": attempt,
        "attempt_dir": attempt_dir,
        "exp_commit": commit,
        "exp_hv": harness,
        "shard_plan": Path(args.shard_plan),
        "route_runtime": args.route_runtime,
    }

    started = time.time()
    all_results: list[dict] = []
    all_results.extend(
        drain_queue(
            queue="normal",
            workers=int(exec_plan["normal_workers"]),
            attempt_dir=attempt_dir,
            run_dir=run_dir,
            route_runtime=args.route_runtime,
            run_worker_kwargs=worker_kwargs,
            shard_meta=shard_meta,
            ids_dir=ids_dir,
            stop_on_failure=args.stop_on_failure,
        )
    )
    all_results.extend(
        drain_queue(
            queue="fault",
            workers=int(exec_plan["fault_workers"]),
            attempt_dir=attempt_dir,
            run_dir=run_dir,
            route_runtime=args.route_runtime,
            run_worker_kwargs=worker_kwargs,
            shard_meta=shard_meta,
            ids_dir=ids_dir,
            stop_on_failure=args.stop_on_failure,
        )
    )
    elapsed = time.time() - started

    contamination = detect_cross_worker_contamination(worker_results=all_results)
    jsonl_paths = [Path(r["jsonl_path"]) for r in all_results if r.get("jsonl_path")]
    for sid in reused_shards:
        published = run_dir / f"{sid}-{args.route_runtime}" / "cross-product-results.jsonl"
        if published.is_file():
            jsonl_paths.append(published)
    expected_ids: set[str] = set()
    for sid in planned_shards:
        expected_ids.update(shard_meta[sid].get("combination_ids") or [])
    merged = merge_worker_jsonl(jsonl_paths=jsonl_paths, expected_ids=expected_ids, expected_harness=harness)
    final = {
        "ok": all(r.get("ok") for r in all_results) and contamination.get("ok") and merged.get("ok"),
        "run_id": run_id,
        "attempt": attempt,
        "workers": exec_plan["normal_workers"],
        "fault_workers": exec_plan["fault_workers"],
        "elapsed_sec": round(elapsed, 3),
        "scenarios_per_sec": round((merged.get("executed") or 0) / elapsed, 4) if elapsed else 0,
        "contamination": contamination,
        "merge": merged,
        "recommended_workers": recommend_workers(measured_stable=exec_plan["normal_workers"]),
        "ended_at": utc_now(),
        "coordinator_state": load_coordinator_state(attempt_dir),
        "worker_results": [
            {k: r.get(k) for k in ("ok", "rc", "worker_id", "shard", "generation_id", "side_run_id", "jsonl_path")}
            for r in all_results
        ],
    }
    atomic_write_json(attempt_dir / "parallel-final-report.json", final)
    print(json.dumps(final, indent=2))
    return 0 if final["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
