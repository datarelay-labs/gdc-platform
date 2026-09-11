#!/usr/bin/env python3
"""Unit tests for bounded parallel Full E2E Matrix scheduler (no live lab)."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from parallel_lib import (  # noqa: E402
    GLOBAL_FAULT_TYPES,
    apply_route_runtime_scope,
    assign_next_shard,
    atomic_write_json,
    build_parallel_execution_plan,
    classify_scenario_axes,
    classify_shard,
    classify_shard_plan,
    detect_cross_worker_contamination,
    init_coordinator_state,
    merge_worker_jsonl,
    publish_shard_result,
    recommend_workers,
    record_worker_result,
    select_resume_shards,
    trusted_complete_marker_ok,
    worker_collector_channel,
    worker_resource_name_prefix,
    worker_s3_prefix,
    write_shard_complete_marker,
)

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS {name}")
    else:
        FAIL += 1
        print(f"FAIL {name} {detail}")


def test_classification() -> None:
    check("none_is_parallel_safe", classify_scenario_axes({"fault_type": "NONE"}) == "PARALLEL_SAFE")
    check("http_401_is_resource_isolated", classify_scenario_axes({"fault_type": "http_401"}) == "RESOURCE_ISOLATED")
    for ft in sorted(GLOBAL_FAULT_TYPES):
        check(f"global_fault_{ft}", classify_scenario_axes({"fault_type": ft}) == "GLOBAL_FAULT")
    check(
        "fault_shard",
        classify_shard({"shard_id": "xp-fault-000", "isolated_compose": True}) == "GLOBAL_FAULT",
    )
    check(
        "normal_shard",
        classify_shard({"shard_id": "xp-normal-000", "fault_count": 0}) == "PARALLEL_SAFE",
    )
    check("no_serial_convenience", classify_shard({"shard_id": "xp-normal-001"}) != "SERIAL_ONLY")


def test_plan_and_queues() -> None:
    plan = {
        "shards": [
            {"shard_id": "xp-normal-000", "combination_ids": ["a", "b"], "fault_count": 0},
            {"shard_id": "xp-normal-001", "combination_ids": ["c"], "fault_count": 0},
            {"shard_id": "xp-fault-000", "combination_ids": ["d"], "isolated_compose": True, "fault_count": 1},
        ]
    }
    classified = classify_shard_plan(plan)
    check("shard_count", classified["shard_count"] == 3)
    check("unique_combos", classified["unique_combinations"] == 4)
    check("no_serial", classified["SERIAL_ONLY_SHARDS"] == [])
    check("fault_isolated", classified["GLOBAL_FAULT_SHARDS"] == ["xp-fault-000"])
    check("parallel_safe", classified["PARALLEL_SAFE_SHARDS"] == ["xp-normal-000", "xp-normal-001"])
    exec_plan = build_parallel_execution_plan(
        ["xp-normal-000", "xp-normal-001", "xp-fault-000"],
        classified=classified,
        normal_workers=2,
        fault_workers=1,
    )
    check("plan_ok", exec_plan["ok"] is True)
    check("serialize_fault", exec_plan["concurrent_policy"] == "SERIALIZE_FAULT_AFTER_NORMAL")
    check("normal_queue", exec_plan["pending_normal"] == ["xp-normal-000", "xp-normal-001"])
    check("fault_queue", exec_plan["pending_fault"] == ["xp-fault-000"])


def test_isolation_namespaces() -> None:
    a = worker_resource_name_prefix(worker_id="n-00", generation_id="g1")
    b = worker_resource_name_prefix(worker_id="n-01", generation_id="g1")
    check("name_prefix_distinct", a != b and a.startswith("[FULL E2E][w-"))
    check("s3_prefix_distinct", worker_s3_prefix(worker_id="n-00", generation_id="g1") != worker_s3_prefix(worker_id="n-01", generation_id="g1"))
    check("channel_distinct", worker_collector_channel(worker_id="n-00", generation_id="g1") != worker_collector_channel(worker_id="n-01", generation_id="g1"))
    ch = worker_collector_channel(worker_id="n-00", generation_id="g1")
    check("channel_no_space", " " not in ch)


def test_scheduler_and_fault_wait() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        attempt = Path(tmp)
        classified = classify_shard_plan(
            {
                "shards": [
                    {"shard_id": "xp-normal-000", "combination_ids": ["a"]},
                    {"shard_id": "xp-fault-000", "combination_ids": ["b"], "isolated_compose": True},
                ]
            }
        )
        plan = build_parallel_execution_plan(
            ["xp-normal-000", "xp-fault-000"],
            classified=classified,
            normal_workers=2,
            fault_workers=1,
        )
        init_coordinator_state(
            attempt, run_id="r1", attempt="a1", plan=plan, harness_version="hv", commit="c"
        )
        fault_early = assign_next_shard(attempt, worker_id="f-00", queue="fault", generation_id="g0")
        check("fault_waits", fault_early.get("reason") == "FAULT_WAITS_FOR_NORMAL")
        n0 = assign_next_shard(attempt, worker_id="n-00", queue="normal", generation_id="g1")
        check("normal_assign", n0.get("ok") is True and n0.get("shard") == "xp-normal-000")
        dup = assign_next_shard(attempt, worker_id="n-01", queue="normal", generation_id="g2")
        check("normal_queue_empty_or_blocked", dup.get("ok") is False)
        rec = record_worker_result(attempt, worker_id="n-00", shard_id="xp-normal-000", status="PASS", generation_id="g1")
        check("record_pass", rec.get("ok") is True)
        fault = assign_next_shard(attempt, worker_id="f-00", queue="fault", generation_id="g3")
        check("fault_after_normal", fault.get("ok") is True and fault.get("shard") == "xp-fault-000")


def test_no_duplicate_assignment() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        attempt = Path(tmp)
        plan = build_parallel_execution_plan(["xp-normal-000", "xp-normal-001"], normal_workers=2)
        init_coordinator_state(attempt, run_id="r", attempt="a", plan=plan, harness_version="h", commit="c")
        a1 = assign_next_shard(attempt, worker_id="n-00", queue="normal", generation_id="g1")
        a2 = assign_next_shard(attempt, worker_id="n-01", queue="normal", generation_id="g2")
        check("two_workers_distinct_shards", a1["shard"] != a2["shard"])


def test_contamination_and_merge() -> None:
    wr = [
        {
            "worker_id": "n-00",
            "generation_id": "g1",
            "jsonl_path": "/tmp/a.jsonl",
            "collector_channel": "xpwn-00gg1",
            "name_prefix": "[FULL E2E][w-n-00][g-g1]",
            "combination_ids": ["c1"],
            "generation_ids_in_jsonl": ["g1"],
            "writer_owners": ["n-00"],
        },
        {
            "worker_id": "n-01",
            "generation_id": "g2",
            "jsonl_path": "/tmp/b.jsonl",
            "collector_channel": "xpwn-01gg2",
            "name_prefix": "[FULL E2E][w-n-01][g-g2]",
            "combination_ids": ["c2"],
            "generation_ids_in_jsonl": ["g2"],
            "writer_owners": ["n-01"],
        },
    ]
    clean = detect_cross_worker_contamination(worker_results=wr)
    check("no_contamination", clean["ok"] is True and clean["cross_worker_contamination"] == 0)
    wr[1]["combination_ids"] = ["c1"]
    dirty = detect_cross_worker_contamination(worker_results=wr)
    check("duplicate_scenario_detected", dirty["ok"] is False and dirty["scenario_duplicate"] == 1)

    with tempfile.TemporaryDirectory() as tmp:
        p1 = Path(tmp) / "w1.jsonl"
        p2 = Path(tmp) / "w2.jsonl"
        p1.write_text(
            json.dumps({"combination_id": "c1", "status": "PASS", "harness_version": "h"}) + "\n",
            encoding="utf-8",
        )
        p2.write_text(
            json.dumps({"combination_id": "c2", "status": "PASS", "harness_version": "h"}) + "\n",
            encoding="utf-8",
        )
        merged = merge_worker_jsonl(jsonl_paths=[p1, p2], expected_ids={"c1", "c2"}, expected_harness="h")
        check("merge_ok", merged["ok"] is True and merged["unique"] == 2 and merged["duplicates"] == 0)
        p2.write_text(
            json.dumps({"combination_id": "c1", "status": "PASS", "harness_version": "h"}) + "\n",
            encoding="utf-8",
        )
        dup = merge_worker_jsonl(jsonl_paths=[p1, p2], expected_ids={"c1", "c2"}, expected_harness="h")
        check("merge_dup_fail", dup["ok"] is False and dup["duplicates"] == 1)
        p2.write_text(
            json.dumps({"combination_id": "c2", "status": "FAIL", "harness_version": "h"}) + "\n",
            encoding="utf-8",
        )
        mixed = merge_worker_jsonl(jsonl_paths=[p1, p2], expected_ids={"c1", "c2"}, expected_harness="h")
        check("merge_ok_with_product_fail", mixed["ok"] is True and mixed["FAIL"] == 1 and mixed["PASS"] == 1)


def test_trusted_complete_fail_gate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        art = Path(tmp) / "xp-normal-000-ROUTE_ON"
        art.mkdir(parents=True)

        def _write(rows: list[dict[str, Any]], *, expected: int = 2) -> dict[str, Any]:
            (art / "cross-product-results.jsonl").write_text(
                "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8"
            )
            atomic_write_json(art / "shard-manifest.json", {"harness_version": "h", "git_commit": "abc"})
            return trusted_complete_marker_ok(art, expected_count=expected, expected_harness="h", expected_commit="abc")

        all_pass = _write(
            [
                {"combination_id": "on1", "status": "PASS", "harness_version": "h"},
                {"combination_id": "on2", "status": "PASS", "harness_version": "h"},
            ]
        )
        check("expected_complete_fail_zero_reusable", all_pass["reuse"] is True and all_pass["FAIL"] == 0)

        with_fail = _write(
            [
                {"combination_id": "on1", "status": "PASS", "harness_version": "h"},
                {"combination_id": "on2", "status": "FAIL", "harness_version": "h"},
            ]
        )
        check("expected_complete_fail_gt_zero_not_reusable", with_fail["reuse"] is False and with_fail["FAIL"] == 1)

        missing = _write([{"combination_id": "on1", "status": "PASS", "harness_version": "h"}], expected=2)
        check("missing_not_reusable", missing["reuse"] is False)

        dup_rows = [
            {"combination_id": "on1", "status": "PASS", "harness_version": "h"},
            {"combination_id": "on1", "status": "PASS", "harness_version": "h"},
        ]
        (art / "cross-product-results.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in dup_rows), encoding="utf-8"
        )
        dup = trusted_complete_marker_ok(art, expected_count=2, expected_harness="h", expected_commit="abc")
        check("duplicates_not_reusable", dup["reuse"] is False and dup["duplicates"] == 1)

        corrupt = Path(tmp) / "xp-normal-001-ROUTE_ON"
        corrupt.mkdir(parents=True)
        (corrupt / "cross-product-results.jsonl").write_text("{not json\n", encoding="utf-8")
        bad = trusted_complete_marker_ok(corrupt, expected_count=1, expected_harness="h")
        check("corrupt_evidence_not_reusable", bad["reuse"] is False and bad["reason"] == "CORRUPT_RESULT")


def test_route_scope_and_complete_with_fail() -> None:
    classified = {
        "shards": [
            {"shard_id": "xp-normal-000", "combination_ids": ["on1", "off1", "on2"], "expected_count": 3},
        ],
        "total_combinations": 3,
        "unique_combinations": 3,
    }
    idx = {"on1": "ROUTE_ON", "off1": "ROUTE_OFF", "on2": "ROUTE_ON"}
    apply_route_runtime_scope(classified, route_runtime="ROUTE_ON", route_index=idx)
    check("route_scope_count", classified["total_combinations"] == 2)
    check("route_scope_ids", classified["shards"][0]["combination_ids"] == ["on1", "on2"])
    check("route_scope_expected", classified["shards"][0]["expected_count"] == 2)

def test_resume_reuse_and_corrupt_reject() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        reports = Path(tmp)
        run = reports / "run1"
        art = run / "xp-normal-000-ROUTE_ON"
        art.mkdir(parents=True)
        rows = [
            {"combination_id": "c1", "status": "PASS", "harness_version": "h"},
            {"combination_id": "c2", "status": "PASS", "harness_version": "h"},
        ]
        (art / "cross-product-results.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8"
        )
        atomic_write_json(art / "shard-manifest.json", {"harness_version": "h", "git_commit": "abc"})
        ok = trusted_complete_marker_ok(art, expected_count=2, expected_harness="h", expected_commit="abc")
        check("trusted_complete", ok["reuse"] is True)
        write_shard_complete_marker(art, ok)

        pub_dest = run / "published" / "xp-normal-000-ROUTE_ON"
        pub = publish_shard_result(src_art_dir=art, dest_art_dir=pub_dest, validation=ok)
        check("publish_ok", pub.get("ok") is True and (pub_dest / "cross-product-results.jsonl").is_file())

        bad = run / "xp-normal-001-ROUTE_ON"
        bad.mkdir(parents=True)
        (bad / "cross-product-results.jsonl").write_text("{not json\n", encoding="utf-8")
        corrupt = trusted_complete_marker_ok(bad, expected_count=1, expected_harness="h")
        check("corrupt_reject", corrupt["reuse"] is False and corrupt["reason"] == "CORRUPT_RESULT")

        mismatch = run / "xp-normal-002-ROUTE_ON"
        mismatch.mkdir(parents=True)
        (mismatch / "cross-product-results.jsonl").write_text(
            json.dumps({"combination_id": "z", "status": "PASS", "harness_version": "old"}) + "\n",
            encoding="utf-8",
        )
        atomic_write_json(mismatch / "shard-manifest.json", {"harness_version": "old", "git_commit": "abc"})
        hv = trusted_complete_marker_ok(mismatch, expected_count=1, expected_harness="h")
        check("harness_mismatch_reject", hv["reuse"] is False)

        missing = run / "xp-normal-003-ROUTE_ON"
        miss = trusted_complete_marker_ok(missing, expected_count=1)
        check("missing_reject", miss["reuse"] is False and miss["reason"] == "FAILED_RESULT_MISSING")

        sel = select_resume_shards(
            all_shards=[
                {"shard_id": "xp-normal-000", "expected_count": 2, "combination_ids": ["c1", "c2"]},
                {"shard_id": "xp-normal-001", "expected_count": 1, "combination_ids": ["x"]},
                {"shard_id": "xp-normal-002", "expected_count": 1, "combination_ids": ["z"]},
                {"shard_id": "xp-normal-003", "expected_count": 1, "combination_ids": ["m"]},
            ],
            reports_root=reports,
            run_id="run1",
            expected_harness="h",
            expected_commit="abc",
        )
        check("reuse_only_trusted", sel["reuse_shards"] == ["xp-normal-000"])
        check("rerun_failed_missing_corrupt", set(sel["rerun_shards"]) == {"xp-normal-001", "xp-normal-002", "xp-normal-003"})


def test_recommend_workers() -> None:
    check("measured_wins", recommend_workers(nproc=64, measured_stable=2) == 2)
    check("cpu_capped", recommend_workers(nproc=8, measured_stable=None) == 2)
    check("min_one", recommend_workers(nproc=1, measured_stable=None) == 1)


def main() -> int:
    test_classification()
    test_plan_and_queues()
    test_isolation_namespaces()
    test_scheduler_and_fault_wait()
    test_no_duplicate_assignment()
    test_contamination_and_merge()
    test_route_scope_and_complete_with_fail()
    test_trusted_complete_fail_gate()
    test_resume_reuse_and_corrupt_reject()
    test_recommend_workers()
    print(f"\n{PASS} PASS / {FAIL} FAIL")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
