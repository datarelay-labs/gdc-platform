# M13.2 Per Route Transform

**Milestone:** M13.2 (Per Route Transform)
**Status:** CURRENT implementation spec for M13.2 (delivered). Original M13 rollout assumed flag default OFF; product default is ON as of P1-4 (`false` = rollback).
**Depends on:** M13.1 Route Processing Foundation (`specs/091-route-processing-architecture/spec.md`)
**Design review:** [`docs/architecture/m13-route-architecture-design-review.md`](../../docs/architecture/m13-route-architecture-design-review.md) — findings incorporated in this revision
**Authority:** Product Charter 1.2.1, Master WBS 1.2.1, `.specify/memory/constitution.md`, `specs/064-advanced-transform/spec.md` (via `.cursor/rules/advanced-transform.mdc`)
**Architecture:** [`docs/architecture/route-processing-foundation-implementation-spec.md`](../../docs/architecture/route-processing-foundation-implementation-spec.md)
**Gap analysis:** [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)

---

## 1. Problem Statement

Transform (Mapping + Enrichment) is **Stream-scoped** today. One mapping and one enrichment configuration apply to all destinations on a stream. After transform, `StreamRunner` fan-out sends the **same payload** to every route.

```text
Stream
↓
Transform once (Mapping + Enrichment — stream-scoped)
↓
Fan-out (identical events)
↓
Destinations
```

**Product violation:** Operators who need different field shapes per destination (e.g. Route A → raw syslog, Route B → normalized XDR schema, Route C → data lake custom transform) must **duplicate Streams** for the same source. Product Charter 1.2.1 explicitly forbids this: *목적지별 처리 차이는 Route를 통해 구성한다* and *users must not duplicate Streams because destinations require different processing*.

**Gap (evidence):** `mappings.stream_id` UNIQUE, `enrichments.stream_id` UNIQUE; `stream_loader` injects transform config on stream dict only; `_collect_and_transform_events()` runs mapping/enrichment once (`app/runners/stream_runner.py`).

**M13.1 delivered:** Route loop skeleton, `SharedBatchContext`, `RouteRuntimeContext`, `GDC_ROUTE_PROCESSING_ENABLED`, dual-read helper, NO-OP `process_route()`.

**M13.1 implementation debt (design review):** Route loop currently runs **after** stream-level Protection and Policy, uses post-protection events, and `RouteStageResult` is not wired to fan-out. **M13.2 must resolve this debt** — not optional.

**M13.2 solves:** Move Transform execution into the **per-route pipeline** (before Protection / Classification / Policy), using **existing Mapping and Enrichment engines**, with **route config + stream fallback**, and **route-specific fan-out delivery**.

---

## 2. Source Of Truth Alignment

| Document | Mandate relevant to M13.2 |
|----------|---------------------------|
| **Product Charter 1.2.1** | Route = Destination Specific Processing Unit; Transform route-applicable; Runtime Reuse First; No Parallel Pipeline |
| **Master WBS 1.2.1** | M13.2 = Route Specific Mapping, Route Specific Enrichment, Route Specific Transform |
| **UX Charter 1.2.1** | §24–27 Route model; per-destination differences via Route |
| **Stream Wizard Charter v5.2** | Step 4 Route Processing → Transform tab per route; Transform workflow (Auto Mapping → Required Fields → … → Output Verification) |
| **Governance & Transform Policy v1.1** | §19 Route Transform Policy — same stream, different transform per route (Syslog raw vs XDR transform vs data lake custom) |
| **Union Schema UX Spec v1.1** | Union Schema = shared input; Route Transform Model — Union Schema unchanged; each route applies different transform |
| **Governance UX Charter v1.1** | Configuration Scope = Stream (defaults); Execution Scope = Route — **M13.2 applies to Transform execution only** |
| **ChatGPT Guardrail v1.0** | No new governance categories; reuse runtime; Runtime priority |
| **M13 design review** | Loop relocation mandatory; reject stream-scoped Protection continuation; context alignment prerequisite |

