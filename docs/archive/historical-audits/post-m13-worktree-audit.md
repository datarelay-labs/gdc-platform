# Post-M13 Worktree Audit

**Date:** 2026-06-17  
**Branch:** `feature/sensitive-detection-m5-clean` (up to date with `origin`)  
**M13 baseline:** `967d19b` — `Add M13 Route Architecture runtime (M13.1-M13.6)` (pushed)  
**Mode:** Read-only audit — no code changes, no commit, no push

---

## 1. Executive Summary

M13 Route Architecture is **committed and pushed**. The working tree retains **14 modified** and **22 untracked path entries** (~48 files including `docs/source-of-truth/` tree) representing **three coherent workstreams** and **one critical gap** introduced by the M13 commit itself.

| Workstream | Files | Status | Recommendation |
|------------|-------|--------|----------------|
| **Schema Drift observability** | Backend module + tests + frontend logs/protection UI | Partial, cohesive | **COMMIT LATER** (single milestone commit) |
| **Governance quarantine label UX** | 4 backend services + 4 frontend surfaces | Partial, aligned with SoT | **COMMIT LATER** (bundle with schema drift or follow-up) |
| **Source of Truth canonicalization** | `docs/source-of-truth/` + index + archive README | Complete on disk, untracked | **COMMIT LATER** (docs-only commit) |
| **M13 audit artifacts (not in 967d19b)** | 4 architecture docs | Complete | **COMMIT LATER** |
| **Missing module referenced by M13 commit** | `app/schema_drift_policy/delivery_log_stages.py` | **On disk only** | **COMMIT NOW** (hotfix) |

### Critical finding

`967d19b` modifies `app/runners/stream_runner.py` to import `app.schema_drift_policy.delivery_log_stages`, but **`delivery_log_stages.py` was not included in the commit**. Fresh clones from `origin` will **fail to import `StreamRunner`** unless this file exists locally. Local workspace passes only because the untracked file is present on disk.

**No accidental debug files, dead experiments, or abandoned scratch code were found.** All remaining WIP maps to named milestones (Schema Drift M4 extension, Governance Workspace UX, SoT indexing).

---

## 2. Modified Files Audit

| # | Path | Category | Milestone | SoT alignment | Status | Keep? | Commit? |
|---|------|----------|-----------|---------------|--------|-------|---------|
| 1 | `app/governance_audit/service.py` | B Governance | M20 Governance Workspace | Governance UX Charter §quarantine labels | Partial — passes `quarantine_source` to humanizer | YES | LATER |
| 2 | `app/governance_quarantine/service.py` | B Governance | M20 | Same | Partial | YES | LATER |
| 3 | `app/governance_replay/service.py` | B Governance | M20 | Same | Partial | YES | LATER |
| 4 | `app/governance_violations/service.py` | B Governance | M20 | Same — improves schema drift + manual quarantine labels | Partial | YES | LATER |
| 5 | `frontend/.../quarantine-center-page.test.tsx` | B Governance | M20 | Label parity with backend | Test update only | YES | LATER |
| 6 | `frontend/.../replay-center-page.tsx` | B Governance | M20 | Uses shared `humanizeQuarantineReason` | Partial — needs untracked lib | YES | LATER |
| 7 | `frontend/.../violation-center-page.tsx` | B Governance | M20 | Same | Partial | YES | LATER |
| 8 | `frontend/.../delivery-log-stages.ts` | A Schema Drift | M4 Schema Drift Policy | Union Schema / drift observability | Partial — stage tokens + labels | YES | LATER |
| 9 | `frontend/.../logs-explorer-page.tsx` | A+C Frontend | M4 | Log drill-down quick filters for drift stages | Partial | YES | LATER |
| 10 | `frontend/.../protection-panel.tsx` | A+C Frontend | M4 | Auto Protect activity from delivery logs | Partial — needs untracked libs | YES | LATER |
| 11 | `frontend/.../quarantine-panel.tsx` | B+C Frontend | M20 | Humanized quarantine reasons | Partial | YES | LATER |
| 12 | `frontend/.../stream-governance-drawer.tsx` | A+C Frontend | M4 + Governance | Schema Drift Policy read-only card | Partial — needs untracked card + lib | YES | LATER |
| 13 | `frontend/.../stream-runtime-detail-page.tsx` | A+C Frontend | M4 | Wires schema drift policy labels to drawer | Partial | YES | LATER |
| 14 | `tests/test_schema_drift_policy_runtime.py` | A+E Tests | M4 | Drift delivery_log persistence tests | Partial — +82 lines, extends committed suite | YES | LATER |

---

