# Current Source Of Truth

**Last updated:** 2026-08-16
**Task:** Remove AI Gateway from Data Relay OSS current product scope
**Canonical directory:** `docs/source-of-truth/`

This is the reading order for Cursor and contributors. Do **not** treat historical audits, session recovery notes, or `_incoming/` copies as product authority.

If a document conflicts with **PRODUCT-CHARTER v1.2.1**, the charter wins.
If a document conflicts with **verified Runtime** (`Runtime Is Truth`), record the conflict; do not silently change Runtime to match an old spec.

---

## Read this first

```text
1. PRODUCT-CHARTER v1.2.1
2. Latest Architecture / UX Charter (this index → listed CURRENT docs)
3. Latest Implementation Spec (specs/091–097 for Route Processing)
4. Runtime Code
5. Tests
```

---

## Hierarchy

```text
PRODUCT
  PRODUCT-CHARTER v1.2.1

ARCHITECTURE
  One Stream → Many Routes → Many Destinations
  Route Processing (Transform → Protection → Classification → Policy → Delivery)
  Union Schema (Stream scope)
  Schema Drift baseline / unknown-field policy (Stream scope)
  Governance (optional)

UX
  DATA-RELAY-UX-CHARTER v1.2.1
  STREAM-WIZARD-UX-CHARTER v5.2
  ROUTE-PROCESSING-UX-SPEC
  Dashboard / Stream Group operational docs

IMPLEMENTATION
  specs/091–097 (Route Processing)
  specs/001–004 + constitution (runtime invariants: checkpoint, route fan-out, mapping≠enrichment)
  Schema Drift Policy Runtime Spec (Stream-scoped persist)

HISTORICAL
  SUPERSEDED / ARCHIVE_CANDIDATE docs — design evidence only
```

### Product model (must not regress in active docs)

```text
Wizard:
  Connect → Sample & Record Selection → Destinations → Route Processing → Deploy

Route Processing:
  Transform → Protection → Classification → Policy → Delivery

Governance: optional (not a default wizard step; not primary navigation)

Union Schema: Stream scope (shared by all routes on the stream)

Schema Drift: Stream-scoped baseline; new field ≠ immediate Confirmed Drift

Unknown Field default: Pass Through

Navigation (primary sidebar):
  Dashboard → Data Sources (Connectors, Streams) → Delivery (Destinations) → Administration

Dashboard / Stream Group: source-product grouping (UX), not a new DB entity

Enterprise IAM / SSO / SAML / OIDC / SCIM: Out of Scope
```

---

## CURRENT (use as Source of Truth)

| Area | Document | Path |
|------|----------|------|
| Product | Product Charter v1.2.1 | [`docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt`](../source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt) |
| WBS | Master WBS v1.2.1 *(read historical vs current status)* | [`docs/source-of-truth/MASTER-WBS-Version-1.2.1-FINAL.txt`](../source-of-truth/MASTER-WBS-Version-1.2.1-FINAL.txt) |
| UX | UX Charter v1.2.1 | [`docs/source-of-truth/DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt`](../source-of-truth/DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt) |
| Wizard | Stream Wizard UX Charter v5.2 | [`docs/source-of-truth/DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt`](../source-of-truth/DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt) |
| Route Processing UX | Route Processing UX Spec | [`docs/ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md`](../ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md) |
| Governance UX | Governance UX Charter v1.1 | [`docs/source-of-truth/GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt`](../source-of-truth/GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt) |
| Governance Workspace UX | Governance Workspace UX Charter v1.1 | [`docs/source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt) |
| Governance Workspace | Governance Workspace spec v1.1 | [`docs/source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt) |
| Policy | Governance & Transform Policy (draft) | [`docs/source-of-truth/DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt) |
| Union Schema | Union Schema UX Spec | [`docs/source-of-truth/DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt) |
| Schema Drift | Schema Drift Policy Runtime Spec | [`docs/ux/DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md`](../ux/DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md) |
| Guardrail | ChatGPT / assistant guardrail *(rules only; Current Goal section is historical)* | [`docs/source-of-truth/CHATGPT-DATA-RELAY-GUARDRAIL.txt`](../source-of-truth/CHATGPT-DATA-RELAY-GUARDRAIL.txt) |
| OSS architecture | OSS v1 Architecture Overview | [`docs/architecture/OSS-v1-ARCHITECTURE.md`](OSS-v1-ARCHITECTURE.md) |
| Dashboard | Dashboard Operational Monitoring | [`docs/ux/dashboard-operational-monitoring.md`](../ux/dashboard-operational-monitoring.md) |
| Operator hub | Documentation hub | [`docs/README.md`](../README.md) |
| Getting started | First pipeline walkthrough | [`docs/getting-started/GETTING-STARTED.md`](../getting-started/GETTING-STARTED.md) |
| Limitations | Known Limitations (GA + persist kinds) | [`docs/release/KNOWN-LIMITATIONS.md`](../release/KNOWN-LIMITATIONS.md) |
| Persist record | Route Processing Persist Roadmap | [`docs/architecture/route-processing-persist-roadmap.md`](route-processing-persist-roadmap.md) |