**Constitution (unchanged):**

- Mapping and Enrichment remain **separate stages** internally
- UX may unify as "Transform" (Wizard Charter)
- Stream = execution unit; Route connects Stream → Destination
- Advanced Transform policy: JSONPath, JSONata, regex_extract only; no arbitrary code (`advanced-transform.mdc`)

---

## 3. Current Transform Model

### 3.1 Storage

| Entity | Scope | Key fields |
|--------|-------|------------|
| `mappings` | Stream (1:1) | `stream_id` UNIQUE, `event_array_path`, `event_root_path`, `field_mappings_json`, `raw_payload_mode`, `transform_rules` / advanced fields (if present) |
| `enrichments` | Stream (1:1) | `stream_id` UNIQUE, `enrichment_json`, `override_policy`, `enabled` |

**Evidence:** `app/mappings/models.py`, `app/enrichments/models.py`

### 3.2 Runtime loading

`stream_loader.load_stream_context()` loads stream mapping + enrichment onto `stream_runtime` dict. Routes carry **delivery fields only**.

### 3.3 Runtime execution (legacy + M13.1 flag ON today)

```text
_collect_and_transform_events()
  Extract → Schema observation → Mapping (stream) → Enrichment (stream)
  → Sensitive detection → Classification → Schema drift policy

→ _prepare_delivery_events()     ← stream Protection
→ _evaluate_policies()           ← stream Policy
→ _execute_route_processing_foundation()  ← NO-OP on delivery_events
→ _fan_out(delivery_events)      ← identical payload all routes
```

### 3.4 M13.1 route loop (implementation — to be replaced by M13.2)

When `GDC_ROUTE_PROCESSING_ENABLED=true` today:

- Stream transform still runs in shared phase
- Route loop runs **after** Protection and Policy
- Route loop receives **post-protection** `delivery_events`
- `RouteStageResult` is **not** passed to `_fan_out()`

**M13.2 replaces this entirely when flag ON.**

---

## 4. Target Transform Model

### 4.1 Topology (unchanged)

```text
One Stream → Many Routes → Many Destinations
Execution Unit: Stream
Processing Unit: Route (transform execution)
```

### 4.2 Target pipeline (flag ON + M13.2) — mandatory

```text
SHARED PHASE (once per batch)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → SharedBatchContext (extracted_events = pre-mapping raw events)

PER-ROUTE LOOP (for each enabled route) — BEFORE governance
  process_route_pipeline()
    → Transform        (Mapping + Enrichment — ACTIVE in M13.2)
    → Protection       (NO-OP stub in M13.2; M13.3 activates)
    → Classification   (NO-OP stub in M13.2; M13.4 activates)
    → Policy           (NO-OP stub in M13.2; M13.5 activates)
    → Delivery handoff (RouteStageResult → fan-out)

POST-LOOP (stream scope)
  Dynamic routing (additive destinations — existing)
  → Checkpoint (stream cursor, post-delivery ACK)
```

**Mandatory (design review R1):** Route loop **must** run **before** Protection, Classification, and Policy when `GDC_ROUTE_PROCESSING_ENABLED=true`. Stream-scoped Protection / Classification / Policy **must not** run on a shared pre-route batch when flag ON.

**Rejected approach:** Continuing stream-scoped Protection while only Transform is per-route (former "Option A") — causes incorrect masking when routes produce different field shapes.

### 4.3 Fan-out requirement (mandatory)

`_fan_out()` **must** receive **per-route** transformed events from `RouteStageResult`. It **must not** deliver a single stream-level transformed batch to all routes when flag ON.

```text
route_payloads: dict[route_id, list[event]] = {
  result.route_id: result.events
  for result in route_pipeline_results
}
_fan_out(stream, route_payloads)
```

Delivery uses **route transform output**, not stream-level transformed events.

### 4.4 Transform input

