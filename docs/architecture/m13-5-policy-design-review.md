# M13.5 Per Route Policy — Design Review

**Status:** SUPERSEDED (historical design review)  
**Superseded By:** [`specs/095-per-route-policy`](../../specs/095-per-route-policy/spec.md)

Design review only — no code, implementation, or migrations  
**Date:** 2026-06-16  
**Scope:** Spec 095 validation; compatibility with M13.6 (Route Runtime Delivery)  
**Inputs:**

| Document | Role |
|----------|------|
| [`specs/091-route-processing-architecture/spec.md`](../specs/091-route-processing-architecture/spec.md) | M13.1 foundation contracts |
| [`specs/092-per-route-transform/spec.md`](../specs/092-per-route-transform/spec.md) | M13.2 transform + pipeline order |
| [`specs/093-per-route-protection/spec.md`](../specs/093-per-route-protection/spec.md) | M13.3 protection + governance override pattern |
| [`specs/094-per-route-classification/spec.md`](../specs/094-per-route-classification/spec.md) | M13.4 classification + M13.5 handoff §10.6 |
| [`specs/095-per-route-policy/spec.md`](../specs/095-per-route-policy/spec.md) | M13.5 policy (subject of review) |
| [`route-data-model-review.md`](route-data-model-review.md) | DB pattern confirmation |
| [`m13-4-classification-design-review.md`](m13-4-classification-design-review.md) | Prior M13.4 → M13.5/M13.6 compatibility review |
| [`m13-3-protection-design-review.md`](m13-3-protection-design-review.md) | Governance JSON + drift signal lineage |
| [`route-processing-foundation-implementation-spec.md`](route-processing-foundation-implementation-spec.md) | Architecture authority |
| `docs/source-of-truth/` | Product Charter 1.2.1, WBS 1.2.1, UX/Wizard/Governance/Union Schema charters |

---

## 1. Review Summary

Spec 095 is **implementation-ready** for M13.5 scope and **correctly aligned** with Product Charter (*Configuration Scope = Stream*, *Execution Scope = Route*), the established per-route pipeline (M13.2–M13.4), M13.4 → M13.5 handoff (Policy consumes stamped events only), and the route data model review finding that Policy fits the **additive `route_*` + dual-read list-replacement** pattern.

**Overall verdict:** M13.5 **does not create hard blockers** for M13.6 Route Runtime Delivery, Route Metrics, Route Health, or Route Observability. It **activates the final governance stage slot** before delivery handoff and emits the typed results M13.6 needs (`policy_result`, `delivery_allowed`, stage durations, per-route audit). However, **seven gaps** should be resolved **before or during M13.5 implementation** to avoid rework for M13.6 and operations:

1. **`effective_config.policy` still untyped** — `RouteEffectiveConfig.policy` remains `Any | None` in `app/runners/route_context.py`; M13.5 must land `RoutePolicyConfig` + resolver before stage activation.
2. **Fan-out does not gate on policy decision** — `_fan_out()` today includes all routes from `route_payloads` regardless of quarantine/block; M13.5 must add `delivery_allowed` on `RouteStageResult` and filter send map (spec 095 §13.4).
3. **Route-aware schema drift evaluation underspecified** — `derive_review_signal()` / `derive_quarantine_signal()` with `route_id` are referenced in §5.2 but not normatively defined; shared drift is stream-scoped — per-route divergence requires explicit algorithm before implementation.
4. **`stream_quarantine_events` lacks `route_id` column** — Model is stream-only today (`app/quarantine/models.py`); nullable FK is a **hard prerequisite** for route-attributed quarantine, not optional polish.
5. **Policy engine ORM coupling** — `evaluate_batch()` in `app/protection/policy_engine.py` likely queries `stream_policy_rules` by `stream_id`; route path must inject resolved rules via adapter (same pattern as M13.4 classification).
6. **Governance override conflict resolution** — Spec uses `first normalized(delivery_behavior …)` when multiple override entries match a route; nested SoT vs flat JSON reconciliation inherited from M13.4 must be normative for policy enforcement.
7. **Require Review MVP semantics vs M13.6 metrics** — §10.3 allows delivery with `review_required` audit; M13.6 must distinguish *delivered-with-review-flag* vs *held* in metrics — spec should document event disposition for observability.

