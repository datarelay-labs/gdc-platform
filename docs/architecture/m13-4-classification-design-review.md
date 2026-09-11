# M13.4 Per Route Classification — Design Review

**Status:** SUPERSEDED (historical design review)  
**Superseded By:** [`specs/094-per-route-classification`](../../specs/094-per-route-classification/spec.md)

Design review only — no code, implementation, or migrations  
**Date:** 2026-06-15  
**Scope:** Spec 094 validation; compatibility with M13.5 (Policy), M13.6 (Route Runtime Delivery)  
**Inputs:**

| Document | Role |
|----------|------|
| [`specs/091-route-processing-architecture/spec.md`](../specs/091-route-processing-architecture/spec.md) | M13.1 foundation contracts |
| [`specs/092-per-route-transform/spec.md`](../specs/092-per-route-transform/spec.md) | M13.2 transform + pipeline order |
| [`specs/093-per-route-protection/spec.md`](../specs/093-per-route-protection/spec.md) | M13.3 protection + governance override pattern |
| [`specs/094-per-route-classification/spec.md`](../specs/094-per-route-classification/spec.md) | M13.4 classification (subject of review) |
| [`route-data-model-review.md`](route-data-model-review.md) | DB pattern confirmation |
| [`m13-3-protection-design-review.md`](m13-3-protection-design-review.md) | Prior M13.3 → M13.4–M13.6 compatibility review |
| [`route-processing-foundation-implementation-spec.md`](route-processing-foundation-implementation-spec.md) | Architecture authority |
| `docs/source-of-truth/` | Product Charter 1.2.1, WBS 1.2.1, UX/Wizard/Governance/Union Schema charters |

---

## 1. Review Summary

Spec 094 is **implementation-ready** for M13.4 scope and **correctly aligned** with Product Charter (*Configuration Scope = Stream*, *Execution Scope = Route*), the established per-route pipeline skeleton (M13.2/M13.3), and the route data model review finding that Classification fits the **additive `route_*` + dual-read list-replacement** pattern.

**Overall verdict:** M13.4 **does not create hard blockers** for M13.5 or M13.6. It **activates a stage slot** that M13.3 already reserves in the correct order (after Protection, before Policy). However, **five gaps** should be resolved **before or during M13.4 implementation** to avoid rework for downstream milestones:

1. **`effective_config.classification` still untyped** — `RouteEffectiveConfig.classification` remains `Any | None` in `app/runners/route_context.py`; M13.4 must land `RouteClassificationConfig` + resolver before stage activation.
2. **Governance override document shape** — Spec 094 canonicalizes flat `streams.config_json.governance.route_overrides[]`; Governance Workspace SoT nests `route_overrides[]` **per field-level Governance Rule**. Runtime must reconcile (flatten at load or nest in JSON) without splitting persistence paths.
3. **Classification override semantics vs Protection** — Protection overrides are **field-path keyed**; Classification override in spec 094 is a **route-level floor** (`max_level` after rule resolution), not per-field. Document clearly for operators and M13.5 to avoid conflating override models.
4. **Legacy vs route stage order delta** — Flag OFF: Classification before Protection; flag ON route path: Classification after Protection. Spec 094 documents this; **regression matrix is mandatory** before ship.
5. **Post-classification policy consumption contract** — Policy engine already reads stamped `classification_level` from events (`classification_levels_from_events()` in `app/protection/policy_engine.py`). M13.4 must ensure stamps exist on **classified route events** before Policy stub is replaced in M13.5; no engine redesign, but `processing_state` should carry `effective_level` for observability.

**Governance storage decision in spec 094 is explicit and sound for near-term milestones:** `streams.config_json.governance.route_overrides[]` is **sufficient through M13.4 and M13.5 MVP**. A normalized `route_governance_overrides` table is **optional hardening post-M13.5**, not a prerequisite for Policy or Delivery.

**Dual-read list-replacement** for Classification scales cleanly to M13.5 Policy (`route_policy_rules` + `delivery_behavior` on same override entries). The **pipeline and context model do not require redesign**.

---

## 2. M13.4 Assessment

### 2.1 Spec quality

Spec 094 is thorough, SoT-aligned, and consistent with specs 091/092/093 and the route data model review. Strengths:

| Area | Assessment |
|------|------------|
| Engine reuse | Correctly mandates `classify_batch()` / `resolve_classification_level()` — forbids `evaluate_batch()` on route path (stream DB query) |
| Sensitive Detection | Stream-scoped once; per-route classification consumes shared findings |
| Ownership model | Stream defaults + optional `route_classification_rules` + governance `classification_level` floor — matches Product Charter route-applicable processing |
| Fallback | Route config absent → stream rules → engine defaults — backward compatible |
| Pipeline slot | Replaces `classification_stub` inside `process_route_pipeline()` — no parallel runtime |
| Stage order | Explicitly owns Protection → Classification on route path; legacy dual behavior documented |
| Governance decision | **Unambiguous:** JSON `route_overrides[]` selected; normalized table deferred |
| Non-scope | Policy, Quarantine, Require Review, M13.6 delivery observability correctly excluded |

### 2.2 Spec vs current implementation (flag ON)

Evidence: `app/runners/stream_runner.py`, `app/runners/route_stage.py`, `app/runners/route_context.py`.

| Deliverable | Spec 094 | Implemented (2026-06-15) | Assessment |
|-------------|----------|--------------------------|------------|
| Route loop before stream Classification/Policy | ✅ Required | ✅ Route branch skips stream `_classify_events()` / `_evaluate_policies()` | **Complete** |
| `process_route_pipeline()` staged order | Transform → Protection → Classification → Policy stub | ✅ Protection active; `classification_stub` NO-OP | **Skeleton ready for M13.4** |
| Shared-phase schema drift when flag ON | Prerequisite (M13.3) | ✅ `_apply_schema_drift_policy()` in `_execute_route_pipeline()` | **Complete** |
| `sensitive_detection_result` on shared batch | Required | ✅ Passed to `SharedBatchContext` | **Complete** |
| `schema_drift_policy_result` on shared batch | M13.5 signal source | ✅ Populated in route path | **Complete** |
| `route_overrides` in shared runtime data | Required | ✅ Loaded from `runtime_stream` | **Partial** — persistence/API may trail |
| `effective_config.protection` | Typed (M13.3) | ✅ `RouteProtectionConfig` wired | **Complete** |
| **`effective_config.classification`** | Typed `RouteClassificationConfig` | ❌ `Any \| None` placeholder | **M13.4 deliverable** |
| **`classification_stub` → active stage** | Required | ❌ Still `classification_stub` pass-through | **M13.4 deliverable** |
| Stream `_classify_events()` when flag ON | Must not run | ✅ Skipped in route processing branch | **Complete** |
| Per-route fan-out with classified events | Required post-M13.4 | ⚠️ Fan-out uses protected events; stamps not yet applied | **Expected until M13.4** |
| Legacy flag OFF | Unchanged | ✅ Stream classification before protection | **Complete** |

### 2.3 Classification ownership model (spec 094 §5)

The three-step model is **sound and future-compatible**:

```text
Layer 1 — Persisted base (dual-read, list-replacement):
  route_classification_rules(route) ?? stream_classification_rules(stream) ?? empty

Layer 2 — Engine resolution (shared findings):
  resolve_classification_level(finding_classes, persisted_rules)
  OR default_level_from_findings() when no rules

Layer 3 — Route governance floor (optional):
  effective_level = max_level(resolved_level, route_overrides[].classification_level)
```

**Compatible with Stream default + Route override** for M13.5 when Policy uses the same structural pattern: base `route_policy_rules` ?? `stream_policy_rules` + `delivery_behavior` on `route_overrides[]`.

**Intentional difference from Protection:** Classification override is **batch-level floor**, not field-path merge. Aligns with spec 066 batch stamp semantics.

### 2.4 Spec ambiguities (minor)

| Item | Issue | Recommendation |
|------|-------|----------------|
| **Flat vs nested `route_overrides[]`** | Spec 094 §7 shows flat `governance.route_overrides[]`; SoT nests overrides under per-field Governance Rule | Document loader flattening algorithm or nested JSON canonical shape in M13.4 impl plan |
| **`field_path` on classification override** | SoT override model has no `classification_level`; spec 094 adds it without `field_path` | Accept as route-level floor; do not require field_path for classification override |
| **`matched_rule_count` at resolve vs stage** | Optional at resolve time | Populate on `stage_timeline` after `classify_batch()` — normative in impl |
| **Engine rule type coupling** | `classify_batch()` typed to `StreamClassificationRule` | Introduce protocol or generic rule entry mapping in M13.4 — algorithm unchanged |

