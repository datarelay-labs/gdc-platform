#!/usr/bin/env bash
# Fresh install: validate tooling, prepare .env and directories, run migrations, start the stack.
# PostgreSQL-only; never uses SQLite. Does not delete existing Docker volumes.
#
# Options:
#   (default)  Full install: use existing images; compose builds only if a required image is missing.
#   --build    Rebuild api, frontend, and reverse-proxy images (docker compose build per service group).
#   --pull     Pull images for services that declare image: (e.g. postgres) before build/up.
#   --no-build Restart / redeploy only: docker compose up -d --no-build (no migrations, no admin seed).
#   -h, --help Show usage.
set -Eeuo pipefail
set -o errtrace

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/release/_release_postgres_catalog.sh
source "$SCRIPT_DIR/_release_postgres_catalog.sh"
# shellcheck source=scripts/release/_release_migration_validate.sh
source "$SCRIPT_DIR/_release_migration_validate.sh"
COMPOSE_REL="${GDC_RELEASE_COMPOSE_FILE:-docker-compose.platform.yml}"
ENV_EXAMPLE="$ROOT/.env.example"
ENV_FILE="$ROOT/.env"

INSTALL_START_EPOCH="$(date +%s)"
IMAGE_BUILD_SECONDS=""
MIGRATION_SECONDS=""
INSTALL_ADMIN_ALREADY_EXISTS=0
INSTALL_SECRETS_GENERATED=0
INSTALL_ORIGINAL_ARGS=()

DO_PULL=0
DO_BUILD=0
RESTART_ONLY=0
LAST_HEALTH_BACKEND_RESULT=""
LAST_HEALTH_FRONTEND_RESULT=""
STEP_TOTAL=11
STEP_NUM=0
CURRENT_STEP=""
MIN_INSTALL_MEM_MB="${GDC_INSTALL_MIN_MEM_MB:-2048}"
MIN_INSTALL_DISK_GB="${GDC_INSTALL_MIN_DISK_GB:-10}"
INSTALL_REQUIRED_PORTS=()
GDC_PLATFORM_RESERVED_PORTS=(5432 8000 8080 8099 5514)

die() { echo "ERROR: $*" >&2; exit 1; }

ts() { date '+%Y-%m-%d %H:%M:%S'; }

elapsed_seconds() { echo "$(($(date +%s) - INSTALL_START_EPOCH))"; }

format_elapsed() {
  local sec="${1:-0}"
  local m=$((sec / 60)) s=$((sec % 60))
  if [[ "$m" -gt 0 ]]; then
    echo "${m}m ${s}s"
  else
    echo "${s}s"
  fi
}

err_trap() {
  local ec=$?
  echo "" >&2
  echo "==================================================" >&2
  echo "FAILED at step: ${CURRENT_STEP:-unknown}" >&2
  echo "Exit code: ${ec}" >&2
  echo "Failing command: ${BASH_COMMAND}" >&2
  echo "==================================================" >&2
  exit "$ec"
}
trap err_trap ERR

emit_install_timing_summary() {
  local total_now
  total_now="$(date +%s)"
  local install_total_seconds=$((total_now - INSTALL_START_EPOCH))
  python3 - "$IMAGE_BUILD_SECONDS" "$MIGRATION_SECONDS" "$install_total_seconds" <<'PY'
import json
import sys

img_raw, mig_raw, tot_raw = sys.argv[1], sys.argv[2], sys.argv[3]

def opt_int(s: str):
    s = (s or "").strip()
    if not s:
        return None
    return int(s)

print(
    json.dumps(
        {
            "stage": "install_timing_summary",
            "image_build_seconds": opt_int(img_raw),
            "migration_seconds": int(mig_raw) if str(mig_raw).strip() else None,
            "install_total_seconds": int(tot_raw),
        },
        separators=(",", ":"),
    )
)
PY
}

docker_engine_installed() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

docker_daemon_usable() {
  docker info >/dev/null 2>&1
}

user_in_docker_group() {
  local user="${1:-$(id -un)}"
  local members
  if id -nG "$user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    return 0
  fi
  members="$(getent group docker 2>/dev/null | awk -F: '{print $4}')"
  [[ -n "$members" ]] || return 1
  tr ',' '\n' <<<"$members" | grep -qx "$user"
}

current_process_in_docker_group() {
  id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker
}

docker_group_membership_pending() {
  [[ "${EUID:-$(id -u)}" -ne 0 ]] \
    && user_in_docker_group \
    && ! current_process_in_docker_group \
    && ! docker_daemon_usable
}

quote_shell_command() {
  python3 - "$@" <<'PY'
import shlex
import sys

print(" ".join(shlex.quote(arg) for arg in sys.argv[1:]), end="")
PY
}

