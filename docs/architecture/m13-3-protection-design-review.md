# M13.3 Per Route Protection — Design Review

**Status:** SUPERSEDED (historical design review)  
**Superseded By:** [`specs/093-per-route-protection`](../../specs/093-per-route-protection/spec.md)

Design review only — no code, implementation, or migrations  
**Date:** 2026-06-14  
**Scope:** M13.3 spec validation; compatibility with M13.4 (Classification), M13.5 (Policy), M13.6 (Route Runtime Delivery)  
**Inputs:**

| Document | Role |
|----------|------|
| [`specs/091-route-processing-architecture/spec.md`](../specs/091-route-processing-architecture/spec.md) | M13.1 foundation contracts |
| [`specs/092-per-route-transform/spec.md`](../specs/092-per-route-transform/spec.md) | M13.2 transform + pipeline order |
| [`specs/093-per-route-protection/spec.md`](../specs/093-per-route-protection/spec.md) | M13.3 protection (subject of review) |
| [`route-processing-foundation-implementation-spec.md`](route-processing-foundation-implementation-spec.md) | Architecture authority |
| [`m13-route-architecture-design-review.md`](m13-route-architecture-design-review.md) | Prior M13.1/M13.2 review |
| `docs/source-of-truth/` | Product Charter 1.2.1, WBS 1.2.1, UX/Wizard/Governance/Union Schema charters |

---

## 1. Review Summary

Spec 093 is **implementation-ready** for M13.3 scope and **correctly aligned** with Product Charter (*Configuration Scope = Stream*, *Execution Scope = Route*), Governance Workspace `route_overrides[]`, and the prior M13 architecture review finding that Protection requires **base rules + override merge** (not Transform-style full-bundle-only semantics).

**Overall verdict:** M13.3 **does not create hard blockers** for M13.4–M13.6. It **activates a stage slot** that M13.2 already reserves in the correct order. However, **four gaps** should be resolved **before or during M13.3 implementation** to avoid rework for downstream milestones:

1. **Shared-phase schema drift policy** — Spec 093 assumes `ephemeral_protection_rules` on the shared batch; the current flag-ON path skips `_apply_schema_drift_policy()` entirely (legacy path only). Auto Protect and unknown-field ephemeral rules will not exist unless shared phase is extended.
2. **`route_overrides[]` schema generality** — Governance Workspace models overrides with `protection_action` + `delivery_behavior` only. Classification and Policy route overrides need a **documented extension pattern** before M13.4/M13.5 (additive fields, not pipeline redesign).
3. **`effective_config.protection` typing and loader wiring** — Implementation has `protection: Any | None = None` with no resolver; M13.3 must land typed config + `resolve_protection_config()` before stage activation.
4. **Stage order vs legacy OSS** — Target pipeline is Transform → **Protection** → Classification → Policy (Product Charter Core Pipeline, spec 093). Legacy flag-OFF path remains Classification → Protection. M13.4 must explicitly own the reorder semantics and regression tests; M13.3 must not cement Classification-before-Protection in the route pipeline.

**Dual-read + override merge** for Protection scales to future milestones when paired with parallel patterns: `route_classification_rules` + classification overrides, `route_policy_rules` + policy/delivery_behavior overrides. **`route_overrides[]` alone is insufficient** for Classification/Policy without schema extension — but the **pipeline and context model do not require redesign**.

---

## 2. M13.3 Assessment

### 2.1 Spec quality

Spec 093 is thorough, SoT-aligned, and consistent with specs 091/092 and the foundation implementation spec. Strengths:

| Area | Assessment |
|------|------------|
| Engine reuse | Correctly mandates `protect_batch()` / `protect_events_for_delivery()` — no new engine |
| Sensitive Detection | Stream-scoped once; per-route protection consumes shared results |
| Ownership model | Stream defaults + optional `route_protection_rules` + `route_overrides[]` merge — matches Governance Workspace v1.1 §ROUTE GOVERNANCE MODEL |
| Fallback | Route config absent → stream rules — backward compatible |
| Pipeline slot | Replaces M13.2 `protection_stub` inside `process_route_pipeline()` — no parallel runtime |
| Remove action | Explicitly evaluated and deferred — honest gap vs Governance Workspace dropdown |
| Unknown fields | Clear M13.3 vs M13.5 boundary (Auto Protect execution vs Require Review / Quarantine) |
| Non-scope | Classification, Policy, Delivery observability correctly excluded |

