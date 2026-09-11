# M13 Flag OFF Parity Report

**Status:** SUPERSEDED (historical validation snapshot)
**Superseded By:** [`source-of-truth-index.md`](source-of-truth-index.md), Runtime code + tests

Do **not** treat the flag default recorded below as current. Product default is `GDC_ROUTE_PROCESSING_ENABLED=true` (P1-4).

**Date:** 2026-06-17
**Flag (at audit time):** `GDC_ROUTE_PROCESSING_ENABLED=false` (then the `app/config.py` default)
**Prerequisite:** Circular import fix applied (`m13-circular-import-root-cause.md`)

---

## 1. Objective

Verify that with the route processing flag **disabled**, runtime behavior matches pre-M13 legacy pipeline: stream-scoped transform, protection, classification, policy, and fan-out — **no per-route loop**.

---

## 2. Verification Method

### Import / executability

```bash
python3 -c "from app.runners.stream_runner import StreamRunner"
# OK after import fix
```

### Automated parity tests

```bash
python3 -m pytest \
  tests/test_route_processing_foundation.py::test_feature_flag_off_skips_route_loop \
  tests/test_route_processing_foundation.py::test_backward_compatibility_flag_off_matches_delivery \
  tests/test_per_route_transform.py::test_feature_flag_off_parity \
  tests/test_per_route_protection.py::test_feature_flag_off_parity_with_protection_rules \
  tests/test_per_route_classification.py::test_feature_flag_off_legacy_unchanged \
  tests/test_per_route_policy.py::test_feature_flag_off_legacy_unchanged \
  tests/test_route_runtime_delivery.py::test_feature_flag_off_route_delivery_not_in_legacy \
  -v
```

**Result:** 7 passed in 20.86s

### Full M13 suite (includes all flag OFF tests)

```bash
python3 -m pytest tests/test_route_processing_foundation.py \
  tests/test_per_route_transform.py tests/test_per_route_protection.py \
  tests/test_per_route_classification.py tests/test_per_route_policy.py \
  tests/test_route_runtime_delivery.py tests/test_route_transform_config.py -v
```

**Result:** 75 passed in 51.31s

---

## 3. Evidence by Concern

| Concern | Test | Assertion | Result |
|---------|------|-----------|--------|
| Route loop skipped | `test_feature_flag_off_skips_route_loop` | `build_route_runtime_contexts` not called; no `route_count` in summary | ✅ PASS |
| Delivery parity OFF vs ON (no route rows) | `test_backward_compatibility_flag_off_matches_delivery` | Same `delivered_batch_event_count`; payload unchanged | ✅ PASS |
| Stream transform path | `test_feature_flag_off_parity` (transform) | Legacy mapping/enrichment path | ✅ PASS |
| Stream protection path | `test_feature_flag_off_parity_with_protection_rules` | Legacy `_prepare_delivery_events` behavior | ✅ PASS |
| Stream classification | `test_feature_flag_off_legacy_unchanged` (classification) | `process_routes` not invoked | ✅ PASS |
| Stream policy | `test_feature_flag_off_legacy_unchanged` (policy) | `process_routes` not invoked | ✅ PASS |
| No route delivery stage | `test_feature_flag_off_route_delivery_not_in_legacy` | Flag false; legacy path only | ✅ PASS |

---

## 4. Code Path (design reference)

When `GDC_ROUTE_PROCESSING_ENABLED` is false, `stream_runner.py` uses the legacy branch (~L475+):

- `_collect_and_transform_events()` — stream mapping + enrichment
- `_prepare_delivery_events()` — stream protection
- `_classify_events()` — stream classification (before protection in legacy order)
- `_evaluate_policies()` — stream policy
- `_fan_out()` — identical payload to all routes

Route pipeline (`_execute_route_pipeline`, `process_route_pipeline`) is **not entered**.

---

## 5. Known Intentional Deltas (not flag OFF regressions)

| Delta | Notes |
|-------|-------|
| Classification before Protection (OFF) vs after (ON) | Documented in spec 094 §10.4 — only applies when flag ON |
| Require Review delivery on drift path (OFF) vs blocked (ON) | M13.6 §20 — flag ON behavior |

These do not affect flag OFF parity.

---

## 6. Verdict

| Check | Status |
|-------|--------|
| StreamRunner importable | ✅ |
| Route loop not invoked | ✅ |
| Legacy delivery outcome preserved | ✅ |
| Route delivery stage absent | ✅ |

**Flag OFF parity: PASS** (within blocker-fix scope; import fix was prerequisite)

---

## 7. Remaining Gap

Flag OFF parity was **unverifiable** before the circular import fix (audit TD-H1). It is now verified via automated tests. Production deploys on builds **without** this WIP still use pre-M13 code until merged.

---

*Report generated 2026-06-17 after TD-H1 fix and test execution.*