**Governance storage decision in spec 095 is explicit and sound:** `streams.config_json.governance.route_overrides[]` remains **sufficient through M13.5 MVP** for Protection, Classification, and Policy override fields. A normalized `route_governance_overrides` table is **optional hardening post-M13.5**, not a prerequisite for Delivery observability.

**Dual-read list-replacement** for Policy scales to Audit, Review, Quarantine, and Delivery gating without `RoutePolicyConfig` redesign. The **pipeline and context model do not require redesign** for M13.6.

---

## 2. M13.5 Assessment

### 2.1 Spec quality

Spec 095 is thorough, SoT-aligned, and consistent with specs 091–094 and the route data model review. Strengths:

| Area | Assessment |
|------|------------|
| Engine reuse | Correctly mandates `evaluate_batch()` / `evaluate_event()` with injected rules — forbids stream DB query on route path |
| Prior-stage consumption | §9 explicitly forbids re-running Classification, Protection, Sensitive Detection, or schema drift orchestrator per route |
| M13.4 handoff | Inherits spec 094 §10.6 without modification — policy reads event stamps + shared findings |
| Ownership model | Stream defaults + optional `route_policy_rules` + `route_overrides[].delivery_behavior` + shared drift signals — matches Product Charter |
| Decision merge | Precedence `quarantine > block > require_review > audit > allow` — sufficient for delivery gating |
| Quarantine | Nullable `route_id` on existing table — preserves legacy rows and release flows |
| Non-scope | M13.6 delivery observability redesign correctly excluded; partial audit/UI acceptable |
| Governance decision | **Unambiguous:** JSON `route_overrides[]` selected; normalized table deferred |

### 2.2 Spec vs current implementation (flag ON)

Evidence: `app/runners/stream_runner.py`, `app/runners/route_stage.py`, `app/runners/route_context.py`, `app/quarantine/models.py`.

| Deliverable | Spec 095 | Implemented (2026-06-16) | Assessment |
|-------------|----------|--------------------------|------------|
| Route loop before stream Policy | ✅ Required | ✅ Route branch skips `_evaluate_policies()` | **Complete** |
| `process_route_pipeline()` staged order | Transform → Protection → Classification → Policy | ✅ Through Classification active; `policy_stub` NO-OP | **Skeleton ready for M13.5** |
| M13.4 classification stamps on events | Prerequisite | ✅ `route_classification_stage()` active | **Complete** |
| `SharedBatchContext.schema_drift_policy_result` | Required | ✅ Populated in route path | **Complete** |
| `sensitive_detection_result` on shared batch | Required | ✅ Available | **Complete** |
| `route_overrides` in shared runtime data | Required | ✅ Loaded into `shared_runtime_data` | **Partial** — `delivery_behavior` enforcement not wired |
| **`effective_config.policy`** | Typed `RoutePolicyConfig` | ❌ `Any \| None` placeholder | **M13.5 deliverable** |
| **`policy_stub` → active stage** | Required | ❌ Still `policy_stub` pass-through | **M13.5 deliverable** |
| **`RouteStageResult.delivery_allowed`** | Required | ❌ Field absent | **M13.5 deliverable** |
| **`RouteStageResult.policy_result`** | Required | ❌ Field absent | **M13.5 deliverable** |
| Fan-out policy gate | Blocked/quarantined routes excluded | ❌ All `route_payloads` sent | **M13.5 deliverable** |
| Quarantine `route_id` column | Nullable FK | ❌ Not on `stream_quarantine_events` | **M13.5 migration** |
| `route_policy_rules` table | Additive | ❌ Not migrated | **M13.5 migration** |
| Policy metrics on loop summary | AC-26 | ❌ `RouteProcessingMetrics` has no policy fields | **M13.5 / M13.6 prep** |
| Legacy flag OFF | Unchanged | ✅ Stream policy after stream protection | **Complete** |

### 2.3 Policy ownership model (spec 095 §5)

The five-step model is **sound and M13.6-compatible**:

```text
Layer 1 — Persisted base (dual-read, list-replacement):
  route_policy_rules(route) ?? stream_policy_rules(stream) ?? empty

Layer 2 — Engine evaluation (shared findings + event stamps):
  evaluate_batch(rules, events, findings)   # injected rules — no stream DB query

Layer 3 — Shared drift signals (route-aware evaluation at stage):
  derive_review_signal / derive_quarantine_signal(drift_result, route_id, overrides)

Layer 4 — Governance delivery_behavior override:
  merge_decision(policy_result, override_delivery_behavior, drift signals)

Layer 5 — Enforce:
  allow → fan-out; block/quarantine/review → omit route from send + audit/quarantine record
```

