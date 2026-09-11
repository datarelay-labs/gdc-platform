# Data Relay Documentation

**Product:** Data Relay — Enterprise Data Control Gateway (OSS v1.0 GA)  
**Hub role:** Central index for operator, architect, and release documentation.

---

## Start here

| Document | Audience | Description |
|----------|----------|-------------|
| [Source of Truth Index](./architecture/source-of-truth-index.md) | Cursor, architects | Reading order: PRODUCT-CHARTER → UX → specs → Runtime |
| [Product Charter v1.2.1](./source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt) | Everyone | Top-level product authority |
| [Getting Started](./getting-started/GETTING-STARTED.md) | New operators | First connector → stream → deploy → monitoring walkthrough |
| [Architecture Overview (OSS v1)](./architecture/OSS-v1-ARCHITECTURE.md) | Integrators, architects | Mental model, runtime, checkpoint, replay, quarantine, failover |
| [Root README](../README.md) | Everyone | Install, quick start, project overview |

---

## Release & GA

| Document | Description |
|----------|-------------|
| [OSS v1.0 GA Release Notes](./release/OSS-v1.0-GA-RELEASE-NOTES.md) | Historical GA snapshot (2026-06-20) — not current flag/KPI truth |
| [OSS v1 RC Release Notes](./release/OSS-v1-RC-RELEASE-NOTES.md) | Historical RC snapshot — not current flag/KPI truth |
| [Known Limitations](./release/KNOWN-LIMITATIONS.md) | Current gaps: route bundle persist `intent_only`, scale, DATABASE_QUERY PostgreSQL-only; SMTP delivery is implemented (default off) |
| [OSS v1.0 GA Checklist](./release/OSS-v1.0-GA-CHECKLIST.md) | Historical GA verification checklist |
| [Production Checklist](./release/production-checklist.md) | Go-live security and operations |
| [Installation Validation](./release/installation-validation.md) | Post-install verification steps |
| [Release Readiness Audit](./release/release-readiness-audit.md) | M20.4 OSS surface audit |
| [CHANGELOG](../CHANGELOG.md) | Version history |

---

## Architecture & Design

| Document | Description |
|----------|-------------|
| [Source of Truth Index](./architecture/source-of-truth-index.md) | Current vs superseded vs archive |
| [OSS v1 Architecture](./architecture/OSS-v1-ARCHITECTURE.md) | Current OSS mental model |
| [Route Processing Persist Roadmap](./architecture/route-processing-persist-roadmap.md) | Persist kinds and remaining gaps |
| [Route Processing UX Spec](./ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md) | Inherit/override UX contract |
| [Runtime Capability Matrix](./runtime/runtime-capability-matrix.md) | Feature availability matrix |
| [Schema Drift Runtime Spec](./ux/DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md) | Schema drift policy behavior (Stream scope) |
| [Master Design](./master-design.md) | SUPERSEDED historical design |

---

## UX & Operations

| Document | Description |
|----------|-------------|
| [Dashboard Operational Monitoring](./ux/dashboard-operational-monitoring.md) | Dashboard charter implementation |
| [Operator Runbook](./operator-runbook.md) | Day-2 operator procedures |
| [Product Charter (source)](./source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt) | Top-level product authority |
| [UX Charter (source)](./source-of-truth/DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt) | UX design authority |
| [Stream Wizard UX Charter (source)](./source-of-truth/DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt) | Wizard step authority |

---

## Governance

| Document | Description |
|----------|-------------|
| [Governance UX Charter (source)](./source-of-truth/GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt) | Governance surface design |
| [Governance Workspace UX Charter (source)](./source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt) | Workspace MVP spec |
| [Support Bundle](./admin/support-bundle.md) | Diagnostic export procedure |
| [Backup & Restore](./admin/backup-restore.md) | Configuration backup |

---

## Route Processing

| Document | Description |
|----------|-------------|
| [Route Processing UX Spec](./ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md) | Full UX spec (wizard, route edit, effective status) |
| [Route Persist Roadmap](./architecture/route-processing-persist-roadmap.md) | Persist kinds and remaining gaps |
| Specs 091–097 | `../specs/091-route-processing-architecture/` through `097-route-processing-ux/` |
| Historical M13 audits | [`docs/archive/historical-audits/`](./archive/historical-audits/) (SUPERSEDED) |

---

## Performance

| Document | Description |
|----------|-------------|
| [Performance P0 Report](./performance/performance-p0-optimization-report.md) | Runtime loading and catalog caches |
| [Performance P1 Report](./performance/performance-p1-optimization-report.md) | Streams N+1, lazy routes, recharts chunk |

---

## Deployment

| Document | Description |
|----------|-------------|
| [Install Guide](./deployment/install-guide.md) | Detailed installation |
| [Upgrade Guide](./deployment/upgrade-guide.md) | Version upgrade procedure |
| [HTTPS Reverse Proxy](./deployment/https-reverse-proxy.md) | TLS termination |
| [Backup & Restore (deployment)](./deployment/backup-restore.md) | Deployment-level backup |
| [Docker Platform](./docker-platform.md) | Compose topology |

---

## Testing & Development

| Document | Description |
|----------|-------------|
| [Backend Full Test](./testing/backend-full-test.md) | Backend test suite guide |
| [Dev Validation Lab](./testing/dev-validation-lab.md) | Internal lab (non-OSS) |
| [E2E Regression](./testing/e2e-regression.md) | End-to-end test matrix |

---

## Specifications (Spec Kit)

Numbered specs live under [`../specs/`](../specs/). Key entries:

| Spec | Topic |
|------|-------|
| 001 | Core architecture |
| 002 | Runtime pipeline |
| 004 | Delivery routing |
| 065 | Protection engine |
| 067 | Failover routing |
| 068 | Replay engine |
| 069 | Quarantine MVP |
| 091–096 | Route processing architecture |
| 097 | Route processing UX |

Constitution: [`.specify/memory/constitution.md`](../.specify/memory/constitution.md)

---

## Samples

Example JSON configurations: [`../samples/`](../samples/)

---

*Data Relay OSS v1.0 GA — Documentation index. Last updated: 2026-08-13 (P1-3 Source of Truth alignment).*
