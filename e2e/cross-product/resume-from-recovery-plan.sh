#!/usr/bin/env bash
# Resume shards listed in a recovery-attempt plan, writing replacements
# under the attempt directory. Does not delete or move original artifacts.
#
# Reports root priority: --reports-root > GDC_E2E_REPORTS_ROOT > <repo>/e2e/reports
#
# Canary:
#   --only-shard xp-normal-000   (or --canary-shard)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/e2e"
RUN_ID="xp_full_on_20260717_101601"
ATTEMPT="recovery-attempt-001"
REPORTS_ROOT_CLI=""
DRY_RUN=0
ONLY_SHARD=""
WORKERS="${GDC_XP_WORKERS:-1}"
FAULT_WORKERS="${GDC_XP_FAULT_WORKERS:-1}"
# Optional catalog fallback (main checkout) when worktree generated/ lacks gitignored files.
CATALOG_FALLBACK_E2E="${GDC_XP_CATALOG_FALLBACK_E2E:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --attempt) ATTEMPT="$2"; shift 2 ;;
    --reports-root) REPORTS_ROOT_CLI="$2"; shift 2 ;;
    --only-shard|--canary-shard) ONLY_SHARD="$2"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --fault-workers) FAULT_WORKERS="$2"; shift 2 ;;
    --catalog-fallback-e2e) CATALOG_FALLBACK_E2E="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: resume-from-recovery-plan.sh [options]
  --run-id ID
  --attempt recovery-attempt-NNN
  --reports-root PATH
  --only-shard|--canary-shard SHARD_ID
  --workers N                 Parallel normal shards (default 1 = sequential)
  --fault-workers N           GLOBAL_FAULT concurrency (default 1)
  --catalog-fallback-e2e PATH   # e2e root containing generated/shard-plan.json
  --dry-run
EOF
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

RESOLVE_JSON="$(
  REPORTS_ROOT_CLI="$REPORTS_ROOT_CLI" ROOT="$ROOT" RUN_ID="$RUN_ID" ATTEMPT="$ATTEMPT" python3 - <<'PY'
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(os.environ["ROOT"]) / "e2e" / "cross-product"))
from recovery_lib import (
    classify_lock,
    resolve_reports_root_detailed,
    resolve_run_dir,
)

cli = (os.environ.get("REPORTS_ROOT_CLI") or "").strip() or None
root = Path(os.environ["ROOT"])
reports, source = resolve_reports_root_detailed(cli, repo_root=root)
try:
    run_dir = resolve_run_dir(os.environ["RUN_ID"], reports_root=reports, must_exist=True)
except FileNotFoundError as e:
    print(json.dumps({"ok": False, "error": str(e), "errors": [str(e)]}))
    raise SystemExit(0)

attempt = os.environ["ATTEMPT"]
attempt_dir = run_dir / attempt
plan = attempt_dir / "recovery-plan.json"
imm_path = run_dir / "immutable-run-manifest.json"
lock = reports / ".locks" / f"xp-full-recovery-{run_dir.name}.lock"
lock_info = classify_lock(lock)
errors = []
if not attempt_dir.is_dir():
    errors.append(f"attempt dir missing: {attempt_dir}")
if not plan.is_file():
    errors.append(f"missing {plan}")
if not imm_path.is_file():
    errors.append("missing immutable-run-manifest.json")
print(json.dumps({
    "ok": not errors,
    "errors": errors,
    "reports_root": str(reports),
    "reports_root_source": source,
    "run_dir": str(run_dir),
    "attempt_dir": str(attempt_dir),
    "plan": str(plan),
    "imm": str(imm_path),
    "lock_file": str(lock),
    "lock_status": lock_info["lock_status"],
}))
PY
)"

echo "$RESOLVE_JSON" > /tmp/xp-resume-resolve.json
if ! python3 -c "import json,sys;d=json.load(open('/tmp/xp-resume-resolve.json'));sys.exit(0 if d.get('ok') else 2)"; then
  echo "ERROR: failed to resolve recovery paths" >&2
  python3 -c "import json;d=json.load(open('/tmp/xp-resume-resolve.json'));print('\n'.join(d.get('errors') or [d.get('error','unknown')]))" >&2
  exit 2
fi

REPORTS_ROOT="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['reports_root'])")"
REPORTS_ROOT_SOURCE="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['reports_root_source'])")"
RUN_DIR="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['run_dir'])")"
ATTEMPT_DIR="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['attempt_dir'])")"
PLAN="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['plan'])")"
IMM="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['imm'])")"
LOCK_FILE="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['lock_file'])")"
LOCK_STATUS="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-resolve.json'))['lock_status'])")"

echo "reports_root=$REPORTS_ROOT (source=$REPORTS_ROOT_SOURCE)"
echo "run_dir=$RUN_DIR"
echo "attempt_dir=$ATTEMPT_DIR"
echo "lock_status=$LOCK_STATUS"

if [[ "$LOCK_STATUS" == "HELD_ACTIVE" ]]; then
  echo "ERROR: active recovery lock present: $LOCK_FILE" >&2
  exit 1
fi

HEAD="$(git -C "$ROOT" rev-parse HEAD)"
# Prefer attempt-scoped expected-fixed-harness.json when present (intentional harness upgrade
# for recovery-attempt-NNN). Never mutate run-level immutable-run-manifest.json.
ATTEMPT_EXPECTED="$ATTEMPT_DIR/expected-fixed-harness.json"
if [[ -f "$ATTEMPT_EXPECTED" ]]; then
  echo "using attempt-scoped expected harness: $ATTEMPT_EXPECTED"
  EXP_COMMIT="$(python3 -c "import json;print(json.load(open('$ATTEMPT_EXPECTED'))['git_commit'])")"
  EXP_HV="$(python3 -c "import json;print(json.load(open('$ATTEMPT_EXPECTED'))['harness_version'])")"
  EXP_MANIFEST="$(python3 -c "import json;print(json.load(open('$ATTEMPT_EXPECTED')).get('manifest_hash',''))")"
  EXP_RULES="$(python3 -c "import json;print(json.load(open('$ATTEMPT_EXPECTED')).get('applicability_rules_hash',''))")"
  EXP_AXES="$(python3 -c "import json;print(json.load(open('$ATTEMPT_EXPECTED')).get('axes_hash',''))")"
