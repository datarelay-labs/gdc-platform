# M13.6 Route Runtime Delivery — Design Review

**Status:** SUPERSEDED (historical design review)  
**Superseded By:** [`specs/096-route-runtime-delivery`](../../specs/096-route-runtime-delivery/spec.md)

Design review only — no code, implementation, or migrations  
**Date:** 2026-06-16  
**Scope:** Spec 096 validation before M13.6 implementation  
**Inputs:**

| Document | Role |
|----------|------|
| [`specs/091-route-processing-architecture/spec.md`](../specs/091-route-processing-architecture/spec.md) | M13.1 foundation contracts |
| [`specs/092-per-route-transform/spec.md`](../specs/092-per-route-transform/spec.md) | M13.2 transform + pipeline order |
| [`specs/093-per-route-protection/spec.md`](../specs/093-per-route-protection/spec.md) | M13.3 protection |
| [`specs/094-per-route-classification/spec.md`](../specs/094-per-route-classification/spec.md) | M13.4 classification |
| [`specs/095-per-route-policy/spec.md`](../specs/095-per-route-policy/spec.md) | M13.5 policy + `delivery_allowed` |
| [`specs/096-route-runtime-delivery/spec.md`](../specs/096-route-runtime-delivery/spec.md) | M13.6 subject of review |
| [`m13-5-policy-design-review.md`](m13-5-policy-design-review.md) | Prior M13.5 → M13.6 compatibility review |
| [`route-data-model-review.md`](route-data-model-review.md) | DB / snapshot extension patterns |
| [`route-architecture-gap-analysis.md`](route-architecture-gap-analysis.md) | Gap evidence |
| `docs/source-of-truth/` | Product Charter 1.2.1, WBS 1.2.1, UX/Wizard/Governance/Union Schema charters |
| `.specify/memory/constitution.md` | Checkpoint and pipeline invariants |

**Implementation evidence (read-only):** `app/runners/stream_runner.py`, `app/runners/route_stage.py`, `app/runners/route_context.py`, `app/runtime/operational_snapshot_repository.py`, `app/runtime/runtime_snapshot_repository.py`, `app/route_policy/stage.py`, `app/route_policy/decision.py`

---

## 1. Review Summary

Spec 096 is **implementation-ready** for M13.6 scope and **correctly aligned** with Product Charter (*Runtime Reuse First*, *No Parallel Delivery Engine*, *Delivery Unit = Route*, *Checkpoint after Delivery Success*) and the established M13.1–M13.5 per-route pipeline.

**Overall verdict:** M13.6 **does not require** a new runtime, delivery engine, observability platform, or metrics platform. It **extends orchestration and read models** on existing `StreamRunner`, `_fan_out()`, destination adapters, `delivery_logs`, `runtime_route_snapshot`, `runtime_analytics_bucket_*`, and spec 012 health scoring.

**Conditional GO** for implementation — resolve **six pre-implementation items** (§8) to avoid rework:

1. **Delivery stage placement tension** — Spec 096 §12.1 places `route_delivery_stage()` inside `process_route_pipeline()` with injected `send_fn`, but M13.5 today runs fan-out **after** the route loop in `StreamRunner`. Implementation plan must pick one coordinator pattern and document it.
2. **`FanOutOutcome` is batch-aggregate, not per-route** — `_fan_out()` returns global `successful_events` only; M13.6 needs per-route send outcomes for `RouteDeliveryResult`.
3. **Policy-blocked routes log as `route_skip` / empty payload** — Not disposition-auditable today; M13.6 must emit explicit disposition rows **before** fan-out skip.
4. **Health/metrics stage lists exclude policy stages** — `SUCCESS_STAGES` / `FAILURE_STAGES` in `operational_snapshot_repository.py` cover send outcomes only.
5. **`delivery_handoff` timeline entry** — Must merge into `delivery` stage without breaking timeline consumers.
6. **Checkpoint partial-route attribution** — Spec 096 §11.4 `route_dispositions` on checkpoint trace is conceptual; not implemented.