| Input | Source | Scope |
|-------|--------|-------|
| Raw extracted events | `SharedBatchContext.extracted_events` | Shared — **pre-mapping only** |
| Union Schema | `SharedBatchContext.union_schema` | Shared |
| Event root / record paths | Stream mapping or stream config | Shared (not per-route in M13.2) |
| Sensitive detection | `SharedBatchContext.sensitive_detection_result` | Shared suggestions (M13.3 consumes) |

**Union Schema does not change per route** (Union Schema UX Spec §Route Transform Model).

### 4.5 Transform output

| Output | Description |
|--------|-------------|
| `route_transformed_events` | Per-route list after Mapping + Enrichment |
| `mapping_field_errors` | Per route, structured (existing engine semantics) |
| `enrichment_field_errors` | Per route, structured |
| `stage_timeline` | `transform` → `protection_stub` → `classification_stub` → `policy_stub` → `delivery_handoff` |

---

## 5. Transform Ownership Model

### 5.1 Definitions

| Concept | Owner | Role in M13.2 |
|---------|-------|---------------|
| **Stream Transform** | Stream | Default transform config; fallback when route config absent |
| **Route Transform** | Route | Destination-specific Mapping + Enrichment execution config |
| **Union Schema** | Stream (Sample) | Shared field catalog — not transform config |
| **Record / Event Root** | Stream | Extraction contract — not per-route in M13.2 |

### 5.2 Inheritance

```text
Route Transform effective config =
  if route_has_transform_config(route_id):
    route config (full mapping + enrichment bundle)
  else:
    stream config (full mapping + enrichment bundle)
```

**Full bundle fallback** — not field-level merge.

### 5.3 Override

When route transform config **exists**, route mapping and enrichment **replace** stream config for that route's execution. Stream config remains for fallback on other routes.

### 5.4 Stream Transform after M13.2

| Mode | Stream transform role |
|------|------------------------|
| Flag OFF | Authoritative — executed in shared phase (legacy) |
| Flag ON, no route rows | Fallback only — executed in each route slot via dual-read |
| Flag ON, route rows present | Default for routes without own config; **not executed at stream level** |

### 5.5 No conflict with M13.3 Protection ownership

Transform produces route event **shape**. Protection (M13.3) acts on route-transformed fields with stream defaults + `route_overrides[]`. Ownership models are complementary; pipeline order ensures Protection runs **after** route Transform inside `process_route_pipeline()`.

---

## 6. Configuration Resolution Model

### 6.1 Dual-read algorithm (normative)

```text
resolve_transform_config(route_id, stream_id):

  route_mapping = load_route_mapping(route_id)
  route_enrichment = load_route_enrichment(route_id)
  stream_mapping = load_stream_mapping(stream_id)
  stream_enrichment = load_stream_enrichment(stream_id)

  effective_mapping =
    route_mapping if route_mapping is not null else stream_mapping

  effective_enrichment =
    route_enrichment if route_enrichment is not null else stream_enrichment

  return TransformConfig(mapping=effective_mapping, enrichment=effective_enrichment)
```

### 6.2 Route config exists → use route config

Empty JSON `{}` on route row counts as **present**.

### 6.3 Route config missing → fallback to stream config

No route row → stream row. No stream row → platform empty pass-through.

### 6.4 Dual-read behavior summary

| Route mapping | Route enrichment | Effective mapping | Effective enrichment |
|---------------|------------------|-------------------|----------------------|
| absent | absent | stream | stream |
| present | absent | route | stream |
| absent | present | stream | route |
| present | present | route | route |

### 6.5 Loader integration

Pre-resolve `effective_config.transform` per route at load time; attach to `RouteRuntimeContext` per spec 091 §7.3.

---

## 7. M13.2 Prerequisites — Context Contract Alignment

**Gate:** M13.2 implementation **must not** start route transform logic until contexts align with spec 091 (design review R2).

### 7.1 RouteRuntimeContext — required fields (spec 091)