else
  EXP_COMMIT="$(python3 -c "import json;print(json.load(open('$IMM'))['git_commit'])")"
  EXP_HV="$(python3 -c "import json;print(json.load(open('$IMM'))['harness_version'])")"
  EXP_MANIFEST="$(python3 -c "import json;print(json.load(open('$IMM')).get('manifest_hash',''))")"
  EXP_RULES="$(python3 -c "import json;print(json.load(open('$IMM')).get('applicability_rules_hash',''))")"
  EXP_AXES="$(python3 -c "import json;print(json.load(open('$IMM')).get('axes_hash',''))")"
fi

LIVE_JSON="$(
  python3 - <<PY
import json, sys
from pathlib import Path
sys.path.insert(0, "$E2E/cross-product")
from recovery_lib import compute_harness_version
print(json.dumps(compute_harness_version(root=Path("$ROOT"), commit="$HEAD")))
PY
)"
LIVE_HV="$(python3 -c "import json,sys;print(json.load(sys.stdin)['harness_version'])" <<<"$LIVE_JSON")"
LIVE_MANIFEST="$(python3 -c "import json,sys;print(json.load(sys.stdin)['manifest_hash'])" <<<"$LIVE_JSON")"
LIVE_RULES="$(python3 -c "import json,sys;print(json.load(sys.stdin)['applicability_rules_hash'])" <<<"$LIVE_JSON")"
LIVE_AXES="$(python3 -c "import json,sys;print(json.load(sys.stdin)['axes_hash'])" <<<"$LIVE_JSON")"

echo "HEAD=$HEAD expected_commit=$EXP_COMMIT"
echo "live_harness=$LIVE_HV expected_harness=$EXP_HV"

fail_preflight=0
if [[ "$HEAD" != "$EXP_COMMIT" ]]; then
  echo "ERROR: HEAD must equal immutable git_commit (use fixed worktree)" >&2
  fail_preflight=1
fi
if [[ "$LIVE_HV" != "$EXP_HV" ]]; then
  echo "ERROR: HARNESS_DRIFT — refuse resume" >&2
  fail_preflight=1
fi
if [[ -n "$EXP_MANIFEST" && "$LIVE_MANIFEST" != "$EXP_MANIFEST" ]]; then
  echo "ERROR: manifest_hash mismatch" >&2
  fail_preflight=1
fi
if [[ -n "$EXP_RULES" && "$LIVE_RULES" != "$EXP_RULES" ]]; then
  echo "ERROR: applicability_rules_hash mismatch" >&2
  fail_preflight=1
fi
if [[ -n "$EXP_AXES" && "$LIVE_AXES" != "$EXP_AXES" ]]; then
  echo "ERROR: axes_hash mismatch" >&2
  fail_preflight=1
fi
if [[ -n "${GDC_XP_COMBINATION_IDS:-}" || -n "${GDC_XP_LIMIT:-}" ]]; then
  echo "ERROR: residual filters set (GDC_XP_COMBINATION_IDS / GDC_XP_LIMIT)" >&2
  fail_preflight=1
fi
if [[ "$REPORTS_ROOT" == "$E2E/reports" && ! -f "$PLAN" ]]; then
  echo "ERROR: refusing default worktree reports root without recovery plan" >&2
  fail_preflight=1
fi
if [[ "$fail_preflight" -ne 0 ]]; then
  exit 42
fi

# Default catalog fallback: sibling main checkout when worktree lacks gitignored generated files.
if [[ -z "$CATALOG_FALLBACK_E2E" && -f "/home/aella/gdc-platform/e2e/cross-product/generated/shard-plan.json" ]]; then
  CATALOG_FALLBACK_E2E="/home/aella/gdc-platform/e2e"
fi

PREFLIGHT_JSON="$(
  ROOT="$ROOT" E2E="$E2E" RUN_DIR="$RUN_DIR" ATTEMPT_DIR="$ATTEMPT_DIR" PLAN="$PLAN" \
  ONLY_SHARD="$ONLY_SHARD" CATALOG_FALLBACK_E2E="$CATALOG_FALLBACK_E2E" DRY_RUN="$DRY_RUN" \
  python3 - <<'PY'
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(os.environ["ROOT"]) / "e2e" / "cross-product"))
from recovery_lib import (
    ensure_recovery_snapshot_for_attempt,
    get_snapshot_shard,
    load_shard_plan_snapshot,
    preflight_selected_shards,
    read_json,
    resolve_catalog_paths,
    update_attempt_status,
    validate_recovery_plan_consistency,
    write_attempt_abort,
    write_combination_ids_file,
    write_runtime_shard_plan,
)

run_dir = Path(os.environ["RUN_DIR"])
attempt_dir = Path(os.environ["ATTEMPT_DIR"])
e2e = Path(os.environ["E2E"])
fallback = (os.environ.get("CATALOG_FALLBACK_E2E") or "").strip()
fallbacks = [Path(fallback)] if fallback else []
only = (os.environ.get("ONLY_SHARD") or "").strip()
dry = os.environ.get("DRY_RUN") == "1"

plan = read_json(Path(os.environ["PLAN"]), {}) or {}
rep_map = read_json(attempt_dir / "replacement-map.json", {}) or {}
consistency = validate_recovery_plan_consistency(plan, rep_map)
if not consistency.get("ok"):
    if not dry:
        write_attempt_abort(
            attempt_dir,
            reason="PLAN_INCONSISTENT",
            detail={"errors": consistency.get("errors") or []},
        )
    print(json.dumps({
        "ok": False,
        "reason": "PLAN_INCONSISTENT",
        "errors": consistency.get("errors") or [],
        "selected_count": 0,
        "selected_combinations": 0,
        "reuse_shards": len(plan.get("reuse_shards") or []),
        "rerun_selected": 0,
    }))
    raise SystemExit(0)