## 3. Untracked Files Audit

| # | Path | Category | Milestone | SoT alignment | Status | Keep? | Commit? |
|---|------|----------|-----------|---------------|--------|-------|---------|
| 1 | `app/schema_drift_policy/delivery_log_stages.py` | A Schema Drift | M4 | Drift policy log stage contract | **Required by 967d19b** — import break on clone | YES | **NOW** |
| 2 | `tests/test_schema_drift_policy_delivery_logs.py` | A+E Tests | M4 | Unit tests for stage tokens/messages | Ready | YES | LATER |
| 3 | `frontend/.../delivery-log-stages.schema-drift.test.ts` | A+E Tests | M4 | Frontend stage constant tests | Ready | YES | LATER |
| 4 | `frontend/.../schema-drift-policy-card.tsx` | A+C Frontend | M4 | Read-only deployed policy card | Ready | YES | LATER |
| 5 | `frontend/.../schema-drift-policy-card.test.tsx` | A+E Tests | M4 | Card tests | Ready | YES | LATER |
| 6 | `frontend/.../protection-panel.test.tsx` | A+E Tests | M4 | Auto Protect activity tests | Ready | YES | LATER |
| 7 | `frontend/.../quarantine-panel.test.tsx` | B+E Tests | M20 | Humanize reason tests | Ready | YES | LATER |
| 8 | `frontend/src/lib/stream-schema-drift-policy.ts` | A+C Frontend | M4 | Read config_json drift policy labels | Ready | YES | LATER |
| 9 | `frontend/src/lib/stream-schema-drift-policy.test.ts` | A+E Tests | M4 | Lib tests | Ready | YES | LATER |
| 10 | `frontend/src/lib/auto-protect-activity.ts` | A+C Frontend | M4 | Parse auto_protect delivery logs | Ready | YES | LATER |
| 11 | `frontend/src/lib/auto-protect-activity.test.ts` | A+E Tests | M4 | Lib tests | Ready | YES | LATER |
| 12 | `frontend/src/lib/humanize-quarantine-reason.ts` | B+C Frontend | M20 | Shared quarantine label humanizer | Ready — mirrors backend | YES | LATER |
| 13 | `frontend/src/lib/humanize-quarantine-reason.test.ts` | B+E Tests | M20 | Lib tests | Ready | YES | LATER |
| 14 | `frontend/src/lib/protection-rule-origin.ts` | C Frontend | M5 Protection | Operator vs Wizard rule origin | Ready | YES | LATER |
| 15 | `frontend/src/lib/protection-rule-origin.test.ts` | E Tests | M5 | Lib tests | Ready | YES | LATER |
| 16 | `docs/architecture/m13-pre-commit-validation.md` | D Documentation | M13 audit | N/A | Complete audit record | YES | LATER |
| 17 | `docs/architecture/m13-push-readiness-report.md` | D Documentation | M13 audit | N/A | Complete audit record | YES | LATER |
| 18 | `docs/architecture/route-architecture-gap-analysis.md` | D Documentation | M13 planning | Product Charter 1.2.1 | Pre-implementation analysis | YES | LATER |
| 19 | `docs/architecture/route-processing-foundation-implementation-spec.md` | D Documentation | M13.1 | Spec 091 companion | Superseded in part by committed spec 091 | YES | LATER |
| 20 | `docs/architecture/source-of-truth-index.md` | D Documentation | SoT milestone | Top-level index | Ready | YES | LATER |
| 21 | `docs/source-of-truth/*.txt` (10 canonical) | D Documentation | SoT milestone | Product Charter hierarchy | Ready | YES | LATER |
| 22 | `docs/source-of-truth/_incoming/*.txt` (10 duplicates) | D Documentation | SoT staging | Duplicates of canonical | Redundant after copy | YES* | **NEVER** (or archive only) |
| 23 | `docs/archive/legacy-design/README.md` | D Documentation | SoT milestone | Archive policy | Ready | YES | LATER |

\*Keep on disk for reference until canonical set is committed; do not commit `_incoming/` duplicates alongside canonical files.

---

## 4. Schema Drift Audit

### 4.1 Scope

Schema Drift Policy **runtime** (orchestrator, auto-protect) was committed in `7c9e2e2`. Remaining WIP extends **observability**: delivery log stage tokens, log explorer filters, protection panel activity feed, governance drawer policy card.

### 4.2 Backend