**Require Review decision (§20):** **Confirmed** — route path (`GDC_ROUTE_PROCESSING_ENABLED=true`): Require Review → **not delivered** → `blocked` disposition + `route_delivery_review_count`. Aligns with M13.5 implementation (`delivery_allowed_for_decision()`). Spec 095 §10.3 delivery-with-flag deferred to legacy flag OFF path only.

---

## 2. Delivery Model Assessment

### 2.1 Verification — new platform requirements?

| Question | Required? | Assessment |
|----------|-----------|------------|
| New runtime | **No** | Spec 096 §19.2 forbids; Product Charter *No Parallel Pipeline* |
| New delivery engine | **No** | Reuses `_send_to_destination()`, adapters, formatter, rate limit, failure policy |
| New observability platform | **No** | Extends `delivery_logs` + existing Runtime / Logs UI surfaces |
| New metrics platform | **No** | Extends `RouteProcessingMetrics`, run summary, snapshot updaters, analytics buckets |

**Conclusion:** Architecture validation passes. M13.6 is **orchestration + typed disposition**, not a new platform.

### 2.2 Fan-out and adapters — support `RouteDeliveryResult` without redesign?

**Yes, with orchestration extension — not adapter redesign.**

| Component | Current | M13.6 fit |
|-----------|---------|-----------|
| `_fan_out()` | Iterates routes; per-route `route_payloads`; logs `route_send_success` / failures | **Reusable** — wrap single-route send slice or refactor loop body into callable injected by `route_delivery_stage()` |
| Destination adapters | `DestinationAdapterRegistry` — Syslog/Webhook | **Unchanged** |
| `FanOutOutcome` | Global `successful_events`, failover counters | **Insufficient alone** — needs per-route result map or callback; extend additively |
| Dynamic routing / failover | Post-loop in `_fan_out()` | **Out of M13.6 per-route disposition** — document as parallel path; do not conflate with `RouteDeliveryResult` |
| Rate limit skip | `destination_rate_limited` log; route not sent | **Gap** — spec 096 §5.4 partial; recommend `skip_reason` on `RouteDeliveryResult` (see §6) |

**Evidence:** `app/runners/stream_runner.py` — `_fan_out()` lines 743–1034; route path builds `route_payloads` from `delivery_allowed` (lines 354–358).

**Assessment:** Adapters need **no redesign**. Fan-out coordinator needs **per-route outcome plumbing** — extract send primitive, not replace engine.

### 2.3 Spec vs implementation gap (flag ON, post-M13.5)

| Deliverable | Spec 096 | Implemented | Assessment |
|-------------|----------|-------------|------------|
| `route_delivery_stage()` | Required | ❌ `delivery_handoff` passive timeline only | **M13.6 deliverable** |
| `RouteDeliveryResult` | Required | ❌ Absent | **M13.6 deliverable** |
| `DeliveryDisposition` enum | Required | ❌ Absent | **M13.6 deliverable** |
| `route_delivery_*` metrics | Required | ❌ Policy metrics only | **M13.6 deliverable** |
| Policy gate before fan-out | Prerequisite (M13.5) | ✅ `delivery_allowed` filter | **Complete** |
| Per-route payloads | Required (M13.2+) | ✅ `route_payloads` dict | **Complete** |
| Send via existing path | Required | ✅ `_fan_out()` | **Complete** — wrap, don't fork |
| Disposition audit | Required | ❌ Blocked routes → `route_skip` / `no_route_payload` | **M13.6 deliverable** |

### 2.4 Orchestration pattern recommendation

Two valid patterns — **pick one in implementation plan:**

```text
Pattern A (spec 096 §12.1 — preferred):
  process_route_pipeline()
    → route_delivery_stage(send_fn=single_route_send)
  StreamRunner aggregates RouteDeliveryResult list; checkpoint from delivered routes

Pattern B (minimal diff):
  process_route_pipeline() records disposition-only results for blocked routes
  StreamRunner._fan_out() enriched to return per-route outcomes map
  route_delivery_stage() post-processes fan-out logs into RouteDeliveryResult
```