rerun = list(plan.get("rerun_shards") or [])
if only:
    if only not in rerun and only not in {s.get("shard_id") for s in plan.get("shards") or []}:
        write_attempt_abort(attempt_dir, reason="SHARD_PLAN_INVALID", detail={"only_shard": only, "error": "not in plan"})
        print(json.dumps({"ok": False, "reason": "SHARD_PLAN_INVALID", "errors": [f"only-shard not in plan: {only}"]}))
        raise SystemExit(0)
    selected = [only]
else:
    selected = rerun

if not dry:
    update_attempt_status(
        attempt_dir,
        source_run_id=run_dir.name,
        attempt=attempt_dir.name,
        phase="PREFLIGHT",
        status="PREFLIGHT",
        current_shard=selected[0] if selected else None,
        expected_shards=len(selected),
        completed_shards=0,
        failed_shards=0,
        pid=os.getpid(),
        process_identity="resume-from-recovery-plan",
        resumable=True,
    )

try:
    # Dry-run requires an existing snapshot (create via ensure step beforehand).
    # Live run may create the immutable snapshot once if missing.
    if dry:
        snapshot = load_shard_plan_snapshot(attempt_dir)
        if not snapshot:
            raise FileNotFoundError(
                f"shard-plan.snapshot.json missing under {attempt_dir} "
                "(create before --dry-run; dry-run does not write)"
            )
    else:
        snapshot = ensure_recovery_snapshot_for_attempt(
            run_dir=run_dir,
            attempt_dir=attempt_dir,
            e2e_root=e2e,
            fallback_e2e_roots=fallbacks,
            route_runtime="ROUTE_ON",
        )
except Exception as exc:
    if not dry:
        write_attempt_abort(
            attempt_dir,
            reason="SHARD_PLAN_MISSING",
            detail={"error": str(exc)},
        )
    print(json.dumps({"ok": False, "reason": "FAILED_PREFLIGHT_SHARD_PLAN_MISSING", "errors": [str(exc)]}))
    raise SystemExit(0)

# AUTHORITATIVE prior-attempt integrity gate (attempt-008+).
# When baseline is present: AUTH failures block resume; NON_AUTH drift never blocks.
baseline_path = attempt_dir / "prior-attempt-authoritative-baseline.json"
if baseline_path.is_file():
    from recovery_lib import preflight_prior_attempt_integrity

    integrity = preflight_prior_attempt_integrity(run_dir=run_dir, attempt_dir=attempt_dir)
    if not integrity.get("ok"):
        reason = integrity.get("reason") or "AUTHORITATIVE_INTEGRITY_FAILURE"
        if not dry:
            write_attempt_abort(
                attempt_dir,
                reason=reason,
                detail={
                    "AUTHORITATIVE_CONTENT_CHANGED": integrity.get("AUTHORITATIVE_CONTENT_CHANGED"),
                    "AUTHORITATIVE_MISSING": integrity.get("AUTHORITATIVE_MISSING"),
                    "AUTHORITATIVE_BASELINE_HASH_MISSING": integrity.get(
                        "AUTHORITATIVE_BASELINE_HASH_MISSING"
                    ),
                    "NON_AUTHORITATIVE_DRIFT": integrity.get("NON_AUTHORITATIVE_DRIFT"),
                    "dependency_coverage": integrity.get("dependency_coverage"),
                },
            )
        print(json.dumps({
            "ok": False,
            "reason": reason,
            "integrity": {
                "AUTHORITATIVE_CONTENT_CHANGED": integrity.get("AUTHORITATIVE_CONTENT_CHANGED"),
                "AUTHORITATIVE_MISSING": integrity.get("AUTHORITATIVE_MISSING"),
                "AUTHORITATIVE_MODE_CHANGED": integrity.get("AUTHORITATIVE_MODE_CHANGED"),
                "AUTHORITATIVE_METADATA_ONLY": integrity.get("AUTHORITATIVE_METADATA_ONLY"),
                "AUTHORITATIVE_BASELINE_HASH_MISSING": integrity.get(
                    "AUTHORITATIVE_BASELINE_HASH_MISSING"
                ),
                "NON_AUTHORITATIVE_DRIFT": integrity.get("NON_AUTHORITATIVE_DRIFT"),
                "full_resume_ready": integrity.get("full_resume_ready"),
                "final_canary_g5_monitor": integrity.get("final_canary_g5_monitor"),
            },
            "errors": [reason],
            "selected_count": 0,
            "selected_combinations": 0,
        }))
        raise SystemExit(0)

plan_expected = {}
for s in plan.get("shards") or []:
    if s.get("shard_id"):
        plan_expected[s["shard_id"]] = int(s.get("expected_combinations") or s.get("expected_count") or 0)

# Resolve catalog path for authoritative count audit + Playwright.
catalog = None
summary_path = None
try:
    _plan_p, _cat_p = resolve_catalog_paths(e2e_root=e2e, fallback_e2e_roots=fallbacks)
    catalog = str(_cat_p)
    cand_summary = _cat_p.parent / "generation-summary.json"
    if cand_summary.is_file():
        summary_path = cand_summary
except FileNotFoundError:
    for root in [e2e, *fallbacks]:
        cand = Path(root) / "cross-product" / "generated" / "valid-combinations.jsonl"
        if cand.is_file():
            catalog = str(cand)
            s = cand.parent / "generation-summary.json"
            if s.is_file():
                summary_path = s
            break

# Canary (--only-shard): shape-check the single shard; do not require full-catalog
# equation (remaining shards are intentionally not selected yet).
# Full/partial resume: authoritative equation uses reuse ∪ selected coverage.
reuse_ids = list(plan.get("reuse_shards") or [])
if only:
    pf = preflight_selected_shards(
        shard_ids=selected,
        snapshot=snapshot,
        plan_expected=plan_expected,
    )
else:
    coverage = sorted(set(reuse_ids) | set(selected))
    pf = preflight_selected_shards(
        shard_ids=selected,
        snapshot=snapshot,
        plan_expected=plan_expected,
        valid_combinations_path=Path(catalog) if catalog else None,
        route_runtime="ROUTE_ON",
        generation_summary_path=summary_path,
        coverage_shard_ids=coverage,
    )
