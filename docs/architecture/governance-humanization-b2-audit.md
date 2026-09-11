# Governance Humanization — Commit B2 Audit

**Status:** ARCHIVE_CANDIDATE (point-in-time audit)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), Governance UX charters

**Date:** 2026-06-17  
**Branch:** `feature/sensitive-detection-m5-clean` (HEAD `4751bec` — Commit B1 on `origin`)  
**Mode:** Read-only audit — no code changes, no commit, no push

---

## 1. Executive Summary

Governance Humanization WIP is a **display-only, scope-contained** change set that improves operator-readable quarantine reason labels across Governance APIs and selected UI surfaces. It does **not** alter quarantine execution, policy evaluation, or configuration scope.

| Criterion | Result |
|-----------|--------|
| **B1 isolation** | ✅ No uncommitted Schema Drift B1 files |
| **Scope** | ✅ Humanization / labels only |
| **SoT alignment** | ✅ Operations in Governance; no scope expansion |
| **Backend tests** | ✅ 35/35 (governance M19–M20 + schema drift label smoke) |
| **Frontend tests** | ✅ 11/11 (B2 vitest) |
| **Atomic commit** | ✅ 11 files; closed import graph |

### Verdict

# **READY FOR COMMIT B2**

---

## 2. Git Status & B2 Inventory

### 2.1 Branch state

```
On branch feature/sensitive-detection-m5-clean
Your branch is up to date with 'origin/feature/sensitive-detection-m5-clean'.

HEAD: 4751bec Add frontend schema drift observability
```

### 2.2 B2 files only (11)

| # | Path | State | Δ |
|---|------|-------|---|
| 1 | `app/governance_violations/service.py` | Modified | Core `_humanize_quarantine_reason()` |
| 2 | `app/governance_quarantine/service.py` | Modified | Pass `quarantine_source` to humanizer |
| 3 | `app/governance_replay/service.py` | Modified | Pass `quarantine_source` to humanizer |
| 4 | `app/governance_audit/service.py` | Modified | Pass `quarantine_source` to humanizer |
| 5 | `frontend/src/lib/humanize-quarantine-reason.ts` | **Untracked** | Frontend mirror of backend labels |
| 6 | `frontend/src/lib/humanize-quarantine-reason.test.ts` | **Untracked** | 4 unit tests |
| 7 | `frontend/src/components/streams/quarantine-panel.tsx` | Modified | Humanize reason column |
| 8 | `frontend/src/components/streams/quarantine-panel.test.tsx` | **Untracked** | Panel + manual case |
| 9 | `frontend/src/components/governance/replay-center-page.tsx` | Modified | Detail drawer humanize |
| 10 | `frontend/src/components/governance/violation-center-page.tsx` | Modified | Detail drawer humanize |
| 11 | `frontend/src/components/governance/quarantine-center-page.test.tsx` | Modified | Fixture label update |

**Tracked diff stat:** 8 files, +31 / −14 lines  
**Untracked:** 3 files, ~115 lines

### 2.3 Proposed `git add` (B2 only)

```bash
git add \
  app/governance_audit/service.py \
  app/governance_quarantine/service.py \
  app/governance_replay/service.py \
  app/governance_violations/service.py \
  frontend/src/lib/humanize-quarantine-reason.ts \
  frontend/src/lib/humanize-quarantine-reason.test.ts \
  frontend/src/components/streams/quarantine-panel.tsx \
  frontend/src/components/streams/quarantine-panel.test.tsx \
  frontend/src/components/governance/replay-center-page.tsx \
  frontend/src/components/governance/violation-center-page.tsx \
  frontend/src/components/governance/quarantine-center-page.test.tsx
```

---

## 3. B1 Isolation Check

| Check | Result |
|-------|--------|
| B1 commit on `origin` | ✅ `4751bec` |
| Uncommitted B1 frontend paths | ✅ **None** (`git diff` empty for logs, policy card, protection-panel, stream-schema-drift-policy, etc.) |
| B2 imports B1-only modules | ✅ No |
| B1 imports `humanize-quarantine-reason` | ✅ No (committed B1 clean) |

Commit B2 can proceed without re-staging Schema Drift observability files.

---

## 4. Change Summary

### 4.1 Backend — canonical humanizer (`governance_violations/service.py`)

| Before | After |
|--------|-------|
| `policy:schema_drift:*` → `{label} quarantine` | `{label}` (e.g. `Schema Drift Policy — Unknown Normal Field`) |
| `policy:Customer PII Policy` → `Response rule matched: Customer PII Policy` | `Policy Rule — Customer PII Policy` |
| No manual source handling | `quarantine_source == "manual"` → `Manual Quarantine` |

Other governance services **only** pass `quarantine_source` into the shared `_humanize_quarantine_reason()` — no duplicated label logic.

### 4.2 Frontend — `humanize-quarantine-reason.ts`

Mirrors backend label rules for surfaces that receive **raw** `quarantine_reason` from stream-scoped APIs:

