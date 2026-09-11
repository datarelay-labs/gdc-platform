# M13 Route Architecture Design Review

**Status:** SUPERSEDED (historical design review)  
**Superseded By:** [`specs/091-route-processing-architecture`](../../specs/091-route-processing-architecture/spec.md), [`source-of-truth-index.md`](source-of-truth-index.md)

Do **not** treat “flag default OFF” in the tables below as the current product default (`GDC_ROUTE_PROCESSING_ENABLED=true` as of P1-4).

Design review only — no code, implementation, or migrations  
**Date:** 2026-06-14  
**Scope:** M13.1 (implemented + spec), M13.2 (spec), compatibility with M13.3–M13.6  
**Inputs:**

| Document | Role |
|----------|------|
| [`specs/091-route-processing-architecture/spec.md`](../specs/091-route-processing-architecture/spec.md) | M13.1 engineering spec |
| [`specs/092-per-route-transform/spec.md`](../specs/092-per-route-transform/spec.md) | M13.2 engineering spec |
| [`route-processing-foundation-implementation-spec.md`](route-processing-foundation-implementation-spec.md) | Architecture authority |
| [`route-architecture-gap-analysis.md`](route-architecture-gap-analysis.md) | Gap evidence |
| `docs/source-of-truth/` | Product Charter 1.2.1, WBS 1.2.1, UX/Wizard/Governance/Union Schema charters |

---

## 1. Review Summary

M13.1 successfully establishes the **orchestration skeleton** (feature flag, route loop, context types, dual-read helper) without breaking legacy behavior. M13.2 spec correctly defines **per-route Transform** using existing Mapping/Enrichment engines with full-bundle dual-read fallback.

**Overall verdict:** The **architecture direction is sound** and aligned with Product Charter (*Execution Unit = Stream*, *Processing Unit = Route*). However, **three structural gaps** must be addressed before or during M13.2 implementation to avoid rework for M13.3–M13.6:

1. **Route loop placement** — M13.1 implementation runs the route loop **after** stream-level Protection and Policy, with **post-protection** events. Target architecture requires Transform → Protection → Classification → Policy **inside** the per-route loop. This is a **lifecycle ordering debt**, not a spec error.
2. **Context contract drift** — Implemented `RouteRuntimeContext` and `SharedBatchContext` are **simplified subsets** of spec 091; they lack `effective_config`, `processing_state`, and pre-transform event semantics required by M13.2+.
3. **Fan-out wiring** — `RouteStageResult` is produced but **not consumed** by `_fan_out()`; all routes still receive identical payloads.

M13.1 does **not** create hard blockers that require abandoning the architecture, but it creates **refactoring prerequisites** that M13.2 must explicitly schedule. M13.2 spec already documents most of these (shared phase split, fan-out per-route payloads); the review recommends **formalizing loop relocation** as a M13.2 gate, not an optional follow-up.

**Dual-read** scales cleanly to Transform, Protection, Classification, and Policy with one extension: Protection requires **stream rule + `route_overrides[]` merge**, not table-only fallback.

---

## 2. M13.1 Assessment

### 2.1 What M13.1 delivers (spec vs implementation)

| Deliverable | Spec 091 | Implemented | Assessment |
|-------------|----------|-------------|------------|
| `GDC_ROUTE_PROCESSING_ENABLED` default OFF | ✅ | ✅ `app/config.py` | **Complete** |
| Route loop in `StreamRunner` | ✅ | ✅ `_execute_route_processing_foundation()` | **Complete** |
| `SharedBatchContext` | Full contract §8 | Simplified fields | **Partial** |
| `RouteRuntimeContext` | Full contract §7 | Delivery identity only | **Partial** |
| Dual-read | All concerns at loader | Metadata + route name only | **Partial** |
| Stage slots (NO-OP) | Transform/Protection/Classification/Policy | Single NO-OP `process_route()` | **Skeleton only** |
| Legacy parity flag OFF | ✅ | ✅ Tests pass | **Complete** |
| Fan-out per-route payloads | Deferred M13.2 | Not wired | **Expected gap** |

### 2.2 Implemented pipeline (flag ON)

Evidence: `app/runners/stream_runner.py` lines 245–391.

```text
_collect_and_transform_events()     ← stream Mapping + Enrichment + Classification + …
→ _prepare_delivery_events()          ← stream Protection
→ _evaluate_policies()                ← stream Policy
→ quarantine check
→ dynamic routing
→ _execute_route_processing_foundation()  ← NO-OP route loop on delivery_events
→ _fan_out(delivery_events)           ← identical payload all routes
→ checkpoint
```

