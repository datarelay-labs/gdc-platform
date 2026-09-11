# Frontend Schema Drift Observability Audit

**Status:** ARCHIVE_CANDIDATE (point-in-time audit)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), [`DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md`](../ux/DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md)

**Date:** 2026-06-17  
**Branch:** `feature/sensitive-detection-m5-clean` (synced with `origin` at `e91515a`)  
**Baseline:** Commit A pushed (`e91515a` — backend schema drift observability regression tests, 29/29)  
**Mode:** Read-only audit — no code changes, no commit, no push

---

## 1. Executive Summary

Frontend Schema Drift Observability WIP is a **cohesive, implementation-complete bundle** that closes the operator gap between backend `delivery_logs` emissions (Commit A) and Stream Runtime / Logs Explorer surfaces.

| Criterion | Result |
|-----------|--------|
| **Completeness (stream-scoped observability)** | ✅ **High** — all four backend stage tokens wired in UI |
| **Dependencies** | ✅ Commit A on `origin`; committed wizard + `SchemaDriftPanel` baseline |
| **SoT alignment (stream baseline)** | ✅ Defaults, read-only policy card, troubleshooting order |
| **Route architecture compatibility** | ⚠️ **Stream-config only** — no per-route drift policy display (SoT §21 deferred) |
| **Build safety** | ⚠️ **Atomic commit required** — modified files import untracked libs |
| **Test coverage** | ✅ 19/19 vitest tests pass on WIP files (8 files) |
| **Governance overlap** | ⚠️ `humanize-quarantine-reason` + quarantine surfaces are **separate workstream** |

### Verdict

| Workstream | Ready? | Recommendation |
|------------|--------|----------------|
| **Commit B1 — Frontend Schema Drift Observability** | **READY** (after `scripts/frontend-redeploy.sh`) | Single atomic commit of 15 frontend files |
| **Commit B2 — Governance UX Humanization** | **READY** (independent) | Separate commit: 4 backend + 4 frontend governance files |

**No DISCARD** recommendations for any frontend file in scope. All WIP is intentional, tested, and aligned with shipped runtime.

---

## 2. File Inventory

### 2.1 `git status` — frontend-related WIP (2026-06-17)

**Modified (tracked, unstaged):**

| Path | Δ | Bucket |
|------|---|--------|
| `frontend/src/components/logs/delivery-log-stages.ts` | +22 | C |
| `frontend/src/components/logs/logs-explorer-page.tsx` | +67 | C |
| `frontend/src/components/streams/protection-panel.tsx` | +49 | B |
| `frontend/src/components/streams/stream-governance-drawer.tsx` | +6 | A, D |
| `frontend/src/components/streams/stream-runtime-detail-page.tsx` | +7 | A, D |
| `frontend/src/components/streams/quarantine-panel.tsx` | +8 | B2 overlap |
| `frontend/src/components/governance/replay-center-page.tsx` | +4 | B2 |
| `frontend/src/components/governance/violation-center-page.tsx` | +5 | B2 |
| `frontend/src/components/governance/quarantine-center-page.test.tsx` | ±1 | B2 |

**Untracked (frontend):**

| Path | Bucket |
|------|--------|
| `frontend/src/components/logs/delivery-log-stages.schema-drift.test.ts` | F |
| `frontend/src/components/streams/schema-drift-policy-card.tsx` | A |
| `frontend/src/components/streams/schema-drift-policy-card.test.tsx` | F |
| `frontend/src/components/streams/protection-panel.test.tsx` | F |
| `frontend/src/components/streams/quarantine-panel.test.tsx` | F (B2 overlap) |
| `frontend/src/lib/stream-schema-drift-policy.ts` | A, E |
| `frontend/src/lib/stream-schema-drift-policy.test.ts` | F |
| `frontend/src/lib/auto-protect-activity.ts` | B, E |
| `frontend/src/lib/auto-protect-activity.test.ts` | F |
| `frontend/src/lib/protection-rule-origin.ts` | B, E |
| `frontend/src/lib/protection-rule-origin.test.ts` | F |
| `frontend/src/lib/humanize-quarantine-reason.ts` | B2, E |
| `frontend/src/lib/humanize-quarantine-reason.test.ts` | F (B2) |