### 2.2 Spec vs current implementation (flag ON)

Evidence: `app/runners/stream_runner.py`, `app/runners/route_stage.py`, `app/runners/route_context_builder.py`.

| Deliverable | Spec 093 | Implemented (2026-06-14) | Assessment |
|-------------|----------|----------------------------|------------|
| Route loop before stream Protection/Policy | ✅ Required | ✅ Route branch skips `_prepare_delivery_events()` | **Complete** |
| `process_route_pipeline()` staged order | Transform → Protection → Classification stub → Policy stub | ✅ Stubs in correct order | **Skeleton ready** |
| Per-route fan-out | Protected events per route | ⚠️ Fan-out uses **unprotected** transform output (protection stub) | **Expected until M13.3** |
| `SharedBatchContext.extracted_events` | Pre-mapping raw events | ✅ Populated from extract | **Complete** |
| `sensitive_detection_result` on shared batch | Required | ✅ Passed from runner context | **Complete** |
| Schema drift ephemeral rules on shared batch | Required for Auto Protect | ❌ `_apply_schema_drift_policy()` not called when flag ON | **Gap — pre-M13.3 fix** |
| `effective_config.protection` | Dual-read + merge resolved | ❌ Placeholder `None` | **M13.3 deliverable** |
| `route_overrides[]` persistence/runtime | Required | ❌ Not in DB/API | **M13.3 deliverable** |
| Stream classification in shared phase (flag ON) | N/A — per-route in M13.4 | ❌ Skipped (by design for route path) | **Expected; M13.4 activates stub** |
| Legacy flag OFF | Unchanged | ✅ Stream Protection once | **Complete** |

### 2.3 Protection ownership model (spec 093 §5)

The three-layer model is **sound and future-compatible**:

```text
Layer 1 — Base rule set (dual-read, full-bundle):
  route_protection_rules(route) ?? stream_protection_rules(stream)

Layer 2 — Field override merge (Governance Workspace):
  apply_route_overrides(base, route_overrides[] filtered by route_id)

Layer 3 — Ephemeral Auto Protect (shared batch artifact):
  merge_ephemeral(effective, schema_drift ephemeral rules, route_ctx)
```

**Compatible with Stream default + Route override** for M13.4/M13.5 when each concern uses the same structural pattern (base table dual-read + concern-specific override fields).

### 2.4 Spec ambiguities (minor)

| Item | Issue | Recommendation |
|------|-------|----------------|
| **Governance config storage** | §11.2 lists `route_governance_overrides` OR JSON column — pick one in M13.3 impl plan | Prefer normalized table + JSON mirror for API export |
| **`merge_ephemeral_for_route()`** | Referenced but algorithm less normative than override merge | Add appendix algorithm in spec 093 errata or M13.3 impl plan |
| **Route-aware schema drift override** | §10.3 defers orchestrator route awareness to M13.5 | Accept; document shared batch must carry `schema_drift_policy_result` for M13.5 |
| **Audit Only + delivery_behavior** | Stored together; enforcement split M13.3 vs M13.5 | Correct; M13.5 must read override `delivery_behavior` per route |

---

## 3. Future Milestone Compatibility

### 3.1 Verification matrix (requested items)

#### Q1. Does M13.3 create blockers for Classification, Policy, Delivery?

| Milestone | Blocker? | Rationale |
|-----------|----------|-----------|
| **M13.4 Classification** | **No** (soft prerequisites) | Classification stub follows Protection in `process_route_pipeline()`; M13.3 replaces Protection stub only. M13.4 activates next slot on **protected** route-shaped events. |
| **M13.5 Policy** | **No** (soft prerequisites) | Policy stub follows Classification; `delivery_behavior` on overrides persisted in M13.3 config but enforced in M13.5. |
| **M13.6 Delivery** | **No** | Fan-out already accepts `route_payloads`; M13.3 changes payload content to protected events. M13.6 adds metrics/health on existing send path. |