### Implementation specs (engineering authority)

| Spec | Topic |
|------|-------|
| [`specs/091-route-processing-architecture`](../../specs/091-route-processing-architecture/spec.md) | Route Processing foundation |
| [`specs/092-per-route-transform`](../../specs/092-per-route-transform/spec.md) | Per-route Transform |
| [`specs/093-per-route-protection`](../../specs/093-per-route-protection/spec.md) | Per-route Protection |
| [`specs/094-per-route-classification`](../../specs/094-per-route-classification/spec.md) | Per-route Classification |
| [`specs/095-per-route-policy`](../../specs/095-per-route-policy/spec.md) | Per-route Policy |
| [`specs/096-route-runtime-delivery`](../../specs/096-route-runtime-delivery/spec.md) | Route runtime delivery |
| [`specs/097-route-processing-ux`](../../specs/097-route-processing-ux/spec.md) | Route Processing UX |
| [`specs/001-core-architecture`](../../specs/001-core-architecture/spec.md) … [`004`](../../specs/004-delivery-routing/spec.md), [`048`](../../specs/048-runtime-reliability/spec.md) | Runtime invariants |
| [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) | Checkpoint, route fan-out, mapping≠enrichment, DB policy |
| [`.specify/specs-index.md`](../../.specify/specs-index.md) | Spec catalog (nav section aligned to current sidebar) |

---

## SUPERSEDED (historical; do not implement from these)

These were valid at a snapshot date. A later charter, spec, or the implemented wizard replaced them.

| Document | Why superseded | Superseded by |
|----------|----------------|---------------|
| [`docs/master-design.md`](../master-design.md) | Pre-charter “Generic Data Connector” master design; Mapping-first product framing | PRODUCT-CHARTER + this index + OSS-v1-ARCHITECTURE |
| [`docs/v1-readiness-checklist.md`](../v1-readiness-checklist.md) | Pre-GA GDC checklist; Mapping/Enrichment/Routes as primary nav | docs/release/OSS-v1.0-GA-CHECKLIST.md + UX Charter nav |
| [`docs/archive/historical-audits/route-architecture-gap-analysis.md`](../archive/historical-audits/route-architecture-gap-analysis.md) | Snapshot: Transform → Destinations wizard as “current” | STREAM-WIZARD-UX-CHARTER v5.2 + wizard-state.ts |
| [`docs/archive/historical-audits/m13-destination-first-full-audit.md`](../archive/historical-audits/m13-destination-first-full-audit.md) | Snapshot: Destination First FAIL | Implemented 5-step Destination First wizard |
| [`docs/archive/historical-audits/m13-route-processing-ui-deferral.md`](../archive/historical-audits/m13-route-processing-ui-deferral.md) | Snapshot: Destination First not implemented | STREAM-WIZARD-UX-CHARTER + specs/097 |
| [`docs/archive/historical-audits/m13-route-architecture-completion-audit.md`](../archive/historical-audits/m13-route-architecture-completion-audit.md) | Snapshot: Transform-first wizard | Current wizard-state.ts |
| [`docs/archive/historical-audits/route-processing-foundation-implementation-spec.md`](../archive/historical-audits/route-processing-foundation-implementation-spec.md) | Pre–Destination First implementation plan | specs/091–097 |
| [`docs/release/OSS-v1.0-GA-RELEASE-NOTES.md`](../release/OSS-v1.0-GA-RELEASE-NOTES.md) | Historical GA snapshot (2026-06-20); flag OFF / unwired drift KPI | KNOWN-LIMITATIONS + OSS-v1-ARCHITECTURE |
| [`docs/release/OSS-v1-RC-RELEASE-NOTES.md`](../release/OSS-v1-RC-RELEASE-NOTES.md) | Historical RC snapshot; flag default False | KNOWN-LIMITATIONS |
| [`docs/release/OSS-v1.0-GA-CHECKLIST.md`](../release/OSS-v1.0-GA-CHECKLIST.md) | Historical GA checklist (item 37 flag false) | KNOWN-LIMITATIONS + this index |
| Other `docs/architecture/m13-*` design reviews / flag reports | Point-in-time M13 engineering records | specs/091–097 + Runtime code |

