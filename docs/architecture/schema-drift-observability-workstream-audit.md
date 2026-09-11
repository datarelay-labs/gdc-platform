# Schema Drift Observability Workstream Audit

**Status:** ARCHIVE_CANDIDATE (point-in-time audit)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), [`DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md`](../ux/DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md)

**Date:** 2026-06-17  
**Branch:** `feature/sensitive-detection-m5-clean` (synced with `origin` at `1806a10`)  
**Baseline:** M13 complete (`967d19b` + hotfix `1806a10`); Schema Drift **runtime** in `7c9e2e2`  
**Mode:** Read-only audit — no code changes, no commit, no push  
**Input:** `docs/architecture/post-m13-worktree-audit.md` + working tree inspection

---

## 1. Executive Summary

Schema Drift Observability WIP is a **cohesive, partially implemented extension** to the already-shipped Schema Drift Policy runtime. It adds **delivery log stage contracts**, **runtime persistence tests**, and **operator-facing UI** (logs explorer filters, protection panel auto-protect feed, governance drawer policy card).

| Aspect | Assessment |
|--------|------------|
| **Useful?** | **Yes** — closes observability gap between orchestrator `log_fn` emissions and operator UI |
| **Partial?** | **Yes** — all WIP is unstaged/untracked; committed `HEAD` lacks UI and extended tests |
| **Abandoned?** | **No** — wired imports, tests, and component tests exist |
| **Discard anything?** | **No code discard** — governance-label files overlap but are separable |
| **Already committed** | `app/schema_drift_policy/delivery_log_stages.py` (`1806a10`) |

### Workstream scope (this audit)

**In scope:** 13 files (1 modified test + 12 untracked/modified frontend+test) directly supporting schema drift **observability**.

**Adjacent (governance overlap):** 7 files — humanize quarantine labels; **not pure schema drift** but coupled in protection/quarantine surfaces.

**Out of scope:** SoT docs tree, M13 audit docs, `protection-rule-origin` is protection UX adjunct (bundled with protection panel WIP).

### Verdict

**KEEP all schema-drift observability files. COMMIT LATER in 2–3 focused commits** (tests → frontend → optional governance labels). **No COMMIT NOW** items remain for this workstream after hotfix `1806a10`.

---

## 2. File Inventory

### 2.1 Git status — Schema Drift related

| State | Path | Class |
|-------|------|-------|
| **Committed** | `app/schema_drift_policy/delivery_log_stages.py` | Backend runtime (stage contract) |
| **Committed** | `app/schema_drift_policy/orchestrator.py`, `path_resolve.py`, `schemas.py`, `__init__.py` | Backend runtime (prior commits) |
| **Modified** | `tests/test_schema_drift_policy_runtime.py` | Backend tests (+79 lines) |
| **Modified** | `frontend/src/components/logs/delivery-log-stages.ts` | Logs / observability |
| **Modified** | `frontend/src/components/logs/logs-explorer-page.tsx` | Logs / observability |
| **Modified** | `frontend/src/components/streams/protection-panel.tsx` | Frontend UI |
| **Modified** | `frontend/src/components/streams/stream-governance-drawer.tsx` | Frontend UI |
| **Modified** | `frontend/src/components/streams/stream-runtime-detail-page.tsx` | Frontend UI |
| **Untracked** | `tests/test_schema_drift_policy_delivery_logs.py` | Backend tests |
| **Untracked** | `frontend/src/components/logs/delivery-log-stages.schema-drift.test.ts` | Backend/frontend contract tests |
| **Untracked** | `frontend/src/components/streams/schema-drift-policy-card.tsx` | Frontend UI |
| **Untracked** | `frontend/src/components/streams/schema-drift-policy-card.test.tsx` | Tests |
| **Untracked** | `frontend/src/components/streams/protection-panel.test.tsx` | Tests |
| **Untracked** | `frontend/src/lib/stream-schema-drift-policy.ts` | Frontend UI lib |
| **Untracked** | `frontend/src/lib/stream-schema-drift-policy.test.ts` | Tests |
| **Untracked** | `frontend/src/lib/auto-protect-activity.ts` | Frontend UI lib |
| **Untracked** | `frontend/src/lib/auto-protect-activity.test.ts` | Tests |
| **Untracked** | `frontend/src/lib/protection-rule-origin.ts` | Frontend UI adjunct |
| **Untracked** | `frontend/src/lib/protection-rule-origin.test.ts` | Tests |

### 2.2 Governance overlap (modified/untracked, not pure schema drift)