**Conclusion:** No architecture pivot required. Prerequisites: M13.2 complete, shared-phase drift policy wired, protection resolver implemented.

---

#### Q2. Is Protection ownership compatible with Stream default + Route override for future milestones?

**Yes.**

| Concern | Config pattern (target) | M13.3 establishes |
|---------|-------------------------|-------------------|
| Protection | Stream rules + `route_overrides[].protection_action` + optional `route_protection_rules` | ✅ Normative in spec 093 §5–§6 |
| Classification (M13.4) | `stream_classification_rules` + override field + optional `route_classification_rules` | Same pattern — not yet specified |
| Policy (M13.5) | `stream_policy_rules` + override + optional `route_policy_rules` | Same pattern — `delivery_behavior` already on override model |

Governance UX Charter Route A/B/C example (Audit / Mask / Tokenize) maps directly to override merge without Stream duplication.

---

#### Q3. Can `route_overrides[]` scale to Protection, Classification, Policy without redesign?

**Yes, with schema extension — not pipeline redesign.**

Current Governance Workspace override entry:

```text
route_id
protection_action
delivery_behavior
enabled
```

| Concern | Scale approach | Redesign needed? |
|---------|----------------|------------------|
| **Protection** | Existing fields + merge in protection stage | No |
| **Classification** | Add optional `classification_level` or `classification_action` on same override entry **or** parallel `route_overrides[].classification` block | No — data model only |
| **Policy** | `delivery_behavior` already present; add optional `policy_action` / link to `stream_policy_rules` | No — enforcement in M13.5 |

**Recommendation:** Extend governance override schema to a **unified per-field override record**:

```text
route_override {
  route_id, field_path, enabled,
  protection_action?,      // M13.3
  classification_level?,   // M13.4
  delivery_behavior?,      // M13.5 (shared with governance rule default)
}
```

Each stage reads only its concern fields. Pipeline order unchanged.

**Alternative (also valid):** Separate override arrays per concern (`protection_overrides[]`, `classification_overrides[]`) — slightly more API surface, same runtime shape.

---

#### Q4. Does `process_route_pipeline()` lifecycle remain valid?

**Yes.** Normative order in spec 093 matches spec 092 stubs and Product Charter Core Pipeline (Protection before Classification):

```text
Shared Phase (once)
  Fetch → Extract → Schema Observation → Sensitive Detection
  [+ Schema Drift Policy — required addition when flag ON]

Per Route — process_route_pipeline()
  Transform           [M13.2 — active]
  → Protection        [M13.3 — activates]
  → Classification    [M13.4 — stub today]
  → Policy            [M13.5 — stub today]
  → Delivery handoff  → RouteStageResult → _fan_out()

Shared Phase
  Checkpoint
```

| Validation | Status |
|------------|--------|
| Slot order preserved after M13.3 | ✅ Protection replaces stub; downstream stubs untouched |
| Product Charter alignment | ✅ Protection → Classification → Policy |
| Legacy flag OFF | ⚠️ Still Classification → Protection (pre-route stream path) — intentional dual behavior |
| Dynamic routing / failover | ✅ Operates on reference events post-loop (existing) |

M13.4 must document **classification input = post-protection route events** (may differ from legacy pre-protection classification stamps).

---

#### Q5. Are SharedBatchContext and RouteRuntimeContext sufficient? Missing fields.

**Mostly sufficient.** Typed extensions needed per milestone — not structural redesign.

##### SharedBatchContext — spec 091 vs implemented vs future

| Field | Spec 091 | Implemented | M13.3 need | M13.4+ need |
|-------|----------|-------------|------------|-------------|
| `stream_id`, `batch_id` | ✅ | ✅ | ✅ | ✅ |
| `extracted_events` | ✅ | ✅ | ✅ | ✅ |
| `event_root`, `union_schema` | ✅ | ✅ | ✅ | ✅ |
| `schema_observation` | ✅ | ✅ partial | ✅ | ✅ drift |
| `sensitive_detection_result` | ✅ | ✅ | ✅ | ✅ classification hints |
| `checkpoint_cursor_before` | ✅ | ✅ | ✅ | ✅ |
| `fetch_metadata` | optional | ✅ | ✅ | ✅ M13.6 |
| **`schema_drift_policy_result`** | implied | ❌ | **Required** — ephemeral rules source | **Required** — quarantine signals for M13.5 |
| **`ephemeral_protection_rules`** | implied | ❌ | **Required** — accessor on shared batch | consumed in protection stage |
| `quarantine_batch_signal` | — | ❌ | optional | **M13.5** — route policy consumption |