---

## 3. Future Milestone Compatibility

### 3.1 Verification matrix (requested items)

#### Q1. Does M13.4 create blockers for Policy and Delivery?

| Milestone | Blocker? | Rationale |
|-----------|----------|-----------|
| **M13.5 Policy** | **No** (soft prerequisites) | Policy stub follows Classification in `process_route_pipeline()`; M13.4 replaces stub only. Policy engine already evaluates `condition_json.classification_level` against **event stamps** (`policy_engine.py`). Per-route stamps enable per-route policy without redesign. |
| **M13.6 Delivery** | **No** | Fan-out already accepts `route_payloads`; M13.4 changes payload content to **classified** events. M13.6 adds metrics/health on existing send path + `stage_timeline`. Delivery config remains on `routes` table. |

**Conclusion:** No architecture pivot required. Prerequisites: M13.3 complete, classification resolver + stage activation, stream classification guard when flag ON.

---

#### Q2. Is Classification ownership compatible with Stream default + Route override for future milestones?

**Yes.**

| Concern | Config pattern (target) | M13.4 establishes |
|---------|-------------------------|-------------------|
| **Classification** | `stream_classification_rules` + optional `route_classification_rules` + `route_overrides[].classification_level` floor | ✅ Normative in spec 094 §5–§7 |
| **Policy (M13.5)** | `stream_policy_rules` + optional `route_policy_rules` + `route_overrides[].delivery_behavior` | Same list-replacement + override pattern — `delivery_behavior` already on override model (spec 093) |
| **Protection (M13.3)** | Field-path rules + override merge + ephemeral | Complementary — different override granularity |

Governance UX Route A/B/C examples extend to classification level per route without Stream duplication.

---

#### Q3. Is `streams.config_json.governance.route_overrides[]` still sufficient after Transform, Protection, and Classification?

**Yes for M13.4 and M13.5 MVP. Optional normalization later.**

| Concern | Stored in `route_overrides[]` | Stored in concern-specific tables |
|---------|------------------------------|-----------------------------------|
| Transform | N/A (full bundle in `route_mappings` / `route_enrichments`) | ✅ |
| Protection | `protection_action` per route (field context from parent rule or flat entry) | Optional `route_protection_rules` |
| Classification | `classification_level` floor (spec 094 §7.2) | Optional `route_classification_rules` |
| Policy (M13.5) | `delivery_behavior` (enforcement deferred) | Optional `route_policy_rules` |

**Sufficient because:**

1. Override entries are **sparse** — most routes inherit stream defaults; JSON document size stays bounded for typical N routes.
2. Runtime already loads `route_overrides` into `SharedBatchContext.shared_runtime_data` (evidence: `stream_runner.py` `_execute_route_pipeline()`).
3. Spec 094 explicitly defers `route_governance_overrides` table — avoids dual persistence in M13.4 window.

**When dedicated governance storage may be required (post-M13.5):**

| Trigger | Normalized table benefit |
|---------|--------------------------|
| Governance Workspace query-by-route at scale | Indexed `(stream_id, route_id)` lookup |
| Audit trail per override change | Row-level `created_at` / `created_by` |
| Cross-stream governance reporting | SQL aggregations |

**Not a blocker** for M13.5 Policy or M13.6 Delivery. M13.5 spec should **reuse the same JSON store** unless a separate governance hardening milestone authorizes normalization.

**Reconciliation note:** SoT Governance Workspace nests `route_overrides[]` under each **Governance Rule** (field-scoped). Spec 094 uses stream-level `governance.route_overrides[]`. Implementation should either:

- **Option A (recommended):** Persist nested per SoT; loader **flattens** to `{route_id, field_path?, protection_action, classification_level, delivery_behavior, enabled}[]` for runtime merge, or
- **Option B:** Store flat array in JSON with optional `field_path` on each entry.

Either option preserves a **single canonical JSON document** — no second table in M13.4.

---