Pattern A gives cleaner per-route timeline; Pattern B minimizes `StreamRunner` refactor. **Either works** without new delivery engine.

---

## 3. Metrics Assessment

### 3.1 Can Route Metrics use existing runtime metrics infrastructure?

**Yes.**

| Infrastructure | Route-scoped today? | M13.6 extension |
|----------------|-------------------|-----------------|
| `RouteProcessingMetrics` | ✅ Policy counters (M13.5) | Add `route_delivery_*` per spec 096 §8.1 |
| Run summary JSON (`StreamRunner`) | ✅ `route_policy_*` in summary | Add delivery counters |
| `runtime_analytics_bucket_1m` / `_5m` | ✅ `route_id` dimension | Filter/include new disposition stages |
| `delivery_logs` | ✅ `route_id` on send stages | Primary source for disposition + send |
| `app/runtime/metrics_service.py` | Stream/route EPS | Unchanged — buckets absorb new stages |

**No new metrics platform required.**

### 3.2 Gaps

| Gap | Risk | Mitigation |
|-----|------|------------|
| Policy disposition stages not in `OUTCOME_STAGES` | Disposition counts invisible to snapshot updater | Add `delivery_disposition` stage or extend stage sets in `operational_snapshot_repository.py` |
| Double-counting policy vs delivery | Inflated attempt counts | Normative: `route_delivery_attempt_count` at disposition resolution; policy counters remain upstream (spec 096 §8.4) |
| Batch summary vs time-series lag | Snapshot updater is incremental | Acceptable — same pattern as existing delivery metrics |

### 3.3 Assessment

Spec 096 metrics model is **sufficient** and **compatible** with existing infrastructure. Implementation is **additive field + stage list extension**.

---

## 4. Health Assessment

### 4.1 Can Route Health use existing runtime health infrastructure?

**Yes, with additive factors.**

| Component | Path | Route-aware? |
|-----------|------|--------------|
| `runtime_route_snapshot` | `app/runtime/models.py` | ✅ Per-route EPS, success_rate, last_error |
| Snapshot updater | `runtime_snapshot_repository.py` | ✅ Aggregates from `delivery_logs` |
| Health scoring API | Spec 012 `/runtime/health/routes` | ✅ Per-route scoring |
| `classify_route_health()` | `operational_snapshot_service.py` | ✅ Deterministic classification |

**Current inputs:** `SUCCESS_STAGES = {route_send_success, route_retry_success}`; `FAILURE_STAGES = {route_send_failed, route_retry_failed, route_unknown_failure_policy}`.

**M13.6 requirement:** Distinguish policy block/review/quarantine from destination send failure (spec 096 §9).

### 4.2 Extension path

| Health signal | Source | Level impact |
|---------------|--------|--------------|
| Send failures | Existing FAILURE_STAGES | Failed / Critical (unchanged) |
| Policy blocks | `policy_blocked`, `delivery_disposition` logs | **Warning** — not Failed |
| Review holds | `policy_review_required` | **Warning** |
| Quarantine volume | `stream_quarantine_events.route_id` | **Warning** → Failed if sustained |

Spec 096 three-level operator model (Healthy / Warning / Failed) **maps cleanly** to spec 012 four-level scoring (HEALTHY / DEGRADED / UNHEALTHY / CRITICAL) via existing `classify_route_health()`.

### 4.3 Optional snapshot columns (spec 096 §9.4)

`last_disposition`, `policy_block_rate_5m`, `quarantine_open_count` — **optional migration**; MVP can derive from `delivery_logs` queries without schema change.

### 4.4 Assessment

**No new health engine.** Extend factor inputs and optionally snapshot columns. **Compatible.**

---

## 5. Observability Assessment

### 5.1 Can Route Observability use existing audit/runtime records?

**Yes — `delivery_logs` is the primary store.**