Extend M13.1 simplified context to include:

| Field / group | M13.2 requirement |
|---------------|-------------------|
| `route_id`, `stream_id`, `destination_id`, `enabled` | Required |
| `route_name`, `route_type` | Required (observability) |
| `formatter`, `delivery_policy`, `rate_limit` | Required (delivery handoff) |
| **`effective_config.transform`** | Required — dual-read resolved mapping + enrichment |
| **`effective_config.protection`** | Placeholder null (M13.3) |
| **`effective_config.classification`** | Placeholder null (M13.4) |
| **`effective_config.policy`** | Placeholder null (M13.5) |
| **`processing_state.current_events`** | Required — mutates through pipeline |
| **`processing_state.stage_timeline`** | Required |
| **`processing_state.errors`** | Required |
| **`shared_batch_ref`** | Required — link to `SharedBatchContext` |
| `config_resolution.transform_source` | Recommended — `route` \| `stream` |

### 7.2 SharedBatchContext — required fields (spec 091)

| Field | M13.2 requirement |
|-------|-------------------|
| `stream_id`, `batch_id` | Required |
| `event_root`, `union_schema` | Required |
| **`extracted_events`** | Required — **pre-mapping raw events**; distinct from route output |
| **`schema_observation`** | Required — full observation artifact (not summary dict only) |
| **`sensitive_detection_result`** | Required — structured stream-scoped suggestions |
| **`checkpoint_cursor_before`** | Required — checkpoint trace / debug |
| `shared_runtime_data` | Required — fetch stats, counts |
| `fetch_metadata` | Optional |

**Critical:** Deprecate ambiguous `events` as post-protection input. Route transform reads **`extracted_events` only**.

### 7.3 Shared batch build timing

`SharedBatchContext` **must** be built **immediately after** extraction and schema observation (and sensitive detection) in the shared phase — **before** any route loop or governance stage.

---

## 8. Route Pipeline Contract — `process_route_pipeline()`

Conceptual only — no code. Replaces monolithic M13.1 `process_route()` for flag ON path.

### 8.1 Signature (conceptual)

```text
process_route_pipeline(
  route_ctx: RouteRuntimeContext,
  shared_batch: SharedBatchContext,
) -> RouteStageResult
```

### 8.2 Stages (in order)

| Stage | M13.2 behavior | Milestone |
|-------|----------------|-----------|
| **Transform** | Mapping → Enrichment on `shared_batch.extracted_events` | **ACTIVE** |
| **Protection** | NO-OP pass-through; `stage_timeline` records `protection_stub` | M13.3 |
| **Classification** | NO-OP pass-through; `stage_timeline` records `classification_stub` | M13.4 |
| **Policy** | NO-OP pass-through; `stage_timeline` records `policy_stub` | M13.5 |
| **Delivery handoff** | Finalize `RouteStageResult.events` for fan-out | M13.2 |

### 8.3 Transform stage detail

```text
Input:  shared_batch.extracted_events
Config: route_ctx.effective_config.transform (dual-read)
Steps:  apply_mappings_with_results() → apply_enrichments_batch()
Output: route_ctx.processing_state.current_events
```

### 8.4 Stub stages (M13.2)

Protection, Classification, and Policy stubs:

- Return `current_events` unchanged
- Set `modified = false` for stub stages
- Record stub name in `stage_timeline`
- **Must not** invoke protection/classification/policy engines in M13.2

### 8.5 Delivery handoff

`RouteStageResult`:

```text
route_id:     route_ctx.route_id
events:       route_ctx.processing_state.current_events  # post-transform (+ stub stages)
modified:     true if transform ran
stage_timeline: [...]
```

Fan-out consumes this result — see §4.3.

### 8.6 Lifecycle diagram