**Modified diff stat (frontend only):** 9 files, +161 / −9 lines (includes B2 governance files).

### 2.2 Committed baseline (dependency context — not WIP)

These files are **already on `origin`** and support B1 but are **not** part of the observability commit:

| Path | Role |
|------|------|
| `frontend/src/components/streams/schema-drift-panel.tsx` | Open drift findings table (Union Schema / observation API) |
| `frontend/src/api/gdcSchemaDrift.ts` | Drift findings API client |
| `frontend/src/components/streams/wizard/step-data-protection.tsx` | Wizard policy configuration |
| `frontend/src/components/streams/wizard/schema-drift-policy-summary.tsx` | Wizard review summary |
| `frontend/src/components/streams/wizard/wizard-schema-drift-policy-persist.ts` | Persist `governance.schema_drift_policy` |
| `frontend/src/components/streams/wizard/wizard-data-protection-summary.ts` | `schemaDriftPolicyReviewSummary()` label helper |
| `app/schema_drift_policy/delivery_log_stages.py` | Backend stage contract (`1806a10` / Commit A dependency) |

### 2.3 Classification map (Task 2)

| Class | Description | Files |
|-------|-------------|-------|
| **A. Schema Drift Policy UI** | Read-only deployed policy display | `schema-drift-policy-card.tsx`, `stream-schema-drift-policy.ts`, `stream-governance-drawer.tsx` (card slot), `stream-runtime-detail-page.tsx` (wire-up) |
| **B. Auto Protect Activity UI** | Runtime auto-protect observability in Protection panel | `protection-panel.tsx`, `auto-protect-activity.ts`, `protection-rule-origin.ts` |
| **C. Logs Explorer UI** | Stage registry + quick filters | `delivery-log-stages.ts`, `logs-explorer-page.tsx` |
| **D. Governance Drawer UI** | Container integrating policy card + existing panels | `stream-governance-drawer.tsx`, `stream-runtime-detail-page.tsx` |
| **E. Shared Components / Libs** | Cross-surface helpers | `delivery-log-stages.ts` (constants), `stream-schema-drift-policy.ts`, `auto-protect-activity.ts`, `protection-rule-origin.ts`, `humanize-quarantine-reason.ts` |
| **F. Tests** | Unit / component tests | 8 test files (see §2.1 untracked + `quarantine-panel.test.tsx`) |

---

## 3. Component Audit

### 3.1 Per-file analysis (Task 3)

#### A — Schema Drift Policy UI

| File | Purpose | Status | Dependency | Decision |
|------|---------|--------|------------|----------|
| `schema-drift-policy-card.tsx` | Read-only card: Unknown Normal / Unknown Sensitive deployed labels | ✅ Complete | `stream-schema-drift-policy.ts` | KEEP · **COMMIT NOW** (B1) |
| `stream-schema-drift-policy.ts` | Extract labels from `streams.config_json.governance.schema_drift_policy`; defaults match backend | ✅ Complete | `wizard-state` normalizers, `schemaDriftPolicyReviewSummary` | KEEP · **COMMIT NOW** (B1) |
| `stream-governance-drawer.tsx` | Optional `SchemaDriftPolicyCard` above `SchemaDriftPanel` | ✅ Complete | `schema-drift-policy-card.tsx` | KEEP · **COMMIT NOW** (B1) |
| `stream-runtime-detail-page.tsx` | `useMemo` → pass `schemaDriftPolicyLabels` to drawer | ✅ Complete | `stream-schema-drift-policy.ts` | KEEP · **COMMIT NOW** (B1) |

#### B — Auto Protect Activity UI