| File | In git `HEAD`? | WIP state |
|------|----------------|-----------|
| `app/schema_drift_policy/orchestrator.py` | ✅ (7c9e2e2) | — |
| `app/schema_drift_policy/path_resolve.py` | ✅ | — |
| `app/schema_drift_policy/schemas.py` | ✅ | — |
| `app/schema_drift_policy/delivery_log_stages.py` | ❌ **MISSING** | Untracked — **imported by 967d19b `stream_runner.py`** |

### 4.3 Tests

| File | State |
|------|-------|
| `tests/test_schema_drift_policy_runtime.py` | Modified (+82 lines: auto_protect + path_resolution delivery_log tests) |
| `tests/test_schema_drift_policy_delivery_logs.py` | Untracked unit tests for stage module |

### 4.4 Frontend

Cohesive package: stage constants → logs explorer quick filters → protection panel auto-protect feed → schema drift policy card in governance drawer.

### 4.5 Milestone assignment

**M4 Schema Drift Policy** (observability extension) — not M13, not M14 Route APIs.

### 4.6 Readiness

| Aspect | Assessment |
|--------|------------|
| Implementation | **Partial** — works locally; incomplete in git |
| Abandoned? | **No** — active, tested WIP |
| Ready to commit? | **Yes** as one bundle after hotfixing `delivery_log_stages.py` |

---

## 5. Governance Audit

### 5.1 Backend changes

All four `app/governance_*` services update `_humanize_quarantine_reason()` to:

- Return `"Manual Quarantine"` when `quarantine_source == "manual"`
- Use cleaner schema drift policy labels (`Schema Drift Policy — …`)
- Use `Policy Rule — {name}` instead of `Response rule matched: …`

**Aligned with:** Governance UX Charter, Governance Workspace spec (operator-readable quarantine reasons).

**Route Architecture:** Complementary — M13 adds `route_id` on quarantine rows (committed); this WIP improves **display labels**, not route processing logic.

### 5.2 Frontend changes

- `humanize-quarantine-reason.ts` (untracked) centralizes same logic as backend
- Violation, replay, quarantine panels consume it
- Test fixture label updated in quarantine-center test

### 5.3 Obsolete?

**No.** Changes are incremental UX polish, not superseded by M13.

### 5.4 Milestone

**M20 Governance Workspace** (display layer) + cross-cutting quarantine label consistency.

---

## 6. Frontend Audit

### 6.1 Dependency graph

```text
delivery_log_stages.py (backend, COMMIT NOW)
  ↔ delivery-log-stages.ts (modified)
      ↔ logs-explorer-page.tsx (modified)
      ↔ protection-panel.tsx (modified)
          ↔ auto-protect-activity.ts (untracked)

stream-schema-drift-policy.ts (untracked)
  ↔ schema-drift-policy-card.tsx (untracked)
      ↔ stream-governance-drawer.tsx (modified)
          ↔ stream-runtime-detail-page.tsx (modified)

humanize-quarantine-reason.ts (untracked)
  ↔ quarantine-panel, violation-center, replay-center (modified)
  ↔ governance_* services (modified, inline duplicate logic)

protection-rule-origin.ts (untracked)
  ↔ protection-panel.tsx (modified)
```

### 6.2 Build risk

Modified frontend files reference **untracked** libs/cards. A frontend build from committed `HEAD` alone may still work (changes unstaged); staging partial frontend without libs would **break build**.

### 6.3 Recommendation

Commit frontend WIP **only as complete package** with all `frontend/src/lib/*` and component test files listed in §3.

---

## 7. Documentation Audit

### 7.1 M13 audit docs (untracked, not in 967d19b)

| File | Purpose | Commit? |
|------|---------|---------|
| `m13-pre-commit-validation.md` | Pre-commit gate record | LATER |
| `m13-push-readiness-report.md` | Push gate record | LATER |
| `route-architecture-gap-analysis.md` | Pre-M13 gap analysis | LATER |
| `route-processing-foundation-implementation-spec.md` | M13.1 impl companion | LATER |

Already in `967d19b`: completion audit, circular-import root cause, flag reports, migration audit, design reviews, route-data-model-review.

### 7.2 Source of Truth (`docs/source-of-truth/`)

| Item | Tracked? | Notes |
|------|----------|-------|
| 10 canonical `*.txt` charters | ❌ Untracked | Product Charter 1.2.1 set |
| `_incoming/` duplicates | ❌ Untracked | Staging copies — **do not commit both** |
| `source-of-truth-index.md` | ❌ Untracked | Index + hierarchy doc |
| `docs/archive/legacy-design/README.md` | ❌ Untracked | Archive policy (no legacy files yet) |

**Should commit:** Canonical 10 txt files + index + archive README as a **docs-only commit**. Exclude `_incoming/` or move to `docs/archive/` first.