if not pf["ok"]:
    if not dry:
        write_attempt_abort(
            attempt_dir,
            reason=pf.get("reason") or "SHARD_PLAN_INVALID",
            detail=pf,
        )
    print(json.dumps({"ok": False, **pf}))
    raise SystemExit(0)

# Materialize per-shard selector artifacts under attempt (not worktree generated/).
# Dry-run must not create directories or files.
runtime_root = attempt_dir / "runtime-selectors"
if not dry:
    runtime_root.mkdir(parents=True, exist_ok=True)
shard_docs = []
for sid in selected:
    snap_shard = get_snapshot_shard(snapshot, sid)
    ids = list(snap_shard["combination_ids"])
    ids_file = runtime_root / f"{sid}.combination_ids.txt"
    plan_file = runtime_root / f"{sid}.shard-plan.json"
    if not dry:
        write_combination_ids_file(ids_file, ids)
        write_runtime_shard_plan(plan_file, sid, ids, route_mode="ROUTE_ON")
    shard_docs.append({
        "shard_id": sid,
        "expected_count": snap_shard["expected_count"],
        "combination_ids": snap_shard["expected_count"],
        "combination_ids_hash": snap_shard["combination_ids_hash"],
        "ids_file": str(ids_file),
        "shard_plan_path": str(plan_file),
        # Output is generation-scoped; active pointer lives in replacement-map.
        "replacement_output_dir": str(
            attempt_dir / "replacements" / "generations" / sid / "<generation_id>-ROUTE_ON"
        ),
        "legacy_replacement_dir": str(attempt_dir / "replacements" / f"{sid}-ROUTE_ON"),
    })

print(json.dumps({
    "ok": True,
    "selected_shards": selected,
    "selected_count": len(selected),
    "selected_combinations": pf["selected_combinations"],
    "authoritative_count": pf.get("authoritative_count"),
    "snapshot_count": pf.get("snapshot_count"),
    "snapshot_unique": pf.get("snapshot_unique"),
    "selected_count_combinations": pf.get("selected_count"),
    "shard_expected_sum": pf.get("shard_expected_sum"),
    "normal_count": pf.get("normal_count"),
    "fault_count": pf.get("fault_count"),
    "route_on_count": pf.get("route_on_count"),
    "route_off_count": pf.get("route_off_count"),
    "missing": pf.get("missing"),
    "extra": pf.get("extra"),
    "duplicate": pf.get("duplicate"),
    "unassigned": pf.get("unassigned"),
    "multi_assigned": pf.get("multi_assigned"),
    "authoritative_catalog_missing": pf.get("authoritative_catalog_missing"),
    "authoritative_catalog_extra": pf.get("authoritative_catalog_extra"),
    "snapshot_missing": pf.get("snapshot_missing"),
    "snapshot_extra": pf.get("snapshot_extra"),
    "plan_missing": pf.get("plan_missing"),
    "plan_extra": pf.get("plan_extra"),
    "equation_ok": pf.get("equation_ok"),
    "other_shards": 0 if only else max(0, len(rerun) - len(selected)),
    "snapshot_path": str(attempt_dir / "shard-plan.snapshot.json"),
    "snapshot_hash": snapshot.get("snapshot_hash"),
    "snapshot_shard_count": snapshot.get("shard_count"),
    "canary": bool(only),
    "canary_required": (not only) and ("xp-normal-000" in selected),
    "reuse_shards": list(plan.get("reuse_shards") or []),
    "reuse_shard_count": len(plan.get("reuse_shards") or []),
    "rerun_selected": len(selected),
    "xp_normal_000_selected": "xp-normal-000" in selected,
    "plan_consistent": True,
    "valid_combinations_path": catalog,
    "shards": shard_docs,
    "files_written": 0 if dry else len(selected) * 2,
    "lock_created": 0,
    "shards_executed": 0,
    "generation_created": 0,
    "pointer_changed": 0,
    "count_audit": pf.get("count_audit"),
}))
PY
)"

echo "$PREFLIGHT_JSON" > /tmp/xp-resume-preflight.json
python3 -c "import json;d=json.load(open('/tmp/xp-resume-preflight.json'));keys=['ok','reason','selected_count','selected_combinations','reuse_shard_count','rerun_selected','xp_normal_000_selected','authoritative_count','snapshot_count','snapshot_unique','shard_expected_sum','normal_count','fault_count','route_on_count','route_off_count','missing','extra','duplicate','unassigned','multi_assigned','equation_ok','canary_required','files_written','lock_created','shards_executed','generation_created','pointer_changed','snapshot_path','snapshot_hash','canary','errors'];print(json.dumps({k:d.get(k) for k in keys if k in d or k in ('ok','errors')}, indent=2))"
if ! python3 -c "import json,sys;d=json.load(open('/tmp/xp-resume-preflight.json'));sys.exit(0 if d.get('ok') else 2)"; then
  echo "ERROR: recovery preflight failed" >&2
  python3 -c "import json;d=json.load(open('/tmp/xp-resume-preflight.json'));print('\n'.join(d.get('errors') or [d.get('reason','unknown')]))" >&2
  exit 43
fi

mapfile -t RERUN < <(python3 -c "import json;print('\n'.join(json.load(open('/tmp/xp-resume-preflight.json'))['selected_shards']))")
REUSE_COUNT="$(python3 -c "import json;print(len(json.load(open('$PLAN')).get('reuse_shards') or []))")"
echo "reuse_shards=$REUSE_COUNT rerun_selected=${#RERUN[@]} only_shard=${ONLY_SHARD:-"(all rerun)"}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  python3 - <<PY
import json
d=json.load(open("/tmp/xp-resume-preflight.json"))
for s in d["shards"]:
    print(f"shard={s['shard_id']} expected={s['expected_count']} combinations={s['combination_ids']} hash={s['combination_ids_hash']}")
    print(f"  replacement_output_dir={s['replacement_output_dir']}")
