#!/usr/bin/env bash
# Merge json-file log rotation into /etc/docker/daemon.json (preserves other keys).
# Does not delete volumes, images, or containers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_SIZE="${GDC_DOCKER_LOG_MAX_SIZE:-20m}"
TARGET_FILES="${GDC_DOCKER_LOG_MAX_FILE:-3}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

sudo python3 - "$TMP" "$TARGET_SIZE" "$TARGET_FILES" <<'PY'
import json, sys
from pathlib import Path

out, target_size, target_files = sys.argv[1], sys.argv[2], sys.argv[3]
path = Path("/etc/docker/daemon.json")
existing: dict = {}
if path.exists() and path.read_text().strip():
    existing = json.loads(path.read_text())

opts = existing.get("log-opts") if isinstance(existing.get("log-opts"), dict) else {}

def size_to_bytes(s: str) -> float:
    s = str(s).strip().lower()
    mul = 1.0
    if s.endswith("g"):
        mul = 1024**3
        s = s[:-1]
    elif s.endswith("m"):
        mul = 1024**2
        s = s[:-1]
    elif s.endswith("k"):
        mul = 1024
        s = s[:-1]
    return float(s) * mul

final_size, final_files = target_size, target_files
if "max-size" in opts:
    try:
        if size_to_bytes(str(opts["max-size"])) <= size_to_bytes(target_size):
            final_size = str(opts["max-size"])
    except Exception:
        pass
if "max-file" in opts:
    try:
        if int(opts["max-file"]) <= int(target_files):
            final_files = str(opts["max-file"])
    except Exception:
        pass

driver = existing.get("log-driver") or "json-file"
if driver in (None, "", "json-file"):
    existing["log-driver"] = "json-file"
existing["log-opts"] = {**opts, "max-size": final_size, "max-file": final_files}
text = json.dumps(existing, indent=2) + "\n"
json.loads(text)
Path(out).write_text(text)
print(text)
PY

sudo cp "$TMP" /etc/docker/daemon.json
sudo chmod 644 /etc/docker/daemon.json
echo "Applied /etc/docker/daemon.json (restart docker to apply to new containers if needed)"