| Surface | Today | M13.6 |
|---------|-------|-------|
| `delivery_logs` | `route_id` on send stages; policy stages from M13.5 (`policy_*`) | Add `delivery_disposition` stage; ensure all dispositions logged |
| `stage_timeline` on `RouteStageResult` | `delivery_handoff` ready/blocked | Replace/enrich with `delivery` + disposition |
| Quarantine | `stream_quarantine_events.route_id` (M13.5) | Link from disposition `quarantined` |
| Logs Explorer | Filter by `route_id`, `stage` | Add disposition / policy_action filters (conceptual §14) |
| Runtime detail page | Route send success/failure | Add disposition badge (conceptual §15) |

### 5.2 “Why did this route not deliver?” — spec 096 §10.2

Decision tree is **implementable** from:

1. `RouteStageResult.stage_timeline` — policy + delivery entries
2. `RouteDeliveryResult` — typed fields
3. `delivery_logs` — audit drill-down
4. Quarantine row — when `quarantined`

### 5.3 Observability gaps (pre-M13.6)

| Gap | Evidence | Fix in M13.6 |
|-----|----------|--------------|
| Blocked routes invisible in fan-out | `route_payloads` exclusion → `route_skip` / `no_route_payload` | Emit `delivery_disposition` log in policy-block path **before** fan-out |
| Policy vs skip conflation | Same log shape for disabled vs policy block | Include `policy_action`, `decision_reason` on disposition row |
| No unified disposition enum in logs | Ad-hoc stages | Normative `delivery_disposition` field in log context |

### 5.4 Assessment

**No new observability platform.** Existing audit pipeline **sufficient** with stage extension and disposition logging. UI depth may trail (acceptable per spec 096 §15.3).

---

## 6. RouteDeliveryResult Sufficiency

### 6.1 Spec 096 §6.1 fields — assessment

| Field | Sufficient? | Notes |
|-------|-------------|-------|
| `route_id`, `stream_id`, `destination_id` | ✅ | Identity complete |
| `delivery_allowed` | ✅ | M13.5 handoff |
| `delivery_disposition` | ✅ | Core M13.6 output |
| `delivery_success`, `delivery_error` | ✅ | Send outcome |
| `delivery_timestamp` | ✅ | Audit ordering |
| `policy_action`, `decision_reason` | ✅ | Policy attribution without re-eval |
| `event_count`, `latency_ms`, `adapter_stage` | ✅ | Send observability |
| `delivery_log_id` | ✅ | Drill-down correlation |

### 6.2 Recommended additive fields (non-blocking)

| Missing field | Why | Priority |
|---------------|-----|----------|
| `batch_id` / `run_id` | Correlate route result to stream batch | **Medium** — available on `SharedBatchContext` / `StreamRunner._run_id` |
| `skip_reason` | Distinguish `route_disabled`, `destination_disabled`, `rate_limited`, `policy_blocked`, `no_events` | **High** — spec §5.4 incomplete for rate limit |
| `failure_policy` | Explain LOG_AND_CONTINUE vs STOP on send failure | **Low** — derivable from route config |
| `failover_attempted` / `failover_succeeded` | Failover path observability | **Low** — parallel concern; optional on result |
| `quarantine_event_id` | Link to quarantine row when `quarantined` | **Medium** — operator drill-down |
| `review_required` (bool) | Explicit flag when `policy_action=require_review` | **Low** — redundant with `policy_action` |

**Conclusion:** `RouteDeliveryResult` is **sufficient for MVP**. Add `skip_reason` and `batch_id`/`run_id` in implementation plan; others optional.

---

## 7. DeliveryDisposition Sufficiency

### 7.1 Four-value model

| Disposition | Sufficient? | Usage |
|-------------|-------------|-------|
| `delivered` | ✅ | Successful adapter ACK |
| `delivered_review_required` | ✅ | **Legacy flag OFF only** (spec 096 §20.3) |
| `blocked` | ✅ | Policy block **and** route-path require_review |
| `quarantined` | ✅ | Policy quarantine |

### 7.2 Edge cases