docker_group_reexec_possible() {
  [[ "${GDC_DOCKER_GROUP_REEXEC:-}" != "1" ]] || return 1
  [[ "${EUID:-$(id -u)}" -ne 0 ]] || return 1
  command -v sg >/dev/null 2>&1 || return 1
  getent group docker >/dev/null 2>&1 || return 1
  user_in_docker_group || return 1
  sg docker -c 'id -nG 2>/dev/null | tr " " "\n" | grep -qx docker' >/dev/null 2>&1
}

exit_docker_group_rerun_required() {
  echo "Docker installed successfully. Re-run ./bootstrap.sh" >&2
  exit 0
}

reexec_bootstrap_under_docker_group() {
  local command
  if ! docker_group_reexec_possible; then
    exit_docker_group_rerun_required
  fi
  echo "Docker installed successfully."
  echo "Activating docker group for this bootstrap run via 'sg docker'..."
  echo "Re-executing ./bootstrap.sh with the original arguments."
  command="$(quote_shell_command \
    env \
    GDC_DOCKER_GROUP_REEXEC=1 \
    bash \
    "$ROOT/bootstrap.sh" \
    "${INSTALL_ORIGINAL_ARGS[@]}")"
  exec sg docker -c "$command"
}

install_docker_on_ubuntu_2404() {
  local installer="$ROOT/scripts/install-docker-ubuntu2404.sh"
  [[ -f "$installer" ]] || die "Docker installer not found: $installer"
  echo "Docker Engine / Compose plugin not found; installing for Ubuntu 24.04..."
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    sudo -E bash "$installer"
  else
    bash "$installer"
  fi
  if docker_group_membership_pending; then
    reexec_bootstrap_under_docker_group
  fi
}

ensure_docker_ready() {
  if docker_daemon_usable; then
    return 0
  fi
  if ! docker_engine_installed; then
    if [[ -r /etc/os-release ]]; then
      # shellcheck disable=SC1091
      source /etc/os-release
      if [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]]; then
        install_docker_on_ubuntu_2404
      else
        die "Docker is not installed. Automatic install supports Ubuntu 24.04 only; install Docker Engine + Compose plugin manually."
      fi
    else
      die "Docker is not installed and OS could not be detected for automatic install."
    fi
  fi
  if ! docker_engine_installed; then
    die "Docker installation finished but 'docker' or 'docker compose' is still unavailable on PATH."
  fi
  if ! systemctl is-active --quiet docker 2>/dev/null; then
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
      sudo systemctl enable --now docker || die "Docker daemon is not running and could not be started."
    else
      systemctl enable --now docker || die "Docker daemon is not running and could not be started."
    fi
  fi
  if docker_daemon_usable; then
    return 0
  fi
  if docker_group_membership_pending; then
    reexec_bootstrap_under_docker_group
  fi
  if getent group docker >/dev/null 2>&1 && ! user_in_docker_group; then
    die "Docker is installed but user '$(id -un)' is not in the docker group. Add the user to the docker group, then re-run ./bootstrap.sh."
  fi
  die "Docker daemon is not reachable (docker info failed). Check: sudo systemctl status docker"
}