Stub files remain under `docs/architecture/` so old links resolve to a SUPERSEDED notice.

---

## ARCHIVE_CANDIDATE (recovery / staging / historical evidence)

Do **not** use as development Source of Truth.

| Location | Role |
|----------|------|
| [`docs/source-of-truth/_incoming/`](../source-of-truth/_incoming/) | Staging duplicates of canonical SoT `.txt` files |
| [`docs/archive/legacy-design/`](../archive/legacy-design/) | SoT replacement notes |
| [`docs/archive/historical-audits/`](../archive/historical-audits/) | M13 / gap / deferral snapshots |
| [`docs/session-recovery/`](../session-recovery/) | Host/session recovery snapshots (2026-05) |
| [`docs/e2e-recovery-campaign-closure-20260805.md`](../e2e-recovery-campaign-closure-20260805.md) | E2E recovery campaign closure |
| [`archive/`](../../archive/) | Repo-level backups / pending-merge scripts |

---

## MASTER-WBS status (how to read)

Do **not** invent new completion percentages.

| Kind | Meaning |
|------|---------|
| **Historical milestone completion** | Foundation / Data Control Runtime / Governance / OSS Release **100%** as of **OSS v1.0 GA**. Original WBS milestone scope for those phases was delivered. **AI Gateway is not current Data Relay OSS product scope.** |
| **Current stabilization / convergence** | OSS v1 Stabilization is the active goal. Destination First wizard (5-step) and Route Processing 5-stage UX are **implemented in product**. Default runtime is Route Processing (`GDC_ROUTE_PROCESSING_ENABLED=true`); remaining persist `intent_only` cases are draft-only Deploy blockers. |
| **Out of scope** | Enterprise IAM, SSO, SAML, OIDC, SCIM — PRODUCT-CHARTER non-goals. AI Gateway / AI Proxy is not current Data Relay OSS product scope and is not an Enterprise Edition Backlog item. |

---

## CODE_GAPS (documented only)

1. **Classification route bundle** — `inherit.classification = false` without a floor override row still projects `intent_only` (EXPECTED_DRAFT_ONLY; Deploy is blocked).
2. **Incomplete protection override** — protection override without ready non-audit intents still projects `intent_only` (EXPECTED_DRAFT_ONLY; Deploy is blocked).
3. **Frontend sensitivity class** — `inferWizardSensitivityClass` reads backend Union Schema `sensitivity_class` first, then defaults to `pii` (BACKEND_VALUE_FIRST_LEGACY_FALLBACK).

Closed in P1-4: `GDC_ROUTE_PROCESSING_ENABLED` defaults **ON**; Failover and Replay reuse the shared StreamRunner delivery primitive on the route path.

Closed in P2 SMTP: existing Governance / operational notifications deliver via `NotificationService` / dispatcher → `SmtpEmailSender` when `SMTP_ENABLED=true` and `SMTP_HOST` is set. Disabled or unconfigured SMTP does not send and does not fail Stream/runtime/approval. SMTP failure records notification FAILED only. Slack remains planned.

---

## Cursor reading rule

1. Open this index.
2. Read PRODUCT-CHARTER.
3. Read the CURRENT UX / Wizard / Route Processing docs listed above.
4. Use specs/091–097 for Route Processing implementation.
5. Verify against Runtime code and tests.
6. Ignore SUPERSEDED and ARCHIVE_CANDIDATE paths unless investigating history.