#### Q4. Can `effective_config.classification` scale to future policy evaluation?

**Yes.**

| Consumer | How it uses classification | Redesign needed? |
|----------|---------------------------|------------------|
| **M13.5 Policy engine** | Reads `classification_level` / `classification_level_gdc` **from stamped events** via `classification_levels_from_events(events)` | **No** — stamps applied in M13.4 stage |
| **M13.5 Policy resolver** | Parallel `RoutePolicyConfig` with `rules[]` + `resolution` — same shape as `RouteClassificationConfig` | **No** — pattern established |
| **M13.5 Quarantine** | Policy `quarantine` action + `schema_drift_policy_result` from shared batch | **No** — independent of classification config object |
| **Dynamic routing** | Already uses `classification_levels_from_events()` on reference events | **No** — route-classified payloads compatible |
| **M13.6 metrics** | `stage_timeline` + optional `RouteStageResult.classification_duration_ms` | **No** — additive fields |

**Recommended extension on `RouteClassificationConfig` / `processing_state` for M13.5 observability:**

```text
processing_state.classification_result:
  effective_level: str
  matched_rule_count: int
  persisted_source: route | stream | empty
  override_applied: bool
```

Policy stage reads **events**, not `effective_config.classification` directly — but debug APIs and governance Route Preview benefit from typed result on context.

---

#### Q5. Does `process_route_pipeline()` lifecycle remain valid?

**Yes.**

```text
Shared Phase (once)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → Schema Drift Policy (flag ON)
  → NO stream Classification when flag ON

Per Route — process_route_pipeline()
  Transform           [M13.2 — active]
  → Protection        [M13.3 — active]
  → Classification    [M13.4 — activates]
  → Policy            [M13.5 — stub today]
  → Delivery handoff  → RouteStageResult → _fan_out() → [M13.6 observability]

Shared Phase
  Checkpoint
```

| Validation | Status |
|------------|--------|
| Slot order preserved after M13.4 | ✅ Classification replaces stub; Policy stub untouched |
| Product Charter alignment | ✅ Protection → Classification → Policy |
| Legacy flag OFF | ⚠️ Classification → Protection (stream path) — intentional |
| Stream Policy skipped when flag ON | ✅ `_evaluate_policies()` not called in route branch — M13.5 activates per-route policy stage |
| Dynamic routing / failover | ✅ Operates on reference events post-loop |

---

#### Q6. Are SharedBatchContext and RouteRuntimeContext sufficient for Policy and Delivery?

**Mostly sufficient.** Typed extensions needed per milestone — not structural redesign.

##### SharedBatchContext — current vs M13.5/M13.6 need

| Field | Implemented | M13.4 need | M13.5 need | M13.6 need |
|-------|-------------|------------|------------|------------|
| `stream_id`, `batch_id` | ✅ | ✅ | ✅ | ✅ |
| `extracted_events` | ✅ | ✅ (transform input) | ✅ | ✅ |
| `event_root`, `union_schema` | ✅ | ✅ | ✅ | ✅ |
| `schema_observation` | ✅ | ✅ | ✅ drift context | ✅ |
| `sensitive_detection_result` | ✅ | ✅ | ✅ policy conditions | ✅ |
| `checkpoint_cursor_before` | ✅ | ✅ | ✅ | ✅ |
| `fetch_metadata` | ✅ | optional | optional | ✅ |
| **`schema_drift_policy_result`** | ✅ | — | **Required** — quarantine/review signals | — |
| `ephemeral_auto_protect_rules` (accessor) | ✅ | — | consumed in protection | — |
| **`quarantine_batch_signal`** | ❌ | — | **Recommended** — route policy consumption without re-parsing drift result | — |
| **`policy_evaluation_result`** | ❌ | — | N/A at shared scope (per-route) | — |

##### RouteRuntimeContext — current vs M13.5/M13.6 need

