# Schema Drift Test Readiness Audit — Commit A

**Status:** ARCHIVE_CANDIDATE (point-in-time audit)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), [`DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md`](../ux/DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md)

**Date:** 2026-06-17  
**Branch:** `feature/sensitive-detection-m5-clean` (`1806a10` on `origin`)  
**Commit A candidate:**
- `tests/test_schema_drift_policy_runtime.py` (modified: +79 lines WIP)
- `tests/test_schema_drift_policy_delivery_logs.py` (untracked, new)

**Mode:** Read-only audit — no code changes, no commit, no push

---

## 1. Executive Summary

Commit A bundles **24 tests** (22 in runtime file + 2 in delivery_logs file). **All 24 passed** in isolation (`42.07s`). Tests are **valid** and **independent of frontend WIP** and **governance WIP** (static + runtime verification).

However, relative to the **observability extension goal** (delivery log persistence + operator-visible messages), coverage is **incomplete**:

| Criterion | Result |
|-----------|--------|
| Valid | ✅ 24/24 pass |
| Independent (no frontend) | ✅ |
| Independent (no governance WIP) | ✅ |
| Policy behavior coverage (stream path) | ✅ Strong (20 pre-existing + WIP) |
| **Observability / DeliveryLog DB coverage** | ⚠️ **Partial** — only auto_protect + path_resolution_failed |
| **delivery_logs message unit tests** | ⚠️ **Partial** — 1 of 4 stage message paths |
| M13 route-path observability | ❌ Not tested |

**Final verdict: NOT READY FOR COMMIT A** — commit as-is is safe and valuable, but **observability test completeness** criteria from this audit are not fully met. Add missing DeliveryLog persistence tests and expand `test_schema_drift_policy_delivery_logs.py` before labeling Commit A complete.

---

## 2. Test Coverage Review

### 2.1 File inventory

| File | Git state | Tests | Role |
|------|-----------|-------|------|
| `test_schema_drift_policy_runtime.py` | Modified (+79 lines) | 22 | Integration: orchestrator, StreamRunner, quarantine, defaults |
| `test_schema_drift_policy_delivery_logs.py` | Untracked | 2 | Unit: stage tokens + auto_protect message formatter |

### 2.2 Task 2 matrix — policy behaviors

| Scenario | Covered? | Test(s) | Notes |
|----------|----------|---------|-------|
| **Unknown Normal → Pass Through** | ✅ | `test_load_defaults_when_policy_absent`, `test_unknown_normal_pass_through_delivers` | Default + delivery succeeds |
| **Unknown Sensitive → Auto Protect** | ✅ | `test_auto_protect_email_partial_mask`, `test_auto_protect_secret_full_mask`, `test_orchestrator_auto_protect_builds_ephemeral_rules`, +6 more | Ephemeral rules, masking modes |
| **Require Review** (normal + sensitive) | ✅ runtime | `test_unknown_normal_require_review_delivers_with_review_log`, `test_unknown_sensitive_require_review_delivers_with_review_log`, `test_orchestrator_sensitive_classification_uses_detection_context` | Asserts `log_fn` / `captured_logs` stage `schema_drift_policy_review_required` |
| **Quarantine** (normal + sensitive) | ✅ runtime | `test_unknown_normal_quarantine_blocks_delivery_and_checkpoint`, `test_unknown_sensitive_quarantine_blocks_delivery_and_checkpoint` | Blocks delivery; quarantine row; governance label smoke |
| **Delivery Log Generation** | ⚠️ Partial | WIP: `test_auto_protect_persists_schema_drift_delivery_logs`, `test_path_resolution_failed_persists_schema_drift_delivery_log` | **DB `DeliveryLog` rows** only for auto_protect + path_fail |
| **Operator Visibility** | ⚠️ Partial | `test_schema_drift_delivery_log_message_auto_protect`; runtime asserts `message.startswith("Auto protect applied:")` | No unit tests for review/quarantine/summary messages |
| **Runtime Timeline** | ⚠️ Partial | Review tests use `_CaptureLogRunner.captured_logs` | In-memory timeline only; not `delivery_logs` table for review/quarantine |

### 2.3 WIP delta (+79 lines) — specific assertions

**`test_auto_protect_persists_schema_drift_delivery_logs`**
- Queries `DeliveryLog` for `schema_drift_policy_auto_protect_applied` and `schema_drift_policy`
- Asserts human message prefix, `field_path`, `protection_mode`, `action == auto_protect`

**`test_path_resolution_failed_persists_schema_drift_delivery_log`**
- Queries `DeliveryLog` for `schema_drift_policy_path_resolution_failed`
- Asserts `extracted_path == $.missing.path`

### 2.4 Coverage gaps (observability focus)

| Missing test | Runtime emits via `log_fn`? | Priority |
|--------------|----------------------------|----------|
| `DeliveryLog` row for `schema_drift_policy_review_required` | ✅ orchestrator L247–259 | **High** |
| `DeliveryLog` row for `schema_drift_policy` + `action: quarantine` | ✅ orchestrator L327–337 | **High** |
| `schema_drift_policy_delivery_log_message()` for review_required | ✅ helper exists | Medium |
| `schema_drift_policy_delivery_log_message()` for path_resolution_failed | ✅ helper exists | Medium |
| `schema_drift_policy_delivery_log_message()` for quarantine summary | ✅ helper exists | Medium |
| M13 `GDC_ROUTE_PROCESSING_ENABLED=true` drift + delivery_logs | Shared-phase drift in route path | Medium (post-M13) |

### 2.5 Pre-existing tests on `origin` (without WIP)

`HEAD` contains **20 tests** in `test_schema_drift_policy_runtime.py` (no delivery_logs file). WIP adds **2 integration + 2 unit** tests.

