# OSS v1.0 GA Checklist

**Status:** HISTORICAL GA CHECKLIST (2026-06-20) — item 37 and Post-GA backlog rows below are snapshot criteria, not current product defaults.
**Current default:** `GDC_ROUTE_PROCESSING_ENABLED=true`. Schema Drift fleet count is confirmed open `StreamSchemaFieldDrift` via Runtime Snapshot. See [`KNOWN-LIMITATIONS.md`](./KNOWN-LIMITATIONS.md).

**Release:** Data Relay OSS v1.0 GA
**Branch:** `feature/sensitive-detection-m5-clean`
**Date:** 2026-06-20
**Use with:** [Production Checklist](./production-checklist.md) for go-live security sign-off

---

## Build & Test Gates

| # | Gate | Command / criterion | Status |
|---|------|---------------------|--------|
| 1 | **Frontend build** | `cd frontend && npm run build` — exit 0 | ☐ |
| 2 | **Frontend tests** | `cd frontend && npm test` — all pass | ☐ |
| 3 | **Frontend validate** | `cd frontend && npm run validate` (tsc + test) | ☐ |
| 4 | **Backend full suite** | `./scripts/test/run-backend-full.sh` — exit 0 | ☐ |
| 5 | **Docker build (API)** | `docker compose -f docker-compose.platform.yml build api` | ☐ |
| 6 | **Docker build (Frontend)** | `docker compose -f docker-compose.platform.yml build frontend` | ☐ |
| 7 | **Fresh install validation** | `./scripts/release/validate-clean-install.sh` (if available) | ☐ |
| 8 | **Alembic head aligned** | Container and host migration revision match | ☐ |

---

## OSS Release Surface

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 9 | **OSS release mode** | Frontend built with `VITE_OSS_RELEASE_MODE=true` | ☐ |
| 10 | **Dev validation lab hidden** | `ENABLE_DEV_VALIDATION_LAB=false` in production `.env` | ☐ |
| 11 | **Internal routes guarded** | `/validation`, `/templates`, connector catalog redirect in OSS | ☐ |
| 12 | **Auth required** | `REQUIRE_AUTH=true`; login gate active | ☐ |
| 13 | **Default admin bootstrap** | First login password change enforced | ☐ |

---

## Core Product — Connector

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 14 | **Connector list** | Connectors overview loads | ☐ |
| 15 | **Connector create** | New connector wizard completes | ☐ |
| 16 | **Connector detail** | Detail page shows config (masked secrets) | ☐ |
| 17 | **Connector CRUD API** | Create/read/update/delete via API | ☐ |

---

## Core Product — Stream

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 18 | **Stream wizard** | 5-step wizard completes (Connect → Deploy) | ☐ |
| 19 | **Stream list** | Streams console group view renders | ☐ |
| 20 | **Stream edit** | Edit page loads and saves | ☐ |
| 21 | **Stream mapping** | Mapping page JSONPath/JSONata works | ☐ |
| 22 | **Stream enrichment** | Enrichment page loads | ☐ |
| 23 | **Stream CRUD API** | Create/read/update/delete via API | ☐ |

---

## Core Product — Route & Destination

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 24 | **Destination CRUD** | Create and list destinations | ☐ |
| 25 | **Route CRUD** | Create stream–destination routes | ☐ |
| 26 | **Route Edit** | Transform/Protection/Classification/Policy tabs | ☐ |
| 27 | **Effective Status** | Inherited/Overridden/Mixed displays correctly | ☐ |
| 28 | **Route Processing Overview** | Stream route processing summary visible | ☐ |

---

## Runtime

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 29 | **Stream start/stop** | Runtime controls respond | ☐ |
| 30 | **Run once** | Manual pipeline execution succeeds | ☐ |
| 31 | **HTTP polling collect** | Events ingested from HTTP source | ☐ |
| 32 | **Webhook collect** | Inbound webhook accepted | ☐ |
| 33 | **Mapping runtime** | Field mappings applied in delivery payload | ☐ |
| 34 | **Multi-route delivery** | Events delivered to all enabled routes | ☐ |
| 35 | **Checkpoint** | Advances only after successful delivery | ☐ |
| 36 | **Delivery logs** | Structural delivery logs written | ☐ |
| 37 | **Default runtime path** | `GDC_ROUTE_PROCESSING_ENABLED=false` verified | ☐ |

---