| Path | Overlap |
|------|---------|
| `app/governance_*` (4 services) | Humanize `policy:schema_drift:*` quarantine reasons |
| `frontend/.../quarantine-panel.tsx` + `.test.tsx` | Humanize display |
| `frontend/src/lib/humanize-quarantine-reason.ts` + test | Shared label logic |
| `frontend/.../violation-center-page.tsx`, `replay-center-page.tsx` | Governance center display |
| `frontend/.../quarantine-center-page.test.tsx` | Label fixture update |

---

## 3. Backend Runtime Audit

### 3.1 Committed baseline

| File | Role | Status |
|------|------|--------|
| `schemas.py` | Defaults: normal=`pass_through`, sensitive=`auto_protect` | ✅ Complete |
| `orchestrator.py` | Emits `log_fn` payloads with stages `schema_drift_policy*`, auto_protect ephemeral rules | ✅ Complete (`7c9e2e2`) |
| `path_resolve.py` | Path resolution for drift fields | ✅ Complete |
| `delivery_log_stages.py` | Stage token constants + `schema_drift_policy_delivery_log_message()` | ✅ Complete (`1806a10`) |
| `stream_runner.py` (M13) | Imports stages; `_persist_delivery_log` uses message helper | ✅ Complete |

### 3.2 WIP backend runtime

**None.** All backend runtime for observability is committed.

### 3.3 Orchestrator → delivery_logs flow

```text
orchestrator.apply_schema_drift_policy_to_batch()
  → log_fn({ stage: schema_drift_policy_auto_protect_applied | ... })
    → stream_runner._persist_delivery_log()
      → schema_drift_policy_delivery_log_message(payload)
        → delivery_logs.message + payload_sample
```

**Risk:** Frontend `delivery-log-stages.ts` must stay synchronized with `delivery_log_stages.py` (explicit comment in backend module).

---

## 4. Backend Test Audit

| File | Tracked? | Purpose | Status | Dependencies |
|------|----------|---------|--------|--------------|
| `tests/test_schema_drift_policy_runtime.py` | ✅ (base) | E2E-style runtime drift policy cases | **+79 lines WIP** — auto_protect + path_resolution delivery_log persistence | DB, StreamRunner, protection enabled |
| `tests/test_schema_drift_policy_delivery_logs.py` | ❌ | Unit tests for stage frozenset + message formatter | **Ready** — 2 tests | `delivery_log_stages.py` |

### Gaps

| Gap | Severity |
|-----|----------|
| No WIP test for `schema_drift_policy_review_required` delivery_log row | Low |
| No WIP test with `GDC_ROUTE_PROCESSING_ENABLED=true` (M13 shared-phase drift) | Medium — post-M13 route path observability unverified |
| `test_schema_drift_policy_delivery_logs.py` not tracked | Medium — commit with runtime test delta |

---

## 5. Frontend UI Audit

### 5.1 Modified components

| File | Purpose | Status | Depends on |
|------|---------|--------|------------|
| `delivery-log-stages.ts` | Register 4 schema drift stages + display labels + drilldown constants | Complete in WIP | Backend stage strings |
| `logs-explorer-page.tsx` | Quick-filter chips for drift stages | Complete in WIP | `delivery-log-stages.ts` |
| `protection-panel.tsx` | Recent Auto Protect activity table; rule origin column | Complete in WIP | `auto-protect-activity.ts`, `protection-rule-origin.ts`, runtime logs API |
| `stream-governance-drawer.tsx` | Optional `SchemaDriftPolicyCard` slot | Complete in WIP | `schema-drift-policy-card.tsx`, `stream-schema-drift-policy.ts` |
| `stream-runtime-detail-page.tsx` | Reads `config_json` → passes labels to drawer | Complete in WIP | `stream-schema-drift-policy.ts` |

### 5.2 Untracked components / libs

| File | Purpose | Status |
|------|---------|--------|
| `schema-drift-policy-card.tsx` | Read-only deployed policy summary | Ready + tested |
| `stream-schema-drift-policy.ts` | Label extraction from `streams.config_json.governance.schema_drift_policy` | Ready — defaults match backend |
| `auto-protect-activity.ts` | Parse `schema_drift_policy_auto_protect_applied` log messages | Ready + tested |
| `protection-rule-origin.ts` | Operator vs Wizard badge for **persisted** rules only (excludes ephemeral auto-protect) | Ready — aligns with SoT distinction |

### 5.3 Build / deploy risk