validate_system_resources() {
  local mem_kb avail_kb disk_kb
  if [[ -r /proc/meminfo ]]; then
    mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    if [[ -n "$mem_kb" && "$mem_kb" -lt $((MIN_INSTALL_MEM_MB * 1024)) ]]; then
      die "Insufficient memory: need at least ${MIN_INSTALL_MEM_MB} MiB (MemTotal=$((mem_kb / 1024)) MiB)."
    fi
  fi
  if command -v df >/dev/null 2>&1; then
    disk_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
    if [[ -n "$disk_kb" && "$disk_kb" -lt $((MIN_INSTALL_DISK_GB * 1024 * 1024)) ]]; then
      die "Insufficient free disk under $ROOT: need at least ${MIN_INSTALL_DISK_GB} GiB free."
    fi
  fi
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

validate_required_ports_free() {
  local port busy=()
  resolve_install_required_ports
  for port in "${INSTALL_REQUIRED_PORTS[@]}"; do
    if port_in_use "$port"; then
      busy+=("$port")
    fi
  done
  if [[ "${#busy[@]}" -gt 0 ]]; then
    die "Required host ports already in use: ${busy[*]} (platform HTTP ${GDC_HTTP_PORT_RESOLVED}, HTTPS ${GDC_HTTPS_PORT_RESOLVED}, PostgreSQL ${GDC_PLATFORM_POSTGRES_HOST_PORT_RESOLVED})."
  fi
}

env_value() {
  local key="$1" file_val
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return 0
  fi
  file_val="$(read_env_assignment "$ENV_FILE" "$key")"
  printf '%s' "$file_val"
}

env_first_value() {
  local key val
  for key in "$@"; do
    val="$(env_value "$key")"
    if [[ -n "$val" ]]; then
      printf '%s' "$val"
      return 0
    fi
  done
}

validate_numeric_port() {
  local key="$1" raw="$2"
  if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
    die "$key must be a numeric TCP port (got '${raw:-<empty>}')."
  fi
  if (( raw < 1 || raw > 65535 )); then
    die "$key must be between 1 and 65535 (got $raw)."
  fi
}

validate_reverse_proxy_ports() {
  local http_port https_port api_port pg_port reserved
  http_port="$(env_first_value GDC_HTTP_PORT GDC_ENTRY_HTTP_PORT)"
  https_port="$(env_first_value GDC_HTTPS_PORT GDC_ENTRY_HTTPS_PORT)"
  api_port="$(env_value GDC_API_HOST_PORT)"
  pg_port="$(env_value GDC_PLATFORM_POSTGRES_HOST_PORT)"
  [[ -z "$http_port" ]] && http_port="18080"
  [[ -z "$https_port" ]] && https_port="18443"
  [[ -z "$api_port" ]] && api_port="8000"
  [[ -z "$pg_port" ]] && pg_port="55432"

  validate_numeric_port GDC_HTTP_PORT "$http_port"
  validate_numeric_port GDC_HTTPS_PORT "$https_port"
  validate_numeric_port GDC_API_HOST_PORT "$api_port"
  validate_numeric_port GDC_PLATFORM_POSTGRES_HOST_PORT "$pg_port"

  if [[ "$http_port" == "$https_port" ]]; then
    die "GDC_HTTP_PORT and GDC_HTTPS_PORT cannot be identical ($http_port)."
  fi
  for reserved in "$api_port" "$pg_port" "${GDC_PLATFORM_RESERVED_PORTS[@]}"; do
    if [[ "$http_port" == "$reserved" ]]; then
      die "GDC_HTTP_PORT conflicts with a reserved platform service port ($reserved)."
    fi
    if [[ "$https_port" == "$reserved" ]]; then
      die "GDC_HTTPS_PORT conflicts with a reserved platform service port ($reserved)."
    fi
  done

  GDC_HTTP_PORT_RESOLVED="$http_port"
  GDC_HTTPS_PORT_RESOLVED="$https_port"
  GDC_PLATFORM_POSTGRES_HOST_PORT_RESOLVED="$pg_port"
}

resolve_install_required_ports() {
  validate_reverse_proxy_ports
  INSTALL_REQUIRED_PORTS=("$GDC_HTTP_PORT_RESOLVED" "$GDC_HTTPS_PORT_RESOLVED" "$GDC_PLATFORM_POSTGRES_HOST_PORT_RESOLVED")
}

# Read a single KEY=value from .env-style file (no shell evaluation). Empty if missing.
read_env_assignment() {
  local file="$1" key="$2"
  python3 - "$file" "$key" <<'PY'
import re
import sys

path, key = sys.argv[1], sys.argv[2]
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except OSError:
    sys.exit(0)
pat = re.compile(rf"^\s*{re.escape(key)}\s*=\s*(.*)\s*$")
for line in reversed(lines):
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    m = pat.match(line)
    if not m:
        continue
    val = m.group(1).strip()
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        val = val[1:-1]
    print(val, end="")
    break
PY
}

# shellcheck disable=SC2317
resolve_install_web_ui_url() {
  python3 - "$ENV_FILE" <<'PY'
import os, re, socket, subprocess, sys
from pathlib import Path


def read_env(path: str, key: str) -> str:
    p = Path(path)
    if not p.is_file():
        return ""
    pat = re.compile(rf"^\s*{re.escape(key)}\s*=\s*(.*)\s*$")
    for line in reversed(p.read_text(encoding="utf-8").splitlines()):
        ls = line.strip()
        if not ls or ls.startswith("#"):
            continue
        m = pat.match(line)
        if not m:
            continue
        val = m.group(1).strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        return val
    return ""


def first_non_loopback_from_hostname_i() -> str | None:
    try:
        out = subprocess.check_output(["hostname", "-I"], text=True, stderr=subprocess.DEVNULL).split()
    except (OSError, subprocess.CalledProcessError):
        return None
    for ip in out:
        ip = ip.strip()
        if ip and not ip.startswith("127."):
            return ip
    return None


def udp_local_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.25)
        s.connect(("1.1.1.1", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return None


def hostname_i_first() -> str | None:
    try:
        out = subprocess.check_output(["hostname", "-I"], text=True, stderr=subprocess.DEVNULL).split()
    except (OSError, subprocess.CalledProcessError):
        return None
    if not out:
        return None
    first = out[0].strip()
    return first or None


env_file = sys.argv[1]
public = (os.environ.get("GDC_PUBLIC_URL") or "").strip() or read_env(env_file, "GDC_PUBLIC_URL").strip()
if public:
    print(public.rstrip("/") + "/")
    raise SystemExit(0)

port = read_env(env_file, "GDC_HTTP_PORT").strip() or "18080"
ip = udp_local_ip() or first_non_loopback_from_hostname_i() or hostname_i_first()
if not ip or ip.startswith("127."):
    ip = "localhost"
print(f"http://{ip}:{port}/")
PY
}

print_install_completion_banner() {
  local web_url http_port https_port
  web_url="$(resolve_install_web_ui_url)"
  http_port="$(resolve_entry_http_port)"
  https_port="$(read_env_assignment "$ENV_FILE" GDC_HTTPS_PORT)"
  [[ -z "$https_port" ]] && https_port="18443"
  echo ""
  echo "=================================================="
  echo "GDC Platform installation completed successfully"
  echo "=================================================="
  echo ""
  echo "Access URLs:"
  echo "  Web UI (HTTP):  ${web_url}"
  echo "  API health:     http://127.0.0.1:${http_port}/health"
  echo "  HTTPS (optional): configure Admin → TLS, then use port ${https_port}"
  echo "    See docs/deployment/https-reverse-proxy.md"
  echo ""
  echo "Administrator login:"
  echo "  Username: admin"
  if [[ "$INSTALL_ADMIN_ALREADY_EXISTS" -eq 1 ]]; then
    echo "  Password: (unchanged — admin user already existed in the database volume)"
    echo "    The install script does not reset existing credentials."
    echo "    To set a known password: export GDC_SEED_ADMIN_PASSWORD (8+ chars) and run:"
    echo "      docker compose -f $COMPOSE_REL run --rm --no-deps -e GDC_SEED_ADMIN_PASSWORD api \\"
    echo "        python -m app.db.seed --platform-admin-only --reset-platform-admin-password"
  else
    local _admin_pw _pw_source
    _admin_pw="$(resolve_install_admin_password)"
    if [[ "$_admin_pw" == "admin" ]]; then
      _pw_source='first-install default'
      echo "  Password: admin"
    else
      _pw_source="GDC_SEED_ADMIN_PASSWORD in .env or environment"
      echo "  Password: (custom value from GDC_SEED_ADMIN_PASSWORD; not shown)"
    fi
    echo "    (source: ${_pw_source})"
    echo "  Password change required on first login: yes"
  fi
  echo ""
  echo "Next steps:"
  echo "  1. Open the Web UI URL above and sign in as admin."
  echo "  2. Review Settings → operational health and configure connectors."
  echo "  3. For production exposure: set GDC_PUBLIC_URL in .env, enable HTTPS, and restrict host firewall."
  if [[ "$INSTALL_SECRETS_GENERATED" -eq 1 ]]; then
    echo "  4. Secret values were generated in .env — back up .env securely; do not commit it."
  fi
  echo ""
  echo "Compose file: $COMPOSE_REL"
  echo "Environment:  $ENV_FILE"
  echo ""
  echo "=================================================="
}

validate_env_file() {
  local key val missing=()
  [[ -f "$ENV_FILE" ]] || die ".env missing after bootstrap (unexpected)."
  for key in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL; do
    val="$(read_env_assignment "$ENV_FILE" "$key")"
    if [[ -z "$val" ]]; then
      missing+=("$key")
    fi
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    die "Missing required .env keys: ${missing[*]} (see .env.example)."
  fi
  local url
  url="$(read_env_assignment "$ENV_FILE" DATABASE_URL)"
  case "$url" in
    postgresql://*|postgres://*) ;;
    sqlite*) die "SQLite is not supported. Set DATABASE_URL to a PostgreSQL URL." ;;
    *) die "DATABASE_URL must start with postgresql:// or postgres:// (PostgreSQL only)." ;;
  esac
  local pg_db pg_user
  pg_db="$(read_env_assignment "$ENV_FILE" POSTGRES_DB)"
  pg_user="$(read_env_assignment "$ENV_FILE" POSTGRES_USER)"
  if [[ "$pg_db" != "gdc" ]]; then
    echo "WARN: POSTGRES_DB is '$pg_db' (platform install expects gdc)." >&2
  fi
  if [[ "$COMPOSE_REL" == *"platform"* && "$pg_user" != "gdc" ]]; then
    echo "WARN: POSTGRES_USER is '$pg_user' (docker-compose.platform.yml defaults to gdc)." >&2
  fi
  validate_reverse_proxy_ports
}