This differs from the **target** lifecycle in foundation spec §6 and spec 091 §4.2:

```text
Shared → [per route: Transform → Protection → Classification → Policy] → Delivery → Checkpoint
```

### 2.3 M13.1 strengths

- **Runtime Reuse First** honored — single `StreamRunner`, no parallel engine.
- **Backward compatibility** — flag OFF preserves OSS GA behavior; tests confirm.
- **Additive** — no DB migrations, no user config loss.
- **Extension points exist** — `route_stage.py`, `route_context_builder.py`, loop hook before fan-out.
- **Observability hook** — `route_processing_loop` delivery_log stage.

### 2.4 M13.1 gaps (acceptable for foundation label, debt for M13.2)

| Gap | Impact on M13.3–M13.6 |
|-----|------------------------|
| Loop after Protection/Policy | **High** — per-route Protection/Policy cannot run on route-transformed shapes without reorder |
| `SharedBatchContext.events` = post-protection copy | **High** — M13.2 Transform must receive **pre-mapping extracted events** |
| `stage_results` unused | **High** — M13.2/M13.6 need per-route payload map for fan-out |
| Monolithic `process_route()` | **Medium** — should become staged pipeline before M13.3 |
| No `effective_config` on context | **Medium** — loader must extend before M13.2 |
| No `stream_id` on `RouteRuntimeContext` | **Low** — easy add |

---

## 3. M13.2 Assessment

### 3.1 Spec quality

Spec 092 is **implementation-ready** and aligned with Product Charter, WBS, Union Schema Route Transform Model, and M13.1 contracts. Strengths:

- Reuses `apply_mappings_with_results()` and `apply_enrichments_batch()` — no new engine.
- Full-bundle dual-read (route row → else stream row) — predictable inheritance.
- Additive `route_mappings` / `route_enrichments` — preserves stream UNIQUE constraints.
- Explicit parity requirement: flag ON + no route rows ≡ flag OFF delivery.
- Clear non-scope boundary (M13.3–M13.6).

### 3.2 Spec gaps / ambiguities

| Item | Issue | Recommendation |
|------|-------|----------------|
| **Interim Option A vs B** (§4.3) | Option A (protection stays stream-scoped while transform is per-route) creates **incorrect masking** when routes produce different field shapes | **Reject Option A**; mandate Option B + loop reorder |
| **Downstream governance** (§4.2, §7) | States Protection/Classification/Policy remain stream-scoped in M13.2 | Accept only as **≤1 sprint bridge**; document M13.3 as hard dependency if routes diverge |
| **Checkpoint reference** (§8.4) | Two interim choices left open | Pick one in M13.2 impl plan: checkpoint cursor on **raw extracted** events, not route-shaped |
| **Classification order** | Current runtime: Classification before Protection; foundation spec shows Protection before Classification in route loop | Defer to **M13.4** spec; M13.2 must not cement order in fan-out API |

### 3.3 M13.2 vs M13.1 implementation

M13.2 spec correctly states M13.1 loop runs on post-transform stream path today. Implementation matches that statement. M13.2 **must relocate** the route loop and split shared phase — spec documents this; review **confirms it is mandatory**, not optional.

---

## 4. Future Milestone Compatibility

### 4.1 Verification matrix

| Question | M13.3 Protection | M13.4 Classification | M13.5 Policy | M13.6 Delivery |
|----------|------------------|----------------------|--------------|----------------|
| **Q1: M13.1 blocker?** | Soft — loop order | Soft — loop order + stage split | Soft — loop order | Soft — fan-out wiring |
| **Hard redesign required?** | No, if loop reordered | No | No | No |
| **Dual-read applies?** | Yes + `route_overrides[]` | Yes | Yes | N/A (delivery config exists) |
| **Engine reuse?** | `app/protection/engine.py` | `app/classification/service.py` | Stream policy pattern | Existing formatter/send |

**Conclusion:** M13.1 creates **no irreversible blocker**. It creates **ordering and wiring debt** that M13.2 must pay down.

---

### 4.2 RouteRuntimeContext — required vs present

**Spec 091 contract (target):**

