# M13 Flag ON Runtime Validation

**Status:** SUPERSEDED (historical validation snapshot)  
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), Runtime code + tests

**Date:** 2026-06-17  
**Flag:** `GDC_ROUTE_PROCESSING_ENABLED=true`  
**Prerequisite:** Circular import fix applied

---

## 1. Target Pipeline

```text
SHARED PHASE (once per batch)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → Schema Drift Policy → SharedBatchContext

PER-ROUTE LOOP (process_route_pipeline)
  Transform → Protection → Classification → Policy → Delivery

POST-LOOP
  Dynamic routing → Checkpoint (stream cursor)
```

---

## 2. Verification Method

### Full M13 test gate

```bash
python3 -m pytest tests/test_route_processing_foundation.py \
  tests/test_per_route_transform.py tests/test_per_route_protection.py \
  tests/test_per_route_classification.py tests/test_per_route_policy.py \
  tests/test_route_runtime_delivery.py tests/test_route_transform_config.py -v
```

**Result:** 75 passed in 51.31s

### Focused flag ON / pipeline tests

| Test | Evidence |
|------|----------|
| `test_feature_flag_on_executes_route_loop` | Route loop runs; `route_count`, `route_transform_count`, `route_processing_loop` delivery log |
| `test_flag_on_stage_order` | Stage order: transform < protection < classification < policy < delivery |
| `test_flag_on_policy_stage_active` | `policy` in timeline; no `policy_stub` |
| `test_pipeline_delivery_after_policy` | Delivery stage executes after policy gate |

All **PASSED** in full suite run.

---

## 3. Stage Order Evidence

### Code (`app/runners/route_stage.py`)

`process_route_pipeline()` invokes stages in order:

1. `_apply_route_transform()` → timeline `"transform"`
2. `route_protection_stage()` → `"protection"`
3. `route_classification_stage()` → `"classification"`
4. `route_policy_stage()` → `"policy"`
5. `route_delivery_stage()` → `"delivery"`

Policy sets `delivery_allowed`; delivery receives `send_fn` only when allowed.

### Test (`test_flag_on_stage_order`)

```python
stages = [entry.get("stage") for entry in result.stage_timeline if entry.get("stage")]
transform_idx = stages.index("transform")
protection_idx = stages.index("protection")
classification_idx = stages.index("classification")
policy_idx = stages.index("policy")
delivery_idx = stages.index("delivery")
assert transform_idx < protection_idx < classification_idx < policy_idx < delivery_idx
```

**Result:** PASSED

---

## 4. End-to-End Route Loop Evidence

### `test_feature_flag_on_executes_route_loop`

With flag ON and seeded stream + route:

- `summary["outcome"] == "completed"`
- `summary["route_count"] == 1`
- `summary["route_context_build_time_ms"]` present
- `summary["route_transform_count"] == 1`
- Webhook delivery occurred
- `DeliveryLog` with `stage == "route_processing_loop"` and message `"route processing pipeline complete"`

---

## 5. Per-Stage Spot Checks (flag ON tests in suite)

| Stage | Representative tests | Status |
|-------|---------------------|--------|
| Shared phase + context build | `test_shared_batch_context_*`, `test_build_route_runtime_contexts` | ✅ |
| Transform | `test_route_transform_applied`, `test_flag_on_skips_stream_protection` | ✅ |
| Protection | `test_feature_flag_on_protection_active`, `test_route_protection_stage_*` | ✅ |
| Classification | `test_route_stage_attaches_classification_result`, `test_classify_batch_reused_not_evaluate_batch` | ✅ |
| Policy | `test_route_policy_allow_delivers`, `test_route_policy_block_prevents_delivery`, `test_delivery_gate_fan_out` | ✅ |
| Delivery | `test_delivered_success`, `test_blocked_disposition_audit`, `test_checkpoint_reference_on_success` | ✅ |

---

## 6. Policy → Delivery Gate Evidence

| Decision | Delivery | Test |
|----------|----------|------|
| allow | Delivered | `test_route_policy_allow_delivers` ✅ |
| audit | Delivered | `test_route_policy_audit_delivers` ✅ |
| block | Not delivered | `test_route_policy_block_prevents_delivery` ✅ |
| require_review | Not delivered | `test_route_policy_require_review_prevents_delivery` ✅ |
| quarantine | Not delivered + route_id recorded | `test_route_policy_quarantine_prevents_delivery` ✅ |

---

## 7. Shared Phase Evidence

`test_schema_drift_invoked_before_shared_batch` and `_execute_route_pipeline()` in `stream_runner.py` apply schema drift in the shared phase before `process_routes()`.

Stream-scoped transform/classify/policy paths are **skipped** when flag ON (verified in transform/protection/classification/policy flag ON tests).

---

## 8. Verdict

| Check | Status |
|-------|--------|
| StreamRunner importable | ✅ |
| Shared phase executes | ✅ |
| Per-route loop executes | ✅ |
| Stage order correct | ✅ |
| Policy gates delivery | ✅ |
| Checkpoint on successful delivery | ✅ |

**Flag ON runtime validation: PASS** (automated test evidence)

---

## 9. Out of Scope (not blockers for this audit)

- Route-scoped REST APIs (TD-H2)
- Route Processing UI
- `runtime_route_snapshot` disposition columns (TD-M3)
- Production enablement without committed migrations (TD-H3)

---

*Report generated 2026-06-17. Evidence from pytest run post circular-import fix.*