| Case | Spec handling | Assessment |
|------|---------------|------------|
| Send attempted, failed | §7.4 — still `delivered` disposition with `delivery_success=false`? | **Ambiguity** — recommend sub-state: `delivery_disposition=delivered` + `delivery_success=false` OR add `delivery_failed` disposition in implementation plan. Current spec §5.3 says "delivered attempt failed" under `delivered` branch — **use `delivery_success=false`**, not new enum value. |
| Rate limited | Not in enum | Use `blocked` + `skip_reason=rate_limited` OR exclude from attempt_count — **specify in impl plan** |
| Zero-event allow | §5.3 vacuous success | ✅ `delivered`, `event_count=0`, no send |
| Dynamic routing | §5.4 unchanged | ✅ Out of per-route disposition scope |

### 7.3 Require Review on route path

`require_review` → `blocked` (not `delivered_review_required`) — **intentional** per spec 096 §20.2. Metrics split via `route_delivery_review_count` vs `route_delivery_blocked_count`.

**Conclusion:** Disposition model is **sufficient** for M13.6 MVP. Clarify send-failure-as-`delivered`+`delivery_success=false` in implementation plan.

---

## 8. Checkpoint Assessment

### 8.1 Only successful delivery advances checkpoint?

**Yes — verified against SoT and code.**

| Source | Rule |
|--------|------|
| **Product Charter 1.2.1** | *Checkpoint Update — Delivery Success 이후에만 갱신* |
| **Constitution §7** | *Checkpoint must be updated only after successful Destination delivery* |
| **Spec 002** | Checkpoint staged only after successful route delivery ACK |
| **Spec 096 §11** | Policy dispositions never checkpoint; multi-route partial success allowed |
| **`StreamRunner`** | `_update_checkpoint_after_success()` when `successful_events` non-empty |

### 8.2 Multi-route behavior (flag ON)

```text
Route A delivered, Route B policy-blocked:
  → route_payloads includes A only
  → fan-out sends A
  → successful_events from fan-out drives checkpoint (if all required routes succeed)
```

**Caveat:** `_fan_out()` returns **empty** `successful_events` if **any** required route fails send (lines 1027–1034), even when another route succeeded. Policy-blocked routes are excluded from `route_payloads` and may not count as failures — **checkpoint may advance when all attempted routes succeed**. This matches spec 096 §11.3 intent but **checkpoint trace lacks `route_dispositions`** (§11.4) — implementation debt.

### 8.3 Assessment

Checkpoint rules in spec 096 are **constitution-aligned**. No checkpoint model change required. **Additive trace attribution** recommended.

---

## 9. Require Review Decision Review

### 9.1 Current spec 096 decision

| Path | Behavior |
|------|----------|
| **Route path (flag ON)** | Require Review → **not delivered** → `blocked` disposition |
| **Legacy path (flag OFF)** | Drift require_review may deliver → `delivered_review_required` |

### 9.2 Cross-document alignment

| Document | Position |
|----------|----------|
| **Spec 095 §10.3** | Events *may still deliver* with review flag on route path |
| **M13.5 implementation** | `require_review` → `delivery_allowed=false` |
| **Spec 096 §20** | **Freezes** Option A for route path |
| **M13.5 design review** | Recommended disposition taxonomy; review deliveries distinct from blocked |

### 9.3 Review verdict: **CONFIRMED**

**Do not reopen** Require Review delivery semantics in M13.6 implementation.

| Rationale | |
|-----------|---|
| M13.5 shipped and tested with hold-not-deliver | |
| M19 review queue not available | |
| `route_delivery_review_count` provides distinct observability | |
| Spec 095 §10.3 preserved on legacy path only | |

**Reject** adopting `delivered_review_required` on route path for M13.6.

---

## 10. Implementation Debt (Fix Before or During M13.6)