**Compatible with Stream default + Route override** for all four governance concerns. Override granularity differs by design (field-path protection vs route-level classification floor vs route-level delivery behavior) — spec 095 §5.3 documents this explicitly.

### 2.4 Spec ambiguities (minor — resolve in implementation plan)

| Item | Issue | Recommendation |
|------|-------|----------------|
| **Route-aware drift derivation** | §5.2 Step 3 references `derive_*_signal(drift_result, route_id=R, overrides)` without normative algorithm | Add appendix algorithm: stream drift policy produces batch signals; route `delivery_behavior` / future per-route drift override escalates per route |
| **Multiple `delivery_behavior` overrides per route** | §7.1 uses `first normalized(...)` | Document tie-break: highest restriction wins, or most recently enabled entry — pick one |
| **Require Review + delivery** | §10.3: events *may still deliver* with audit | M13.6 metrics must tag `review_required` deliveries separately from `delivery_blocked` |
| **Quarantine payload shape** | §13.1: `current_events = []` vs retain for quarantine record | Normative: always snapshot classified events to quarantine row; fan-out receives empty |
| **`policy_evaluation_enabled()` flag name** | §13.1 references `GDC_POLICY_ENABLED or equivalent` | Align with existing kill-switch name in codebase before impl |
| **Block action on `stream_policy_rules`** | Engine today supports `audit_only`, `quarantine` — block may be governance-only | Confirm `block` is merge-time decision from `delivery_behavior`, not new `action_type` unless engine extended |

---

## 3. M13.6 Compatibility

### 3.1 Verification matrix — blockers for downstream milestones

#### Q1. Does M13.5 create blockers for Route Runtime Delivery, Route Metrics, Route Health, Route Observability?

| Milestone | Blocker? | Rationale |
|-----------|----------|-----------|
| **Route Runtime Delivery (M13.6)** | **No** | Delivery config already on `routes` (formatter, failure policy, rate limit). M13.5 adds **gating** before existing format/send — M13.6 extends observability on unchanged send path. Spec 095 explicitly excludes delivery redesign. |
| **Route Metrics (M13.6)** | **No** | Spec defines `route_policy_count`, `route_policy_duration_ms`, `route_policy_blocked_count` (AC-26); `RouteStageResult.policy_duration_ms` recommended. `RouteProcessingMetrics` already carries transform/protection/classification counters — policy fields are **additive**. |
| **Route Health (M13.6)** | **No** | `runtime_route_snapshot` exists per route data model review §1.5. Policy outcomes (blocked/quarantine rate) feed health via M13.6 wiring from `stage_timeline` + `policy_result` — no schema redesign. |
| **Route Observability (M13.6)** | **No** | `delivery_logs` extension with `route_id` + policy stages (`policy_complete`, `policy_blocked`, `policy_quarantine`, `policy_review_required`) prepares M13.6 dashboards. Partial Governance Dashboard route breakdown is acceptable per spec §16.3. |

**Conclusion:** No architecture pivot required for M13.6. M13.5 **enables** per-route delivery observability by producing typed `RoutePolicyResult` and `delivery_allowed` before fan-out. M13.6 work is **extend metrics/health on existing tables**, not replace policy stage.

**Soft dependency:** M13.6 spec should document disposition taxonomy:

```text
delivered | delivered_review_required | blocked | quarantined | skipped_disabled
```

so health panels do not mis-count Require Review deliveries as failures.

---

#### Q2. Is Policy ownership model compatible with Stream default + Route override for future milestones?

**Yes.**

| Concern | Config pattern | M13.5 establishes |
|---------|----------------|-------------------|
| **Transform (M13.2)** | `route_mappings` / `route_enrichments` ?? stream bundle | Independent — policy does not own transform |
| **Protection (M13.3)** | Stream rules + field `route_overrides[].protection_action` + optional `route_protection_rules` | Policy **does not consume** protection overrides — events already protected |
| **Classification (M13.4)** | Stream rules + `route_overrides[].classification_level` floor + optional `route_classification_rules` | Policy **consumes stamps only** — override not re-read in policy stage |
| **Policy (M13.5)** | `stream_policy_rules` + `route_overrides[].delivery_behavior` + optional `route_policy_rules` + shared drift | ✅ Normative in spec 095 §5–§8 |

