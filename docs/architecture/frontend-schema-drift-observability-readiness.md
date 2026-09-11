# Frontend Schema Drift Observability — Commit B1 Readiness

**Status:** ARCHIVE_CANDIDATE (point-in-time readiness)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), [`DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md`](../ux/DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md)

**Date:** 2026-06-17  
**Branch:** `feature/sensitive-detection-m5-clean` (HEAD `e91515a` — Commit A on `origin`)  
**Input:** `docs/architecture/frontend-schema-drift-observability-audit.md`  
**Mode:** Read-only validation — no commit, no push

---

## 1. Included Files

**15 files — atomic Commit B1 scope** (matches audit §7)

| # | Path | Bucket |
|---|------|--------|
| 1 | `frontend/src/components/logs/delivery-log-stages.ts` | A — Logs Explorer |
| 2 | `frontend/src/components/logs/delivery-log-stages.schema-drift.test.ts` | F — Tests |
| 3 | `frontend/src/components/logs/logs-explorer-page.tsx` | A — Logs Explorer |
| 4 | `frontend/src/components/streams/schema-drift-policy-card.tsx` | B — Policy UI |
| 5 | `frontend/src/components/streams/schema-drift-policy-card.test.tsx` | F — Tests |
| 6 | `frontend/src/components/streams/stream-governance-drawer.tsx` | B/D — Drawer wiring |
| 7 | `frontend/src/components/streams/stream-runtime-detail-page.tsx` | B/D — Runtime wiring |
| 8 | `frontend/src/lib/stream-schema-drift-policy.ts` | B — Policy UI / shared |
| 9 | `frontend/src/lib/stream-schema-drift-policy.test.ts` | F — Tests |
| 10 | `frontend/src/components/streams/protection-panel.tsx` | C — Auto Protect |
| 11 | `frontend/src/components/streams/protection-panel.test.tsx` | F — Tests |
| 12 | `frontend/src/lib/auto-protect-activity.ts` | C — Auto Protect / shared |
| 13 | `frontend/src/lib/auto-protect-activity.test.ts` | F — Tests |
| 14 | `frontend/src/lib/protection-rule-origin.ts` | C — Auto Protect / shared |
| 15 | `frontend/src/lib/protection-rule-origin.test.ts` | F — Tests |

**Proposed `git add` (B1 only):**

```bash
git add \
  frontend/src/components/logs/delivery-log-stages.ts \
  frontend/src/components/logs/delivery-log-stages.schema-drift.test.ts \
  frontend/src/components/logs/logs-explorer-page.tsx \
  frontend/src/components/streams/schema-drift-policy-card.tsx \
  frontend/src/components/streams/schema-drift-policy-card.test.tsx \
  frontend/src/components/streams/protection-panel.tsx \
  frontend/src/components/streams/protection-panel.test.tsx \
  frontend/src/components/streams/stream-governance-drawer.tsx \
  frontend/src/components/streams/stream-runtime-detail-page.tsx \
  frontend/src/lib/stream-schema-drift-policy.ts \
  frontend/src/lib/stream-schema-drift-policy.test.ts \
  frontend/src/lib/auto-protect-activity.ts \
  frontend/src/lib/auto-protect-activity.test.ts \
  frontend/src/lib/protection-rule-origin.ts \
  frontend/src/lib/protection-rule-origin.test.ts
```

**Git state (2026-06-17):** All 15 paths exist in working tree (6 modified + 9 untracked). None staged.

---

## 2. Excluded Files

Per audit and task scope — **must not** be staged with B1.

### Governance Humanization (Commit B2)

| Path | State |
|------|-------|
| `frontend/src/lib/humanize-quarantine-reason.ts` | Untracked |
| `frontend/src/lib/humanize-quarantine-reason.test.ts` | Untracked |
| `frontend/src/components/streams/quarantine-panel.tsx` | Modified |
| `frontend/src/components/streams/quarantine-panel.test.tsx` | Untracked |
| `frontend/src/components/governance/replay-center-page.tsx` | Modified |
| `frontend/src/components/governance/violation-center-page.tsx` | Modified |
| `frontend/src/components/governance/quarantine-center-page.test.tsx` | Modified |

### Backend Governance (Commit B2)

| Path | State |
|------|-------|
| `app/governance_audit/service.py` | Modified |
| `app/governance_quarantine/service.py` | Modified |
| `app/governance_replay/service.py` | Modified |
| `app/governance_violations/service.py` | Modified |