---

## 3. SoT Alignment

Verified against `docs/source-of-truth/DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt` and `app/schema_drift_policy/schemas.py`.

| SoT principle | Test evidence |
|---------------|---------------|
| Unknown Normal default **Pass Through** | `test_load_defaults_when_policy_absent` |
| Unknown Sensitive default **Auto Protect** | `test_load_defaults_when_policy_absent` |
| Pass Through delivers data (gateway philosophy) | `test_unknown_normal_pass_through_delivers` |
| Auto Protect only for **sensitive** unknown fields | `test_orchestrator_auto_protect_builds_ephemeral_rules`; non-sensitive skipped in orchestrator |
| Require Review / Quarantine **configurable, not default** | Explicit policy in tests; defaults test confirms pass_through + auto_protect |
| Schema Drift at **stream** baseline | All tests use `streams.config_json.governance.schema_drift_policy` |
| Route override (SoT §21) | **Not tested** — no per-route drift policy in Commit A scope |
| Union Schema UX | Indirect via drift findings + field paths; no Union Schema UI tests |

**Alignment:** ✅ Stream-scoped policy tests match Governance Policy SoT. Route-aware drift is **out of scope** for current tests (consistent with M13 route override runtime existing but UI/API deferred).

---

## 4. Dependency Review

### 4.1 Frontend dependency

| Question | Answer |
|----------|--------|
| Can Commit A run without frontend changes? | **Yes** |
| Do tests import frontend? | **No** |
| Do tests require `delivery-log-stages.ts`? | **No** — backend stage strings asserted directly |

### 4.2 Governance WIP dependency

| Question | Answer |
|----------|--------|
| Can tests run without governance WIP committed? | **Yes** |
| Tests touching governance | `test_governance_quarantine_labels_schema_drift_policy`, `test_unknown_normal_quarantine_blocks_delivery_and_checkpoint` import `_humanize_quarantine_reason` from **committed** module API |
| WIP governance changes | Optional `quarantine_source` param — tests call without it; assertions (`"Schema Drift Policy" in reason`) pass on **both** `HEAD` and WIP humanizer |

### 4.3 Backend dependencies (committed)

| Dependency | Required? |
|------------|-----------|
| `app/schema_drift_policy/delivery_log_stages.py` | ✅ Committed `1806a10` |
| `app/schema_drift_policy/orchestrator.py` | ✅ `7c9e2e2` |
| `app/runners/stream_runner.py` | ✅ M13 + drift integration |
| `tests/test_stream_runner_e2e` helpers | ✅ Committed fixtures |

### 4.4 Independence verdict

**Commit A can be committed and executed without frontend or governance WIP.** ✅

---

## 5. Runtime Validation

```bash
pytest tests/test_schema_drift_policy_runtime.py tests/test_schema_drift_policy_delivery_logs.py -v
```

| Result | Count |
|--------|-------|
| **Passed** | **24** |
| **Failed** | 0 |
| **Skipped** | 0 |
| **Errors** | 0 |
| **Duration** | 42.07s |

### Collection

```
24 tests collected
```

All tests use pytest + test DB (conftest `db_session`); no external WireMock required for this subset.

---

## 6. Commit A Readiness

### Ready aspects

| Item | Status |
|------|--------|
| Tests pass | ✅ |
| No frontend coupling | ✅ |
| No governance WIP coupling | ✅ |
| Policy matrix (pass_through, auto_protect, review, quarantine) at runtime | ✅ |
| Adds DeliveryLog DB proof for key observability cases | ✅ (2 new cases) |
| Stage token contract unit test | ✅ |

### Not-ready aspects (observability completeness)

| Item | Status |
|------|--------|
| DeliveryLog DB tests for require_review | ❌ |
| DeliveryLog DB tests for quarantine summary stage | ❌ |
| Full `schema_drift_policy_delivery_log_message()` coverage | ❌ (1/4 paths) |
| Route-path (M13 flag ON) observability | ❌ |

### Commit A contents if proceeded anyway

| File | Change |
|------|--------|
| `tests/test_schema_drift_policy_runtime.py` | +79 lines (2 new tests) |
| `tests/test_schema_drift_policy_delivery_logs.py` | +27 lines (new file) |

**Risk of committing now:** Low regression risk (all pass); **medium documentation debt** — observability milestone partially tested.

---

## 7. Go / No-Go

### Blocking items before **READY FOR COMMIT A** (observability-complete bar)

1. Add `test_require_review_persists_schema_drift_delivery_log` (or equivalent) asserting `DeliveryLog.stage == schema_drift_policy_review_required`.
2. Add `test_quarantine_persists_schema_drift_delivery_log` asserting `DeliveryLog.stage == schema_drift_policy` with `action == quarantine`.
3. Extend `test_schema_drift_policy_delivery_logs.py` with message tests for `review_required`, `path_resolution_failed`, and quarantine/summary `schema_drift_policy` stage.

### Non-blocking follow-ups (post Commit A)

- M13 route-path delivery_log test with `GDC_ROUTE_PROCESSING_ENABLED=true`
- Split `test_governance_quarantine_labels_*` to governance commit C (coupling hygiene)

---

## Final Decision

# **NOT READY FOR COMMIT A**

**Reason:** Tests are **valid and independent**, but **observability coverage is incomplete** — DeliveryLog persistence is only proven for **auto_protect** and **path_resolution_failed**, not for **require_review** or **quarantine**, and the delivery_logs unit file exercises only one message formatter path.

**If committing incrementally is acceptable:** the current bundle is **safe to commit** (24/24 green, no external deps) as **Commit A-min**; rename scope or add the three blocking tests above to meet the full observability readiness bar.

---

*Audit performed read-only 2026-06-17.*