```text
Shared Phase
  → SharedBatchContext(extracted_events, schema_observation, sensitive_detection_result, …)

For each enabled route:
  RouteRuntimeContext (effective_config resolved)
  → Transform          [ACTIVE]
  → Protection stub    [NO-OP]
  → Classification stub [NO-OP]
  → Policy stub        [NO-OP]
  → Delivery handoff   → RouteStageResult

Fan-out(route_id → events)
Checkpoint
```

---

## 9. Runtime Integration

### 9.1 Feature flag matrix

| `GDC_ROUTE_PROCESSING_ENABLED` | Behavior |
|--------------------------------|----------|
| `false` (rollback) | **Legacy:** stream mapping + enrichment in `_collect_and_transform_events()`; stream Protection/Policy; no route pipeline; identical fan-out |
| `true`, no route rows | Shared phase only (extract/observe/detect); `process_route_pipeline()` with dual-read stream transform per route; stubs for governance; per-route fan-out |
| `true`, route rows | Per-route transform where configured; stream fallback elsewhere |

### 9.2 StreamRunner changes (flag ON)

| Component | Change |
|-----------|--------|
| `_collect_and_transform_events()` | **Remove** mapping + enrichment; **remove** classification from shared phase when flag ON; keep extract + observation + sensitive detection |
| Route loop placement | **Before** any governance — replaces current post-Protection placement |
| `_prepare_delivery_events()` | **Not called** on shared batch when flag ON (Protection stub in pipeline) |
| `_evaluate_policies()` | **Not called** on shared batch when flag ON (Policy stub in pipeline) |
| `_execute_route_processing_foundation()` | Invokes `process_route_pipeline()` per route; collects `RouteStageResult[]` |
| `_fan_out()` | Accepts per-route payload map from `RouteStageResult` |

### 9.3 Checkpoint

Checkpoint cursor remains **stream-scoped** on shared extraction success (`specs/004-delivery-routing/spec.md`). Reference metadata uses **extracted_events** or stream-fallback transform snapshot — not route-specific shapes.

### 9.4 No parallel runtime

Same `StreamRunner`; no `RouteRunner`; no new transform engine.

---

## 10. Database Impact

Conceptual only — no SQL.

| Artifact | Key | M13.2 |
|----------|-----|-------|
| `mappings` | UNIQUE `stream_id` | Unchanged — fallback |
| `enrichments` | UNIQUE `stream_id` | Unchanged — fallback |
| **`route_mappings`** | UNIQUE `route_id` | Additive |
| **`route_enrichments`** | UNIQUE `route_id` | Additive |

`event_array_path`, `event_root_path` remain stream-scoped only.

---

## 11. API Impact

Conceptual only.

**Retained:** all `/runtime/streams/{id}/mapping-ui/*` and enrichment endpoints.

**Added (M13.2):**

```text
GET/POST /runtime/routes/{route_id}/mapping-ui/config|save
GET/POST /runtime/routes/{route_id}/enrichment-ui/config|save
GET/POST /runtime/routes/{route_id}/transform-ui/config|save   (optional facade)
POST     /runtime/preview/*  (+ route_id — dual-read effective config)
GET      /runtime/routes/{route_id}/transform-readiness
```

Response metadata should include `resolution.fallback_used` and `transform_source`.

---

## 12. Frontend Impact

Conceptual only.

- Wizard Step 4 Route Processing → Transform tab per route
- Stream mapping page → route selector or "Default Transform"
- `UnionSchemaTree` shared; per-route transform config

---

## 13. Backward Compatibility

| Condition | Expected behavior |
|-----------|-------------------|
| `GDC_ROUTE_PROCESSING_ENABLED=false` | **Identical** to OSS GA — no route pipeline |
| Flag ON, no `route_*` rows | Dual-read stream config per route → **delivery parity** with flag OFF |
| Flag ON, partial route config | Unconfigured routes use stream fallback |
| User data | No truncate of mappings or enrichments |

**Parity:** Stream S, routes R1..Rn, no route transform rows → flag ON outbound payloads **byte-equivalent** to flag OFF per route.

**Rollback:** Set flag OFF — immediate legacy path; delete route rows to force stream fallback.