| Field / group | M13.1 impl | M13.2 need | M13.3–M13.6 need |
|---------------|------------|------------|------------------|
| `route_id`, `destination_id`, `enabled` | ✅ | ✅ | ✅ |
| `stream_id` | ❌ | ✅ | ✅ |
| `route_name`, `route_type` | ✅ | ✅ | ✅ (UI/observability) |
| `formatter`, `delivery_policy`, `rate_limit` | partial (no rate_limit) | ✅ | ✅ M13.6 metrics |
| **`effective_config.transform`** | ❌ | ✅ | — |
| **`effective_config.protection`** | ❌ | — | ✅ + overrides |
| **`effective_config.classification`** | ❌ | — | ✅ |
| **`effective_config.policy`** | ❌ | — | ✅ |
| **`processing_state.current_events`** | ❌ | ✅ | ✅ |
| **`processing_state.stage_timeline`** | ❌ | ✅ | ✅ |
| **`processing_state.errors`** | ❌ | ✅ | ✅ |
| **`shared_batch_ref`** | ❌ | ✅ | ✅ |
| `processing_ready`, `readiness_reasons` | ❌ | optional | ✅ deploy gate |

**Missing fields to add (recommended unified contract):**

```text
stream_id
effective_config: { transform, protection, classification, policy }
processing_state: { current_events, stage_timeline, errors }
shared_batch_ref (or batch_id link)
rate_limit (from route/destination dual-read)
config_resolution: { transform_source, protection_source, … }  # audit/debug
```

---

### 4.3 SharedBatchContext — required vs present

**Spec 091 / foundation target:**

| Field | M13.1 impl | M13.2 need | M13.3–M13.6 need |
|-------|------------|------------|------------------|
| `stream_id`, `batch_id` | ✅ | ✅ | ✅ |
| `event_root`, `union_schema` | ✅ | ✅ | ✅ (governance UI) |
| **`extracted_events` (pre-mapping)** | ❌ (uses `events` ambiguously) | ✅ | ✅ |
| `observed_schema` / `schema_observation` | partial | ✅ | ✅ drift |
| **`sensitive_detection_result`** | ❌ (not structured) | optional | ✅ M13.3 suggestions |
| **`checkpoint_cursor_before`** | ❌ | ✅ | ✅ |
| `fetch_metadata` | ❌ | optional | ✅ M13.6 |
| `shared_runtime_data` | ✅ | ✅ | ✅ |

**Missing fields / semantics:**

```text
extracted_events          — explicit; distinct from route-transformed events
schema_observation        — full observation artifact (not just observed_schema dict)
sensitive_detection_result — structured; stream-scoped suggestions for all routes
checkpoint_cursor_before  — for checkpoint trace/debug
```

**Critical fix:** Rename or split `events` so route transform input is **never** post-protection copy.

---

### 4.4 Q4: M13.2 Transform ownership vs M13.3 Protection ownership

**No ownership conflict.**

| Concern | Config owner | Execution owner | Relationship |
|---------|--------------|-----------------|--------------|
| Transform | Route (+ stream fallback) | Route | Produces route event **shape** |
| Protection | Stream defaults + **`route_overrides[]`** | Route (M13.3) | Acts on route-transformed fields |
| Classification | Route (+ stream fallback) | Route (M13.4) | Labels route-transformed fields |
| Policy | Route (+ stream fallback) | Route (M13.5) | Gates route outbound behavior |

Governance Workspace model (stream rule + per-route override) is **complementary** to dual-read tables — not conflicting.

**Runtime conflict (interim only):** If M13.2 ships per-route Transform but leaves Protection at stream scope **before** the route loop (current M13.1 placement), Protection runs on **wrong event shape** for divergent routes. **Fix:** Move route loop before Protection or move Protection into route loop in M13.3 immediately after M13.2.

---

### 4.5 Q5: Dual-read scalability

| Concern | Dual-read pattern | Scales? | Notes |
|---------|-------------------|---------|-------|
| **Transform** | `route_mappings` ?? `mappings` | ✅ | Full-bundle fallback (spec 092) |
| **Enrichment** | `route_enrichments` ?? `enrichments` | ✅ | Same |
| **Protection** | `route_protection_rules` ?? `stream_protection_rules` **+** `route_overrides[]` on stream rules | ✅ with extension | Override merge: stream rule base + route override for matching `route_id` |
| **Classification** | `route_classification_rules` ?? `stream_classification_rules` | ✅ | Table fallback |
| **Policy** | `route_policy_rules` ?? `stream_policy_rules` | ✅ | Table fallback; schema drift stream policy stays stream-scoped |