| Field / group | Implemented | M13.4 need | M13.5 need | M13.6 need |
|---------------|-------------|------------|------------|------------|
| Identity (`route_id`, `stream_id`, `destination_id`, `enabled`) | ✅ | ✅ | ✅ | ✅ |
| Delivery (`formatter`, `delivery_policy`, `rate_limit`) | ✅ | ✅ | ✅ | ✅ metrics source |
| `effective_config.transform` | ✅ typed | — | — | — |
| `effective_config.protection` | ✅ typed | — | — | — |
| **`effective_config.classification`** | ❌ `Any` | **`RouteClassificationConfig`** | — | — |
| **`effective_config.policy`** | ❌ `Any` | — | **`RoutePolicyConfig`** | — |
| `processing_state.current_events` | ✅ | ✅ post-classification | ✅ post-policy | ✅ |
| `processing_state.stage_timeline` | ✅ | + classification entry | + policy entry | ✅ M13.6 |
| **`processing_state.classification_result`** | ❌ | **Recommended** | Policy debug / preview | — |
| **`processing_state.policy_result`** | ❌ | — | **M13.5** — quarantine/block signals | — |
| `shared_batch_ref` | ✅ | ✅ | ✅ | ✅ |
| **`config_resolution.classification_source`** | ❌ | **Recommended** | — | deploy summary |
| **`config_resolution.policy_source`** | ❌ | — | **M13.5** | — |
| `processing_ready`, `readiness_reasons` | ✅ | optional | ✅ deploy gate | ✅ |
| **`RouteStageResult.classification_duration_ms`** | ❌ | **Recommended** | — | **M13.6** |
| **`RouteStageResult.policy_duration_ms`** | ❌ | — | M13.5 | **M13.6** |
| **`routes.processing_metadata_json`** | ❌ | optional | optional | readiness hash |

**Missing fields summary (add before/at downstream milestones):**

```text
M13.4 implementation:
  RouteClassificationConfig (effective_config.classification)
  processing_state.classification_result (optional but recommended)
  config_resolution.classification_source (optional)

M13.5 preparation (not M13.4 blockers):
  RoutePolicyConfig (effective_config.policy)
  processing_state.policy_result
  quarantine_batch_signal on SharedBatchContext (or derive from schema_drift_policy_result)
  nullable route_id on stream_quarantine_events

M13.6 preparation:
  RouteStageResult per-stage duration fields
  Wire stage_timeline → runtime_route_snapshot updater
  routes.processing_metadata_json (optional)
```

---

#### Q7. Can Policy decisions consume Classification findings without redesign?

**Yes.**

Evidence: `app/protection/policy_engine.py`

```text
Policy evaluation inputs (today):
  finding_classes     ← shared Sensitive Detection findings
  classification_levels ← classification_levels_from_events(events)  # reads event stamps

Condition types:
  condition_json.sensitivity_class
  condition_json.classification_level   # additive per spec 066
```

**M13.4 → M13.5 handoff contract (no redesign):**

1. Classification stage stamps `classification_level` or `classification_level_gdc` on **every event** in `processing_state.current_events`.
2. Policy stage passes **same event list** to policy evaluator with **injected rule list** (route dual-read — M13.5 spec).
3. Shared `findings` reused from `SharedBatchContext.sensitive_detection_result` — no re-detection.

**Soft consideration:** Post-protection classification stamps may differ from legacy pre-protection stamps for the same batch (stage order delta). Policy rules keyed on `classification_level` behave consistently **within** each path; cross-path parity is not guaranteed — document in operator docs.

**Quarantine / Require Review:** Policy actions consume classification conditions **and** `schema_drift_policy_result` + `delivery_behavior` override — classification stamps are **necessary but not sufficient** for M13.5 workflows. No redesign of classification output required.

---

### 3.2 Cross-milestone dependency graph

```text
M13.2 (Transform + pipeline skeleton)
  ↓ hard prerequisite
M13.3 (Protection + governance overrides + shared drift)
  ↓ hard prerequisite
M13.4 (Classification on protected route events)
  ↓ enables per-route classification stamps
M13.5 (Policy + delivery_behavior + quarantine)
  ↓
M13.6 (Delivery metrics/health on existing fan-out)
```

No circular dependencies. M13.4 does not block the chain.

---

## 4. Architectural Risks