Product Charter Route A/B/C examples (Continue / Quarantine / Block per destination) map directly to `delivery_behavior` + optional route rule sets without Stream duplication.

---

#### Q3. Is `streams.config_json.governance.route_overrides[]` still sufficient after Protection, Classification, and Policy?

**Yes for M13.5 MVP and M13.6 delivery observability. Optional normalization later.**

| Concern | `route_overrides[]` field | Concern-specific table |
|---------|---------------------------|------------------------|
| Protection | `protection_action`, optional `field_path` | `route_protection_rules` |
| Classification | `classification_level` (route floor) | `route_classification_rules` |
| Policy | `delivery_behavior` | `route_policy_rules` |
| Transform | N/A | `route_mappings` / `route_enrichments` |

**Sufficient because:**

1. Override entries are **sparse** — typical streams have few per-route divergences; JSON document size bounded.
2. Runtime already loads `route_overrides` into `SharedBatchContext.shared_runtime_data` (evidence: `process_route_pipeline()` passes overrides to protection and classification stages).
3. Specs 093, 094, 095 **consistently defer** `route_governance_overrides` normalized table.
4. Each concern reads **only its fields** from the same entry — no cross-concern merge collision at storage layer.

**When dedicated governance storage may be required (post-M13.5):**

| Trigger | Benefit |
|---------|---------|
| Governance Workspace query-by-route at scale | Indexed `(stream_id, route_id)` |
| Override change audit trail | Row-level `created_at` / `created_by` |
| Cross-stream governance reporting | SQL aggregations |

**Not a blocker** for M13.6. M13.6 consumes **runtime outcomes** (`policy_result`, `delivery_logs`, `stage_timeline`), not governance document shape.

**Reconciliation note (inherited from M13.4):** Governance Workspace SoT may nest `route_overrides[]` under per-field Governance Rules. Loader must flatten to canonical runtime shape — single JSON document, no second persistence path.

---

#### Q4. Can `RoutePolicyConfig` scale to Audit, Review, Quarantine, and Delivery decisions without redesign?

**Yes.**

| Capability | `RoutePolicyConfig` / `RoutePolicyResult` support | Redesign needed? |
|------------|---------------------------------------------------|------------------|
| **Audit** | `decision=audit`; additive audit via `delivery_logs` `policy_complete` | **No** — audit is non-blocking per §10.2 |
| **Review** | `review_required` on result; `resolution.drift_review_required`; `delivery_behavior=require_review` | **No** — merge precedence handles escalation |
| **Quarantine** | `decision=quarantine`; `quarantine_recorded`; `delivery_blocked` | **No** — nullable `route_id` on quarantine row |
| **Delivery allow/block** | `delivery_allowed` on `RouteStageResult`; fan-out filter | **No** — terminal gate before handoff |
| **Debug / effective config API** | `rules[]`, `resolution`, `override_delivery_behavior` | **No** — parallel to `RouteClassificationConfig` |
| **M13.6 metrics** | `policy_duration_ms`, blocked counts, decision enum on timeline | **No** — additive fields |

`RoutePolicyConfig.empty` correctly treats drift gates as non-empty even without persisted rules — supports drift-only quarantine/review without rule table rows.

**Extension point (post-M13.5, no redesign):** Additional `policy_batch_result` reference on `RoutePolicyResult` for rich audit metadata already specified in §6.0.

---

#### Q5. Does `process_route_pipeline()` lifecycle remain valid?

**Yes.**

```text
Shared Phase (once)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → Schema Drift Policy
  → NO stream-level Policy when flag ON

Per Route — process_route_pipeline()
  Transform           [M13.2 — active]
  → Protection        [M13.3 — active]
  → Classification    [M13.4 — active]
  → Policy            [M13.5 — activates]
  → Delivery handoff  → RouteStageResult → _fan_out() [+ M13.6 observability]

Shared Phase
  Checkpoint
```