resolve_install_admin_password() {
  local pw="${GDC_SEED_ADMIN_PASSWORD:-}"
  if [[ -z "$pw" && -f "$ENV_FILE" ]]; then
    pw="$(read_env_assignment "$ENV_FILE" GDC_SEED_ADMIN_PASSWORD)"
  fi
  if [[ -z "$pw" ]]; then
    pw="admin"
  fi
  printf '%s' "$pw"
}

warn_lab_database_url_for_platform() {
  case "$COMPOSE_REL" in
    docker-compose.platform.yml|*/docker-compose.platform.yml) ;;
    deploy/docker-compose.https.yml|*/deploy/docker-compose.https.yml) ;;
    *) return 0 ;;
  esac
  if grep -qE '^[[:space:]]*DATABASE_URL=.*gdc_pytest' "$ENV_FILE" 2>/dev/null; then
    echo "WARN: .env DATABASE_URL points at pytest catalog gdc_pytest (destructive tests)." >&2
    echo "      Use gdc for platform host-side tools; see .env.example." >&2
  fi
}

generate_random_secret() {
  local nbytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$nbytes" | tr -d '\n/'
    return 0
  fi
  python3 - "$nbytes" <<'PY'
import secrets, sys
n = max(16, int(sys.argv[1]) * 3 // 4)
print(secrets.token_urlsafe(n)[: max(24, int(sys.argv[1]))], end="")
PY
}

bootstrap_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_EXAMPLE" ]]; then
      die ".env.example not found at $ENV_EXAMPLE"
    fi
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "Created $ENV_FILE from .env.example."
  fi
  bootstrap_env_secrets
}