| Risk | Severity | Likelihood | Impact on M13.5/M13.6 | Mitigation |
|------|----------|------------|-------------------------|------------|
| **`classification_stub` not replaced** | **High** | Pre-M13.4 | Policy evaluates unstamped events — wrong quarantine/audit behavior | M13.4 gate: active stage + AC-5–AC-7 |
| **`effective_config.classification` untyped** | **Medium** | Current | Loader/debug debt; M13.5 pattern inconsistent | `RouteClassificationConfig` in M13.4 PR 1 |
| **Governance JSON flat vs SoT nested overrides** | **Medium** | Implementation | Wrong override merge; wizard/API drift | Document canonical JSON shape + flatten algorithm (§3.1 Q3) |
| **Classification override conflated with field-path protection override** | **Medium** | Operator UX | Misconfigured governance | UI labels: "Route classification floor" vs "Field protection override" |
| **Legacy vs route stage order delta** | **Medium** | Always (dual path) | Operator confusion; false regression bugs | AC-20–AC-22 regression matrix |
| **Engine coupled to `StreamClassificationRule` ORM** | **Medium** | Current code | Route rules require refactor | Rule entry protocol in M13.4 — map `RouteClassificationRule` → engine input |
| **`evaluate_batch()` accidentally called on route path** | **Medium** | Implementation mistake | Stream rules used for all routes — defeats M13.4 | AC-18; code review gate |
| **Governance `route_overrides[]` persistence incomplete** | **Medium** | M13.3 trailing work | Classification floor + Policy `delivery_behavior` unrunnable | Complete M13.3 governance API before M13.4 override floor |
| **Shared findings vs post-protection event shape** | **Low** | Edge cases | Classification level driven by findings, not masked values — usually correct | Document in Route Preview |
| **JSON governance document growth** | **Low** | Many routes × many overrides | Slow stream load | Defer normalized table to post-M13.5; monitor document size |
| **N × classification cost** | **Low** | Many routes | Latency | Shared findings O(1); batch rule load; benchmark in M13.6 |
| **Policy quarantine without per-route `route_id`** | **Medium** | M13.5 | Stream-only quarantine rows | Plan nullable `route_id` in M13.5 — not M13.4 blocker |

---

## 5. Recommended Adjustments

### 5.1 Before M13.4 implementation (mandatory)

| # | Adjustment | Owner |
|---|------------|-------|
| **R1** | Confirm M13.3 gates: protection active, protected fan-out, shared drift wired | Verify before M13.4 start |
| **R2** | Implement `resolve_classification_config()` + typed `RouteClassificationConfig` on `RouteEffectiveConfig` | M13.4 |
| **R3** | Replace `classification_stub` with `route_classification_stage()` using `classify_batch()` + injected rules | M13.4 |
| **R4** | Guard stream `_classify_events()` when `GDC_ROUTE_PROCESSING_ENABLED=true` | M13.4 (verify existing guard) |
| **R5** | Document governance JSON canonical shape: nested per SoT vs flat — pick one for persistence; define loader flattening | M13.4 design |

### 5.2 During M13.4 (recommended)

| # | Adjustment | Owner |
|---|------------|-------|
| **R6** | Add `processing_state.classification_result` with `effective_level`, `matched_rule_count` | M13.4 |
| **R7** | Extend `RouteStageResult` with `classification_duration_ms`, `classification_level` | M13.4 / M13.6 prep |
| **R8** | Rule entry protocol for `classify_batch()` — decouple from `StreamClassificationRule` ORM type | M13.4 |
| **R9** | Route classification APIs + effective config endpoint (spec 094 §12) | M13.4 |
| **R10** | Regression matrix: flag OFF vs ON stage order + stamp parity cases | M13.4 tests |

### 5.3 For downstream specs (M13.5–M13.6 prep)

| # | Adjustment | Owner |
|---|------------|-------|
| **R11** | M13.5 spec: `RoutePolicyConfig` + `route_policy_stage()`; consume stamped events + `schema_drift_policy_result` + `delivery_behavior` | M13.5 spec |
| **R12** | M13.5 spec: nullable `route_id` on quarantine; `quarantine_batch_signal` on shared batch or documented derivation | M13.5 spec |
| **R13** | M13.6 spec: per-route stage durations from `stage_timeline` → `runtime_route_snapshot` | M13.6 spec |
| **R14** | Unified `resolve_effective_config(route_id, concern)` wrapping all four resolvers | M13.4–M13.5 refactor (optional) |
| **R15** | Post-M13.5 governance hardening: evaluate `route_governance_overrides` table if JSON query/audit insufficient | Future milestone |

