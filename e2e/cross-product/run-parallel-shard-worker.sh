#!/usr/bin/env bash
# Isolated parallel worker for one Cross-Product shard.
# Writes only generation-scoped artifacts. Coordinator owns merge/publish.
set -euo pipefail

ROOT="${ROOT:?}"
E2E="${E2E:?}"
REPORTS_ROOT="${REPORTS_ROOT:?}"
RUN_ID="${RUN_ID:?}"
ATTEMPT="${ATTEMPT:?}"
ATTEMPT_DIR="${ATTEMPT_DIR:?}"
SHARD="${SHARD:?}"
WORKER_ID="${WORKER_ID:?}"
EXP_COMMIT="${EXP_COMMIT:?}"
EXP_HV="${EXP_HV:?}"
IDS_FILE="${IDS_FILE:?}"
SHARD_PLAN_RUNTIME="${SHARD_PLAN_RUNTIME:?}"
EXP_COUNT="${EXP_COUNT:?}"
WORKER_RESULT_PATH="${WORKER_RESULT_PATH:?}"
ROUTE_RUNTIME="${GDC_XP_ROUTE_RUNTIME:-ROUTE_ON}"
QUEUE="${GDC_XP_QUEUE:-normal}"

mkdir -p "$(dirname "$WORKER_RESULT_PATH")" "$ATTEMPT_DIR/workers/$WORKER_ID"

ALLOC_JSON="$(
  REPORTS_ROOT="$REPORTS_ROOT" RUN_ID="$RUN_ID" ATTEMPT="$ATTEMPT" SHARD="$SHARD" \
  EXP_COMMIT="$EXP_COMMIT" EXP_HV="$EXP_HV" ATTEMPT_DIR="$ATTEMPT_DIR" E2E="$E2E" \
  WORKER_ID="$WORKER_ID" ROUTE_RUNTIME="$ROUTE_RUNTIME" \
  python3 - <<'PY'
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(os.environ["E2E"]) / "cross-product"))
from recovery_lib import allocate_side_run_generation
from parallel_lib import (
    format_worker_side_run_id,
    worker_collector_channel,
    worker_resource_name_prefix,
    worker_s3_prefix,
    worker_sftp_directory,
)
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
    route_runtime=os.environ.get("ROUTE_RUNTIME") or "ROUTE_ON",
)
if r.get("ok"):
    gen = r["generation_id"]
    wid = os.environ["WORKER_ID"]
    r["name_prefix"] = worker_resource_name_prefix(worker_id=wid, generation_id=gen)
    r["s3_prefix"] = worker_s3_prefix(worker_id=wid, generation_id=gen)
    r["collector_channel"] = worker_collector_channel(worker_id=wid, generation_id=gen)
    r["sftp_directory"] = worker_sftp_directory(worker_id=wid, generation_id=gen)
    r["worker_side_run_id"] = format_worker_side_run_id(
        os.environ["RUN_ID"], os.environ["ATTEMPT"], os.environ["SHARD"], gen, wid
    )
print(json.dumps(r))
if not r.get("ok"):
    raise SystemExit(49 if r.get("reason") == "SHARD_ALREADY_RUNNING" else 50)
PY
)"

echo "$ALLOC_JSON" >"$ATTEMPT_DIR/workers/$WORKER_ID/last-alloc-$SHARD.json"
SIDE_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['side_run_id'])" "$ALLOC_JSON")"
GENERATION_ID="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['generation_id'])" "$ALLOC_JSON")"
SIDE_DIR="$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['side_run_dir'])" "$ALLOC_JSON")"
NAME_PREFIX="$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('name_prefix') or '')" "$ALLOC_JSON")"
S3_PREFIX="$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('s3_prefix') or '')" "$ALLOC_JSON")"
CHANNEL="$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('collector_channel') or '')" "$ALLOC_JSON")"
SFTP_DIR="$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('sftp_directory') or '')" "$ALLOC_JSON")"
ART_DIR="$SIDE_DIR/${SHARD}-${ROUTE_RUNTIME}"

echo "==== WORKER shard=$SHARD worker=$WORKER_ID queue=$QUEUE generation=$GENERATION_ID ===="