bootstrap_env_secrets() {
  local changed_flag
  changed_flag="$(python3 - "$ENV_FILE" <<'PY'
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
lines = text.splitlines()

PLACEHOLDER_POSTGRES = {"change-me-strong-db-password", "gdc"}
PLACEHOLDER_GENERIC = {
    "change-me-in-production-use-long-random-string",
    "replace-with-fernet-or-aes-key-placeholder",
    "change-me-long-random-token",
    "change-me-in-production",
    "devtoken",
}

def parse_val(raw: str) -> str:
    val = raw.strip()
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        return val[1:-1]
    return val

def read_key(key: str) -> str | None:
    pat = re.compile(rf"^\s*{re.escape(key)}\s*=\s*(.*)\s*$")
    for line in reversed(lines):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = pat.match(line)
        if m:
            return parse_val(m.group(1))
    return None

def upsert_key(key: str, value: str) -> None:
    global lines
    pat = re.compile(rf"^(\s*{re.escape(key)}\s*=).*$")
    replaced = False
    out: list[str] = []
    for line in lines:
        m = pat.match(line)
        if m:
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{key}={value}")
    lines = out

def read_first(*keys: str) -> str | None:
    for key in keys:
        value = read_key(key)
        if value is not None and str(value).strip():
            return value
    return None

def token(n: int = 32) -> str:
    return secrets.token_urlsafe(max(24, n))

changed = False
pg_user = read_key("POSTGRES_USER") or "gdc"
pg_db = read_key("POSTGRES_DB") or "gdc"
pg_pw = read_key("POSTGRES_PASSWORD") or ""
if not pg_pw or pg_pw in PLACEHOLDER_POSTGRES:
    pg_pw = token(24)
    upsert_key("POSTGRES_PASSWORD", pg_pw)
    changed = True

db_url = read_key("DATABASE_URL") or ""
needs_db_url = (
    not db_url
    or "change-me-strong-db-password" in db_url
    or db_url.startswith("sqlite")
)
if needs_db_url:
    upsert_key(
        "DATABASE_URL",
        f"postgresql://{quote(pg_user, safe='')}:{quote(pg_pw, safe='')}@127.0.0.1:55432/{quote(pg_db, safe='')}",
    )
    changed = True
elif pg_pw:
    parsed = urlparse(db_url)
    if parsed.scheme.startswith("postgres") and parsed.password != pg_pw:
        netloc = parsed.netloc
        if "@" in netloc:
            userpart, hostpart = netloc.rsplit("@", 1)
            user = userpart.split(":", 1)[0]
            netloc = f"{user}:{quote(pg_pw, safe='')}@{hostpart}"
        upsert_key("DATABASE_URL", urlunparse(parsed._replace(netloc=netloc)))
        changed = True

for key in ("SECRET_KEY", "JWT_SECRET_KEY"):
    val = read_key(key) or ""
    if not val or val in PLACEHOLDER_GENERIC:
        upsert_key(key, token(48))
        changed = True

enc = read_key("ENCRYPTION_KEY") or ""
if not enc or enc in PLACEHOLDER_GENERIC:
    upsert_key("ENCRYPTION_KEY", token(32))
    changed = True

proxy_tok = read_key("GDC_PROXY_RELOAD_TOKEN") or ""
if not proxy_tok or proxy_tok in PLACEHOLDER_GENERIC:
    upsert_key("GDC_PROXY_RELOAD_TOKEN", token(32))
    changed = True

http_port = read_first("GDC_HTTP_PORT", "GDC_ENTRY_HTTP_PORT") or "18080"
https_port = read_first("GDC_HTTPS_PORT", "GDC_ENTRY_HTTPS_PORT") or "18443"
if read_key("GDC_HTTP_PORT") is None:
    upsert_key("GDC_HTTP_PORT", http_port)
    changed = True
if read_key("GDC_HTTPS_PORT") is None:
    upsert_key("GDC_HTTPS_PORT", https_port)
    changed = True
if read_key("GDC_PUBLIC_HTTPS_PORT") is None:
    upsert_key("GDC_PUBLIC_HTTPS_PORT", https_port)
    changed = True

# Administrator bootstrap is intentionally deterministic: when
# GDC_SEED_ADMIN_PASSWORD is unset, the seed creates admin/admin with
# must_change_password=true. Do not generate or persist random admin passwords
# here; first-login password change is the operational contract.


if changed:
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")

print("1" if changed else "0", end="")
PY
)"
  if [[ "$changed_flag" == "1" ]]; then
    INSTALL_SECRETS_GENERATED=1
    echo "Generated secure values in $ENV_FILE (database, JWT, encryption, proxy token, reverse-proxy ports)."
  fi
}

