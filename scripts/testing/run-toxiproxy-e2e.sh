#!/usr/bin/env bash
# Toxiproxy TCP-level fault E2E (source + destination hold/recover).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/testing/_env.sh"
cd "$ROOT"

mkdir -p .test-history/latest .test-history/artifacts/toxiproxy
JUNIT=".test-history/latest/toxiproxy-junit.xml"
LOG=".test-history/latest/toxiproxy-last.log"

export WIREMOCK_BASE_URL
export TEST_DATABASE_URL
export TOXIPROXY_API_URL
export TOXIPROXY_SOURCE_BASE_URL
export TOXIPROXY_DEST_BASE_URL
export WIREMOCK_TOXIPROXY_UPSTREAM

echo "==> Ensuring WireMock + Toxiproxy are up"
docker compose -p "$COMPOSE_PROJECT_NAME" -f "$GDC_TEST_COMPOSE_FILE" up -d wiremock-test toxiproxy-test

deadline=$((SECONDS + 60))
while true; do
  if curl -sf "$TOXIPROXY_API_URL/version" >/dev/null 2>&1 \
    && curl -sf "$WIREMOCK_BASE_URL/__admin/mappings" >/dev/null 2>&1; then
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "ERROR: Toxiproxy or WireMock not ready" >&2
    exit 1
  fi
  sleep 1
done
echo "    OK api=$TOXIPROXY_API_URL wiremock=$WIREMOCK_BASE_URL"

set +e
python3 -m pytest -m e2e_toxiproxy -v --tb=short \
  --junitxml="$JUNIT" \
  tests/test_toxiproxy_network_fault_e2e.py 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e

python3 "$ROOT/scripts/testing/py/junit_summary.py" "$JUNIT" --text || true
exit "$rc"