| Validation | Status |
|------------|--------|
| Slot order after M13.5 | ✅ Policy replaces stub; delivery handoff follows |
| Product Charter alignment | ✅ Protection → Classification → Policy → Delivery |
| Legacy flag OFF | ⚠️ Classification before Protection; Policy after Protection — intentional dual path |
| Stream `_evaluate_policies()` skipped when flag ON | ✅ Required; M13.5 activates per-route stage |
| Independent per-route gating | ✅ Route B quarantine does not block Route A — spec §4.5 |
| Checkpoint semantics | ✅ Stream-scoped cursor unchanged — blocked routes do not affect checkpoint rule |

---

#### Q6. Can Policy consume classification_result, classification levels, sensitive findings, and schema drift results without rerunning engines?

**Yes — with one implementation obligation.**

| Input | Source | Re-run forbidden? | Spec reference |
|-------|--------|-------------------|----------------|
| Classification levels | `classification_levels_from_events(current_events)` on M13.4 stamps | **Yes** | §9.1, §9.3 |
| Classification result metadata | `RouteStageResult.classification_result` / `processing_state.classification_result` | Optional observability | §9.1 |
| Sensitive findings | `SharedBatchContext.sensitive_detection_result` → `findings_from_context()` | **Yes** | §9.1 |
| Schema drift result | `SharedBatchContext.schema_drift_policy_result` | **Yes** | §9.1, §7.1 Step C |
| Protected event shape | `processing_state.current_events` post-classification | **Yes** | §9.2 |

Evidence alignment: `app/protection/policy_engine.py` already uses `classification_levels_from_events(events)` and finding classes in `evaluate_batch()`.

**Implementation obligation:** Route path must call `evaluate_batch(rules=injected, events=..., findings=...)` — **not** the stream-scoped wrapper that queries `stream_policy_rules` by `stream_id`.

**Route-aware drift (soft gap):** Shared `schema_drift_policy_result` is computed **once** at stream scope. Per-route divergence for unknown-field Require Review / Quarantine (Governance Policy §21) is achieved by **route policy stage** interpreting the same drift artifact with `route_id` + `delivery_behavior` override — **not** by re-running `apply_schema_drift_policy_to_batch()` per route. Algorithm for `derive_drift_gates(drift, route_id, overrides)` must be specified in M13.5 implementation plan (see §2.4).

---

#### Q7. Is nullable `route_id` on `stream_quarantine_events` sufficient for release, audit, visibility, operations?

**Yes — with API and UI extensions specified in spec 095 §11.3–§11.4.**

| Operation | `route_id=NULL` (legacy) | `route_id` set (flag ON) | Sufficient? |
|-----------|--------------------------|--------------------------|-------------|
| **Release** | Existing stream quarantine release | `release_delivery` with route context — evidence in `app/quarantine/release_delivery.py` already passes `route_id` at send time | ✅ — column enables **filtering** quarantine rows per route |
| **Audit** | Stream-scoped audit trail | `metadata_json` + `route_id` column for queryable attribution | ✅ — spec rejects metadata-only (§11.1) |
| **Visibility** | Stream quarantine list | Filter `GET .../quarantine?route_id=` + route name in UI | ✅ — spec §15.2 |
| **Operations** | Operator release/discard at stream level | Per-route quarantine without affecting sibling routes on same stream | ✅ — core product goal of per-route policy |

**Legacy compatibility:** `route_id=NULL` rows from flag OFF path remain valid; no backfill required.

**Not sufficient alone:** `metadata_json.route_id` without column — spec correctly rejects (route data model review D6). Indexed nullable FK required for Governance Extension queries.

---

### 3.2 Cross-milestone dependency graph

```text
M13.2 (Transform + pipeline skeleton)
  ↓
M13.3 (Protection + shared drift + governance overrides)
  ↓
M13.4 (Classification stamps + handoff contract)
  ↓
M13.5 (Policy + delivery gate + route quarantine)
  ↓
M13.6 (Delivery metrics/health/observability on gated fan-out)
```

No circular dependencies. M13.5 does not block M13.6; it **produces** the policy dimension M13.6 observability consumes.

---

## 4. Quarantine Review

### 4.1 Design decision assessment

Spec 095 §11 adopts **nullable `route_id` on `stream_quarantine_events`** — consistent with route data model review D6 and M13.4 design review R12. **Correct decision** — avoids duplicate quarantine table and preserves existing release/discard semantics.

### 4.2 Recording contract

