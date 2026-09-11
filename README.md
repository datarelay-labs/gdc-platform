# Data Relay — Enterprise Data Control Gateway

**Version:** GA v1.0.2 (OSS)

Data Relay is an open-source **Enterprise Data Control Gateway**. It collects data from external systems (HTTP API polling, webhook receiver), applies Stream and Route Processing (Transform, optional Protection / Classification / Policy), runs schema drift detection and sensitive-data detection, then delivers events to multiple Destinations via Routes. Governance, RBAC, and audit are optional control-plane surfaces.

Source of Truth: [`docs/architecture/source-of-truth-index.md`](docs/architecture/source-of-truth-index.md) · [`PRODUCT-CHARTER v1.2.1`](docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt)

Release documentation: [`docs/release/`](docs/release/) · Documentation hub: [`docs/README.md`](docs/README.md)

---

## Why Data Relay?

Enterprises need a **control point** between internal systems and external destinations — not another SIEM, data lake, or IAM product.

Data Relay fills the gap between **"we have data"** and **"we deliver data safely"**:

- **One stream, many destinations** — avoid duplicating pipelines for each target
- **Route-level processing** — destination-specific transform and protection without stream copies
- **Operational visibility first** — Dashboard and Streams console designed for daily checks, not just incidents
- **Optional governance** — protection, classification, policy, quarantine, and replay when you need them
- **Runtime is truth** — checkpoints, delivery logs, and metrics reflect what actually happened

See the [Product Charter](docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt) for scope and non-goals.

---

## Core Capabilities

| Capability | OSS v1.0 GA |
|------------|-------------|
| HTTP API polling & Webhook sources | ✅ |
| Database Query source (PostgreSQL runtime) | ✅ (PG only) |
| Mapping & Enrichment (JSONPath, JSONata, regex_extract) | ✅ |
| Multi-route delivery & dynamic routing | ✅ |
| Failover (active/standby) | ✅ (default runtime path) |
| Protection, Classification, Policy | ✅ |
| Schema Drift & Sensitive Detection | ✅ |
| Quarantine & Replay | ✅ |
| Dashboard & Operations UX | ✅ |
| Governance centers (RBAC-gated) | ✅ |
| Per-route processing pipeline | ✅ Default ON (`GDC_ROUTE_PROCESSING_ENABLED`) |

Known gaps: [docs/release/KNOWN-LIMITATIONS.md](docs/release/KNOWN-LIMITATIONS.md)

---

## What is Data Relay

Data Relay is a lightweight connector platform that:

- Separates **Connectors**, **Streams**, **Sources**, and **Destinations**
- Executes pipelines at the **Stream** level
- Connects streams to destinations via **Routes** (multi-destination)
- Applies **Transform** (Mapping then Enrichment internally) on Stream / Route Processing
- Updates **Checkpoints** only after successful destination delivery
- Optional **Governance** (violations, quarantine, replay, approvals, audit, notifications)
- Enforces **RBAC** for operator and governance personas

---

## Architecture

```
Source
  ↓
Mapping
  ↓
Enrichment
  ↓
Schema Drift
  ↓
Sensitive Detection
  ↓
Protection
  ↓
Classification
  ↓
Policy
  ↓
Quarantine
  ↓
Replay
  ↓
Dynamic Routing
  ↓
Failover
  ↓
Destination
```

---

## Quick Start

### Requirements

- Docker Engine 24+ with Compose v2
- Ports **18080** (HTTP) and **18443** (HTTPS)

### Install and run

```bash
git clone https://github.com/RickLee-kr/gdc-platform.git data-relay
cd data-relay
cp .env.example .env
# Set JWT_SECRET_KEY, SECRET_KEY, ENCRYPTION_KEY, POSTGRES_PASSWORD before production use

docker compose -f docker-compose.platform.yml up -d
```

Or use the release installer:

```bash
./scripts/release/install.sh
```

Open **https://localhost:18443/** (accept self-signed cert) or **http://localhost:18080/**.

**Default login:** `admin` / `admin` — password change required on first login.

Override bootstrap password with `GDC_SEED_ADMIN_PASSWORD` in `.env`.

---

## First Stream

> **New to Data Relay?** Follow the full walkthrough: [Getting Started](docs/getting-started/GETTING-STARTED.md)

Use the stream wizard (**Streams → Create First Stream**):

| Step | Action |
|------|--------|
| **Connect** | Select connector + configure HTTP source (create connector first under **Connectors**) |
| **Sample** | Run API test, select record path, confirm checkpoint |
| **Destinations** | Choose delivery targets and route drafts |
| **Route Processing** | Shared mapping/enrichment + optional per-route overrides |
| **Deploy** | Review decision center, create stream, start delivery |

Sample JSON files are in the [`samples/`](samples/) directory.