| File | Purpose | Status | Dependency | Decision |
|------|---------|--------|------------|----------|
| `protection-panel.tsx` | Fetches `schema_drift_policy_auto_protect_applied` logs; shows Recent Auto Protect Activity; Origin column on rules | ✅ Complete | `gdcRuntime.searchRuntimeDeliveryLogs`, `auto-protect-activity.ts`, `protection-rule-origin.ts`, `delivery-log-stages.ts` | KEEP · **COMMIT NOW** (B1) |
| `auto-protect-activity.ts` | Parse backend message `Auto protect applied: {path} ({mode})` | ✅ Complete | Commit A message contract | KEEP · **COMMIT NOW** (B1) |
| `protection-rule-origin.ts` | Operator vs Wizard badge for **persisted** DB rules only | ✅ Complete | `ProtectionRule.source_finding_id` | KEEP · **COMMIT NOW** (B1) — bundle with panel |

#### C — Logs Explorer UI

| File | Purpose | Status | Dependency | Decision |
|------|---------|--------|------------|----------|
| `delivery-log-stages.ts` | Register 4 schema drift stages, display labels, drilldown constants; sync with `delivery_log_stages.py` | ✅ Complete | Backend stage strings | KEEP · **COMMIT NOW** (B1) |
| `logs-explorer-page.tsx` | Quick-filter chips: Schema Drift Policy, Auto Protect Applied, Review Required, Path Resolution Failed | ✅ Complete | `delivery-log-stages.ts`, URL `stage` param | KEEP · **COMMIT NOW** (B1) |

#### D — Governance Drawer UI

| File | Purpose | Status | Dependency | Decision |
|------|---------|--------|------------|----------|
| `stream-governance-drawer.tsx` | Drawer stack: Policy Card → Drift Panel → Sensitive → Classification → Protection → Quarantine | ✅ Complete | Multiple panels | KEEP · **COMMIT NOW** (B1) |
| `schema-drift-panel.tsx` *(committed)* | Drift **findings** (open/ack/baseline) — distinct from policy card | ✅ Shipped | `gdcSchemaDrift` API | KEEP · **NEVER** (already committed) |

**Note:** `SchemaDriftPolicyCard` (deployed **policy**) and `SchemaDriftPanel` (observed **findings**) are complementary, not duplicates.

#### E — Shared / B2 overlap

| File | Purpose | Status | Dependency | Decision |
|------|---------|--------|------------|----------|
| `humanize-quarantine-reason.ts` | Display-only quarantine reason labels incl. `policy:schema_drift:*` | ✅ Complete | Mirrors backend `_humanize_quarantine_reason` | KEEP · **COMMIT LATER** (B2) |
| `quarantine-panel.tsx` | Uses humanize for reason column | ✅ Complete | `humanize-quarantine-reason.ts` | KEEP · **COMMIT LATER** (B2) — or split: B1 can ship without this change |

#### F — Tests

| File | Covers | Status | Decision |
|------|--------|--------|----------|
| `delivery-log-stages.schema-drift.test.ts` | Stage token registry + labels | ✅ 2 tests pass | KEEP · **COMMIT NOW** (B1) |
| `schema-drift-policy-card.test.tsx` | Card render | ✅ 1 test pass | KEEP · **COMMIT NOW** (B1) |
| `stream-schema-drift-policy.test.ts` | Config → labels, defaults | ✅ 2 tests pass | KEEP · **COMMIT NOW** (B1) |
| `auto-protect-activity.test.ts` | Log parsing | ✅ 4 tests pass | KEEP · **COMMIT NOW** (B1) |
| `protection-rule-origin.test.ts` | Origin badge | ✅ 2 tests pass | KEEP · **COMMIT NOW** (B1) |
| `protection-panel.test.tsx` | Activity + origin integration | ✅ 2 tests pass | KEEP · **COMMIT NOW** (B1) |
| `humanize-quarantine-reason.test.ts` | Label mapping | ✅ 4 tests pass | KEEP · **COMMIT LATER** (B2) |
| `quarantine-panel.test.tsx` | Humanized reason in panel | ✅ 2 tests pass | KEEP · **COMMIT LATER** (B2) |

### 3.2 Coverage gaps (non-blocking)

