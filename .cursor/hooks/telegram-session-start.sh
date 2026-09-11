#!/usr/bin/env bash
# Inject mandatory Telegram COMPLETE gate into every agent session.
set -euo pipefail

# Consume stdin (sessionStart payload) so Cursor does not hang.
cat >/dev/null || true

python3 - <<'PY'
import json
print(json.dumps({
  "additional_context": (
    "HARD GATE — Telegram task-complete notify is mandatory.\n"
    "Before every final user-facing reply that ends requested work, run this Shell command "
    "(real execution, not a suggestion):\n"
    "/usr/local/bin/notify.sh COMPLETE \"Task: <short name>\\nStatus: PASS|PARTIAL|BLOCKED\\n"
    "Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)\\n"
    "HEAD: $(git rev-parse --short HEAD 2>/dev/null || echo n/a)\"\n"
    "Do not claim done/PASS until that command has run in this turn. "
    "Project stop-hook is only a backstop."
  )
}))
PY
