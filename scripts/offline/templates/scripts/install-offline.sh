#!/usr/bin/env bash
# Fresh offline install: load images, prepare .env, reset data (optional), migrate, start stack, verify.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

OFFLINE_PACKAGE_ROOT="$(offline_resolve_package_root "$SCRIPT_DIR")"
export OFFLINE_PACKAGE_ROOT

COMPOSE_FILE="$(offline_compose_file)"
ENV_FILE="$(offline_env_file)"
ENV_TEMPLATE="$(offline_env_template)"
IMAGES_DIR="$OFFLINE_PACKAGE_ROOT/images"

SKIP_RESET=0
SKIP_LOAD=0
SKIP_VERIFY=0
SKIP_DOCKER_INSTALL=0

die() { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install-offline.sh [OPTION]...

Fresh offline install for air-gapped production hosts.

Options:
  --skip-reset          Do not remove existing DB volumes before install.
  --skip-load           Assume Docker images are already loaded.
  --skip-verify         Skip post-install checks/verify-install.sh.
  --skip-docker-install Fail if Docker is missing (do not auto-install from .deb bundle).
  -h, --help            Show this help.

Prerequisites:
  - Ubuntu 24.04 LTS (64-bit) recommended
  - Docker Engine + Compose v2 (auto-installed from packages/docker/debs when missing)
  - Extracted offline-release package on local disk
  - configs/.env prepared (or copied from .env.production.template)

Typical reinstall (wipe data):
  scripts/reset-production-data.sh
  scripts/install-offline.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-reset) SKIP_RESET=1; shift ;;
    --skip-load) SKIP_LOAD=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [[ "$SKIP_DOCKER_INSTALL" -eq 1 ]]; then
  export GDC_OFFLINE_SKIP_DOCKER_INSTALL=1
fi
offline_ensure_docker_engine

[[ -f "$COMPOSE_FILE" ]] || die "Missing compose file: $COMPOSE_FILE"
[[ -f "$ENV_TEMPLATE" ]] || die "Missing env template: $ENV_TEMPLATE"

echo "============================================================"
echo "Data Relay — offline install"
echo "============================================================"
echo "Package: $OFFLINE_PACKAGE_ROOT"
echo ""

if [[ "$SKIP_LOAD" -eq 0 ]]; then
  [[ -x "$IMAGES_DIR/load-images.sh" ]] || die "Missing $IMAGES_DIR/load-images.sh"
  echo "[$(offline_ts)] Loading Docker images..."
  "$IMAGES_DIR/load-images.sh"
else
  echo "[$(offline_ts)] Skipping image load (--skip-load)"
  [[ -x "$IMAGES_DIR/verify-images.sh" ]] && "$IMAGES_DIR/verify-images.sh"
fi

mkdir -p "$OFFLINE_PACKAGE_ROOT/configs" "$OFFLINE_PACKAGE_ROOT/deploy/tls" "$OFFLINE_PACKAGE_ROOT/deploy/backups"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  echo "[$(offline_ts)] Created $ENV_FILE from template — review secrets before production exposure."
fi

# Bootstrap secrets for first-time .env
python3 - "$ENV_FILE" <<'PY'
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse

path = Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines()
PLACEHOLDER = {
    "change-me-strong-db-password",
    "change-me-in-production-use-long-random-string",
    "replace-with-fernet-or-aes-key-placeholder",
    "change-me-long-random-token",
    "change-me-in-production",
    "devtoken",
    "gdc",
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

def upsert(key: str, value: str) -> None:
    global lines
    pat = re.compile(rf"^(\s*{re.escape(key)}\s*=).*$")
    out, replaced = [], False
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

def token(n: int = 32) -> str:
    return secrets.token_urlsafe(max(24, n))

pg_user = read_key("POSTGRES_USER") or "gdc"
pg_db = read_key("POSTGRES_DB") or "gdc"
pg_pw = read_key("POSTGRES_PASSWORD") or ""
if not pg_pw or pg_pw in PLACEHOLDER:
    pg_pw = token(24)
    upsert("POSTGRES_PASSWORD", pg_pw)

db_url = read_key("DATABASE_URL") or ""
if not db_url or "change-me-strong-db-password" in db_url or db_url.startswith("sqlite"):
    upsert(
        "DATABASE_URL",
        f"postgresql://{quote(pg_user, safe='')}:{quote(pg_pw, safe='')}@127.0.0.1:55432/{quote(pg_db, safe='')}",
    )
elif pg_pw:
    parsed = urlparse(db_url)
    if parsed.scheme.startswith("postgres") and parsed.password != pg_pw:
        netloc = parsed.netloc
        if "@" in netloc:
            userpart, hostpart = netloc.rsplit("@", 1)
            user = userpart.split(":", 1)[0]
            netloc = f"{user}:{quote(pg_pw, safe='')}@{hostpart}"
        upsert("DATABASE_URL", urlunparse(parsed._replace(netloc=netloc)))

for key in ("SECRET_KEY", "JWT_SECRET_KEY", "ENCRYPTION_KEY", "GDC_PROXY_RELOAD_TOKEN"):
    val = read_key(key) or ""
    if not val or val in PLACEHOLDER:
        upsert(key, token(48 if key != "ENCRYPTION_KEY" else 32))

path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
PY

if [[ "${GDC_INSTALL_GENERATE_TLS:-}" == "1" && -f "$OFFLINE_PACKAGE_ROOT/app/scripts/release/generate-self-signed-cert.sh" ]]; then
  echo "[$(offline_ts)] Generating self-signed TLS..."
  (cd "$OFFLINE_PACKAGE_ROOT/app" && bash scripts/release/generate-self-signed-cert.sh) || true
fi

if [[ "$SKIP_RESET" -eq 0 ]]; then
  echo "[$(offline_ts)] Removing existing platform containers and volumes..."
  offline_compose down -v --remove-orphans 2>/dev/null || true
else
  echo "[$(offline_ts)] Keeping existing volumes (--skip-reset)"
fi

cd "$OFFLINE_PACKAGE_ROOT"

PG_DB="$(offline_read_env POSTGRES_DB)"
PG_USER="$(offline_read_env POSTGRES_USER)"
[[ -n "$PG_DB" ]] || PG_DB=gdc
[[ -n "$PG_USER" ]] || PG_USER=gdc

echo "[$(offline_ts)] Starting PostgreSQL..."
offline_compose up -d postgres
for _ in $(seq 1 45); do
  if offline_compose exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
offline_compose exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 \
  || die "PostgreSQL did not become ready"

if [[ -f "$OFFLINE_PACKAGE_ROOT/app/scripts/release/_release_migration_validate.sh" ]]; then
  # shellcheck source=scripts/release/_release_migration_validate.sh
  source "$OFFLINE_PACKAGE_ROOT/app/scripts/release/_release_migration_validate.sh"
  echo "[$(offline_ts)] Pre-migration integrity check..."
  mig_log="$(mktemp)"
  set +e
  offline_compose run --rm --no-deps api python -m app.db.validate_migrations --pre-upgrade >"$mig_log" 2>&1
  mig_rc=$?
  set -e
  cat "$mig_log"
  mig_rc="$(gdc_release_normalize_pre_migration_validate_rc "$mig_rc" "$mig_log")"
  rm -f "$mig_log"
  gdc_release_handle_pre_migration_validate_rc "$mig_rc" || die "Migration integrity check failed"
fi

echo "[$(offline_ts)] Running Alembic migrations..."
offline_compose run --rm --no-deps api alembic upgrade head

echo "[$(offline_ts)] Seeding platform administrator (create-only)..."
offline_compose run --rm --no-deps api python -m app.db.seed --platform-admin-only

echo "[$(offline_ts)] Starting full application stack..."
offline_compose up -d

# Wait briefly for healthchecks before summary/verify.
for _ in $(seq 1 30); do
  if offline_compose exec -T api wget -qO- http://127.0.0.1:8000/health >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

offline_print_install_summary "$SKIP_VERIFY"
exit $?