##### RouteRuntimeContext — spec 091 vs implemented vs future

| Field / group | Implemented | M13.3 need | M13.4+ need |
|---------------|-------------|------------|-------------|
| Identity (`route_id`, `stream_id`, `destination_id`, `enabled`) | ✅ | ✅ | ✅ |
| Delivery (`formatter`, `delivery_policy`, `rate_limit`) | ✅ | ✅ | ✅ M13.6 metrics |
| `effective_config.transform` | ✅ typed | — | — |
| **`effective_config.protection`** | ❌ `Any` placeholder | **Typed `RouteProtectionConfig`** with rules + resolution metadata | — |
| `effective_config.classification` | ❌ placeholder | — | **M13.4 typed config** |
| `effective_config.policy` | ❌ placeholder | — | **M13.5 typed config** |
| `processing_state` | ✅ | ✅ + protection timeline entries | ✅ |
| `shared_batch_ref` | ✅ set at pipeline entry | ✅ | ✅ |
| **`config_resolution.*`** | partial (transform only) | **`protection_source`, `override_count`** | classification_source, policy_source |
| **`audit_only_paths`** | — | **Recommended** — per-route audit-only field set | — |
| **`processing_state.protected_events_ref`** | — | optional | replay/debug |
| Route delivery metrics | — | — | **M13.6** — send latency, success counts |

---

#### Q6. Does Unknown Field Auto Protect conflict with future Policy workflows?

**No fundamental conflict** — boundary split is correct but **shared-phase wiring is incomplete today**.

| Scenario | M13.3 behavior | M13.5 behavior | Conflict? |
|----------|----------------|----------------|-----------|
| Unknown Normal → Pass Through | No protection mutation | No quarantine | No |
| Unknown Sensitive → Auto Protect | Ephemeral mask via protection stage; route may override mode | Continue delivery unless policy overrides | No |
| Unknown Sensitive → Require Review | Optional ephemeral mask (stream policy) | Review queue / hold | No — sequential stages |
| Unknown Sensitive → Quarantine | May mask first (if Auto Protect path) | Quarantine before/at delivery | **Soft** — dual action acceptable if documented (mask then quarantine) |
| Route B Require Review for unknown normal (Governance Policy §21) | No protection | Route-scoped policy evaluation | Requires **route-aware drift override** in M13.5 — additive |

**Risk (soft):** Stream-scoped drift orchestrator today does not evaluate per-route unknown-field policy. M13.3 can apply **route override to ephemeral rule modes**; **route-specific drift policy selection** (Pass Through vs Require Review per route) belongs to **M13.5** with `schema_drift_policy_result` on shared batch + route policy config.

---

#### Q7. Can Require Review / Quarantine be added later without redesign?

**Yes.**

| Capability | Added in | Mechanism |
|------------|----------|-----------|
| Require Review queue | M13.5 | Policy stage reads shared drift signals + route `delivery_behavior` override |
| Quarantine creation | M13.5 | Existing quarantine services + `route_id` dimension |
| Block delivery | M13.5 | Policy stage before delivery handoff — stub already in place |
| Route-aware unknown field policy | M13.5 | Extend policy evaluator with `route_id`; optional drift override table |

M13.3 **must not** implement quarantine/review but **should** persist `delivery_behavior` on overrides and attach `schema_drift_policy_result` to `SharedBatchContext` so M13.5 does not re-run drift detection per route.

---

### 3.2 Cross-milestone dependency graph

```text
M13.2 (Transform + pipeline skeleton)
  ↓ hard prerequisite
M13.3 (Protection stage + governance override merge)
  ↓ enables divergent outbound copies
M13.4 (Classification on protected route events)
  ↓
M13.5 (Policy + delivery_behavior + quarantine)
  ↓
M13.6 (Delivery metrics/health on existing fan-out)
```

No circular dependencies. M13.3 does not block the chain.