print(f"selected_shards={d['selected_count']} other_shards={d['other_shards']}")
print(f"authoritative_count={d.get('authoritative_count')}")
print(f"snapshot_count={d.get('snapshot_count')} snapshot_unique={d.get('snapshot_unique')}")
print(f"selected_combinations={d.get('selected_combinations')} shard_expected_sum={d.get('shard_expected_sum')}")
print(f"normal_count={d.get('normal_count')} fault_count={d.get('fault_count')}")
print(f"route_on_count={d.get('route_on_count')} route_off_count={d.get('route_off_count')}")
print(f"missing={d.get('missing')} extra={d.get('extra')} duplicate={d.get('duplicate')}")
print(f"unassigned={d.get('unassigned')} multi_assigned={d.get('multi_assigned')}")
print(f"equation_ok={d.get('equation_ok')} canary_required={d.get('canary_required')}")
print(f"reuse_shards={d.get('reuse_shard_count')} rerun_selected={d.get('rerun_selected')}")
print(f"xp_normal_000_selected={d.get('xp_normal_000_selected')}")
print(f"snapshot={d['snapshot_path']}")
print(f"valid_combinations_path={d.get('valid_combinations_path')}")
print("DRY_RUN complete — no shards started")
print(
    f"shards_executed={d.get('shards_executed', 0)} "
    f"files_written={d.get('files_written', 0)} "
    f"lock_created={d.get('lock_created', 0)} "
    f"generation_created={d.get('generation_created', 0)} "
    f"pointer_changed={d.get('pointer_changed', 0)}"
)
PY
  exit 0
fi

export GDC_E2E_REPORTS_ROOT="$REPORTS_ROOT"
export GDC_XP_ROUTE_RUNTIME=ROUTE_ON
export GDC_ROUTE_PROCESSING_ENABLED=true
export GDC_XP_EXPECTED_HARNESS="$EXP_HV"
export GDC_XP_COMMIT="$EXP_COMMIT"
unset GDC_XP_COMBINATION_IDS GDC_XP_LIMIT || true

VALID_COMBOS="$(python3 -c "import json;print(json.load(open('/tmp/xp-resume-preflight.json')).get('valid_combinations_path') or '')")"
if [[ -z "$VALID_COMBOS" || ! -f "$VALID_COMBOS" ]]; then
  echo "ERROR: valid-combinations.jsonl not found for Playwright" >&2
  python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, "$E2E/cross-product")
from recovery_lib import write_attempt_abort
write_attempt_abort(Path("$ATTEMPT_DIR"), reason="SHARD_PLAN_MISSING", detail={"error": "valid-combinations.jsonl missing"})
PY
  exit 43
fi
export GDC_XP_VALID_COMBINATIONS_PATH="$VALID_COMBOS"

if [[ "${WORKERS}" -gt 1 ]]; then
  echo "PARALLEL resume workers=$WORKERS fault_workers=$FAULT_WORKERS shards=${#RERUN[@]}"
  PAR_ARGS=(
    --run-id "$RUN_ID"
    --attempt "$ATTEMPT"
    --workers "$WORKERS"
    --fault-workers "$FAULT_WORKERS"
    --reports-root "$REPORTS_ROOT"
    --route-runtime "${GDC_XP_ROUTE_RUNTIME:-ROUTE_ON}"
  )
  for shard in "${RERUN[@]}"; do
    PAR_ARGS+=(--only-shard "$shard")
  done
  exec python3 "$E2E/cross-product/parallel-matrix-coordinator.py" "${PAR_ARGS[@]}"
fi

REPL_ROOT="$ATTEMPT_DIR/replacements"
mkdir -p "$REPL_ROOT"

PHASE="RESUME_RUNNING"
if [[ -n "$ONLY_SHARD" ]]; then
  PHASE="CANARY_RUNNING"
fi
python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, "$E2E/cross-product")
from recovery_lib import update_attempt_status, utc_now
update_attempt_status(
    Path("$ATTEMPT_DIR"),
    status="$PHASE",
    phase="$PHASE",
    started_at=utc_now(),
    expected_shards=${#RERUN[@]},
    current_shard="${RERUN[0]}",
)
PY

COMPLETED=0
for shard in "${RERUN[@]}"; do
  IDS_FILE="$(python3 -c "import json;d=json.load(open('/tmp/xp-resume-preflight.json'));print(next(s['ids_file'] for s in d['shards'] if s['shard_id']=='$shard'))")"
  SHARD_PLAN_RUNTIME="$(python3 -c "import json;d=json.load(open('/tmp/xp-resume-preflight.json'));print(next(s['shard_plan_path'] for s in d['shards'] if s['shard_id']=='$shard'))")"
  EXP_COUNT="$(python3 -c "import json;d=json.load(open('/tmp/xp-resume-preflight.json'));print(next(s['expected_count'] for s in d['shards'] if s['shard_id']=='$shard'))")"

  # Always allocate a fresh generation side-run. Never reuse fixed SIDE_ID paths.
  ALLOC_JSON="$(
    REPORTS_ROOT="$REPORTS_ROOT" RUN_ID="$RUN_ID" ATTEMPT="$ATTEMPT" SHARD="$shard" \
    EXP_COMMIT="$EXP_COMMIT" EXP_HV="$EXP_HV" ATTEMPT_DIR="$ATTEMPT_DIR" E2E="$E2E" \
    python3 - <<'PY'
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(os.environ["E2E"]) / "cross-product"))
from recovery_lib import allocate_side_run_generation
r = allocate_side_run_generation(
    reports_root=Path(os.environ["REPORTS_ROOT"]),
    run_id=os.environ["RUN_ID"],
    attempt=os.environ["ATTEMPT"],
    shard_id=os.environ["SHARD"],
    commit=os.environ["EXP_COMMIT"],
    harness_version=os.environ["EXP_HV"],
    attempt_dir=Path(os.environ["ATTEMPT_DIR"]),
    parent_pid=os.getppid(),
    dry_run=False,
)
print(json.dumps(r))
if not r.get("ok"):
    raise SystemExit(49 if r.get("reason") == "SHARD_ALREADY_RUNNING" else 50)