| # | Debt | Severity | Recommendation |
|---|------|----------|----------------|
| **D1** | Delivery stage vs fan-out placement ambiguous (§12.1 vs current runner) | **High** | Lock Pattern A or B in implementation plan before coding |
| **D2** | `FanOutOutcome` lacks per-route results | **High** | Add `per_route_outcomes: dict[int, ...]` or build `RouteDeliveryResult` inside send loop |
| **D3** | Policy-blocked routes log as `route_skip` / `no_route_payload` | **High** | Emit `delivery_disposition` audit in `route_delivery_stage()` for non-send paths |
| **D4** | `SUCCESS_STAGES` / `FAILURE_STAGES` omit policy stages | **Medium** | Extend operational snapshot stage sets OR separate policy health query |
| **D5** | `delivery_handoff` → `delivery` timeline migration | **Medium** | Keep `delivery_handoff` as alias one release or update tests consuming timeline |
| **D6** | Checkpoint trace lacks `route_dispositions` | **Medium** | Add to `checkpoint_candidate` log context per spec 096 §11.4 |
| **D7** | Rate-limit skip not in disposition model | **Medium** | Add `skip_reason` to `RouteDeliveryResult` |
| **D8** | Spec 095 §10.3 vs §20 documented tension | **Low** | Already resolved in 096 §20 — no action |
| **D9** | Dynamic routing / failover outside `RouteDeliveryResult` | **Low** | Document exclusion in M13.6 tests |
| **D10** | Optional snapshot columns (`last_disposition`) | **Low** | Defer to post-MVP migration |

**Not blockers for GO** — address D1–D3 in first implementation slice.

---

## 11. Architectural Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Double send if delivery stage and fan-out both send | Medium | High | Single send primitive; idempotent wiring |
| Health mis-classifies policy block as send failure | Medium | Medium | Distinct log stages; UI badge rules spec 096 §15.2 |
| Metrics double-count policy + delivery | Low | Medium | §8.4 aggregation invariants |
| Timeline consumers break on `delivery_handoff` rename | Low | Low | Alias or dual-write timeline entry |
| Partial checkpoint confusion | Medium | Medium | `route_dispositions` on checkpoint trace (D6) |
| Require Review product backlash vs Spec 095 §10.3 | Low | Medium | Document §20; M19 queue before reconsideration |

---

## 12. Recommended Adjustments (Spec / Plan — Not Code)

| # | Adjustment | Type |
|---|------------|------|
| **R1** | Add `skip_reason: str \| None` to `RouteDeliveryResult` in spec 096 appendix | Spec amendment (optional) |
| **R2** | Add `batch_id` / `run_id` to `RouteDeliveryResult` | Spec amendment (optional) |
| **R3** | Normatively choose Pattern A or B for delivery stage placement | Implementation plan |
| **R4** | Clarify send failure: `delivery_disposition=delivered` + `delivery_success=false` | Implementation plan |
| **R5** | Extend `operational_snapshot_repository` stage lists for policy disposition stages | Implementation plan |
| **R6** | Rate-limit path: `skip_reason=rate_limited`, exclude or count in `route_delivery_attempt_count` | Implementation plan |

No architecture pivot required.

---

## 13. Go / No-Go Decision

| Criterion | Status |
|-----------|--------|
| No new runtime / delivery engine / observability / metrics platform | ✅ **GO** |
| Fan-out + adapters support `RouteDeliveryResult` without redesign | ✅ **GO** (with per-route plumbing) |
| Route metrics on existing infrastructure | ✅ **GO** |
| Route health on existing infrastructure | ✅ **GO** (extend factors) |
| Observability on existing audit records | ✅ **GO** |
| `RouteDeliveryResult` sufficient | ✅ **GO** (minor optional fields) |
| `DeliveryDisposition` sufficient | ✅ **GO** |
| Checkpoint rules constitution-aligned | ✅ **GO** |
| Require Review decision confirmed | ✅ **GO** |
| Implementation debt identified | ✅ D1–D3 must be scheduled |

### Final decision: **CONDITIONAL GO**

Proceed with M13.6 implementation after locking **delivery orchestration pattern** (D1/D2) and **disposition audit for non-send routes** (D3). No spec rewrite required; optional amendments R1–R2 improve clarity.

**Stop boundary:** M13.6 does not include M18 simulation, dashboard redesign, or new delivery engine — unchanged from spec 096 §19.

---

*End of design review — M13.6 Route Runtime Delivery.*