**Recommendation:** Document a single `resolve_effective_config(route_id, concern)` API with concern-specific merge:

- Transform/Classification/Policy: **replace fallback**
- Protection: **rule set + override merge**

---

### 4.6 Q6: Lifecycle support without redesign?

**Target lifecycle (Product Charter / foundation spec):**

```text
Shared Phase
↓
Transform          (M13.2)
↓
Protection         (M13.3)
↓
Classification     (M13.4)
↓
Policy             (M13.5)
↓
Delivery           (M13.6 + existing)
↓
Checkpoint
```

| Aspect | Supported without redesign? | Condition |
|--------|---------------------------|-----------|
| Conceptual model | ✅ | Specs already define this |
| M13.1 implementation | ❌ | Loop order + monolithic stage |
| After M13.2 adjustments | ✅ | Loop relocation + staged `process_route_*` |
| Stage order (Classification vs Protection) | ⚠️ | One reorder decision in M13.4; do not block M13.2 |

**Required structural change (once, in M13.2):**

```text
process_route_pipeline(route_ctx, shared_batch):
  events = route_transform(...)
  events = route_protection(...)      # NO-OP until M13.3
  events = route_classification(...)  # NO-OP until M13.4
  events = route_policy(...)          # NO-OP until M13.5
  return RouteStageResult(events)
```

No second runner or parallel pipeline — **refactor inside existing loop**.

---

### 4.7 Q7: Product Charter validity

**Execution Unit = Stream** — **Still valid.**

| Stream-owned (unchanged) | Evidence |
|--------------------------|----------|
| Source fetch, polling, checkpoint | M13.1 + specs |
| Record path, Event root | M13.2 keeps stream-scoped |
| Union Schema, baseline, drift observation | Foundation spec §4 |
| Sensitive detection suggestions | Stream/sample scope |
| Stream status, scheduling | Unchanged |

**Processing Unit = Route** — **Still valid** (progressive realization).

| Route-owned (target) | Milestone |
|----------------------|-----------|
| Transform | M13.2 |
| Protection | M13.3 |
| Classification | M13.4 |
| Policy | M13.5 |
| Delivery context | Exists; M13.6 extends observability |

Product rule *users must not duplicate Streams for destination-specific processing* — **achievable** once M13.2+ complete; architecture supports it.

---

## 5. Architectural Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **Loop order debt** — route loop after stream Protection/Policy | **High** | Current | M13.2 gate: relocate loop before governance stages |
| **SharedBatchContext wrong event stage** — post-protection input | **High** | Current | Build shared batch from extracted events at shared phase end |
| **Fan-out ignores RouteStageResult** | **High** | Current | M13.2: `_fan_out(route_payloads: dict[int, list])` |
| **Interim stream Protection on pre-route-transform batch** when routes diverge | **High** | If Option A | Reject Option A in spec 092 |
| **Context contract drift** (impl vs 091) | **Medium** | Current | Align types in M13.2 PR 1 |
| **Protection override merge complexity** | **Medium** | M13.3 | Spec override algorithm early in M13.3 |
| **Classification vs Protection order change** | **Medium** | M13.4 | Regression tests; pipeline debug route timeline |
| **N × transform cost** | **Medium** | M13.2+ | Shared extract once; batch loader; benchmark |
| **Checkpoint vs route-shaped events** | **Medium** | M13.2 | Checkpoint on shared cursor / raw extract only |
| **Dual-write migration confusion** | **Low** | Transition | Dual-read sufficient without backfill |
| **Wizard/API ahead of runtime** | **Low** | Parallel | Route APIs require effective_config in responses |

---

## 6. Recommended Adjustments

### 6.1 Before M13.2 implementation (spec + design)

| # | Adjustment | Owner |
|---|------------|-------|
| **R1** | Update spec 092 to **remove Option A**; mandate loop relocation + fan-out per-route payloads | Spec |
| **R2** | Publish **context contract addendum** aligning impl with spec 091 §7–§8 field list | Spec 091 patch or 092 appendix |
| **R3** | Define `process_route_pipeline()` staged interface replacing monolithic `process_route()` | M13.2 design |
| **R4** | Document Protection override merge algorithm placeholder for M13.3 | M13.3 prep |
| **R5** | Fix checkpoint rule: cursor advances on shared fetch success; reference events = extracted or stream-fallback transform for metadata only | M13.2 |