Committed `HEAD` **does not** include modified frontend files. Production bundle from `HEAD` alone **still builds** (WIP unstaged). **Staging partial frontend** (e.g. only `delivery-log-stages.ts`) **will break** — modified panels import untracked libs.

**Frontend redeploy required** after commit (`scripts/frontend-redeploy.sh`).

---

## 6. Governance Overlap Audit

Governance WIP improves **quarantine reason labels** for `policy:schema_drift:*` and manual quarantine. It is **display-only** and does not change drift policy execution.

| Concern | Schema drift workstream? | Recommendation |
|---------|--------------------------|----------------|
| `humanize-quarantine-reason.ts` | Overlap | **Separate commit D** or bundle with frontend if tested together |
| `app/governance_*` inline humanizer | Overlap | Same as above |
| `quarantine-panel.tsx` | Overlap | Uses humanize lib — not required for logs/protection observability |

**Not obsolete** — aligned with Governance Workspace UX. **Not blocking** schema drift observability commit if split.

---

## 7. Source of Truth Alignment

Verified against `docs/source-of-truth/DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt` and `app/schema_drift_policy/schemas.py`.

| SoT principle | WIP alignment | Evidence |
|---------------|---------------|----------|
| Unknown Normal → **Pass Through** default | ✅ | `DEFAULT_UNKNOWN_NORMAL_POLICY`; `stream-schema-drift-policy.test.ts` Case 1 |
| Unknown Sensitive → **Auto Protect** default | ✅ | `DEFAULT_UNKNOWN_SENSITIVE_POLICY`; test defaults |
| Schema Drift = **Stream baseline** | ✅ | UI reads `streams.config_json.governance.schema_drift_policy` only |
| Route can override behavior | ⚠️ **Not in this WIP** | SoT §21 Route Override — M13 `route_policy/drift_gates.py` handles runtime; **no per-route drift policy UI** in WIP |
| Auto Protect **only** for unknown **sensitive** fields | ✅ | `orchestrator.py` L271–275: `if not item.is_sensitive: continue` |
| Require Review / Quarantine **not** defaults | ✅ | Defaults are pass_through + auto_protect; review/quarantine only when configured |

**Conclusion:** WIP is **aligned** for stream-scoped observability. Route-aware drift policy display is **future work** (not a reason to discard current WIP).

---

## 8. Risks and Blockers

| # | Blocker / risk | Severity | Mitigation |
|---|----------------|----------|------------|
| 1 | Frontend WIP split across tracked/untracked — partial commit breaks build | **HIGH** | Commit all frontend files in **one atomic frontend commit** |
| 2 | Backend/frontend stage token drift | **MEDIUM** | `delivery-log-stages.schema-drift.test.ts` + `test_schema_drift_policy_delivery_logs.py` as contract gate |
| 3 | Extended runtime tests unstaged | **MEDIUM** | Commit with delivery_logs unit tests |
| 4 | M13 route path not covered in new tests | **MEDIUM** | Add follow-up test under `GDC_ROUTE_PROCESSING_ENABLED=true` post-commit |
| 5 | Governance humanize duplicated backend/frontend | **LOW** | Acceptable for MVP; consolidate later |
| 6 | `protection-rule-origin` excludes ephemeral auto-protect rules | **LOW** | Intentional per lib comment — correct SoT semantics |
| 7 | Missing import / runtime break | **RESOLVED** | `delivery_log_stages.py` pushed in `1806a10` |

**No accidental leftovers** (debug files, dead experiments) in this workstream.

---

## 9. Recommended Commit Split

| Commit | Label | Files | Rationale |
|--------|-------|-------|-----------|
| **A** | Backend observability tests | `tests/test_schema_drift_policy_runtime.py` (delta), `tests/test_schema_drift_policy_delivery_logs.py` | Validates delivery_log persistence without UI |
| **B** | Frontend observability UI | All modified + untracked frontend schema drift files (§10 table) | Atomic — avoids broken imports |
| **C** | Governance label UX *(optional separate)* | governance services + humanize lib + quarantine/violation/replay UI | Cross-cutting display; can ship after B |
| **D** | *(not recommended alone)* | `protection-rule-origin` without protection-panel | Orphan — always bundle with protection-panel |

**Do not split** `delivery-log-stages.ts` from `logs-explorer-page.tsx` or protection-panel from its libs.

---

## 10. Final File Decision Table