| Gap | Severity | Notes |
|-----|----------|-------|
| No Protection-panel feed for `review_required` or `quarantine` stages | Low | Logs Explorer quick filters cover these; Protection panel scope is auto-protect per SoT |
| No deep-link from Governance Drawer → Logs Explorer with stage preset | Low | Future UX polish |
| No per-route drift policy display | Medium | SoT §21 — M13 runtime supports route override; UI deferred |
| No `logs-explorer-page` component test for new chips | Low | Covered indirectly via `delivery-log-stages.schema-drift.test.ts` |
| `humanize-quarantine-reason` duplicated frontend/backend | Low | Acceptable for display-only MVP |

### 3.3 Runtime validation (read-only)

```bash
cd frontend && npm test -- --run \
  src/components/logs/delivery-log-stages.schema-drift.test.ts \
  src/components/streams/schema-drift-policy-card.test.tsx \
  src/components/streams/protection-panel.test.tsx \
  src/components/streams/quarantine-panel.test.tsx \
  src/lib/stream-schema-drift-policy.test.ts \
  src/lib/auto-protect-activity.test.ts \
  src/lib/humanize-quarantine-reason.test.ts \
  src/lib/protection-rule-origin.test.ts
```

| Result | Count |
|--------|-------|
| **Passed** | **19** |
| **Failed** | 0 |
| **Duration** | ~10.5s |

Backend Commit A: **29/29** pytest (already on `origin`).

---

## 4. SoT Alignment

Validated against:

- `DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt`
- `DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt`
- `DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt`
- `DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt`
- `DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt`

| SoT principle | WIP evidence | Alignment |
|---------------|--------------|-----------|
| **UX Charter §16 Level 3** — Stream Detail answers "why?" with Schema Drift + Protection | Policy card + drift panel + protection activity in governance drawer | ✅ |
| **UX Charter §20** — Troubleshooting order: Schema Drift before Protection | Drawer order: Policy Card → Drift Panel → … → Protection | ✅ |
| **UX Charter §22** — Schema Drift "사실상 필수"; field change → notification expectation | Logs Explorer filters + delivery log stages | ✅ |
| **Governance Policy §9–10** — Unknown Normal default Pass Through; Unknown Sensitive default Auto Protect | `stream-schema-drift-policy.test.ts` defaults; card shows deployed values | ✅ |
| **Governance Policy §11** — Auto Protect for unknown **sensitive** only | Activity panel shows runtime ephemeral auto-protect logs only | ✅ |
| **Governance Policy §21** — Route override for drift policy | **Not implemented in UI** | ⚠️ Deferred (config scope remains Stream) |
| **Wizard Charter** — Data Protection / governance engines optional | Runtime card is **read-only**; wizard remains configuration path | ✅ |
| **Governance Workspace** — Operator-readable quarantine reasons | `humanize-quarantine-reason` (B2) | ✅ (separate commit) |
| **Union Schema UX** — Drift findings via observation APIs | `SchemaDriftPanel` (committed) unchanged; WIP does not conflict | ✅ |

**Conclusion:** B1 WIP is **aligned** for stream-scoped observability. Route-aware policy display is explicitly **out of scope** for this commit and consistent with M13 "runtime first, UI deferred" posture.

---

## 5. Route Architecture Compatibility

### 5.1 Pre-M13 assumption check (Task 5)

| Check | Finding |
|-------|---------|
| **Stream-only governance display** | `schemaDriftPolicyLabelsFromStreamConfig` reads `streams.config_json` only — matches SoT Configuration Scope = Stream |
| **Missing route concepts** | No route-level drift policy card, no route filter on auto-protect activity — **gap, not obsolete** |
| **Obsolete schema drift UX** | None — WIP extends committed `SchemaDriftPanel`, does not replace wizard or findings workflow |
| **Duplicate policy views** | Three surfaces serve different jobs: **Wizard** (configure), **Policy Card** (deployed summary), **Drift Panel** (open findings) — **intentional, not duplicate** |

### 5.2 M13 compatibility