### 6.2 M13.2 implementation sequence (recommended)

```text
1. Extend RouteRuntimeContext + SharedBatchContext (R2)
2. Move shared batch build to end of extract/observation phase (pre-mapping)
3. Implement resolve_transform_config + route tables
4. Replace process_route NO-OP with route_transform stage; stub protection/classification/policy NO-OPs
5. Relocate route loop BEFORE _prepare_delivery_events when flag ON
6. Wire stage_results → _fan_out per route
7. Stream-level mapping/enrichment skip when flag ON
8. Parity tests: flag OFF; flag ON no route rows; flag ON divergent routes
```

### 6.3 Do not defer to M13.3

- Loop relocation (if M13.2 per-route transform ships)
- Fan-out per-route wiring
- `extracted_events` semantics

### 6.4 M13.1 spec vs implementation reconciliation

Track in `.specify/specs-index.md` or 091 errata:

- M13.1 **implementation** delivered simplified contexts acceptable for skeleton.
- Full 091 contract is **target** for M13.2 context alignment.

---

## 7. Go / No-Go Decision

### 7.1 M13.1 foundation

| Decision | **GO (complete for foundation milestone)** |
|----------|---------------------------------------------|
| Rationale | Flag OFF parity proven; extension points exist; no irreversible choices |
| Caveat | Document known debt in this review; do not treat impl contexts as final |

### 7.2 M13.2 specification

| Decision | **Conditional GO** |
|----------|---------------------|
| Rationale | Spec 092 is sound, SoT-aligned, engine reuse correct |
| Conditions | Apply adjustments R1–R3 before first M13.2 code PR |

### 7.3 M13.2 implementation start

| Decision | **GO after R1–R3** |
|----------|---------------------|
| Block if | M13.2 starts without loop relocation plan or fan-out wiring plan |
| Do not block on | M13.3 Protection tables, Wizard UI, backfill tool |

### 7.4 M13.3–M13.6 trajectory

| Decision | **GO — no architecture pivot required** |
|----------|------------------------------------------|
| Rationale | Dual-read + staged route pipeline + existing engines sufficient |
| Watch | Protection override merge (M13.3), stage order (M13.4), policy + drift interaction (M13.5), per-route metrics (M13.6) |

---

## Appendix A — Verification checklist (requested items)

| # | Question | Answer |
|---|----------|--------|
| 1 | M13.1 blocker for M13.3–M13.6? | **Soft debt only** — loop order, context fields, fan-out wiring |
| 2 | RouteRuntimeContext complete? | **No** — missing `stream_id`, `effective_config`, `processing_state`, `shared_batch_ref`, `rate_limit` |
| 3 | SharedBatchContext complete? | **No** — missing `extracted_events` semantics, `sensitive_detection_result`, `checkpoint_cursor_before`, full `schema_observation` |
| 4 | M13.2 Transform vs M13.3 Protection conflict? | **No ownership conflict**; **interim runtime order risk** if loop not relocated |
| 5 | Dual-read scales to all four concerns? | **Yes**, with Protection override merge extension |
| 6 | Lifecycle supports full pipeline without redesign? | **Yes conceptually**; **requires M13.2 loop refactor** (not greenfield redesign) |
| 7 | Product Charter Stream/Route model valid? | **Yes** |
| 8 | Debt to fix before M13.2? | **Yes** — R1–R5 above |

---

## Appendix B — Reference architecture (target end state M13.6)

```text
StreamRunner
  SHARED (once)
    fetch → extract → observe → sensitive_detect
    → SharedBatchContext(extracted_events)

  FOR EACH enabled route
    RouteRuntimeContext (effective_config resolved)
    → transform      [M13.2]
    → protection     [M13.3]
    → classification [M13.4]
    → policy         [M13.5]
    → format/send    [existing + M13.6 observability]

  SHARED (once)
    checkpoint
```

---

## Appendix C — Document cross-reference

| SoT statement | Review finding |
|---------------|----------------|
| Route = Destination Specific Processing Unit | Supported by M13.2+ staged pipeline |
| Runtime Reuse First | Honored — no parallel runtime |
| Configuration Scope = Stream, Execution Scope = Route | Dual-read + overrides consistent |
| Union Schema shared across routes | SharedBatchContext carries union_schema |
| No Stream duplication for destination processing | Enabled after M13.2 transform divergence |

---

*End of design review. No code, implementation, migrations, or refactoring performed.*
