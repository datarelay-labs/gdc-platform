#!/usr/bin/env bash
# Cursor stop-hook: Telegram COMPLETE when an agent turn ends.
# Mechanical backstop — agents should still call notify.sh with a rich message.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="${ROOT}/.cursor/hooks/state"
LOG_FILE="${STATE_DIR}/telegram-on-stop.log"
mkdir -p "${STATE_DIR}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${LOG_FILE}" 2>/dev/null || true
}

input="$(cat || true)"
# Always acknowledge so Cursor does not treat the hook as failed.
ack() { printf '%s\n' '{}'; }

if [[ -z "${input}" ]]; then
  log "skip: empty stdin"
  ack
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  log "skip: python3 missing"
  ack
  exit 0
fi

STATUS=""
GENERATION_ID=""
CONVERSATION_ID=""
LOOP_COUNT="0"

while IFS='=' read -r key value; do
  case "${key}" in
    STATUS) STATUS="${value}" ;;
    GENERATION_ID) GENERATION_ID="${value}" ;;
    CONVERSATION_ID) CONVERSATION_ID="${value}" ;;
    LOOP_COUNT) LOOP_COUNT="${value}" ;;
  esac
done < <(
  python3 -c '
import json, sys
raw = sys.stdin.read() or "{}"
try:
    data = json.loads(raw)
except Exception:
    data = {}
print("STATUS=" + str(data.get("status") or ""))
print("GENERATION_ID=" + str(data.get("generation_id") or data.get("generationId") or "unknown"))
print("CONVERSATION_ID=" + str(data.get("conversation_id") or data.get("session_id") or "unknown"))
print("LOOP_COUNT=" + str(int(data.get("loop_count") or 0)))
' <<<"${input}"
)

status_norm="$(printf '%s' "${STATUS}" | tr '[:upper:]' '[:lower:]')"
log "invoke status=${STATUS:-<empty>} generation_id=${GENERATION_ID} loop_count=${LOOP_COUNT}"

# Skip only explicit abort/error/cancel. Empty/success/completed all notify.
case "${status_norm}" in
  aborted|abort|cancelled|canceled|error|failed)
    log "skip: terminal failure status=${STATUS}"
    ack
    exit 0
    ;;
esac

safe_gen="$(printf '%s' "${GENERATION_ID}" | tr -c 'A-Za-z0-9._-' '_')"
marker="${STATE_DIR}/telegram-notified-${safe_gen}"
if [[ -f "${marker}" ]]; then
  log "skip: already notified generation_id=${GENERATION_ID}"
  ack
  exit 0
fi

# Conversation-level debounce (60s) to avoid double-fire from project+user hooks.
safe_conv="$(printf '%s' "${CONVERSATION_ID}" | tr -c 'A-Za-z0-9._-' '_')"
debounce="${STATE_DIR}/telegram-debounce-${safe_conv}"
now_epoch="$(date +%s)"
if [[ -f "${debounce}" ]]; then
  prev="$(cat "${debounce}" 2>/dev/null || echo 0)"
  if [[ "${prev}" =~ ^[0-9]+$ ]] && (( now_epoch - prev < 60 )); then
    log "skip: conversation debounce conversation_id=${CONVERSATION_ID}"
    : > "${marker}"
    ack
    exit 0
  fi
fi

branch="$(git -C "${ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
head="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo n/a)"
short_conv="$(printf '%s' "${CONVERSATION_ID}" | cut -c1-8)"

msg="Task: agent turn complete (stop-hook)
Status: PASS
Branch: ${branch}
HEAD: ${head}
Conversation: ${short_conv}
Loop: ${LOOP_COUNT}"

if [[ -x /usr/local/bin/notify.sh ]]; then
  if /usr/local/bin/notify.sh COMPLETE "${msg}" >> "${LOG_FILE}" 2>&1; then
    : > "${marker}"
    printf '%s' "${now_epoch}" > "${debounce}"
    log "sent COMPLETE generation_id=${GENERATION_ID}"
  else
    log "notify.sh FAILED generation_id=${GENERATION_ID}"
  fi
else
  log "notify.sh missing or not executable"
  echo "telegram-on-stop: /usr/local/bin/notify.sh missing or not executable" >&2
fi

ack
exit 0