| Layer | Route-aware? | B1 impact |
|-------|--------------|-----------|
| Backend runtime (M13 shared phase) | Yes — drift can run per route when flag enabled | Logs may include `route_id`; UI does not filter by route |
| Frontend policy display | No — stream config only | Safe to ship; no false route claims |
| Logs Explorer stage filters | Stream-scoped URL params | Works for route-emitted logs (same stage tokens) |

**Risk:** Operators on multi-route streams cannot see **which route** triggered drift policy from current UI. Acceptable for B1; follow-up can add `route_id` column drill-down.

---

## 6. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Partial B1 commit breaks build (imports untracked libs) | **HIGH** | Commit all 15 B1 files atomically |
| 2 | Frontend/backend stage token drift | **MEDIUM** | `delivery-log-stages.schema-drift.test.ts` + Commit A `test_schema_drift_policy_delivery_logs.py` |
| 3 | Production bundle stale after B1 | **HIGH** | Mandatory `scripts/frontend-redeploy.sh` |
| 4 | Bundling B2 into B1 increases review scope | **MEDIUM** | Split commits per §7 |
| 5 | `quarantine-panel.tsx` WIP depends on B2 lib | **LOW** | Revert quarantine-panel change from B1 OR include `humanize-quarantine-reason` only in B2 and keep quarantine-panel on HEAD for B1 |
| 6 | Message parse fragility in `auto-protect-activity.ts` | **LOW** | Regex tied to Commit A `schema_drift_policy_delivery_log_message()` contract |

**Recommended B1 boundary:** Exclude `quarantine-panel.tsx` and `humanize-quarantine-reason*` from B1 to keep observability commit pure. Current WIP couples them — **drop quarantine-panel diff from B1 staging** when committing.

---

## 7. Recommended Commit Split

### Commit B1 — Frontend Schema Drift Observability

**Message suggestion:** `Add frontend schema drift observability UI`

**Files (15 — atomic):**

```text
frontend/src/components/logs/delivery-log-stages.ts
frontend/src/components/logs/delivery-log-stages.schema-drift.test.ts
frontend/src/components/logs/logs-explorer-page.tsx
frontend/src/components/streams/schema-drift-policy-card.tsx
frontend/src/components/streams/schema-drift-policy-card.test.tsx
frontend/src/components/streams/protection-panel.tsx
frontend/src/components/streams/protection-panel.test.tsx
frontend/src/components/streams/stream-governance-drawer.tsx
frontend/src/components/streams/stream-runtime-detail-page.tsx
frontend/src/lib/stream-schema-drift-policy.ts
frontend/src/lib/stream-schema-drift-policy.test.ts
frontend/src/lib/auto-protect-activity.ts
frontend/src/lib/auto-protect-activity.test.ts
frontend/src/lib/protection-rule-origin.ts
frontend/src/lib/protection-rule-origin.test.ts
```

**Post-commit:** `scripts/frontend-redeploy.sh`

**Explicitly exclude from B1:** `quarantine-panel.tsx`, `humanize-quarantine-reason*`, governance center pages.

### Commit B2 — Governance UX Humanization

**Message suggestion:** `Humanize governance quarantine reasons for operator display`

**Files:**

```text
app/governance_audit/service.py
app/governance_quarantine/service.py
app/governance_replay/service.py
app/governance_violations/service.py
frontend/src/lib/humanize-quarantine-reason.ts
frontend/src/lib/humanize-quarantine-reason.test.ts
frontend/src/components/streams/quarantine-panel.tsx
frontend/src/components/streams/quarantine-panel.test.tsx
frontend/src/components/governance/replay-center-page.tsx
frontend/src/components/governance/violation-center-page.tsx
frontend/src/components/governance/quarantine-center-page.test.tsx
```

**Dependency:** Can ship after B1; no hard dependency on B1.

---

## 8. Final File Decision Table