After deploy, monitor on **Dashboard** (`/monitoring`) and **Streams** console. See [Architecture Overview](docs/architecture/OSS-v1-ARCHITECTURE.md) for the mental model.

---

## Known Limitations (OSS v1.0 GA)

GA ships with documented gaps — not release blockers for the default deployment path:

- **Route persist gaps** — incomplete classification/protection overrides may still deploy as *Intent only*; complete Transform/Protection/Policy overrides persist at deploy (see Known Limitations)
- **Governance Workspace scale** — 4 API calls per route on load (slow at 50+ routes)
- **Streams scale** — per-stream runtime stats at 50–100 streams (see performance docs)
- **Database Query** — PostgreSQL runtime only
- **`GDC_ROUTE_PROCESSING_ENABLED`** — default ON (Route Processing runtime); set `false` to use the legacy stream-scoped path

Full reference: [`docs/release/KNOWN-LIMITATIONS.md`](docs/release/KNOWN-LIMITATIONS.md)

---

## Governance

Governance is **optional** and **not** a primary sidebar item. Surfaces are RBAC-gated deep links (`/governance/*`):

| Surface | Purpose |
|---------|---------|
| **Dashboard** | Executive KPIs, risk overview, compliance snapshot |
| **Operations** | Day-to-day governance actions |
| **Violations** | Policy violation triage |
| **Quarantine** | Held events review and release |
| **Replay** | Re-process quarantined or failed events |
| **Approvals** | Policy approval workflow |
| **Audit** | Immutable governance audit trail |
| **Notifications** | Email and webhook alert configuration |

RBAC controls who can view governance surfaces. Users without `governance_read` cannot use governance deep links.

---

## Administration

| Area | Path | Purpose |
|------|------|---------|
| **Users & Roles** | Settings | Platform users, roles, credentials |
| **Destinations** | Destinations | Reusable delivery endpoints |
| **Connectors** | Connectors | Source connectors |
| **Routes** | Stream / Destinations drill-down | Stream-to-destination links (not primary sidebar) |
| **Backup** | Backup & Import | Configuration export/import |

---

## Configuration

Key environment variables (see [`.env.example`](.env.example)):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET_KEY` | Yes | JWT signing secret (`JWT_SECRET` in operator docs) |
| `SMTP_ENABLED` | Yes | Enable SMTP for governance/operational email (`false` until configured) |
| `SMTP_HOST` | No | SMTP server hostname (required when `SMTP_ENABLED=true`) |
| `WEBHOOK_TIMEOUT` | Yes | Governance webhook timeout in seconds (default `10`) |
| `REQUIRE_AUTH` | Yes | Require login for API/UI |
| `ENABLE_DEV_VALIDATION_LAB` | No | Must be `false` in production |

Production checklist: [`docs/release/production-checklist.md`](docs/release/production-checklist.md)

---

## Development

### Backend (local)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend (local)

```bash
cd frontend
npm install
npm run dev
```

Set `VITE_OSS_RELEASE_MODE=false` to expose internal validation lab UI during development.

### Tests

```bash
# Backend (isolated gdc_pytest catalog)
./scripts/test/run-backend-full.sh

# Frontend
cd frontend && npm run validate
```

---

## Documentation index

**Documentation hub:** [`docs/README.md`](docs/README.md)

| Document | Description |
|----------|-------------|
| [`docs/getting-started/GETTING-STARTED.md`](docs/getting-started/GETTING-STARTED.md) | First pipeline walkthrough (GA) |
| [`docs/architecture/OSS-v1-ARCHITECTURE.md`](docs/architecture/OSS-v1-ARCHITECTURE.md) | OSS v1 mental model and runtime |
| [`docs/release/OSS-v1.0-GA-RELEASE-NOTES.md`](docs/release/OSS-v1.0-GA-RELEASE-NOTES.md) | GA release notes |
| [`docs/release/KNOWN-LIMITATIONS.md`](docs/release/KNOWN-LIMITATIONS.md) | Known gaps reference |
| [`docs/release/OSS-v1.0-GA-CHECKLIST.md`](docs/release/OSS-v1.0-GA-CHECKLIST.md) | GA verification checklist |
| [`docs/master-design.md`](docs/master-design.md) | Historical design (SUPERSEDED — do not use as SoT) |
| [`docs/deployment/install-guide.md`](docs/deployment/install-guide.md) | Detailed install |
| [`docs/release/installation-validation.md`](docs/release/installation-validation.md) | Install verification steps |
| [`docs/release/production-checklist.md`](docs/release/production-checklist.md) | Production go-live checklist |
| [`docs/release/release-readiness-audit.md`](docs/release/release-readiness-audit.md) | M20.4 release audit |
| [`docs/operator-runbook.md`](docs/operator-runbook.md) | Operator procedures |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history (v1.0.0 – v1.0.2) |
| [`LICENSE`](LICENSE) | Apache License 2.0 |

---

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) for terms.