PY
  )"
  echo "$ALLOC_JSON" >"$ATTEMPT_DIR/last-side-run-alloc-$shard.json"
  SIDE_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['side_run_id'])" "$ALLOC_JSON")"
  GENERATION_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['generation_id'])" "$ALLOC_JSON")"
  SIDE_DIR="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['side_run_dir'])" "$ALLOC_JSON")"
  echo "==== RESUME FULL shard=$shard side_run=$SIDE_ID generation=$GENERATION_ID ===="

  export GDC_E2E_RUN_ID="$SIDE_ID"
  export GDC_XP_SHARD_FILTER="$shard"
  export GDC_XP_SHARD="$shard"
  export GDC_XP_SHARD_PLAN_PATH="$SHARD_PLAN_RUNTIME"
  export GDC_XP_COMBINATION_IDS_FILE="$IDS_FILE"
  export GDC_XP_GENERATION_ID="$GENERATION_ID"
  export GDC_XP_ATTEMPT="$ATTEMPT"
  export GDC_XP_SIDE_RUN_DIR="$SIDE_DIR"
  unset GDC_XP_CONTINUE || true

  # Env verification (explicit)
  python3 - <<PY
import os, sys
checks = {
    "GDC_E2E_REPORTS_ROOT": os.environ.get("GDC_E2E_REPORTS_ROOT"),
    "GDC_E2E_RUN_ID": os.environ.get("GDC_E2E_RUN_ID"),
    "GDC_XP_SHARD": os.environ.get("GDC_XP_SHARD"),
    "GDC_XP_SHARD_PLAN_PATH": os.environ.get("GDC_XP_SHARD_PLAN_PATH"),
    "GDC_XP_COMBINATION_IDS_FILE": os.environ.get("GDC_XP_COMBINATION_IDS_FILE"),
    "GDC_XP_VALID_COMBINATIONS_PATH": os.environ.get("GDC_XP_VALID_COMBINATIONS_PATH"),
    "GDC_XP_ROUTE_RUNTIME": os.environ.get("GDC_XP_ROUTE_RUNTIME"),
    "GDC_XP_LIMIT": os.environ.get("GDC_XP_LIMIT"),
    "GDC_XP_COMBINATION_IDS": os.environ.get("GDC_XP_COMBINATION_IDS"),
    "GDC_XP_GENERATION_ID": os.environ.get("GDC_XP_GENERATION_ID"),
    "GDC_XP_ATTEMPT": os.environ.get("GDC_XP_ATTEMPT"),
}
print("ENV_CHECK", checks)
assert checks["GDC_XP_SHARD"] == "$shard"
assert checks["GDC_XP_ROUTE_RUNTIME"] == "ROUTE_ON"
assert checks["GDC_XP_LIMIT"] in (None, "")
assert checks["GDC_XP_COMBINATION_IDS"] in (None, "")
assert checks["GDC_XP_COMBINATION_IDS_FILE"]
assert open(checks["GDC_XP_COMBINATION_IDS_FILE"]).read().count("\n") >= int("$EXP_COUNT")
assert checks["GDC_XP_SHARD_PLAN_PATH"] and __import__("pathlib").Path(checks["GDC_XP_SHARD_PLAN_PATH"]).is_file()
assert checks["GDC_XP_GENERATION_ID"] == "$GENERATION_ID"
assert checks["GDC_XP_ATTEMPT"] == "$ATTEMPT"
assert "__generation-" in (checks["GDC_E2E_RUN_ID"] or "")
assert checks["GDC_E2E_RUN_ID"] == "$SIDE_ID"
# Refuse legacy fixed path reuse (braced expansion avoids RUN_ID_ parse).
legacy = "${RUN_ID}__${ATTEMPT}__${shard}"
assert checks["GDC_E2E_RUN_ID"] != legacy, "refusing fixed side-run path reuse"
PY

  if [[ "$REPORTS_ROOT" != "$E2E/reports" ]]; then
    mkdir -p "$E2E/reports"
    ln -sfn "$SIDE_DIR" "$E2E/reports/$SIDE_ID"
  fi

  python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, "$E2E/cross-product")
from recovery_lib import update_attempt_status
update_attempt_status(
    Path("$ATTEMPT_DIR"),
    current_shard="$shard",
    current_expected=int("$EXP_COUNT"),
    current_executed=0,
)
PY

  set +e
  "$E2E/cross-product/run-all-shards.sh"
  RC=$?
  set -e
  if [[ "$RC" -eq 42 ]]; then
    echo "ERROR: HARNESS_DRIFT during resume" >&2
    python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, "$E2E/cross-product")
from recovery_lib import finalize_side_run_generation, update_attempt_status, utc_now
finalize_side_run_generation(
    side_run_dir=Path("$SIDE_DIR"),
    attempt_dir=Path("$ATTEMPT_DIR"),
    shard_id="$shard",
    generation_id="$GENERATION_ID",
    status="ABORTED",
    reason="HARNESS_DRIFT",
)
update_attempt_status(Path("$ATTEMPT_DIR"), status="ABORTED", phase="ABORTED", abort_reason="HARNESS_DRIFT", ended_at=utc_now(), resumable=True, final_verdict="ABORTED_HARNESS_DRIFT")
PY
    exit 42
  fi
  if [[ "$RC" -ne 0 ]]; then
    echo "ERROR: shard runner failed rc=$RC" >&2
    FAIL_STATUS="FAILED_REPLACEMENT_VALIDATION"
    if [[ -n "$ONLY_SHARD" ]]; then
      CANARY_SHARD="$(python3 -c "import json;print(json.load(open('$ATTEMPT_DIR/recovery-plan.json')).get('canary_shard') or 'xp-normal-000')")"
      if [[ "$ONLY_SHARD" == "$CANARY_SHARD" ]]; then
        FAIL_STATUS="CANARY_FAIL"
      else
        FAIL_STATUS="SHARD_VALIDATION_FAIL"
      fi
    fi
    if [[ "$RC" -eq 43 || "$RC" -eq 44 ]]; then FAIL_STATUS="FAILED_PREFLIGHT"; fi
    python3 - <<PY