---

## 4. Architectural Risks

| Risk | Severity | Likelihood | Impact on M13.4–M13.6 | Mitigation |
|------|----------|------------|-------------------------|------------|
| **Schema drift policy skipped when flag ON** | **High** | Current code | Auto Protect broken; M13.5 quarantine signals missing | Run `_apply_schema_drift_policy()` in shared phase on `extracted_events`; attach result to `SharedBatchContext` **before M13.3** |
| **Field paths after route transform** | **High** | When routes diverge | Protection rules miss renamed fields | Route Preview + effective config validation; document path = post-transform |
| **Override merge complexity** | **Medium** | M13.3 | Wrong effective mode per route | Unit tests for merge; `GET .../protection/effective` debug API |
| **Classification order change** | **Medium** | M13.4 | Legacy vs route semantics differ | M13.4 spec owns reorder; regression matrix flag OFF vs ON |
| **`route_overrides[]` schema too narrow** | **Medium** | M13.4/M13.5 | Rework governance API | Extend override record in M13.3 governance schema (optional null fields) |
| **Tokenization vault stream-scoped** | **Low** | Cross-route tokenize | Same token across routes (usually desired) | Document as intentional; no `route_id` on vault |
| **Remove action deferred** | **Low** | Product expectation | Governance Workspace lists Remove | Document deferral; Mask Full / Transform drop workaround |
| **Dual-write stream protection API** | **Low** | Migration window | Stale route config | Dual-read sufficient for launch; dual-write optional |
| **N × protection cost** | **Medium** | Many routes | Latency | Shared detection O(1); batch rule load; benchmark in M13.6 |
| **Policy quarantine after partial route mask** | **Low** | Edge cases | Confusing operator view | M13.5 timeline shows protection then policy stages per route |

---

## 5. Recommended Adjustments

### 5.1 Before M13.3 implementation (mandatory)

| # | Adjustment | Owner |
|---|------------|-------|
| **R1** | **Shared-phase schema drift policy when flag ON** — call drift orchestrator on `extracted_events`; populate `SharedBatchContext.schema_drift_policy_result` and ephemeral rules | M13.3 impl (prerequisite gate) |
| **R2** | Implement `resolve_protection_config()` + typed `RouteProtectionConfig` on `RouteEffectiveConfig` | M13.3 |
| **R3** | Replace `protection_stub` with `route_protection_stage()` using existing engine | M13.3 |
| **R4** | Persist governance config with `route_overrides[]` (API §12.2) | M13.3 |
| **R5** | Confirm M13.2 gates: fan-out wired, loop before stream governance, transform active | Verify before M13.3 start |

### 5.2 During M13.3 (recommended)

| # | Adjustment | Owner |
|---|------------|-------|
| **R6** | Extend governance override schema with **optional null** `classification_level` and `policy_action` fields for forward compatibility | M13.3 schema design |
| **R7** | Document `merge_ephemeral_for_route()` algorithm (override wins over ephemeral default mode per `field_path`) | Spec 093 errata |
| **R8** | Add `config_resolution.protection_source` and `override_count` to effective config API responses | M13.3 API |
| **R9** | Ensure protection `delivery_logs` include `route_id` | M13.3 observability |

### 5.3 For downstream specs (M13.4–M13.6 prep)

| # | Adjustment | Owner |
|---|------------|-------|
| **R10** | M13.4 spec: classification runs on **post-protection** events; document delta from legacy pre-protection stamps | M13.4 spec |
| **R11** | M13.5 spec: consume `delivery_behavior` from route override; route-aware unknown field policy evaluation | M13.5 spec |
| **R12** | M13.6 spec: per-route delivery metrics from existing `_fan_out()` + `RouteStageResult.stage_timeline` | M13.6 spec |
| **R13** | Unified `resolve_effective_config(route_id, concern)` helper wrapping transform / protection / classification / policy resolvers | M13.3–M13.5 refactor (optional) |

### 5.4 Do not defer past M13.3

- Shared-phase schema drift policy when flag ON (R1)
- Protection resolver + stage activation (R2, R3)
- Fan-out delivering **protected** payloads (part of R3)

---

## 6. Go / No-Go Decision

### 6.1 M13.3 specification (spec 093)