| Path | Class | KEEP / DISCARD | COMMIT NOW / LATER / NEVER | Notes |
|------|-------|----------------|----------------------------|-------|
| `app/schema_drift_policy/delivery_log_stages.py` | Backend runtime | KEEP | **NEVER** (done `1806a10`) | Already on `origin` |
| `app/schema_drift_policy/orchestrator.py` | Backend runtime | KEEP | NEVER (committed) | — |
| `app/schema_drift_policy/schemas.py` | Backend runtime | KEEP | NEVER (committed) | SoT defaults |
| `app/schema_drift_policy/path_resolve.py` | Backend runtime | KEEP | NEVER (committed) | — |
| `tests/test_schema_drift_policy_runtime.py` | Backend tests | KEEP | **LATER** (commit A) | +79 lines delivery_log assertions |
| `tests/test_schema_drift_policy_delivery_logs.py` | Backend tests | KEEP | **LATER** (commit A) | Stage contract unit tests |
| `frontend/.../delivery-log-stages.ts` | Logs | KEEP | **LATER** (commit B) | Stage registry |
| `frontend/.../delivery-log-stages.schema-drift.test.ts` | Tests | KEEP | **LATER** (commit B) | Contract tests |
| `frontend/.../logs-explorer-page.tsx` | Logs | KEEP | **LATER** (commit B) | Quick filters |
| `frontend/.../protection-panel.tsx` | Frontend UI | KEEP | **LATER** (commit B) | Auto-protect activity |
| `frontend/.../protection-panel.test.tsx` | Tests | KEEP | **LATER** (commit B) | Panel tests |
| `frontend/.../schema-drift-policy-card.tsx` | Frontend UI | KEEP | **LATER** (commit B) | Read-only card |
| `frontend/.../schema-drift-policy-card.test.tsx` | Tests | KEEP | **LATER** (commit B) | — |
| `frontend/.../stream-governance-drawer.tsx` | Frontend UI | KEEP | **LATER** (commit B) | Card slot |
| `frontend/.../stream-runtime-detail-page.tsx` | Frontend UI | KEEP | **LATER** (commit B) | Wires labels |
| `frontend/src/lib/stream-schema-drift-policy.ts` | Frontend lib | KEEP | **LATER** (commit B) | Config reader |
| `frontend/src/lib/stream-schema-drift-policy.test.ts` | Tests | KEEP | **LATER** (commit B) | — |
| `frontend/src/lib/auto-protect-activity.ts` | Frontend lib | KEEP | **LATER** (commit B) | Log parser |
| `frontend/src/lib/auto-protect-activity.test.ts` | Tests | KEEP | **LATER** (commit B) | — |
| `frontend/src/lib/protection-rule-origin.ts` | Frontend adjunct | KEEP | **LATER** (commit B) | With protection-panel |
| `frontend/src/lib/protection-rule-origin.test.ts` | Tests | KEEP | **LATER** (commit B) | — |
| `app/governance_audit/service.py` | Governance overlap | KEEP | **LATER** (commit C) | Not schema-drift core |
| `app/governance_quarantine/service.py` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `app/governance_replay/service.py` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `app/governance_violations/service.py` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `frontend/.../quarantine-panel.tsx` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `frontend/.../quarantine-panel.test.tsx` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `frontend/src/lib/humanize-quarantine-reason.ts` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `frontend/src/lib/humanize-quarantine-reason.test.ts` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `frontend/.../violation-center-page.tsx` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `frontend/.../replay-center-page.tsx` | Governance overlap | KEEP | **LATER** (commit C) | — |
| `frontend/.../quarantine-center-page.test.tsx` | Governance overlap | KEEP | **LATER** (commit C) | — |

### DISCARD / NEVER

| Path | Decision |
|------|----------|
| *(none in schema drift workstream)* | — |

---

## Pre-commit validation checklist (when implementing commits)

```bash
# Commit A
pytest tests/test_schema_drift_policy_runtime.py tests/test_schema_drift_policy_delivery_logs.py -v

# Commit B
cd frontend && npm test -- --run delivery-log-stages.schema-drift protection-panel schema-drift-policy-card stream-schema-drift-policy auto-protect-activity protection-rule-origin
cd frontend && npm run build
scripts/frontend-redeploy.sh

# Optional Commit C
pytest tests/ -k governance -q  # focused governance tests if present
```

---

## Roadmap notes (future milestones, not this WIP)

| Item | Milestone |
|------|-----------|
| Per-route Schema Drift Policy override UI | SoT §21 — post M13 route APIs |
| Route-scoped drift delivery_log attribution (`route_id` dimension) | M13.6 snapshot extensions |
| Flag ON drift observability regression tests | M13 + M4 intersection |

---

*Audit performed read-only 2026-06-17. M13 hotfix `1806a10` reflected; no code modified.*