### 5.4 Do not defer past M13.4

- Classification resolver + stage activation (R2, R3)
- Stream classification guard when flag ON (R4)
- Stage order regression matrix (R10)
- Governance JSON shape decision (R5)

---

## 6. Go / No-Go Decision

### 6.1 M13.4 specification (spec 094)

| Decision | **GO** |
|----------|--------|
| Rationale | Spec is SoT-aligned, engine reuse correct, governance storage decision explicit, boundaries to M13.5/M13.6 clear, route data model review confirmed |
| Caveat | Apply R5 (governance JSON shape), R6–R8 before or alongside first implementation PR |

### 6.2 M13.4 implementation start

| Decision | **Conditional GO** |
|----------|---------------------|
| Conditions | (1) M13.3 acceptance criteria met in runtime; (2) R1 verified; (3) R5 governance JSON shape documented |
| Block if | M13.4 starts without M13.3 protection active on route path — classification input must be post-protection events |
| Do not block on | M13.5 Policy tables, M13.6 metrics, `route_governance_overrides` normalized table |

### 6.3 M13.5 / M13.6 trajectory

| Decision | **GO — no architecture pivot required** |
|----------|------------------------------------------|
| Rationale | Pipeline slots, dual-read pattern, JSON governance overrides, and event-stamp policy consumption extend cleanly |
| Watch | Policy quarantine `route_id` (M13.5), governance JSON scale (post-M13.5), per-route metrics wiring (M13.6) |

---

## Appendix A — Verification checklist (requested items)

| # | Question | Answer |
|---|----------|--------|
| 1 | M13.4 blocker for Policy / Delivery? | **No hard blockers** — soft prerequisites: typed config, active stage, stamped events for policy |
| 2 | Classification ownership compatible with Stream default + Route override? | **Yes** — three-layer model in spec 094 §5 |
| 3 | `route_overrides[]` sufficient after Transform + Protection + Classification? | **Yes for M13.4–M13.5 MVP** — normalized table optional post-M13.5 |
| 4 | `effective_config.classification` scales to policy evaluation? | **Yes** — policy reads event stamps; parallel `RoutePolicyConfig` pattern for M13.5 |
| 5 | `process_route_pipeline()` lifecycle valid? | **Yes** — Transform → Protection → Classification → Policy → Delivery |
| 6 | Contexts sufficient? Missing fields? | **Mostly** — see §3.1 Q6; critical: `RouteClassificationConfig`, optional `classification_result`, M13.5 `RoutePolicyConfig` |
| 7 | Policy consume classification without redesign? | **Yes** — `classification_levels_from_events()` on stamped route events |
| 8 | Debt to fix before M13.4 implementation? | **R1–R5** — especially M13.3 complete, typed config, governance JSON shape, active stage |

---

## Appendix B — Target end state (post M13.6)

```text
StreamRunner
  SHARED (once)
    fetch → extract → observe → sensitive_detect → schema_drift_policy
    → SharedBatchContext (extracted_events, findings, drift_result)

  FOR EACH enabled route
    RouteRuntimeContext (effective_config: transform, protection, classification, policy)
    → transform      [M13.2]
    → protection     [M13.3]
    → classification [M13.4]
    → policy         [M13.5]
    → format/send    [existing + M13.6 observability]

  SHARED (once)
    checkpoint
```

---

## Appendix C — Source of Truth cross-reference

| SoT statement | Review finding |
|---------------|----------------|
| Route-applicable Classification (Product Charter §Core Pipeline) | Spec 094 activates per-route stage after Protection |
| Configuration Scope = Stream; Execution Scope = Route (Governance UX v1.1) | Dual-read + `route_overrides[]` consistent |
| `route_overrides[]` on Governance Rule (Workspace v1.1) | Reconcile nested SoT vs flat spec 094 JSON — R5 |
| Runtime Reuse First / No Parallel Pipeline | `classify_batch()` reuse — no new engine |
| WBS M13.4 Per Route Classification | Spec 094 delivers scope; M13.5/M13.6 not blocked |
| WBS Route Classification Visibility | Frontend §13 conceptual — trails runtime acceptable |

---

*End of design review. No code, implementation, migrations, or refactoring performed.*