| Aspect | Assessment |
|--------|------------|
| Payload snapshot | Classified + protected events at quarantine time — correct for operator review |
| `quarantine_source=policy` | Distinguishes from manual and drift-only sources |
| `metadata_json` enrichment | `destination_id`, matched policies, classification level — supports audit without raw sensitive payload |
| Per-route isolation | Route B quarantine does not create stream-wide hold — enables partial fan-out |

### 4.3 Gaps

| Gap | Severity | Mitigation |
|-----|----------|------------|
| Column not migrated yet | **High** | M13.5 Step B — before `route_policy_stage()` records quarantine |
| List API lacks `route_id` filter | **Medium** | Extend GET quarantine per spec §15.2 |
| Release targets all routes on stream today? | **Medium** | Verify release flow uses quarantine row's `route_id` when re-delivering |
| Drift quarantine vs policy quarantine attribution | **Low** | Both use same table; `quarantine_reason` + `metadata_json` distinguish source |

### 4.4 Verdict

Nullable `route_id` is **architecturally sufficient** for M13.5 and **compatible with M13.6** operations dashboards. Implementation must land column + recording + list filter as a single M13.5 gate — not deferred to M13.6.

---

## 5. Audit Review

### 5.1 Delivery logs extension

Spec 095 §12.1 defines per-route policy audit stages — **aligned** with existing `delivery_logs` pipeline and constitution (structured failures, no full sensitive payload).

| Stage | When | M13.6 use |
|-------|------|-----------|
| `policy_complete` | Evaluation finished, delivery allowed or audit-only | Success rate / latency |
| `policy_blocked` | `delivery_blocked` true | Blocked route count |
| `policy_quarantine` | Quarantine recorded | Quarantine rate by route |
| `policy_review_required` | Require Review signal | Review backlog proxy until M19 UI |

### 5.2 RouteStageResult and stage_timeline

`policy_result` + timeline entry with `decision`, `matched_policy_count`, `duration_ms` — **direct input** for M13.6 `stage_timeline` → `runtime_route_snapshot` wiring (route data model review R9).

### 5.3 Flag OFF vs flag ON

| Path | Audit scope |
|------|-------------|
| Flag OFF | Stream-level policy audit — unchanged |
| Flag ON | **N policy audit records per batch** (one per enabled route) — M13.6 must aggregate per `route_id` |

### 5.4 Verdict

Audit model **scales to M13.6** without redesign. Recommend M13.5 implementation include `persisted_source` and `delivery_behavior_override` on every policy log row for effective-config debugging.

---

## 6. Architectural Risks

| Risk | Severity | Likelihood | Impact on M13.6 | Mitigation |
|------|----------|------------|-----------------|------------|
| **`policy_stub` not replaced** | **High** | Pre-M13.5 | All routes deliver regardless of governance; false health signals | M13.5 gate: active stage + AC-4–AC-6 |
| **No fan-out gate (`delivery_allowed`)** | **High** | Current code | Quarantine/block ineffective; M13.6 metrics wrong | Filter `route_payloads` per spec §13.4 |
| **`effective_config.policy` untyped** | **Medium** | Current | Loader/debug debt; inconsistent with classification | `RoutePolicyConfig` in M13.5 PR 1 |
| **Route-aware drift derivation unspecified** | **Medium** | Implementation | Wrong per-route review/quarantine | Normative `derive_drift_gates()` in impl plan |
| **Policy engine stream DB query on route path** | **Medium** | Current code pattern | All routes use stream rules — defeats M13.5 | Adapter + AC-16 |
| **Quarantine without `route_id` column** | **High** | Current schema | Cannot attribute or filter route quarantine | Migration before stage activation |
| **Require Review delivers but metrics unclear** | **Medium** | Product semantics | M13.6 health false positives | Disposition taxonomy in M13.6 spec |
| **Multiple `delivery_behavior` overrides per route** | **Low** | Misconfiguration | Ambiguous gate | Document tie-break in resolver |
| **Governance JSON flat vs nested SoT** | **Medium** | Wizard/API | Wrong override enforcement | Loader flatten algorithm (M13.4 R5) |
| **N × policy evaluation cost** | **Low** | Many routes | Latency | Shared findings + drift O(1); benchmark in M13.6 |
| **Legacy vs route stage order delta** | **Medium** | Always | Operator confusion | Regression matrix AC-0h |
| **JSON governance document growth** | **Low** | Many overrides | Slow stream load | Defer normalized table post-M13.5 |

---

## 7. Recommended Adjustments

### 7.1 Before M13.5 implementation (mandatory)

