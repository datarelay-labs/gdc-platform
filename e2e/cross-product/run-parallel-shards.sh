#!/usr/bin/env bash
# Bounded parallel Full E2E Matrix entrypoint.
#
#   ./e2e/cross-product/run-parallel-shards.sh --workers 2
#   ./e2e/cross-product/run-parallel-shards.sh --workers 2 --fault-workers 1 --resume
#   ./e2e/cross-product/run-parallel-shards.sh --dry-run --workers 4
#
# Sequential run-all-shards.sh remains the 1-worker path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/e2e"
WORKERS="${GDC_XP_WORKERS:-2}"
FAULT_WORKERS="${GDC_XP_FAULT_WORKERS:-1}"
RUN_ID="${GDC_E2E_RUN_ID:-}"
ATTEMPT="${GDC_XP_ATTEMPT:-parallel-attempt-001}"
REPORTS_ROOT_CLI="${GDC_E2E_REPORTS_ROOT:-}"
RESUME=0
DRY=0
ALLOW_MIXED=0
LIMIT=0
ONLY=()
ROUTE_RUNTIME="${GDC_XP_ROUTE_RUNTIME:-ROUTE_ON}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workers) WORKERS="$2"; shift 2 ;;
    --fault-workers) FAULT_WORKERS="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --attempt) ATTEMPT="$2"; shift 2 ;;
    --reports-root) REPORTS_ROOT_CLI="$2"; shift 2 ;;
    --only-shard) ONLY+=("$2"); shift 2 ;;
    --limit-shards) LIMIT="$2"; shift 2 ;;
    --route-runtime) ROUTE_RUNTIME="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --allow-fault-with-normal) ALLOW_MIXED=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: run-parallel-shards.sh [options]
  --workers N                 Normal/PARALLEL_SAFE concurrency (default 2)
  --fault-workers N           GLOBAL_FAULT concurrency (default 1)
  --run-id ID
  --attempt NAME
  --only-shard SHARD_ID       Repeatable
  --limit-shards N            Measurement subset
  --resume                    Reuse trusted complete shards
  --dry-run
  --allow-fault-with-normal   Not recommended on a shared lab
EOF
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="xp_parallel_$(date -u +%Y%m%d_%H%M%S)"
fi
export GDC_E2E_RUN_ID="$RUN_ID"
export GDC_XP_ROUTE_RUNTIME="$ROUTE_RUNTIME"

ARGS=(
  --run-id "$RUN_ID"
  --attempt "$ATTEMPT"
  --workers "$WORKERS"
  --fault-workers "$FAULT_WORKERS"
  --route-runtime "$ROUTE_RUNTIME"
)
if [[ -n "$REPORTS_ROOT_CLI" ]]; then
  ARGS+=(--reports-root "$REPORTS_ROOT_CLI")
fi
for s in "${ONLY[@]+"${ONLY[@]}"}"; do
  ARGS+=(--only-shard "$s")
done
if [[ "$LIMIT" -gt 0 ]]; then
  ARGS+=(--limit-shards "$LIMIT")
fi
if [[ "$RESUME" -eq 1 ]]; then
  ARGS+=(--resume)
fi
if [[ "$DRY" -eq 1 ]]; then
  ARGS+=(--dry-run)
fi
if [[ "$ALLOW_MIXED" -eq 1 ]]; then
  ARGS+=(--allow-fault-with-normal)
fi

exec python3 "$E2E/cross-product/parallel-matrix-coordinator.py" "${ARGS[@]}"