import sys
from pathlib import Path
sys.path.insert(0, "$E2E/cross-product")
from recovery_lib import (
    finalize_side_run_generation,
    update_attempt_status,
    utc_now,
    quarantine_failed_replacement,
)
src = Path("$REPORTS_ROOT/$SIDE_ID/${shard}-ROUTE_ON")
if src.is_dir():
    quarantine_failed_replacement(src_dir=src, attempt_dir=Path("$ATTEMPT_DIR"), shard_id="$shard", reason=f"runner_rc_$RC")
finalize_side_run_generation(
    side_run_dir=Path("$SIDE_DIR"),
    attempt_dir=Path("$ATTEMPT_DIR"),
    shard_id="$shard",
    generation_id="$GENERATION_ID",
    status="FAILED",
    reason=f"runner_rc_$RC",
)
update_attempt_status(
    Path("$ATTEMPT_DIR"),
    status="$FAIL_STATUS",
    phase="$FAIL_STATUS",
    failed_shards=1,
    abort_reason=f"runner_rc_$RC",
    ended_at=utc_now(),
    resumable=True,
    final_verdict="$FAIL_STATUS",
)
PY
    exit "$RC"
  fi

  SRC="$REPORTS_ROOT/$SIDE_ID/${shard}-ROUTE_ON"
  if [[ ! -d "$SRC" ]]; then SRC="$E2E/reports/$SIDE_ID/${shard}-ROUTE_ON"; fi
  # Legacy fixed path is NEVER the publish destination (attempt-010+).
  # Active replacement is selected via replacement-map active pointer.

  python3 - <<PY
import json, sys
from pathlib import Path
sys.path.insert(0, "$E2E/cross-product")
from recovery_lib import (
    build_generation_authority_baseline,
    finalize_post_canary_success,
    finalize_side_run_generation,
    get_snapshot_shard,
    load_shard_plan_snapshot,
    publish_and_activate_generation_replacement,
    quarantine_failed_replacement,
    read_json,
    update_attempt_status,
    utc_now,
    validate_replacement_artifact,
    write_json,
)

attempt = Path("$ATTEMPT_DIR")
src = Path("$SRC")
side_dir = Path("$SIDE_DIR")
generation_id = "$GENERATION_ID"
snapshot = load_shard_plan_snapshot(attempt)
snap_shard = get_snapshot_shard(snapshot, "$shard")
expected = int(snap_shard["expected_count"])
ids = list(snap_shard["combination_ids"])

validation = validate_replacement_artifact(
    art_dir=src,
    shard_id="$shard",
    expected_count=expected,
    expected_harness="$EXP_HV",
    expected_commit="$EXP_COMMIT",
    expected_ids=ids,
    expected_generation_id=generation_id,
    expected_attempt="$ATTEMPT",
    side_run_dir=side_dir,
)
write_json(attempt / f"validate-$shard.json", validation)
print(json.dumps(validation, indent=2))
if not validation.get("ok"):
    if src.is_dir():
        quarantine_failed_replacement(
            src_dir=src,
            attempt_dir=attempt,
            shard_id="$shard",
            reason=validation.get("reason") or "FAILED_REPLACEMENT_VALIDATION",
        )
    finalize_side_run_generation(
        side_run_dir=side_dir,
        attempt_dir=attempt,
        shard_id="$shard",
        generation_id=generation_id,
        status="FAILED",
        reason=validation.get("reason"),
    )
    status = "FAILED_REPLACEMENT_VALIDATION"
    if ("$ONLY_SHARD" or "").strip():
        plan_doc = read_json(attempt / "recovery-plan.json", {}) or {}
        canary_shard = str(plan_doc.get("canary_shard") or "xp-normal-000")
        status = "CANARY_FAIL" if ("$ONLY_SHARD".strip() == canary_shard) else "SHARD_VALIDATION_FAIL"
    update_attempt_status(
        attempt,
        status=status,
        phase=status,
        failed_shards=1,
        current_executed=int(validation.get("executed") or 0),
        abort_reason=validation.get("reason"),
        ended_at=utc_now(),
        resumable=True,
        final_verdict=status,
    )
    raise SystemExit(46)

only_shard = ("$ONLY_SHARD" or "").strip()
plan_doc = read_json(attempt / "recovery-plan.json", {}) or {}
canary_shard = str(plan_doc.get("canary_shard") or "xp-normal-000")
is_canary_finalize = bool(only_shard) and only_shard == canary_shard and only_shard == "$shard"

# Immutable generation publish + active pointer switch (never overwrite legacy DST).
pub = publish_and_activate_generation_replacement(
    src_dir=src,
    attempt_dir=attempt,
    shard_id="$shard",
    generation_id=generation_id,
    commit="$EXP_COMMIT",
    harness_version="$EXP_HV",
    validation=validation,
    merge_eligible=bool(is_canary_finalize),
    original_path=str(Path("$RUN_DIR") / "${shard}-ROUTE_ON"),
)
print(json.dumps({
    "ok": pub.get("ok"),
    "reason": pub.get("reason"),
    "dst": pub.get("dst"),
    "generation_id": pub.get("generation_id"),
    "content_sha256": pub.get("content_sha256"),
    "generation_publish": pub.get("generation_publish"),
    "active_pointer_switch": pub.get("active_pointer_switch"),
    "files_written": pub.get("files_written"),
    "pointer_changed": pub.get("pointer_changed"),
    "legacy_untouched": pub.get("legacy_untouched"),
}, indent=2))
if not pub.get("ok"):
    finalize_side_run_generation(
        side_run_dir=side_dir,
        attempt_dir=attempt,
        shard_id="$shard",
        generation_id=generation_id,
        status="FAILED",
        reason=pub.get("reason"),
    )
    fail_status = (
        "FAILED_ACTIVE_POINTER_SWITCH"
        if pub.get("generation_publish") == "PASS" and pub.get("active_pointer_switch") == "FAIL"
        else "FAILED_REPLACEMENT_VALIDATION"
    )
    update_attempt_status(
        attempt,
        status=fail_status,
        phase=fail_status,
        abort_reason=pub.get("reason"),
        ended_at=utc_now(),
        resumable=True,
        final_verdict=fail_status,
    )
    raise SystemExit(47)