---

## 14. Acceptance Criteria

M13.2 is **complete** when all criteria pass.

### 14.1 Prerequisites (context alignment)

- [ ] **AC-1** `RouteRuntimeContext` matches spec 091 §7 (including `stream_id`, `effective_config`, `processing_state`, `shared_batch_ref`).
- [ ] **AC-2** `SharedBatchContext` matches spec 091 §8 (`extracted_events`, `schema_observation`, `sensitive_detection_result`, `checkpoint_cursor_before`).
- [ ] **AC-3** `extracted_events` are pre-mapping raw events — never post-protection copy.

### 14.2 Pipeline order (design review gate)

- [ ] **AC-4** When flag ON, route loop executes **before** Protection, Classification, and Policy.
- [ ] **AC-5** Stream-scoped `_prepare_delivery_events()` and `_evaluate_policies()` are **not** invoked on shared batch when flag ON.
- [ ] **AC-6** `process_route_pipeline()` runs stages: Transform (active) → Protection stub → Classification stub → Policy stub → Delivery handoff.
- [ ] **AC-7** Protection, Classification, and Policy engines are **not** invoked in M13.2 (stubs only).

### 14.3 Transform and delivery

- [ ] **AC-8** Flag OFF: zero behavior change vs pre-M13.2 baseline (full e2e green).
- [ ] **AC-9** Flag ON, no route rows: dual-read stream transform per route; delivery parity with flag OFF.
- [ ] **AC-10** Flag ON, route A config differs: Route A outbound payload differs; others use stream fallback unless configured.
- [ ] **AC-11** Mapping and Enrichment use **existing engines** only.
- [ ] **AC-12** **`RouteStageResult` output is passed to `_fan_out()`** — route transform output used for destination delivery.
- [ ] **AC-13** `_fan_out()` does **not** deliver stream-level transformed events to all routes when flag ON.

### 14.4 Config and API

- [ ] **AC-14** `route_mappings` and `route_enrichments` additive tables exist.
- [ ] **AC-15** Dual-read: route row absent → stream config; route row present → route config.
- [ ] **AC-16** Route mapping/enrichment APIs and preview `route_id` functional.
- [ ] **AC-17** Stream mapping/enrichment APIs remain functional.

### 14.5 Observability and boundaries

- [ ] **AC-18** `delivery_logs` include `route_id` for per-route mapping/enrichment stages.
- [ ] **AC-19** Checkpoint semantics unchanged per `specs/004-delivery-routing/spec.md`.
- [ ] **AC-20** No new runtime class or parallel pipeline.
- [ ] **AC-21** No user mapping/enrichment data truncated.
- [ ] **AC-22** Operator can configure different transforms per route without duplicate streams.

---

## 15. Test Strategy

### 15.1 Unit tests

| Area | Cases |
|------|-------|
| Context alignment | All spec 091 fields present |
| `resolve_transform_config` | Route present/absent combinations |
| `process_route_pipeline` | Transform active; stubs pass-through |
| Fan-out wiring | Per-route payload map consumed |

### 15.2 Integration tests

| Case | Expected |
|------|----------|
| Flag OFF | Legacy path — regression gate |
| Flag ON, no route rows | Parity with flag OFF; route loop before governance |
| Flag ON, divergent routes | Different payloads per route |
| Loop order | No stream Protection/Policy before route pipeline when flag ON |
| Fan-out | Each route receives its `RouteStageResult.events` |
| Stubs | Protection/Classification/Policy engines not called |

### 15.3 Regression tests

- Full e2e flag OFF — no expectation changes
- Advanced transform on route config — same engine behavior
- Backup import stream-only config — valid

---

## 16. Implementation Boundaries

### 16.1 IN scope (M13.2)