## Governance

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 38 | **Protection engine** | Mask/hash/block rules apply when configured | ☐ |
| 39 | **Classification** | Classification rules evaluate | ☐ |
| 40 | **Policy engine** | Audit/quarantine actions fire when configured | ☐ |
| 41 | **Quarantine center** | Quarantined events visible; release works | ☐ |
| 42 | **Replay center** | Recorded events replay successfully | ☐ |
| 43 | **Violations center** | Policy violations listed | ☐ |
| 44 | **Audit trail** | Governance audit entries recorded | ☐ |
| 45 | **Notifications config** | Channel configuration UI loads | ☐ |
| 46 | **Governance Workspace** | Read-only overview loads (note scale at 50+ routes) | ☐ |

---

## RBAC

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 47 | **Role assignment** | Admin can assign roles in Settings | ☐ |
| 48 | **Governance nav gate** | Users without `governance_read` hide Governance menu | ☐ |
| 49 | **Operator permissions** | Stream operate vs read-only enforced | ☐ |
| 50 | **API auth** | Unauthenticated API returns 401 when `REQUIRE_AUTH=true` | ☐ |

---

## Dashboard

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 51 | **Dashboard landing** | `/monitoring` loads as default route | ☐ |
| 52 | **Overall Health** | Health hero displays counts | ☐ |
| 53 | **Group KPI strip** | Product group health visible | ☐ |
| 54 | **Operational Issues** | Issue panel renders (no-data, low volume, capacity) | ☐ |
| 55 | **Drill-down** | Group link opens Streams with `expand_group` | ☐ |
| 56 | **Alerts panel** | Recent alerts with runtime links | ☐ |
| 57 | **Refresh cycle** | Manual refresh and auto-refresh options work | ☐ |

---

## Operations UX

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 58 | **Problem-first sort** | Problem streams/groups appear first | ☐ |
| 59 | **Problem panel** | Warning/critical streams listed with runtime links | ☐ |
| 60 | **Group expand/collapse** | Product group rows expand to child streams | ☐ |
| 61 | **Group filter** | Filter by product group works | ☐ |
| 62 | **Quick filters** | Running/degraded/error filters work | ☐ |
| 63 | **Runtime navigation** | Stream row → runtime detail | ☐ |
| 64 | **Streams auto-refresh** | Configurable refresh preference persists | ☐ |
| 65 | **50-stream smoke** | Streams console usable at ~50 streams (latency acceptable) | ☐ |

---

## Performance (P0 + P1)

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 66 | **Runtime detail single refresh** | No duplicate initial API batch | ☐ |
| 67 | **Catalog cache (15s)** | Routes list / stream by-id cache hits within TTL | ☐ |
| 68 | **Snapshot ID reuse** | Dashboard summary cache hit on refresh within 15s | ☐ |
| 69 | **Lazy runtime page** | Runtime detail loads as async chunk | ☐ |
| 70 | **Lazy dashboard** | Dashboard loads as async chunk | ☐ |
| 71 | **Recharts vendor chunk** | `vendor-recharts-*.js` separate from main entry | ☐ |
| 72 | **Mapping-ui lazy (Streams)** | No mapping-ui fetch on collapsed group load | ☐ |

---

## Documentation

| # | Item | Criterion | Status |
|---|------|-----------|--------|
| 73 | **GA release notes** | `docs/release/OSS-v1.0-GA-RELEASE-NOTES.md` published | ☐ |
| 74 | **Getting Started** | `docs/getting-started/GETTING-STARTED.md` published | ☐ |
| 75 | **Architecture overview** | `docs/architecture/OSS-v1-ARCHITECTURE.md` published | ☐ |
| 76 | **Known limitations** | `docs/release/KNOWN-LIMITATIONS.md` published | ☐ |
| 77 | **Documentation index** | `docs/README.md` links all GA docs | ☐ |
| 78 | **README updated** | Root README links GA documentation package | ☐ |

---

## Sign-off

| Role | Name | Date | Notes |
|------|------|------|-------|
| Engineering | | | Build + test gates |
| Product | | | Charter alignment |
| Operations | | | Runtime smoke on target env |
| Security | | | Production checklist complete |

---

## Post-GA (non-blocking backlog)

- Route Bundle Persist MVP (v1.1)
- Governance Workspace lazy load
- Streams batch stats/health API
- Dashboard schema drift KPI wiring
- Wizard Connect gate and onboarding polish

See [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) and [route-processing-persist-roadmap.md](../architecture/route-processing-persist-roadmap.md).

---

*Data Relay OSS v1.0 GA — Release verification checklist.*