| # | Adjustment | Owner |
|---|------------|-------|
| **R1** | Confirm M13.4 gates: classification active, stamped events, `classification_result` on `RouteStageResult` | Verify before M13.5 start |
| **R2** | Implement `resolve_route_policy_config()` + typed `RoutePolicyConfig` on `RouteEffectiveConfig` | M13.5 |
| **R3** | Replace `policy_stub` with `route_policy_stage()` using injected `evaluate_batch()` + adapter | M13.5 |
| **R4** | Add `delivery_allowed` + `policy_result` + `policy_duration_ms` to `RouteStageResult` | M13.5 |
| **R5** | Filter fan-out: exclude blocked/quarantined routes from `route_payloads` | M13.5 |
| **R6** | Migration: `route_policy_rules` + nullable `stream_quarantine_events.route_id` | M13.5 |
| **R7** | Normative `derive_drift_gates(drift, route_id, overrides)` algorithm | M13.5 design |

### 7.2 During M13.5 (recommended)

| # | Adjustment | Owner |
|---|------------|-------|
| **R8** | Extend `RouteProcessingMetrics` with `route_policy_count`, `route_policy_duration_ms`, `route_policy_blocked_count` (AC-26) | M13.5 |
| **R9** | Policy engine rule entry protocol — decouple from `StreamPolicyRule` ORM | M13.5 |
| **R10** | Quarantine list API `route_id` filter + recording passes `destination_id` | M13.5 |
| **R11** | Route policy APIs + effective config + preview `route_id` (spec §15) | M13.5 |
| **R12** | Regression matrix: flag OFF vs ON policy order + divergent route decisions | M13.5 tests |
| **R13** | Document delivery disposition enum for M13.6 consumers | M13.5 → M13.6 handoff |

### 7.3 For M13.6 spec prep (not M13.5 blockers)

| # | Adjustment | Owner |
|---|------------|-------|
| **R14** | M13.6 spec: wire `stage_timeline` + `policy_result` → `runtime_route_snapshot` | M13.6 spec |
| **R15** | M13.6 spec: per-route health signals — blocked rate, quarantine count, policy latency | M13.6 spec |
| **R16** | Optional `routes.processing_metadata_json` for deploy readiness | M13.6 |
| **R17** | Post-M13.5 governance hardening: evaluate `route_governance_overrides` table if JSON insufficient | Future |

### 7.4 Architectural debt to fix before M13.5 (from route data model review + runtime evidence)

| # | Debt | Severity | Fix in |
|---|------|----------|--------|
| **D1** | `effective_config.policy` untyped | **High** | M13.5 R2 |
| **D2** | Policy stub + no fan-out gate | **High** | M13.5 R3, R5 |
| **D3** | `stream_quarantine_events` lacks `route_id` | **High** | M13.5 R6 |
| **D4** | `route_policy_rules` not created | **High** | M13.5 R6 |
| **D5** | Policy engine stream DB coupling | **Medium** | M13.5 R9 |
| **D6** | Route-aware drift evaluation unspecified | **Medium** | M13.5 R7 |
| **D7** | Governance nested vs flat JSON | **Medium** | Loader (M13.3/M13.4 carryover) |
| **D8** | FK `ON DELETE` inconsistency on route transform tables | **Low** | Housekeeping migration — non-blocking |
| **D9** | `RouteProcessingMetrics` missing policy counters | **Medium** | M13.5 R8 |

**Do not defer past M13.5:** R2–R7 (typed config, active stage, fan-out gate, quarantine column, drift derivation).

---

## 8. Go / No-Go Decision

### 8.1 M13.5 specification (spec 095)

| Decision | **GO** |
|----------|--------|
| Rationale | Spec is SoT-aligned, engine reuse correct, M13.4 handoff inherited, governance storage decision explicit, quarantine model sound, boundaries to M13.6 clear, route data model review confirmed |
| Caveat | Apply R7 (drift derivation algorithm), R13 (disposition taxonomy for M13.6) in implementation plan |

### 8.2 M13.5 implementation start

| Decision | **Conditional GO** |
|----------|---------------------|
| Conditions | (1) M13.4 acceptance criteria met in runtime — classification active with stamps; (2) R1 verified; (3) R6 migration plan approved; (4) R7 drift algorithm documented |
| Block if | M13.5 starts without classified events on route path — policy conditions on `classification_level` will be wrong |
| Block if | Fan-out gate (R5) deferred — quarantine/block product goals unmet |
| Do not block on | M13.6 metrics wiring, `route_governance_overrides` table, full Governance Dashboard route breakdown |

