# Current Source Of Truth

Authoritative product, UX, governance, and guardrail documents for Data Relay. Implementation specs under `specs/` remain the engineering authority for code; these documents are the product and UX authority.

**Canonical directory:** `docs/source-of-truth/`

**Last updated:** 2026-06-14

---

## Index

| # | Document | Path | Version (filename) |
|---|----------|------|-------------------|
| 1 | Product Charter | [`docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt`](../source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt) | 1.2.1 |
| 2 | Master WBS | [`docs/source-of-truth/MASTER-WBS-Version-1.2.1-FINAL.txt`](../source-of-truth/MASTER-WBS-Version-1.2.1-FINAL.txt) | 1.2.1 |
| 3 | UX Charter | [`docs/source-of-truth/DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt`](../source-of-truth/DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt) | 1.2.1 |
| 4 | Stream Wizard UX Charter | [`docs/source-of-truth/DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt`](../source-of-truth/DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt) | 5.2 |
| 5 | Governance UX Charter | [`docs/source-of-truth/GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt`](../source-of-truth/GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt) | 1.1 |
| 6 | Governance Workspace UX Charter | [`docs/source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt) | 1.1 |
| 7 | Governance Workspace Spec | [`docs/source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt) | 1.1 |
| 8 | Governance & Transform Policy | [`docs/source-of-truth/DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt) | 1.1 (Draft) |
| 9 | Union Schema UX Spec | [`docs/source-of-truth/DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt`](../source-of-truth/DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt) | 1.1 |

---

## Hierarchy

```text
PRODUCT-CHARTER (1.2.1)          ← top-level product authority
  └─ MASTER-WBS (1.2.1)          ← must not conflict with Product Charter
       ├─ DATA-RELAY-UX-CHARTER (1.2.1)
       ├─ STREAM-WIZARD-UX-CHARTER (5.2)
       ├─ GOVERNANCE-UX-CHARTER (1.1)
       ├─ GOVERNANCE-WORKSPACE-UX-CHARTER (1.1)
       ├─ GOVERNANCE-WORKSPACE (1.1)
       ├─ GOVERNANCE-AND-TRANSFORM-POLICY (1.1 Draft)
       └─ UNION-SCHEMA-UX-SPEC (1.1)
```

---

## Archive

Superseded documents: [`docs/archive/legacy-design/`](../archive/legacy-design/)

---

## Staging

Upload staging area (optional): `docs/source-of-truth/_incoming/`

---

## Runtime (current)

Route Processing (`GDC_ROUTE_PROCESSING_ENABLED=true`) is the only supported product runtime. Explicit `false` is rejected at settings load. Rollback uses a previous release image, not an in-process dual runtime.

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
| [`docs/release/OSS-v1-RC-RELEASE-NOTES.md`](../release/OSS-v1-RC-RELEASE-NOTES.md) | Historical RC snapshot; flag historically defaulted off | KNOWN-LIMITATIONS |
| [`docs/release/OSS-v1.0-GA-CHECKLIST.md`](../release/OSS-v1.0-GA-CHECKLIST.md) | Historical GA checklist (item 37 flag false) | KNOWN-LIMITATIONS + this index |
| [`docs/source-of-truth/CHATGPT-DATA-RELAY-GUARDRAIL.txt`](../source-of-truth/CHATGPT-DATA-RELAY-GUARDRAIL.txt) | Pre-GA AI workflow guardrail with transient M20.4.1/RC/GA state assumptions | `AGENTS.md` + Engineering System + current Product Charter/source-of-truth index |
| Other `docs/architecture/m13-*` design reviews / flag reports | Point-in-time M13 engineering records | specs/091–097 + Runtime code |

Stub files remain under `docs/architecture/` so old links resolve to a SUPERSEDED notice.