### Out of scope

| Category | Examples |
|----------|----------|
| Route-aware governance UI | None in WIP |
| Source of Truth docs | `docs/source-of-truth/**` |
| Audit / architecture docs | `docs/architecture/*.md` (incl. this file) |

### Import boundary check

No B1 file imports `humanize-quarantine-reason` or other B2-only modules.  
`stream-governance-drawer.tsx` imports `QuarantinePanel` from **committed** HEAD (B1 does not stage `quarantine-panel.tsx` changes).

---

## 3. SoT Validation

Validated against:

- `DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt`
- `DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt`
- `DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt`
- `DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt` (policy defaults)

| Requirement | Evidence | Result |
|-------------|----------|--------|
| **Unknown Normal → Pass Through** (default) | `stream-schema-drift-policy.test.ts` — `unknownNormalField: 'Pass Through'` when config absent | ✅ |
| **Unknown Sensitive → Auto Protect** (default) | Same test — `unknownSensitiveField: 'Auto Protect'` | ✅ |
| **Stream baseline display** | `schemaDriftPolicyLabelsFromStreamConfig()` reads `streams.config_json.governance.schema_drift_policy` only | ✅ |
| **Read-only observability** | `SchemaDriftPolicyCard` — no edit controls; Protection activity is display-only; Logs Explorer filters are read/query | ✅ |
| **UX Charter Level 3** — Schema Drift + Protection in Stream Detail | Governance drawer: Policy Card → Drift Panel (committed) → … → Protection | ✅ |
| **Union Schema UX** — drift findings separate from policy | `SchemaDriftPanel` unchanged in B1; policy card is additive | ✅ |
| **No route-aware drift policy UI** | No route override display in B1 files | ✅ (deferred per SoT §21) |

### Backend stage contract (Commit A dependency)

Frontend `delivery-log-stages.ts` tokens match `app/schema_drift_policy/delivery_log_stages.py`:

| Token |
|-------|
| `schema_drift_policy` |
| `schema_drift_policy_review_required` |
| `schema_drift_policy_path_resolution_failed` |
| `schema_drift_policy_auto_protect_applied` |

---

## 4. Test Results

### B1-affected vitest (6 files, 13 tests)

```bash
cd frontend && npm test -- --run \
  src/components/logs/delivery-log-stages.schema-drift.test.ts \
  src/components/streams/schema-drift-policy-card.test.tsx \
  src/components/streams/protection-panel.test.tsx \
  src/lib/stream-schema-drift-policy.test.ts \
  src/lib/auto-protect-activity.test.ts \
  src/lib/protection-rule-origin.test.ts
```

| Result | Count |
|--------|-------|
| **Test files passed** | 6/6 |
| **Tests passed** | 13/13 |
| **Failed** | 0 |
| **Duration** | ~4.8s |

**Excluded from B1 run (B2):** `humanize-quarantine-reason.test.ts`, `quarantine-panel.test.tsx`

### Production build (compile check)

```bash
cd frontend && npm run build
```

| Result | Notes |
|--------|-------|
| **Passed** | `tsc -b && vite build` — exit 0 (~100s) |

**Post-commit requirement (not executed here):** `scripts/frontend-redeploy.sh` to update running platform bundle.

### Backend dependency (Commit A — already on `origin`)

`pytest tests/test_schema_drift_policy_runtime.py tests/test_schema_drift_policy_delivery_logs.py` — **29/29** (prior validation at `e91515a`).

---

## 5. Commit Scope Validation

| Check | Result |
|-------|--------|
| File count = 15 | ✅ |
| All paths present in working tree | ✅ |
| No B2 files in B1 list | ✅ |
| No backend files in B1 list | ✅ |
| No docs in B1 list | ✅ |
| B1 import graph closed (no orphan untracked deps) | ✅ |
| Partial commit would break build | ⚠️ Yes — must stage all 15 atomically |
| `quarantine-panel.tsx` WIP left unstaged | ✅ Correct — avoids B2 coupling |

---

## 6. Final Recommendation

Commit B1 is **implementation-complete**, **SoT-aligned** for stream-scoped observability, **test-green**, and **build-green**. Stage exactly the 15 files above; exclude all B2 and doc paths.

Suggested commit message:

```text
Add frontend schema drift observability UI
```

After commit: run `scripts/frontend-redeploy.sh`.

---

## Final Decision

# **READY FOR COMMIT B1**

---

*Validation performed read-only 2026-06-17. No commit, no push.*