export GDC_E2E_REPORTS_ROOT="$REPORTS_ROOT"
export GDC_E2E_RUN_ID="$SIDE_ID"
export GDC_XP_SHARD_FILTER="$SHARD"
export GDC_XP_SHARD="$SHARD"
export GDC_XP_SHARD_PLAN_PATH="$SHARD_PLAN_RUNTIME"
export GDC_XP_COMBINATION_IDS_FILE="$IDS_FILE"
export GDC_XP_GENERATION_ID="$GENERATION_ID"
export GDC_XP_ATTEMPT="$ATTEMPT"
export GDC_XP_SIDE_RUN_DIR="$SIDE_DIR"
export GDC_XP_WORKER_ID="$WORKER_ID"
export GDC_E2E_NAME_PREFIX="$NAME_PREFIX"
export GDC_E2E_S3_PREFIX="$S3_PREFIX"
export GDC_E2E_COLLECTOR_CHANNEL="$CHANNEL"
export GDC_E2E_SFTP_DIRECTORY="$SFTP_DIR"
export GDC_XP_ROUTE_RUNTIME="$ROUTE_RUNTIME"
export GDC_XP_EXPECTED_HARNESS="$EXP_HV"
export GDC_XP_COMMIT="$EXP_COMMIT"
export PLAYWRIGHT_OUTPUT_DIR="$SIDE_DIR/playwright-output"
export PLAYWRIGHT_HTML_OUTPUT_DIR="$SIDE_DIR/playwright-html"
export PLAYWRIGHT_JSON_OUTPUT_FILE="$SIDE_DIR/playwright-results.json"
unset GDC_XP_CONTINUE GDC_XP_COMBINATION_IDS GDC_XP_LIMIT || true

if [[ "$ROUTE_RUNTIME" == "ROUTE_ON" ]]; then
  export GDC_ROUTE_PROCESSING_ENABLED=true
else
  export GDC_ROUTE_PROCESSING_ENABLED=false
fi

python3 - <<PY
import os
assert os.environ["GDC_XP_SHARD"] == "$SHARD"
assert os.environ["GDC_XP_WORKER_ID"] == "$WORKER_ID"
assert os.environ["GDC_XP_GENERATION_ID"] == "$GENERATION_ID"
assert os.environ.get("GDC_E2E_NAME_PREFIX", "").startswith("[FULL E2E][w-")
assert os.environ.get("GDC_E2E_S3_PREFIX", "").startswith("full-e2e/w-")
assert os.environ.get("GDC_E2E_COLLECTOR_CHANNEL", "").startswith("xpw")
ids = [l for l in open(os.environ["GDC_XP_COMBINATION_IDS_FILE"]) if l.strip()]
assert len(ids) == int("$EXP_COUNT"), (len(ids), int("$EXP_COUNT"))
print("WORKER_ENV_OK", {
  "side_run": os.environ["GDC_E2E_RUN_ID"],
  "worker": os.environ["GDC_XP_WORKER_ID"],
  "generation": os.environ["GDC_XP_GENERATION_ID"],
  "channel": os.environ["GDC_E2E_COLLECTOR_CHANNEL"],
})
PY

# Fault queue: exclusive lock so two fault workers cannot stop shared services together.
FAULT_LOCK_STARTED=0
if [[ "$QUEUE" == "fault" ]]; then
  mkdir -p "$ATTEMPT_DIR/locks"
  exec 9>"$ATTEMPT_DIR/locks/fault-exclusive.lock"
  flock -x 9
  FAULT_LOCK_STARTED=1
fi

if [[ "$REPORTS_ROOT" != "$E2E/reports" ]]; then
  mkdir -p "$E2E/reports"
  ln -sfn "$SIDE_DIR" "$E2E/reports/$SIDE_ID"
fi

set +e
"$E2E/cross-product/run-all-shards.sh"
RC=$?
set -e

if [[ "$FAULT_LOCK_STARTED" -eq 1 ]]; then
  flock -u 9 || true
fi

python3 - <<PY
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path("$E2E") / "cross-product"))
from parallel_lib import trusted_complete_marker_ok, write_shard_complete_marker
art = Path("$ART_DIR")
jsonl = art / "cross-product-results.jsonl"
ids = []
gens = []
if jsonl.is_file():
    for line in jsonl.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("combination_id"):
            ids.append(row["combination_id"])
        if row.get("generation_id"):
            gens.append(row["generation_id"])
check = trusted_complete_marker_ok(
    art,
    expected_count=int("$EXP_COUNT"),
    expected_harness="$EXP_HV",
    expected_commit="$EXP_COMMIT",
)
if check.get("ok"):
    write_shard_complete_marker(art, check)
doc = {
    "ok": bool(check.get("ok")),
    "rc": int("$RC"),
    "playwright_rc": int("$RC"),
    "worker_id": "$WORKER_ID",
    "shard": "$SHARD",
    "generation_id": "$GENERATION_ID",
    "side_run_id": "$SIDE_ID",
    "side_run_dir": "$SIDE_DIR",
    "art_dir": "$ART_DIR",
    "jsonl_path": str(jsonl) if jsonl.is_file() else None,
    "combination_ids": ids,
    "generation_ids_in_jsonl": sorted(set(gens)),
    "writer_owners": ["$WORKER_ID"],
    "name_prefix": "$NAME_PREFIX",
    "s3_prefix": "$S3_PREFIX",
    "collector_channel": "$CHANNEL",
    "validation": check,
}
Path("$WORKER_RESULT_PATH").write_text(json.dumps(doc, indent=2) + "\n")
print(json.dumps({"event": "WORKER_RESULT_WRITTEN", **{k: doc[k] for k in ("ok","rc","shard","worker_id","generation_id")}}))
raise SystemExit(0 if doc["ok"] else int("$RC") or 1)
PY