bootstrap_platform_admin() {
  echo "Ensuring platform administrator account exists (create-only; see python -m app.db.seed --help)..."
  local -a docker_env_args=()
  local seed_pw="${GDC_SEED_ADMIN_PASSWORD:-}"
  if [[ -z "$seed_pw" && -f "$ENV_FILE" ]]; then
    seed_pw="$(read_env_assignment "$ENV_FILE" GDC_SEED_ADMIN_PASSWORD)"
  fi
  if [[ -n "$seed_pw" ]]; then
    local plen="${#seed_pw}"
    if [[ "$plen" -lt 8 ]]; then
      die "GDC_SEED_ADMIN_PASSWORD must be at least 8 characters when set (see .env / environment)."
    fi
    docker_env_args=(-e "GDC_SEED_ADMIN_PASSWORD=${seed_pw}")
  fi
  local seed_out seed_rc=0
  seed_out="$(docker compose -f "$COMPOSE_REL" run --rm --no-deps "${docker_env_args[@]}" api python -m app.db.seed --platform-admin-only 2>&1)" || seed_rc=$?
  echo "$seed_out"
  if [[ "$seed_rc" -ne 0 ]]; then
    die "Platform admin seed failed (exit $seed_rc). See output above."
  fi
  if echo "$seed_out" | grep -qE "'created': False|\"created\": false"; then
    INSTALL_ADMIN_ALREADY_EXISTS=1
  fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [OPTION]...

Fresh platform install: .env bootstrap, migrations, then full stack (see script header).
Restart-only: use --no-build (docker compose up -d --no-build; no migrations or admin seed).

Options:
  (none)     Full install: existing images; compose builds only if a required image is missing.
  --build    Rebuild api, frontend, and reverse-proxy images.
  --pull     Pull declared images (e.g. postgres:16-alpine) before build/up.
  --no-build Restart/redeploy: pull (if also --pull), then docker compose up -d --no-build only.
  -h, --help Show this help.

Environment:
  GDC_RELEASE_COMPOSE_FILE  Compose file (default: docker-compose.platform.yml)
  GDC_INSTALL_GENERATE_TLS  Set to 1 to generate self-signed TLS before start (full install only).
  GDC_PUBLIC_URL            Optional full browser URL for completion banner (e.g. https://gdc.example.com:18443/ or https://gdc.example.com/)
  GDC_INSTALL_MIN_MEM_MB    Minimum host RAM for install (default: 2048)
  GDC_INSTALL_MIN_DISK_GB   Minimum free disk under repo (default: 10)

On Ubuntu 24.04 without Docker, install.sh runs scripts/install-docker-ubuntu2404.sh (sudo).
If Docker group membership changes, bootstrap re-executes itself under the docker group.
EOF
}

log_step() {
  STEP_NUM=$((STEP_NUM + 1))
  CURRENT_STEP="$2"
  echo "[$(ts)] [${STEP_NUM}/${1}] ${CURRENT_STEP} (elapsed $(format_elapsed "$(elapsed_seconds)"))"
}

wait_for_backend_health() {
  local deadline=$(( $(date +%s) + 180 ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if docker compose -f "$COMPOSE_REL" exec -T api \
      wget -qO- "http://127.0.0.1:8000/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

verify_frontend_container_running() {
  local cid
  cid="$(docker compose -f "$COMPOSE_REL" ps -q frontend 2>/dev/null || true)"
  [[ -n "$cid" ]] || return 1
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
  [[ "$running" == "true" ]]
}

print_health_summary_lines() {
  local backend_ok="$1" frontend_ok="$2"
  echo ""
  echo "Health checks:"
  echo "  Backend GET /health (inside api container): $backend_ok"
  echo "  Frontend container running: $frontend_ok"
}

print_final_banner() {
  CURRENT_STEP="Install completion summary (banner and health)"
  local health_backend="$1" health_frontend="$2"
  local overall_health="FAILED"
  if [[ "$health_backend" == "PASS" && "$health_frontend" == "PASS" ]]; then
    overall_health="OK"
  fi
  print_install_completion_banner
  echo ""
  echo "Health checks: backend=$health_backend frontend=$health_frontend ($overall_health)"
  echo "Elapsed: $(format_elapsed "$(elapsed_seconds)")"
  if [[ "$COMPOSE_REL" == *"https"* ]]; then
    local _https_port
    _https_port="$(read_env_assignment "$ENV_FILE" GDC_HTTPS_PORT)"
    [[ -z "$_https_port" ]] && _https_port=443
    echo "HTTPS (after Admin TLS + PEM): see docs/deployment/https-reverse-proxy.md (host port often ${_https_port})."
  fi
  echo "Compose file: $COMPOSE_REL"
}

resolve_entry_http_port() {
  local raw
  raw="$(read_env_assignment "$ENV_FILE" GDC_HTTP_PORT)"
  [[ -z "$raw" ]] && raw="18080"
  printf '%s' "$raw"
}

verify_reverse_proxy_health() {
  local port body
  port="$(resolve_entry_http_port)"
  if ! command -v curl >/dev/null 2>&1; then
    echo "WARN: curl not installed; skipping reverse-proxy /health check." >&2
    return 0
  fi
  body="$(curl -fsS "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  [[ -n "$body" ]] || return 1
  return 0
}

verify_login_endpoint() {
  local port pw payload http_code
  port="$(resolve_entry_http_port)"
  pw="$(resolve_install_admin_password)"
  if ! command -v curl >/dev/null 2>&1; then
    echo "WARN: curl not installed; skipping login endpoint check." >&2
    return 0
  fi
  payload="$(python3 - "$pw" <<'PY'
import json, sys
print(json.dumps({"username": "admin", "password": sys.argv[1]}))
PY
)"
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:${port}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo "000")"
  [[ "$http_code" == "200" ]]
}

run_health_checks_or_fail() {
  local backend_st="FAIL" frontend_st="FAIL" proxy_st="FAIL" login_st="FAIL"
  if wait_for_backend_health; then
    backend_st="PASS"
  fi
  if verify_frontend_container_running; then
    frontend_st="PASS"
  fi
  if verify_reverse_proxy_health; then
    proxy_st="PASS"
  fi
  if verify_login_endpoint; then
    login_st="PASS"
  fi
  LAST_HEALTH_BACKEND_RESULT="$backend_st"
  LAST_HEALTH_FRONTEND_RESULT="$frontend_st"
  print_health_summary_lines "$backend_st" "$frontend_st"
  echo "  Reverse-proxy GET /health (host): $proxy_st"
  echo "  POST /api/v1/auth/login (host): $login_st"
  if [[ "$backend_st" != "PASS" || "$frontend_st" != "PASS" || "$proxy_st" != "PASS" || "$login_st" != "PASS" ]]; then
    echo "" >&2
    echo "ERROR: One or more health checks failed (see above)." >&2
    exit 1
  fi
}

install_restart_only() {
  STEP_TOTAL=5
  STEP_NUM=0
  cd "$ROOT"

  if [[ ! -f "$ROOT/$COMPOSE_REL" ]]; then
    die "Compose file not found: $ROOT/$COMPOSE_REL"
  fi

  log_step "$STEP_TOTAL" "Checking Docker and Compose"
  ensure_docker_ready

  log_step "$STEP_TOTAL" "Preparing environment (.env validation)"
  bootstrap_env
  validate_env_file
  warn_lab_database_url_for_platform

  if [[ "$DO_PULL" -eq 1 ]]; then
    log_step "$STEP_TOTAL" "Pulling images (docker compose pull)"
    docker compose -f "$COMPOSE_REL" pull
  else
    log_step "$STEP_TOTAL" "Pulling images (skipped; use --pull to pull bases)"
  fi

  log_step "$STEP_TOTAL" "Starting containers (docker compose up -d --no-build)"
  echo "NOTE: --no-build mode skips migrations and admin seed. Use a full install for first-time database setup."
  docker compose -f "$COMPOSE_REL" up -d --no-build

  log_step "$STEP_TOTAL" "Waiting for healthcheck (backend /health, frontend container)"
  run_health_checks_or_fail
  print_final_banner "$LAST_HEALTH_BACKEND_RESULT" "$LAST_HEALTH_FRONTEND_RESULT"
  echo ""
  CURRENT_STEP="Emitting install timing summary"
  emit_install_timing_summary
}

install_full() {
  STEP_TOTAL=11
  STEP_NUM=0
  cd "$ROOT"

  log_step "$STEP_TOTAL" "Checking Docker and Compose (install if missing on Ubuntu 24.04)"
  ensure_docker_ready

  log_step "$STEP_TOTAL" "Validating system resources (memory, disk)"
  validate_system_resources

  log_step "$STEP_TOTAL" "Validating required host ports are free"
  validate_required_ports_free

  log_step "$STEP_TOTAL" "Preparing environment (.env bootstrap and validation)"
  mkdir -p deploy/tls deploy/backups
  bootstrap_env
  validate_env_file
  warn_lab_database_url_for_platform

  log_step "$STEP_TOTAL" "Optional TLS material (GDC_INSTALL_GENERATE_TLS)"
  if [[ "${GDC_INSTALL_GENERATE_TLS:-}" == "1" ]]; then
    "$SCRIPT_DIR/generate-self-signed-cert.sh"
  else
    echo "TLS generation skipped (set GDC_INSTALL_GENERATE_TLS=1 to run generate-self-signed-cert.sh)."
  fi

  if [[ ! -f "$ROOT/$COMPOSE_REL" ]]; then
    die "Compose file not found: $ROOT/$COMPOSE_REL"
  fi

  if [[ "$DO_PULL" -eq 1 ]]; then
    log_step "$STEP_TOTAL" "Pulling images (docker compose pull)"
    docker compose -f "$COMPOSE_REL" pull
  else
    log_step "$STEP_TOTAL" "Pulling images (skipped; use --pull to pull bases)"
  fi

  local _build_start _build_end _built=0
  if [[ "$DO_BUILD" -eq 1 ]]; then
    log_step "$STEP_TOTAL" "Building backend (api) image"
    _build_start="$(date +%s)"
    docker compose -f "$COMPOSE_REL" build api
    log_step "$STEP_TOTAL" "Building frontend and reverse-proxy images"
    docker compose -f "$COMPOSE_REL" build frontend reverse-proxy
    _build_end="$(date +%s)"
    IMAGE_BUILD_SECONDS=$((_build_end - _build_start))
    _built=1
  else
    log_step "$STEP_TOTAL" "Building service images (skipped; use --build for a full rebuild)"
    log_step "$STEP_TOTAL" "Deferred image builds (compose builds missing images on startup if needed)"
  fi
  if [[ "$_built" -eq 0 ]]; then
    IMAGE_BUILD_SECONDS=""
  fi

  local _pg_db _pg_user
  _pg_db="$(gdc_release_resolve_postgres_db_name "$ROOT" "$COMPOSE_REL" "")"
  _pg_user="$(gdc_release_resolve_postgres_user "$ROOT" "$COMPOSE_REL")"
  log_step "$STEP_TOTAL" "Starting PostgreSQL and waiting for readiness (catalog: $_pg_db, user: $_pg_user)"
  docker compose -f "$COMPOSE_REL" up -d postgres
  for _ in $(seq 1 45); do
    if docker compose -f "$COMPOSE_REL" exec -T postgres pg_isready -U "$_pg_user" -d "$_pg_db" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  if ! docker compose -f "$COMPOSE_REL" exec -T postgres pg_isready -U "$_pg_user" -d "$_pg_db" >/dev/null 2>&1; then
    die "PostgreSQL did not become ready in time (expected catalog $_pg_db). Check: docker compose -f $COMPOSE_REL logs postgres"
  fi

  log_step "$STEP_TOTAL" "Pre-migration integrity check (read-only)"
  export GDC_RELEASE_COMPOSE_FILE="$COMPOSE_REL"
  gdc_release_run_pre_migration_validate "$COMPOSE_REL" \
    || die "Migration integrity check failed before alembic upgrade. See docs/operations/migration-recovery-runbook.md"

  log_step "$STEP_TOTAL" "Running Alembic migrations (docker compose run api)"
  local _mig_start
  _mig_start="$(date +%s)"
  docker compose -f "$COMPOSE_REL" run --rm --no-deps api alembic upgrade head
  MIGRATION_SECONDS=$(( $(date +%s) - _mig_start ))

  CURRENT_STEP="Bootstrapping platform administrator (create-only)"
  bootstrap_platform_admin

  log_step "$STEP_TOTAL" "Starting full application stack (docker compose up -d)"
  docker compose -f "$COMPOSE_REL" up -d

  log_step "$STEP_TOTAL" "Waiting for healthcheck (backend, frontend, reverse-proxy /health, login)"
  run_health_checks_or_fail
  print_final_banner "$LAST_HEALTH_BACKEND_RESULT" "$LAST_HEALTH_FRONTEND_RESULT"
  echo ""
  CURRENT_STEP="Emitting install timing summary"
  emit_install_timing_summary
}

main() {
  INSTALL_ORIGINAL_ARGS=("$@")
  DO_PULL=0
  DO_BUILD=0
  RESTART_ONLY=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --build) DO_BUILD=1; shift ;;
      --pull) DO_PULL=1; shift ;;
      --no-build) RESTART_ONLY=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1 (try --help)" ;;
    esac
  done
  if [[ "$DO_BUILD" -eq 1 && "$RESTART_ONLY" -eq 1 ]]; then
    die "Cannot combine --build and --no-build."
  fi

  if [[ "$RESTART_ONLY" -eq 1 ]]; then
    install_restart_only
    return 0
  fi

  install_full
}

main "$@"
