# Installation Validation — OSS v1.0.2 GA

**Purpose:** Verify the path `git clone` → `docker compose up` → login → stream → delivery for Open Source users.

**Validation date:** 2026-06-09  
**Target:** Enterprise Data Control Gateway GA v1.0.2

---

## Prerequisites

- Docker Engine 24+ with Compose v2
- Ports **18080** (HTTP) and **18443** (HTTPS) available
- 4 GB RAM minimum for full stack

---

## Step 1 — Clone and configure

```bash
git clone https://github.com/RickLee-kr/gdc-platform.git data-relay
cd data-relay
cp .env.example .env
# Edit .env: set JWT_SECRET_KEY, SECRET_KEY, ENCRYPTION_KEY, POSTGRES_PASSWORD
```

**Required env keys:** `DATABASE_URL`, `JWT_SECRET_KEY`, `SMTP_ENABLED`, `WEBHOOK_TIMEOUT`

---

## Step 2 — Start platform

```bash
docker compose -f docker-compose.platform.yml up -d
```

Or use the release installer:

```bash
./scripts/release/install.sh
```

**Expected:**

- `postgres`, `api`, `frontend`, `reverse-proxy` containers healthy
- Alembic migrations applied automatically on API startup
- Default admin user created when missing (`admin` / `admin`, password change required)

---

## Step 3 — DB migration verification

```bash
docker compose -f docker-compose.platform.yml exec api alembic current
```

**Expected:** Head revision printed (no pending migrations).

Static pre-check (no Docker):

```bash
bash scripts/release/validate-clean-install.sh
```

---

## Step 4 — Admin login

1. Open `https://localhost:18443/` (or `http://localhost:18080/`)
2. Login: `admin` / `admin` (unless `GDC_SEED_ADMIN_PASSWORD` is set)
3. Change password when prompted

**API check:**

```bash
curl -sk -X POST https://localhost:18443/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<your-password>"}'
```

**Expected:** `access_token` in JSON response.

---

## Step 5 — Create stream (UI)

1. Navigate to **Streams** → **Create First Stream**
2. Wizard steps (Destination First):
   - **Connect** — HTTP API polling (see `samples/http/example-api.json`)
   - **Sample & Record Selection** — run API test, set record path / checkpoint
   - **Destinations** — create webhook or syslog from `samples/destinations/` and attach routes
   - **Route Processing** — shared transform/protection (optional) + per-route inherit/override; mapping sample: `samples/mappings/example-mapping.json`
   - **Deploy** — review decision center, create stream, start delivery

---

## Step 6 — Destination & route (if not created in wizard)

Create destination under **Delivery → Destinations** and attach via the wizard Destinations step or stream detail.

**Expected:** Route shows ENABLED; connectivity test available for webhook/syslog.

---

## Step 7 — Run stream

Start the stream from Streams console or runtime panel.

**Expected:**

- Stream status → RUNNING
- Delivery logs appear under Logs
- Checkpoint updates after successful delivery

---

## Step 8 — Governance & RBAC smoke (optional)

Governance is not a primary sidebar item. Use RBAC-gated deep links if the role allows.

| Check | Path | Expected |
|-------|------|----------|
| Governance Dashboard | `/governance` | KPI cards render; empty state on fresh install |
| Operations | `/governance/operations` | Page loads for authorized role |
| RBAC | Login as VIEWER | Governance deep links unavailable without `governance_read` |
| Notifications | `/governance/notifications` | Config page loads |

---

## Validation results (M20.4)

| Step | Result | Notes |
|------|--------|-------|
| Static clean-install checks | ✅ PASS | `validate-clean-install.sh` |
| Compose file / env template | ✅ PASS | Required keys present in `.env.example` |
| OSS UI surface | ✅ PASS | Internal routes gated |
| Sample pack | ✅ PASS | `samples/` created |
| Full Docker E2E | ⚠️ Manual | Run on target host with Docker; steps documented above |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Blank UI after upgrade | Rebuild frontend: `scripts/frontend-redeploy.sh` |
| Auth 401 | Set `JWT_SECRET_KEY`; ensure `REQUIRE_AUTH=true` |
| Migration error on fresh DB | Run `docker compose ... exec api alembic upgrade head` |
| Empty streams after install | Expected on fresh install — use Create First Stream CTA |

See also: [docs/deployment/install-guide.md](../deployment/install-guide.md), [CHANGELOG.md](../../CHANGELOG.md)