### 7.3 SoT vs specs

`specs/` remain engineering authority; SoT docs are product/UX authority per index preamble. No conflict with committed M13 specs 091–096.

---

## 8. Accidental Leftovers

| Candidate | Verdict |
|-----------|---------|
| `docs/source-of-truth/_incoming/*` | **Not accidental** — staging duplicates; commit canonical only |
| Debug/temp files | **None found** |
| Partial dead code | **None** — all WIP wired to imports/tests |
| Abandoned experiments | **None** |
| `delivery_log_stages.py` omission | **Accidental commit gap** in 967d19b — not WIP abandonment |

---

## 9. Recommended Actions

### Immediate (before any other work on this branch)

1. **Hotfix commit:** `app/schema_drift_policy/delivery_log_stages.py` (+ `tests/test_schema_drift_policy_delivery_logs.py` recommended) — restores importability of `StreamRunner` on fresh clone.

### Next commits (suggested order)

2. **Schema Drift Observability** — all Category A modified + untracked files + tests + `test_schema_drift_policy_runtime.py` delta.
3. **Governance Label UX** — governance services + humanize lib + governance/quarantine frontend (can merge with #2 if tested together).
4. **M13 audit docs** — pre-commit, push-readiness, gap-analysis, foundation impl spec.
5. **SoT canonicalization** — `docs/source-of-truth/*.txt` (exclude `_incoming/`), `source-of-truth-index.md`, `docs/archive/legacy-design/README.md`.

### Safe to keep in working tree (no action)

All remaining files — none recommended for deletion.

### Discard

| Path | Action |
|------|--------|
| `docs/source-of-truth/_incoming/*` | **NEVER commit** as duplicate; delete or archive after canonical commit |

---

## 10. Commit Strategy

| Commit | Scope | Files | When |
|--------|-------|-------|------|
| **Hotfix** | Import repair for 967d19b | `delivery_log_stages.py`, optionally `test_schema_drift_policy_delivery_logs.py` | **NOW** |
| **Schema Drift + Governance UX** | Observability + labels | 13 modified + 15 untracked frontend/backend/test | LATER (one PR) |
| **M13 audit trail** | Docs only | 4 architecture md files | LATER |
| **SoT** | Docs only | 10 txt + index + archive README | LATER |

Run before each commit:

```bash
python3 -m pytest tests/test_schema_drift_policy_runtime.py tests/test_schema_drift_policy_delivery_logs.py
python3 -m pytest tests/test_route_processing_foundation.py ... # M13 regression
cd frontend && npm run build  # after frontend bundle commits
```

---

## Final Section — Per Path Verdict

### COMMIT NOW

| Path | Reason |
|------|--------|
| `app/schema_drift_policy/delivery_log_stages.py` | **967d19b imports this module; missing on remote clone** |

### COMMIT LATER

**Modified (14):** All files listed in §2 — bundle as Schema Drift + Governance UX milestone.

**Untracked (commit as groups):**

- `tests/test_schema_drift_policy_delivery_logs.py`
- All `frontend/src/lib/*.ts` + `*.test.ts` (6 pairs)
- `frontend/.../schema-drift-policy-card.tsx` + tests
- `frontend/.../protection-panel.test.tsx`, `quarantine-panel.test.tsx`, `delivery-log-stages.schema-drift.test.ts`
- `docs/architecture/m13-pre-commit-validation.md`
- `docs/architecture/m13-push-readiness-report.md`
- `docs/architecture/route-architecture-gap-analysis.md`
- `docs/architecture/route-processing-foundation-implementation-spec.md`
- `docs/architecture/source-of-truth-index.md`
- `docs/source-of-truth/*.txt` (canonical 10, not `_incoming/`)
- `docs/archive/legacy-design/README.md`

### DISCARD (do not commit)

| Path | Reason |
|------|--------|
| `docs/source-of-truth/_incoming/*` | Duplicates of canonical SoT files already at `docs/source-of-truth/` root |

### No path assigned NEVER / discard for code WIP

All code and test WIP should be **kept** and committed in milestone bundles above.

---

## Inventory Summary

| State | Count |
|-------|-------|
| Modified | 14 files |
| Untracked path entries | 22 (≈48 files incl. SoT tree) |
| Staged | 0 |
| Unknown WIP | 0 |

**Roadmap:** Hotfix `delivery_log_stages.py` → Schema Drift observability + Governance labels → M13 audit docs → SoT canonicalization. Route APIs/UI (M13.2–M13.5 UX) remain **future milestones** with no WIP in this worktree.

---

*Audit performed read-only 2026-06-17 after M13 push `967d19b`.*