dst = Path(pub["dst"])
pub_val = validate_replacement_artifact(
    art_dir=dst,
    shard_id="$shard",
    expected_count=expected,
    expected_harness="$EXP_HV",
    expected_commit="$EXP_COMMIT",
    expected_ids=ids,
    expected_generation_id=generation_id,
    expected_attempt="$ATTEMPT",
    side_run_dir=side_dir,
)
write_json(dst / "validation.json", pub_val)
write_json(attempt / f"validate-$shard.json", pub_val)
if not pub_val.get("ok"):
    finalize_side_run_generation(
        side_run_dir=side_dir,
        attempt_dir=attempt,
        shard_id="$shard",
        generation_id=generation_id,
        status="FAILED",
        reason=pub_val.get("reason"),
    )
    raise SystemExit(46)

if is_canary_finalize:
    fin = finalize_post_canary_success(
        attempt_dir=attempt,
        shard_id="$shard",
        validation=pub_val,
        publish=pub,
        expected_count=expected,
        expected_harness="$EXP_HV",
        expected_commit="$EXP_COMMIT",
        replacement_path=str(dst),
        original_path=str(Path("$RUN_DIR") / "${shard}-ROUTE_ON"),
    )
    print(json.dumps(fin, indent=2))
    if not fin.get("ok"):
        finalize_side_run_generation(
            side_run_dir=side_dir,
            attempt_dir=attempt,
            shard_id="$shard",
            generation_id=generation_id,
            status="FAILED",
            reason=fin.get("reason"),
        )
        update_attempt_status(
            attempt,
            status="FAILED_POST_CANARY_FINALIZE",
            phase="FAILED_POST_CANARY_FINALIZE",
            abort_reason=fin.get("reason"),
            ended_at=utc_now(),
            resumable=True,
            final_verdict="FAILED_POST_CANARY_FINALIZE",
        )
        raise SystemExit(48)
else:
    # Non-canary: pointer already activated with merge_eligible=false.
    # Annotate side_run_id for evidence; do NOT canary-promote.
    rep_map_path = attempt / "replacement-map.json"
    rep_map = json.loads(rep_map_path.read_text()) if rep_map_path.exists() else {}
    entry = dict(rep_map.get("$shard") or {})
    entry["side_run_id"] = "$SIDE_ID"
    entry["generation_id"] = generation_id
    entry["merge_eligible"] = False
    rep_map["$shard"] = entry
    write_json(rep_map_path, rep_map)
    update_attempt_status(
        attempt,
        status="SHARD_VALIDATED" if only_shard else "RESUME_RUNNING",
        phase="SHARD_VALIDATED" if only_shard else "RESUME_RUNNING",
        completed_shards=1,
        current_executed=int(pub_val.get("executed") or 0),
        current_shard="$shard",
        final_verdict="SHARD_VALIDATED" if only_shard else "RESUME_RUNNING",
        resumable=True,
    )

build_generation_authority_baseline(side_run_dir=side_dir, art_dir=src)
finalize_side_run_generation(
    side_run_dir=side_dir,
    attempt_dir=attempt,
    shard_id="$shard",
    generation_id=generation_id,
    status="COMPLETE",
    validation=pub_val,
    publish=pub,
)
print(json.dumps({
    "shard": "$shard",
    "generation_id": generation_id,
    "status": "COMPLETE",
    "generation_publish": pub.get("generation_publish"),
    "active_pointer_switch": pub.get("active_pointer_switch"),
    "active_path": pub.get("dst"),
}, indent=2))
PY

  COMPLETED=$((COMPLETED + 1))
  # Single-shard mode: never continue to remaining shards.
  if [[ -n "$ONLY_SHARD" ]]; then
    if [[ "$ONLY_SHARD" == "xp-normal-000" || "$ONLY_SHARD" == "$(python3 -c "import json;print(json.load(open('$ATTEMPT_DIR/recovery-plan.json')).get('canary_shard') or 'xp-normal-000')")" ]]; then
      echo "CANARY_PASS shard=$shard — stopping (remaining shards not started; Case B remaining=31 after canary reuse)"
    else
      echo "ONLY_SHARD_PASS shard=$shard — stopping without canary promote (canary_shard remains separate)"
    fi
    break
  fi
done

echo "RESUME complete selected=${#RERUN[@]} completed=$COMPLETED under $REPL_ROOT"
if [[ -n "$ONLY_SHARD" ]]; then
  if [[ "$ONLY_SHARD" == "xp-normal-000" ]]; then
    echo "final_verdict=CANARY_PASS"
  else
    echo "final_verdict=SHARD_VALIDATED only_shard=$ONLY_SHARD"
  fi
elif [[ "$COMPLETED" -ge "${#RERUN[@]}" && "${#RERUN[@]}" -gt 0 ]]; then
  # Full Resume completed all selected rerun shards — batch finalize merge eligibility.
  python3 - <<PY
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path("$ROOT") / "e2e" / "cross-product"))
from recovery_lib import finalize_post_full_resume_success, read_json, update_attempt_status, utc_now

attempt = Path("$ATTEMPT_DIR")
plan = read_json(attempt / "recovery-plan.json", {}) or {}
# Finalize all plan shards that should be merge candidates (reuse + validated reruns).
fin = finalize_post_full_resume_success(
    attempt_dir=attempt,
    expected_harness="$EXP_HV",
    expected_commit="$EXP_COMMIT",
    shard_ids=None,
)
print(json.dumps(fin, indent=2))
if not fin.get("ok"):
    update_attempt_status(
        attempt,
        status="FAILED_POST_FULL_RESUME_FINALIZE",
        phase="FAILED_POST_FULL_RESUME_FINALIZE",
        abort_reason=fin.get("reason"),
        ended_at=utc_now(),
        resumable=True,
        final_verdict="FAILED_POST_FULL_RESUME_FINALIZE",
        full_resume_ready_for_merge=False,
    )
    raise SystemExit(49)
print("final_verdict=FULL_RESUME_PASS — READY_FOR_FINAL_MERGE_VALIDATION")
PY
fi