- `policy:schema_drift:unknown_sensitive` → `Schema Drift Policy — Unknown Sensitive Field`
- `policy:schema_drift:unknown_normal` → `Schema Drift Policy — Unknown Normal Field`
- `policy:{name}` → `Policy Rule — {name}`
- `quarantineSource: 'manual'` → `Manual Quarantine`

### 4.3 UI surfaces

| Surface | Change |
|---------|--------|
| Stream `QuarantinePanel` | Display humanized reason (+ `quarantineSource` for manual) |
| Governance Violation detail drawer | Humanize `related_quarantine.quarantine_reason` |
| Governance Replay detail drawer | Humanize `source.quarantine.quarantine_reason` |
| Quarantine center test fixture | Expect `Policy Rule — Customer PII Policy` |

**Not changed:** Policy configuration, wizard, route processing, quarantine recording logic, API routes.

---

## 5. SoT Alignment

Validated against:

- `GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt`
- `DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt`
- `DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt`

| SoT principle | B2 evidence | Result |
|---------------|-------------|--------|
| **Configuration in Wizard; Operations in Governance** | Labels only on governance/quarantine **display** and API `reason` fields | ✅ |
| **No governance scope expansion** | No new policies, engines, routes, or config keys | ✅ |
| **Governance = operations / investigation** | Violation, Quarantine, Replay, Audit list/detail `reason` strings | ✅ |
| **Schema drift labels consistent with runtime** | `Schema Drift Policy — Unknown Normal/Sensitive Field` matches Commit A tests | ✅ |
| **No route-aware governance UI added** | No route fields or per-route labels | ✅ |

### Label-only confirmation

- `quarantine_reason` **DB value unchanged** — humanization at read/render time only
- No new API endpoints
- No RBAC changes
- No checkpoint / delivery behavior changes

---

## 6. Test Results

### 6.1 Backend (35 tests)

```bash
pytest tests/test_governance_quarantine_m19_2.py \
       tests/test_governance_violations_m19_1.py \
       tests/test_governance_replay_m20_1.py \
       tests/test_governance_audit_m19_3.py \
       tests/test_schema_drift_policy_runtime.py::test_unknown_normal_quarantine_blocks_delivery_and_checkpoint \
       tests/test_schema_drift_policy_runtime.py::test_governance_quarantine_labels_schema_drift_policy \
       -v
```

| Result | Count |
|--------|-------|
| **Passed** | **35/35** |
| **Failed** | 0 |
| **Duration** | ~84s |

### 6.2 Frontend B2 vitest (11 tests)

```bash
cd frontend && npm test -- --run \
  src/lib/humanize-quarantine-reason.test.ts \
  src/components/streams/quarantine-panel.test.tsx \
  src/components/governance/quarantine-center-page.test.tsx
```

| Result | Count |
|--------|-------|
| **Test files passed** | 3/3 |
| **Tests passed** | **11/11** |
| **Duration** | ~4.3s |

---

## 7. Risks & Non-Blocking Gaps

| # | Item | Severity | Notes |
|---|------|----------|-------|
| 1 | Partial B2 commit breaks `quarantine-panel` | **HIGH** | Must include `humanize-quarantine-reason.ts` with panel |
| 2 | Frontend/backend label drift | **LOW** | Parallel logic; covered by unit tests |
| 3 | Violation/Replay drawers omit `quarantineSource` option | **LOW** | List APIs return humanized `reason`; detail nested `quarantine_reason` is raw — manual quarantine may not show `Manual Quarantine` in those two drawers until `quarantine_source` is passed (follow-up) |
| 4 | No dedicated pytest for `_humanize_quarantine_reason` variants | **LOW** | Covered indirectly via governance integration + schema drift smoke tests |
| 5 | Production bundle | **MEDIUM** | Post-commit: `scripts/frontend-redeploy.sh` if frontend shipped |

---

## 8. Commit Scope Validation

| Check | Result |
|-------|--------|
| File count = 11 | ✅ |
| All paths present in working tree | ✅ |
| No B1 files in B2 list | ✅ |
| No docs / SoT in B2 list | ✅ |
| No schema drift observability files | ✅ |
| Import graph closed | ✅ `quarantine-panel` → `humanize-quarantine-reason` |
| Display-only / no runtime behavior change | ✅ |

**Suggested commit message:**

```text
Humanize governance quarantine reasons for operator display
```

---

## 9. Excluded (not B2)

| Category | Examples |
|----------|----------|
| Schema Drift B1 | Already committed `4751bec` |
| Docs WIP | `docs/architecture/*`, `docs/source-of-truth/*` |
| Route-aware UI | None in WIP |

---

## Final Decision

# **READY FOR COMMIT B2**

**Reason:** B2 WIP is complete, isolated from B1, SoT-aligned as operations-only humanization, and green on 46 targeted tests (35 backend + 11 frontend). Stage all 11 files atomically.

---

*Audit performed read-only 2026-06-17. No commit, no push.*