| Decision | **GO** |
|----------|--------|
| Rationale | Spec is SoT-aligned, engine reuse correct, override model matches Governance Workspace, boundaries to M13.4/M13.5 clear |
| Caveat | Apply R1, R6, R7 before or alongside first implementation PR |

### 6.2 M13.3 implementation start

| Decision | **Conditional GO** |
|----------|---------------------|
| Conditions | (1) M13.2 acceptance criteria met in runtime; (2) R1 shared-phase drift policy planned as first M13.3 task; (3) R5 verified |
| Block if | M13.3 starts without drift policy on shared batch when flag ON — Auto Protect and M13.5 signals will be wrong |
| Do not block on | M13.4 Classification tables, M13.5 Policy enforcement, M13.6 metrics, Remove engine mode |

### 6.3 M13.4 / M13.5 / M13.6 trajectory

| Decision | **GO — no architecture pivot required** |
|----------|------------------------------------------|
| Rationale | Pipeline slots, dual-read pattern, and override model extend cleanly |
| Watch | Classification order delta (M13.4), route-aware drift policy (M13.5), override schema extension (M13.3–M13.5) |

---

## Appendix A — Verification checklist (requested items)

| # | Question | Answer |
|---|----------|--------|
| 1 | M13.3 blocker for Classification / Policy / Delivery? | **No hard blockers** — soft prerequisites: shared drift policy, protection resolver, M13.2 complete |
| 2 | Protection ownership compatible with Stream default + Route override? | **Yes** — three-layer model in spec 093 §5 |
| 3 | `route_overrides[]` scale to Protection / Classification / Policy? | **Yes with schema extension** — no pipeline redesign |
| 4 | `process_route_pipeline()` lifecycle valid? | **Yes** — Transform → Protection → Classification → Policy → Delivery |
| 5 | Contexts sufficient? Missing fields? | **Mostly** — see §3.1 Q5; critical gap: `schema_drift_policy_result` / ephemeral rules on shared batch |
| 6 | Unknown Field Auto Protect vs Policy conflict? | **No fundamental conflict** — sequential stages; route drift policy deferred to M13.5 |
| 7 | Require Review / Quarantine later without redesign? | **Yes** — M13.5 on existing policy stub + shared batch signals |
| 8 | Debt to fix before M13.3 implementation? | **R1–R5** — especially shared-phase schema drift when flag ON |

---

## Appendix B — Target end state (post M13.6)

```text
StreamRunner
  SHARED (once)
    fetch → extract → observe → sensitive_detect
    → schema_drift_policy (batch signals + ephemeral rules)
    → SharedBatchContext

  FOR EACH enabled route
    RouteRuntimeContext (effective_config resolved per concern)
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
| Route = Destination Specific Processing Unit | M13.3 enables per-route protected payloads |
| Runtime Reuse First | `protect_batch()` reused; no parallel engine |
| Configuration Scope = Stream, Execution Scope = Route | Dual-read + `route_overrides[]` consistent |
| Governance Workspace Route Override model | Spec 093 merge algorithm aligned; extend schema for M13.4/M13.5 |
| Product Charter Protection → Classification order | Route pipeline correct; legacy flag OFF differs — document in M13.4 |
| Unknown Field Pass Through default | M13.3 does not mutate; M13.5 handles review/quarantine |
| No Stream duplication for destination processing | Achievable after M13.3 when overrides diverge per route |

---

## Appendix D — Related specs

| Spec | Relationship |
|------|--------------|
| `specs/091-route-processing-architecture/spec.md` | Context contracts; lifecycle slots |
| `specs/092-per-route-transform/spec.md` | Hard prerequisite; pipeline order |
| `specs/093-per-route-protection/spec.md` | Subject of this review |
| `specs/066-classification-engine/spec.md` | Engine reuse target for M13.4 |
| `specs/065-protection-engine/spec.md` | Engine reuse for M13.3 |
| `specs/004-delivery-routing/spec.md` | Fan-out, checkpoint |
| `docs/architecture/m13-route-architecture-design-review.md` | Prior review; override merge finding incorporated in spec 093 |

---

*End of M13.3 protection design review. No code, implementation, migrations, or refactoring performed.*