| Deliverable | Description |
|-------------|-------------|
| Context contract alignment | §7 prerequisites |
| `process_route_pipeline()` | Transform active + governance stubs |
| Route loop relocation | Before Protection / Classification / Policy |
| Fan-out per-route wiring | §4.3 |
| `route_mappings` / `route_enrichments` | Additive schema + repos |
| Dual-read resolver | Transform config |
| Route APIs + preview `route_id` | Conceptual §11 |
| Tests | §15 |

### 16.2 OUT of scope (M13.3+)

| Milestone | Excluded |
|-----------|----------|
| **M13.3** | Protection engine invocation, `route_overrides` runtime |
| **M13.4** | Classification engine invocation, stage order decision |
| **M13.5** | Policy engine invocation |
| **M13.6** | Route metrics, route health |
| **Any** | New transform engine; stream table breaking changes |

### 16.3 M13.2 implementation order (mandatory)

| Step | Work | Exit criteria |
|------|------|---------------|
| **A** | **Context contract alignment** — extend `RouteRuntimeContext` and `SharedBatchContext` per §7 | AC-1, AC-2, AC-3 |
| **B** | **Shared batch built after extraction / observation** — `extracted_events`, `schema_observation`, `sensitive_detection_result`, `checkpoint_cursor_before` | AC-3 |
| **C** | **Route loop moved before governance stages** — disable stream Protection/Policy/Classification on shared batch when flag ON | AC-4, AC-5 |
| **D** | **Route transform execution** — `process_route_pipeline()` Transform stage; dual-read; existing engines | AC-9, AC-10, AC-11 |
| **E** | **RouteStageResult → fan-out delivery wiring** — per-route payloads | AC-12, AC-13 |
| **F** | **Regression tests** — flag OFF identical; flag ON parity + divergence | AC-8, §15 |

Steps **C** and **E** are **not deferrable**. Do not ship route transform without loop relocation and fan-out wiring.

### 16.4 Follow-on work (post-M13.2 core)

| Step | Deliverable |
|------|-------------|
| G | Alembic + repositories (may parallel A if schema-first) |
| H | Route APIs + preview |
| I | Frontend Route Transform tab |
| J | Staging validation flag ON globally |

---

## Appendix A — Design review cross-reference

| Finding | Spec 092 response |
|---------|-------------------|
| Option A rejected | §4.2 mandatory loop before governance |
| Context drift | §7 prerequisites |
| Fan-out not wired | §4.3, AC-12, AC-13, step E |
| Monolithic `process_route()` | §8 `process_route_pipeline()` |
| Interim stream Protection risk | Stubs in pipeline; stream governance disabled when flag ON |

Source: [`m13-route-architecture-design-review.md`](../../docs/architecture/m13-route-architecture-design-review.md)

---

## Appendix B — Engine reuse

| Engine | Path | Usage |
|--------|------|-------|
| Mapping | `app/mappers/mapper.py` | Per route in Transform stage |
| Enrichment | `app/enrichers/enrichment_engine.py` | Per route in Transform stage |

Config source changes; algorithms unchanged (Union Schema UX Spec AC #10).

---

## Appendix C — Related specs

| Spec | Relationship |
|------|--------------|
| `specs/091-route-processing-architecture/spec.md` | M13.1 foundation — context contracts |
| `docs/architecture/m13-route-architecture-design-review.md` | Findings incorporated in this revision |
| `specs/004-delivery-routing/spec.md` | Fan-out, checkpoint |
| `.cursor/rules/advanced-transform.mdc` | Transform policy |

---

## Appendix D — Key files (implementation reference)

| File | M13.2 change |
|------|--------------|
| `app/runners/route_context.py` | Align with spec 091 |
| `app/runners/route_context_builder.py` | `extracted_events`, observation, detection |
| `app/runners/route_stage.py` | `process_route_pipeline()` |
| `app/runners/stream_runner.py` | Loop relocation; shared phase split; fan-out wiring |
| `app/runners/stream_loader.py` | Effective transform on context |

---

*End of M13.2 companion spec (design review revision). No code, database, API, UI, or runtime changes authorized by this document.*