| Path | Class | KEEP / DISCARD | COMMIT NOW / LATER / NEVER | Commit | Notes |
|------|-------|----------------|----------------------------|--------|-------|
| `frontend/.../delivery-log-stages.ts` | C, E | KEEP | **COMMIT NOW** | B1 | Stage registry |
| `frontend/.../delivery-log-stages.schema-drift.test.ts` | F | KEEP | **COMMIT NOW** | B1 | Contract gate |
| `frontend/.../logs-explorer-page.tsx` | C | KEEP | **COMMIT NOW** | B1 | Quick filters |
| `frontend/.../schema-drift-policy-card.tsx` | A | KEEP | **COMMIT NOW** | B1 | Read-only card |
| `frontend/.../schema-drift-policy-card.test.tsx` | F | KEEP | **COMMIT NOW** | B1 | |
| `frontend/.../protection-panel.tsx` | B | KEEP | **COMMIT NOW** | B1 | Activity + origin |
| `frontend/.../protection-panel.test.tsx` | F | KEEP | **COMMIT NOW** | B1 | |
| `frontend/.../stream-governance-drawer.tsx` | A, D | KEEP | **COMMIT NOW** | B1 | Card slot |
| `frontend/.../stream-runtime-detail-page.tsx` | A, D | KEEP | **COMMIT NOW** | B1 | Wire labels |
| `frontend/.../stream-schema-drift-policy.ts` | A, E | KEEP | **COMMIT NOW** | B1 | Config reader |
| `frontend/.../stream-schema-drift-policy.test.ts` | F | KEEP | **COMMIT NOW** | B1 | |
| `frontend/.../auto-protect-activity.ts` | B, E | KEEP | **COMMIT NOW** | B1 | Log parser |
| `frontend/.../auto-protect-activity.test.ts` | F | KEEP | **COMMIT NOW** | B1 | |
| `frontend/.../protection-rule-origin.ts` | B, E | KEEP | **COMMIT NOW** | B1 | With panel |
| `frontend/.../protection-rule-origin.test.ts` | F | KEEP | **COMMIT NOW** | B1 | |
| `frontend/.../humanize-quarantine-reason.ts` | E | KEEP | **COMMIT LATER** | B2 | Display only |
| `frontend/.../humanize-quarantine-reason.test.ts` | F | KEEP | **COMMIT LATER** | B2 | |
| `frontend/.../quarantine-panel.tsx` | — | KEEP | **COMMIT LATER** | B2 | Uses humanize lib |
| `frontend/.../quarantine-panel.test.tsx` | F | KEEP | **COMMIT LATER** | B2 | |
| `frontend/.../governance/replay-center-page.tsx` | — | KEEP | **COMMIT LATER** | B2 | |
| `frontend/.../governance/violation-center-page.tsx` | — | KEEP | **COMMIT LATER** | B2 | |
| `frontend/.../governance/quarantine-center-page.test.tsx` | F | KEEP | **COMMIT LATER** | B2 | Fixture label |
| `frontend/.../schema-drift-panel.tsx` | D | KEEP | **NEVER** | — | Already on `origin` |
| `frontend/.../wizard/*schema-drift*` | A | KEEP | **NEVER** | — | Wizard phase 1 shipped |
| `frontend/src/api/gdcSchemaDrift.ts` | — | KEEP | **NEVER** | — | Already committed |

**DISCARD count:** 0  
**NEVER (already shipped):** committed baseline only

---

## Final Decision

# **B1 READY — COMMIT NOW (atomic 15 files)**

# **B2 READY — COMMIT LATER (separate, 11 files incl. backend)**

**Commit A (backend tests):** ✅ Done — `e91515a` on `origin`

**Reason B1 is ready:** All four `schema_drift_policy*` delivery log stages are surfaced in Logs Explorer; deployed policy is visible in Stream Runtime governance drawer; Auto Protect activity is visible in Protection panel; 19 frontend tests green; SoT-aligned for stream-scoped observability.

**Reason to split B2:** Governance humanization is cross-cutting (backend API labels + governance center + quarantine panel) and not required for schema drift **log** observability delivered by B1.

---

*Audit performed read-only 2026-06-17. No code, commit, or push.*