### 8.3 M13.6 trajectory

| Decision | **GO — no architecture pivot required** |
|----------|------------------------------------------|
| Rationale | M13.5 completes governance pipeline; delivery config and snapshot tables exist; M13.6 is observability extension on gated fan-out |
| Watch | Disposition taxonomy for Require Review deliveries; per-route policy log volume; snapshot updater consuming `policy_result` |

---

## Appendix A — Verification checklist (requested items)

| # | Question | Answer |
|---|----------|--------|
| 1 | M13.5 blocker for Route Runtime Delivery / Metrics / Health / Observability? | **No hard blockers** — M13.5 enables per-route gating and audit that M13.6 extends |
| 2 | Policy ownership compatible with Stream default + Route override? | **Yes** — five-step model in spec 095 §5 |
| 3 | `route_overrides[]` sufficient after Protection, Classification, Policy? | **Yes for M13.5–M13.6 MVP** — normalized table optional post-M13.5 |
| 4 | `RoutePolicyConfig` scales to Audit / Review / Quarantine / Delivery? | **Yes** — `RoutePolicyResult` + merge precedence; no redesign |
| 5 | `process_route_pipeline()` lifecycle valid? | **Yes** — Transform → Protection → Classification → Policy → Delivery |
| 6 | Policy consume prior outputs without rerunning engines? | **Yes** — §9 normative; drift is shared artifact + route-aware merge at stage |
| 7 | Nullable `route_id` on quarantine sufficient? | **Yes** — with column migration + API filter + release route context |
| 8 | Debt to fix before M13.5 implementation? | **D1–D7 / R1–R7** — especially fan-out gate, quarantine column, typed config, drift algorithm |

---

## Appendix B — Target end state (post M13.6)

```text
StreamRunner
  SHARED (once)
    fetch → extract → observe → sensitive_detect → schema_drift_policy
    → SharedBatchContext (extracted_events, findings, drift_result)

  FOR EACH enabled route
    RouteRuntimeContext (effective_config: transform, protection, classification, policy)
    → transform
    → protection
    → classification
    → policy          → delivery_allowed? 
    → format/send     [existing + M13.6 metrics/health]

  SHARED (once)
    checkpoint
```

---

## Appendix C — Context field readiness (M13.5 / M13.6)

### SharedBatchContext

| Field | M13.5 need | M13.6 need |
|-------|------------|------------|
| `sensitive_detection_result` | **Required** | Aggregates |
| `schema_drift_policy_result` | **Required** | Drift correlation |
| `shared_runtime_data.route_overrides` | **Required** (`delivery_behavior`) | Deploy summary |
| `quarantine_batch_signal` (optional accessor) | Recommended | — |

### RouteRuntimeContext / RouteStageResult

| Field | M13.5 need | M13.6 need |
|-------|------------|------------|
| `effective_config.policy` → `RoutePolicyConfig` | **Required** | Effective config API |
| `processing_state.policy_result` | **Required** | Debug |
| `RouteStageResult.delivery_allowed` | **Required** | Fan-out gate |
| `RouteStageResult.policy_result` | **Required** | Health / violations |
| `RouteStageResult.policy_duration_ms` | Recommended | Latency metrics |
| `RouteProcessingMetrics.route_policy_*` | **Required** (AC-26) | Dashboard |

---

## Appendix D — Source of Truth cross-reference

| SoT statement | Review finding |
|---------------|----------------|
| Route-applicable Policy (Product Charter Core Pipeline) | Spec 095 activates per-route stage after Classification |
| Configuration Scope = Stream; Execution Scope = Route | Dual-read + `route_overrides[].delivery_behavior` consistent |
| Quarantine + Audit (Product Charter) | Nullable `route_id` + `delivery_logs` extension sufficient |
| Runtime Reuse First / No Parallel Pipeline | Policy engine reuse with injected rules |
| WBS M13.5 Per Route Policy | Spec 095 delivers scope; M13.6 not blocked |
| WBS M13.6 Route Runtime Delivery | Observability on existing delivery path after policy gate |

---

*End of design review. No code, implementation, migrations, or refactoring performed.*
