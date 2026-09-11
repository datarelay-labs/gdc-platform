# M13.1 Route Processing Foundation — Implementation Specification

**Status:** Design only — no implementation  
**Milestone:** M13.1 (Route Processing Foundation)  
**Date:** 2026-06-14  
**Authority:** `docs/source-of-truth/` (Product Charter 1.2.1, Master WBS 1.2.1, UX/Wizard/Governance/Union Schema charters)  
**Primary input:** [`route-architecture-gap-analysis.md`](route-architecture-gap-analysis.md)  
**Index:** [`source-of-truth-index.md`](source-of-truth-index.md)

---

## Document Purpose

This specification defines the **foundation** required to enable Route as Destination Specific Processing Unit. It is the implementation planning authority for M13.1 only.

**This document does not authorize:**

- Code changes
- Database migrations
- API implementation
- UI implementation
- M13.2–M13.6 feature delivery

**Downstream milestones enabled by M13.1:**

| Milestone | Scope (not designed here) |
|-----------|---------------------------|
| M13.2 | Per Route Transform |
| M13.3 | Per Route Protection |
| M13.4 | Per Route Classification |
| M13.5 | Per Route Policy |
| M13.6 | Route Runtime Delivery |

---

## 1. Architecture Overview

### 1.1 Product intent (Source of Truth)

Data Relay's delivery architecture is:

```text
One Stream
↓
Many Routes
↓
Many Destinations
```

User workflow (Product Charter 1.2.1, Wizard Charter v5.2):

```text
Collect Data
↓
Select Destinations
↓
Configure Route Processing
↓
Deploy
```

**Route = Destination Specific Processing Unit.** Transform, Protection, Classification, and Policy must be applicable per Route. Users must not duplicate Streams because destinations require different processing (Product Charter §Route Based Processing Architecture, UX Charter §24–27).

### 1.2 Technical principles (non-negotiable)

| Principle | Source | M13.1 implication |
|-----------|--------|-------------------|
| **Execution Unit = Stream** | Product Charter §Technical Principles | Source fetch, checkpoint, status, polling isolation remain Stream-scoped |
| **Processing Unit = Route** | Product Charter §Technical Principles | Per-destination processing config and execution context attach to Route |
| **Runtime Reuse First** | Product Charter §Technical Principles | Re-orchestrate existing `StreamRunner`; no new runner class |
| **No Parallel Pipeline** | Product Charter §Technical Principles | No second delivery engine, governance engine, or scheduler |
| **Checkpoint after delivery success** | `specs/001-core-architecture/spec.md`, `specs/004-delivery-routing/spec.md` | Unchanged; stream cursor advances after route delivery ACK |
| **Configuration Scope = Stream, Execution Scope = Route** | Governance UX Charter §14, Governance Workspace v1.1 | Stream owns defaults; Route owns runtime behavior and overrides |

### 1.3 Target pipeline shape

```text
StreamRunner (unchanged transaction owner)
  │
  ├─ SHARED (Stream scope, once per batch)
  │    Source Fetch
  │    → Extract Events
  │    → Union Schema / Schema Observation
  │    → Baseline & Schema Drift (stream policy)
  │    → Sensitive Detection (suggestions, stream-level)
  │
  └─ PER ROUTE (Route scope, N times)
       Transform          ← M13.2
       → Protection       ← M13.3
       → Classification   ← M13.4
       → Policy           ← M13.5
       → Format & Delivery ← M13.6 (delivery config exists; orchestration slot defined here)
  │
  └─ SHARED (Stream scope)
       Checkpoint (post-delivery ACK)
```

M13.1 defines the **split boundary**, **lifecycle contract**, **Route Runtime Context**, and **configuration model** that make this shape possible. Individual stage implementations belong to M13.2–M13.6.

### 1.4 Gap summary (evidence)

Per [`route-architecture-gap-analysis.md`](route-architecture-gap-analysis.md):

| Layer | Current | Target |
|-------|---------|--------|
| Entity topology | ✅ Stream → Routes → Destinations | Same |
| Delivery fan-out | ✅ `_fan_out()` per enabled route | Same |
| Per-route delivery config | ✅ formatter, failure policy, rate limit | Same |
| Per-route processing | ❌ Mapping/Enrichment/Protection/Classification/Policy are Stream-scoped | Route-scoped |
| Route semantics | Destination Link | Processing Unit |

**Verdict:** Delivery topology is implemented; processing topology is not. M13.1 closes the architectural gap without implementing individual processing engines per route.

---

## 2. Current Runtime Model

### 2.1 Entity model (implemented)

```text
Connector → Source → Stream (execution unit)
                      ├─ Mapping        (1:1, stream_id UNIQUE)
                      ├─ Enrichment     (1:1, stream_id UNIQUE)
                      ├─ Checkpoint     (1:1)
                      ├─ stream_protection_rules
                      ├─ stream_classification_rules
                      ├─ stream_policy_rules
                      └─ Route (N) → Destination
                           └─ delivery config only
                                (formatter_config_json, failure_policy,
                                 rate_limit_json, enabled)
```

**Evidence:** `app/routes/models.py` — no mapping/enrichment/governance FKs or processing JSON on Route. `app/runners/stream_loader.py` injects mapping/enrichment on stream dict; routes carry delivery fields only.

### 2.2 Runtime pipeline (implemented)

```text
Source Fetch (once)
  → Extract
  → Schema Observation
  → Mapping (stream)
  → Enrichment (stream)
  → Sensitive Detection (stream)
  → Classification (stream)
  → Schema Drift Policy (stream)
  → Protection (stream, outbound copy)
  → Policy (stream)
  → Dynamic Routing
  → Fan-out per Route
       → Formatter → Destination send → Failure policy
  → Checkpoint (stream, after ACK)
```

**Evidence:** `app/runners/stream_runner.py` — single `_collect_and_transform_events()` → single `_prepare_delivery_events()` → `_fan_out()` with identical processed payload (modulo protection copy).

### 2.3 Why this structure exists

| Decision | Rationale |
|----------|-----------|
| Stream = execution unit | Source fetch, polling, checkpoint, status isolation per API endpoint |
| Route = delivery link first | Foundation phase connected multi-destination before per-destination transform was specified |
| Stream-scoped Data Control | M5–M13 engines implemented with `stream_id` FK; operator MVP |
| OSS v1.0 GA scope | Shipped Stream-scoped transform + Route fan-out; Route Processing deferred post-GA |

This was the correct incremental path (Gap Analysis §1.2). It is not the target architecture per Product Charter 1.2.1.

### 2.4 Frontend model (implemented)

| Surface | Current behavior |
|---------|------------------|
| Wizard | 5 steps: Connect → Sample → **Transform** → Destinations → Deploy |
| Transform step | Stream-global mapping + enrichment + optional governance drawer |
| Union Schema | Built at Sample; consumed in Transform step (stream-scoped) |
| Route edit | Delivery-only (`route-edit-page.tsx`, `route-operational-panel.tsx`) |
| Governance Workspace | Stream/tenant level; no route breakdown |

**Evidence:** `frontend/src/components/streams/wizard/wizard-state.ts` — steps `transform` before `destinations`; comments reference v3.0 order.

---

## 3. Target Runtime Model

### 3.1 Core model

```text
Execution Unit:     Stream   (fetch, checkpoint, status, shared observation)
Processing Unit:    Route    (= Destination Specific Processing Unit)
Topology:           One Stream → Many Routes → Many Destinations
```

### 3.2 Processing split

| Phase | Scope | Runs |
|-------|-------|------|
| **Common processing** | Stream | Once per batch/cycle |
| **Route processing** | Route | Once per enabled route per batch |
| **Checkpoint** | Stream | Once after delivery transaction completes |

Common processing produces **shared extracted events** and **Union Schema context**. Route processing consumes that shared input and produces **route-specific outbound payloads**.

### 3.3 Orchestration contract (M13.1 deliverable)

`StreamRunner` remains the sole transaction owner. M13.1 defines the refactor contract:

1. **Extract shared phase** — existing fetch/extract/observation/sensitive-detection logic stays in Stream scope; output is a `SharedBatchContext` (conceptual).
2. **Introduce per-route loop** — for each enabled route, invoke `_process_route_batch(route_context, shared_batch)` (name conceptual). M13.1 defines the hook and context; M13.2–M13.5 populate stage slots.
3. **Preserve fan-out delivery** — existing formatter, adapter send, failure policy, rate limit remain on Route; M13.6 may extend observability.
4. **Preserve checkpoint rule** — checkpoint references shared extract cursor, not route-specific shapes (Product Charter unchanged).

**No new runtime class.** No parallel delivery or governance engine (Product Charter §No Parallel Pipeline).

### 3.4 Config resolution contract (M13.1 deliverable)

At load time (`stream_loader`), each route must resolve:

```text
effective_config(route) =
  route_config(route_id) ?? stream_default_config(stream_id)
```

Dual-read is mandatory for backward compatibility (Gap Analysis §12–13). M13.1 defines this resolution order; M13.2–M13.5 define which config keys exist per concern.

### 3.5 Governance scope model

```text
Configuration Scope:  Stream (ownership, optional defaults, catalog assignment)
Execution Scope:      Route (behavior, overrides, delivery context)
```

Route overrides (`route_overrides[]` per Governance Workspace v1.1) are a **configuration model concept** defined in M13.1; runtime application is M13.3–M13.5.

---

## 4. Stream Responsibilities

Stream remains the **operational and observational anchor**. The following concerns stay Stream-scoped in the target model.

### 4.1 Source

| Responsibility | Description |
|----------------|-------------|
| Connector binding | Stream references Source; Source references Connector |
| Fetch orchestration | Polling interval, rate limits (source-side), auth context |
| Checkpoint cursor | Stream-scoped; advances only after successful delivery |
| Stream status | Running, paused, error — per execution unit |

**Unchanged from current model.** Evidence: `specs/001-core-architecture/spec.md`, `specs/002-runtime-pipeline/spec.md`.

### 4.2 Record Selection

| Responsibility | Description |
|----------------|-------------|
| Record path | JSONPath to array/object container in raw response |
| Event root | JSONPath to individual event within record |
| Checkpoint field | Field used for incremental fetch |

Configured in Wizard Step 2 (Sample & Record Selection). Output is stream configuration, not route configuration.

### 4.3 Event Root

Event Root defines **what constitutes one event** for extraction. All routes on a stream share the same Event Root and extracted event set.

Union Schema UX Spec v1.1: Union Schema is built from events at the selected Event Root. Route Processing consumes that schema; it does not redefine Event Root per route.

### 4.4 Union Schema

| Responsibility | Description |
|----------------|-------------|
| Build from sample | 10–20 events at Event Root (SoT target; currently best-effort — Gap Analysis Q6) |
| Shared input | All routes on a stream share one Union Schema |
| Field frequency | N/M occurrence display |
| Sample values | Max 5 per field |
| Rare field marking | &lt;30% threshold (SoT; partial today) |

Union Schema is **not** duplicated per route (Union Schema UX Spec §Route Architecture Extension). M13.1 establishes the **contract** that Route Processing receives `{ event_root, union_schema }` from Sample output; Union Schema hardening (10–20 enforcement, 30% threshold, detail panel) may proceed in parallel but is not M13.1 runtime scope.

### 4.5 Baseline

| Responsibility | Description |
|----------------|-------------|
| Baseline creation | Stream-scoped; Union Schema is source of truth for baseline fields |
| Baseline storage | `streams.config_json` / schema observation artifacts |
| Shared across routes | All routes inherit the same baseline |

Route does not own a separate baseline (Union Schema UX Spec §Schema Drift Preparation Extension).

### 4.6 Schema Drift

| Responsibility | Description |
|----------------|-------------|
| Observation | Detect field added/removed/type change at stream level |
| Policy | Stream-scoped drift policy (pass through, quarantine, etc.) |
| Workflow | Stream-scoped drift workflow (M4) |

Drift is observed on **shared extracted events** before route-specific transform. Route may override **unknown field handling** at delivery time (M13.5); drift detection itself remains stream-scoped.

### 4.7 Sensitive Detection

| Responsibility | Description |
|----------------|-------------|
| Detection run | On shared events / Union Schema build |
| Suggestions | Field-level sensitivity hints (no auto-apply) |
| Shared suggestions | Same detection output feeds all route governance UIs |

Route applies **different protection actions** on the same detected fields (Governance UX Charter §Route example: Route A Audit, Route B Mask). Detection is stream/sample scope; protection action is route scope (M13.3).

### 4.8 Stream responsibility summary

```text
Stream OWNS:
  Source connection & fetch
  Record path & Event Root
  Checkpoint
  Union Schema (shared input)
  Baseline & Schema Drift observation/policy
  Sensitive Detection (suggestions)
  Stream-level governance defaults (optional)
  Execution status & scheduling

Stream does NOT OWN (target):
  Per-destination transform
  Per-destination protection/classification/policy execution
  Per-destination delivery formatting (already on Route)
```

---

## 5. Route Responsibilities

Route becomes the **Processing Unit**. M13.1 defines responsibility boundaries; implementation of each concern is deferred to M13.2–M13.6.

### 5.1 Transform

| Aspect | M13.1 definition | Implementation milestone |
|--------|-------------------|-------------------------|
| Scope | Per route | M13.2 |
| Contents | Mapping + Enrichment (unified in UX as "Transform") | M13.2 |
| Input | Shared extracted events + Union Schema | M13.1 contract |
| Output | Route-specific event shape for downstream stages | M13.2 |
| Storage | Route-scoped config (see §8) | M13.1 model + M13.2 populate |

Engines (`app/mappers/mapper.py`, `app/enrichments/`) are reused unchanged; only config source and orchestration slot change (Gap Analysis Q7, Union Schema AC #10).

### 5.2 Protection

| Aspect | M13.1 definition | Implementation milestone |
|--------|-------------------|-------------------------|
| Scope | Per route, with stream defaults | M13.3 |
| Override model | `route_overrides[]` on stream governance rules | M13.1 model + M13.3 apply |
| Input | Route-transformed events | M13.3 |
| Engine reuse | `app/protection/engine.py` | M13.3 |

### 5.3 Classification

| Aspect | M13.1 definition | Implementation milestone |
|--------|-------------------|-------------------------|
| Scope | Per route | M13.4 |
| Input | Route-transformed events (post-protection order TBD in M13.4; current stream order is classification before protection — reorder is M13.4 scope) | M13.4 |
| Engine reuse | `app/classification/service.py` | M13.4 |

### 5.4 Policy

| Aspect | M13.1 definition | Implementation milestone |
|--------|-------------------|-------------------------|
| Scope | Per route | M13.5 |
| Includes | Unknown field policy override, delivery behavior, quarantine triggers | M13.5 |
| Stream policy rules | May serve as defaults via dual-read | M13.5 |
| Engine reuse | Stream policy evaluation pattern in `stream_runner.py` | M13.5 |

### 5.5 Delivery Context

Already partially implemented on Route:

| Field | Current | M13.1 |
|-------|---------|-------|
| `destination_id` | ✅ | Unchanged |
| `formatter_config_json` | ✅ | Unchanged |
| `failure_policy` | ✅ | Unchanged |
| `rate_limit_json` | ✅ | Unchanged |
| `enabled` | ✅ | Unchanged |
| Processing summary / readiness | ❌ | **M13.1 adds conceptual readiness flags** for deploy gating |

Delivery Context is the **terminal route scope** before wire send. M13.6 extends metrics/health; M13.1 ensures the orchestration slot exists after policy evaluation.

### 5.6 Route responsibility summary

```text
Route OWNS (target):
  Transform (mapping + enrichment)
  Protection (with stream default + route override)
  Classification
  Policy evaluation & enforcement
  Delivery context (formatter, failure policy, rate limit)
  Route-level processing readiness

Route does NOT OWN:
  Source fetch
  Event extraction
  Union Schema creation
  Baseline / drift observation
  Sensitive detection (suggestions)
  Checkpoint cursor
```

---

## 6. Route Processing Lifecycle

Lifecycle only — no code. Defines the execution order M13.1 establishes for `StreamRunner` re-orchestration.

### 6.1 Batch lifecycle

```text
┌─────────────────────────────────────────────────────────────┐
│ STREAM SCOPE (once per execution cycle)                      │
├─────────────────────────────────────────────────────────────┤
│ 1. Fetch Data                                                │
│    Source adapter fetch using stream checkpoint              │
│                                                              │
│ 2. Extract Events                                            │
│    Apply record path + event root → raw event list           │
│                                                              │
│ 3. Union Schema / Schema Observation                         │
│    Observe fields; apply baseline comparison (drift)        │
│                                                              │
│ 4. Sensitive Detection                                       │
│    Generate field sensitivity suggestions (shared)           │
│                                                              │
│ 5. Build SharedBatchContext                                  │
│    extracted_events + observation + detection artifacts      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ ROUTE SCOPE (for each enabled route R1..Rn)                  │
├─────────────────────────────────────────────────────────────┤
│ 6. Resolve Route Runtime Context                             │
│    Load route config; dual-read fallback to stream defaults   │
│                                                              │
│ 7. Transform                    [M13.2 slot]                 │
│    Mapping → Enrichment on shared events                     │
│                                                              │
│ 8. Protection                   [M13.3 slot]                 │
│    Apply route protection rules / overrides                  │
│                                                              │
│ 9. Classification               [M13.4 slot]                 │
│    Apply route classification rules                          │
│                                                              │
│ 10. Policy                      [M13.5 slot]                 │
│     Evaluate route policy; quarantine/block decisions        │
│                                                              │
│ 11. Delivery                    [M13.6 slot + existing]      │
│     Format → adapter send → failure policy → delivery_log    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ STREAM SCOPE (once, after all routes complete per policy)    │
├─────────────────────────────────────────────────────────────┤
│ 12. Checkpoint                                               │
│     Update stream cursor if delivery transaction succeeds    │
│     (per specs/004-delivery-routing failure policy rules)    │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Lifecycle invariants

| Invariant | Source |
|-----------|--------|
| Shared phases run **once** per batch | Performance, Product Charter |
| Route phases run **N times** (enabled routes) | Route = Processing Unit |
| Route failure isolation follows existing failure policy | `specs/004-delivery-routing/spec.md` |
| Checkpoint not updated on partial failure (except LOG_AND_CONTINUE) | Existing rule |
| Dynamic routing / failover remain compatible | `specs/067-failover-routing/spec.md` |
| Replay/quarantine may reference `route_id` | Gap Analysis §5.3 |

### 6.3 Preview lifecycle (foundation)

Transform Preview and Pipeline Debug must accept an optional `route_id` parameter in future APIs (M13.1 defines the requirement; M13.2+ implement). Preview runs the route-scoped chain against sample events without delivery.

---

## 7. Route Runtime Context

Conceptual runtime object required for per-route processing. M13.1 defines the shape; population occurs across M13.2–M13.6.

### 7.1 RouteRuntimeContext

```text
RouteRuntimeContext
├── route_id                    (UUID)
├── stream_id                   (UUID)
├── destination_id              (UUID)
├── enabled                     (bool)
│
├── shared_input                (reference, read-only)
│   ├── extracted_events[]      (from SharedBatchContext)
│   ├── union_schema            (from stream sample contract)
│   ├── event_root              (string, JSONPath)
│   ├── sensitive_suggestions[] (from stream detection)
│   └── schema_observation      (drift signals, baseline ref)
│
├── effective_config            (resolved via dual-read)
│   ├── transform               (nullable → M13.2)
│   ├── protection              (nullable → M13.3)
│   ├── classification          (nullable → M13.4)
│   ├── policy                  (nullable → M13.5)
│   └── delivery                (existing route delivery fields)
│
├── processing_state            (mutable per batch)
│   ├── stage_timeline[]        (for pipeline debug)
│   ├── current_events[]        (route-transformed payload)
│   └── errors[]                (structured, per stage)
│
└── delivery_context            (existing)
    ├── formatter_config
    ├── failure_policy
    ├── rate_limit
    └── destination_adapter_ref
```

### 7.2 SharedBatchContext

```text
SharedBatchContext
├── stream_id
├── batch_id                    (correlation id)
├── extracted_events[]
├── schema_observation
├── sensitive_detection_result
├── union_schema_ref            (or inline snapshot)
└── checkpoint_cursor_before
```

### 7.3 Config resolution

```text
resolve_route_config(route_id):
  for each concern in [transform, protection, classification, policy]:
    if route has config for concern:
      use route config
    else if stream has config for concern:
      use stream config (backward compatibility)
    else:
      use platform default / empty pass-through
```

M13.1 requires `stream_loader` to produce a list of `RouteRuntimeContext` objects per stream load. Stage executors receive context, not raw stream dict.

### 7.4 Feature flag

```text
GDC_ROUTE_PROCESSING_ENABLED
  false (default): legacy path — process once at stream scope, fan-out identical payload
  true:            new path — shared phase + per-route loop (stages no-op until M13.2+)
```

M13.1 must ship with flag **off** by default so existing streams behave identically until downstream milestones populate stage slots.

---

## 8. Database Impact

Conceptual model only — no SQL, no migrations in this document.

### 8.1 Current model

| Table / artifact | Scope | Role |
|------------------|-------|------|
| `streams` | Stream | Execution unit, source binding, drift policy in `config_json` |
| `routes` | Route | Delivery link: destination, formatter, failure, rate limit |
| `mappings` | Stream | UNIQUE `stream_id` |
| `enrichments` | Stream | UNIQUE `stream_id` |
| `stream_protection_rules` | Stream | `stream_id` FK |
| `stream_classification_rules` | Stream | `stream_id` FK |
| `stream_policy_rules` | Stream | `stream_id` FK |
| `stream_policy_assignments` | Stream | Governance catalog assignment (M18) |
| `checkpoints` | Stream | Cursor |
| `delivery_logs` | Route-aware partial | `route_id` in context |

### 8.2 Future model (M13.1 configuration design)

M13.1 defines the **Route Configuration Model** — additive artifacts required before M13.2–M13.5 can persist per-route config:

| Artifact | Approach (conceptual) | Introduced by |
|----------|----------------------|---------------|
| Route mapping | `route_mappings` UNIQUE `route_id` OR nullable `route_id` on `mappings` | M13.1 model; M13.2 populate |
| Route enrichment | `route_enrichments` OR nullable `route_id` on `enrichments` | M13.1 model; M13.2 populate |
| Route protection rules | `route_protection_rules` OR `route_id` on existing table | M13.1 model; M13.3 populate |
| Route classification rules | `route_classification_rules` | M13.1 model; M13.4 populate |
| Route policy rules | `route_policy_rules` | M13.1 model; M13.5 populate |
| Route governance overrides | `route_governance_overrides` JSON or normalized | M13.1 model; M13.3+ apply |
| Route processing metadata | Optional summary JSON on `routes` (readiness, last config hash) | M13.1 |
| Quarantine / replay | Nullable `route_id` on relevant tables | M13.1 model; M13.5+ wire |

**Design decision for M13.1:** Prefer **additive tables** (`route_*`) over breaking existing UNIQUE constraints on stream tables. Dual-read uses stream tables as fallback. This preserves user data (workspace rule: no truncate of live config).

### 8.3 Unchanged entities

`connectors`, `sources`, `streams`, `destinations`, `checkpoints`, core `routes` FK shape `(stream_id, destination_id)`.

### 8.4 Migration scale estimate (for planning only)

From Gap Analysis — not executed in M13.1:

- 8–15 additive Alembic migrations (phased across M13.1–M13.6)
- Backfill: copy stream config to each existing route (O(routes))
- ~213 Python files reference `stream_id` — route context review in M13.2+

---

## 9. API Impact

Conceptual only — no endpoint implementation in M13.1.

### 9.1 Current APIs (stream-centric)

Representative existing surface:

```text
/runtime/streams/{id}/mapping-ui/*
/runtime/streams/{id}/enrichment-ui/*
/runtime/streams/{id}/protection-rules
/runtime/streams/{id}/classification-rules
/runtime/streams/{id}/policy-rules
/runtime/preview/*                    (stream-scoped)
```

~47 `/runtime/streams/{id}/...` processing endpoints (Gap Analysis §5.2).

Route APIs today are delivery-focused:

```text
/runtime/routes/{id}                  (CRUD, delivery fields)
```

### 9.2 Required future API shape (M13.1 defines contract)

M13.1 establishes that route-scoped endpoints **will** exist; first implementations arrive with M13.2–M13.5:

```text
GET/POST /runtime/routes/{route_id}/mapping-ui/config|save      [M13.2]
GET/POST /runtime/routes/{route_id}/enrichment-ui/config|save   [M13.2]
GET/POST /runtime/routes/{route_id}/protection-rules              [M13.3]
GET/POST /runtime/routes/{route_id}/classification-rules          [M13.4]
GET/POST /runtime/routes/{route_id}/policy-rules                  [M13.5]
GET/PUT  /runtime/streams/{id}/governance  (+ route_overrides[])  [M13.3+]
POST     /runtime/preview/*  (route_id parameter)                 [M13.2+]
GET      /runtime/routes/{route_id}/processing-readiness          [M13.1]
```

### 9.3 Compatibility shim (M13.1 policy)

During transition:

| Caller | Behavior |
|--------|----------|
| Stream-scoped write API | Write-through to all routes OR primary route (TBD in M13.2); dual-write |
| Stream-scoped read API | Aggregate from routes OR return stream fallback |
| Route-scoped write API | Write route config only |
| Route-scoped read API | Route config with stream fallback via dual-read |

Stream endpoints **remain** until deprecation phase (Gap Analysis §13). M13.1 documents the policy; shim implementation spans M13.2–M13.10.

### 9.4 Governance API extension (foundation)

Violations, quarantine, replay responses **will** include `route_id` where applicable. Simulation/impact APIs **will** accept route filter. M13.1 defines the dimension; M13.9 implements dashboard breakdown.

---

## 10. Frontend Impact

M13.1 defines UX foundation and touchpoints — not full UI implementation.

### 10.1 Wizard (Destination First)

**Target order** (Wizard Charter v5.2, supersedes current v3.0 step order):

```text
1. Connect
2. Sample & Record Selection   → Union Schema output
3. Destinations                → auto-create route per destination
4. Route Processing            → per-route tabs (M13.2+ UI)
5. Deploy
```

**M13.1 foundation deliverables (conceptual):**

| Item | M13.1 scope |
|------|-------------|
| Step reorder in `wizard-state.ts` | Define; implement in Destination First milestone (P7) |
| `WizardRouteDraft` extension | Add placeholders for transform/governance state |
| Sample → Route Processing contract | `{ event_root, sample_count, union_schema }` formalized |
| Auto-route from destination selection | Design: each destination → one route draft |

**Not M13.1:** Full `step-route-processing.tsx`, per-route transform UI (M13.2+), governance tabs (M13.3–M13.5).

### 10.2 Edit Wizard / Stream Edit

| Surface | M13.1 definition |
|---------|------------------|
| Stream mapping page | Will become route-aware or redirect to route selector |
| Route edit page | Will expand from delivery-only to processing tabs |
| Stream governance drawer | Stream defaults + route override entry points |

Implementation deferred; M13.1 documents navigation intent per UX Charter §26.

### 10.3 Destination UI

Destinations remain global library. Route attachment occurs in Wizard Step 3 (Destinations). No change to destination entity model in M13.1.

### 10.4 Governance Workspace

| Area | M13.1 foundation | Implementation |
|------|------------------|----------------|
| Configuration scope | Stream owns defaults | Documented |
| Route overrides UI | Left panel: Default Rule + Route Overrides | M13.9 |
| Dashboard route dimension | Stream + Route breakdown | M13.9 |
| Violations/quarantine route filter | API contract | M13.9 |

**Conflict resolution:** Governance Workspace Implementation Spec placed governance at "Step 4 Data Processing" before Destinations. **Wizard Charter v5.2 order wins:** Destinations (Step 3) → Route Processing (Step 4). M13.1 adopts v5.2 (Gap Analysis §9).

### 10.5 Union Schema UI

Union Schema remains in Sample step output, consumed by Route Processing step. `buildUnionSchema()`, `UnionSchemaTree` reused per route tab (Gap Analysis Q6). M13.1 formalizes the contract; hardening (10–20 events, 30% rare threshold) is parallel track P6.

---

## 11. Backward Compatibility Strategy

Conceptual only — no migration execution in M13.1.

### 11.1 Principles

1. **Additive DB** — no truncate of user streams, routes, mappings (workspace rule)
2. **Feature flag** — `GDC_ROUTE_PROCESSING_ENABLED`, default off
3. **Dual-read** — route config if present, else stream fallback
4. **Dual-write transition** — stream APIs mirror to all routes during migration window

### 11.2 Existing stream behavior (flag off)

When `GDC_ROUTE_PROCESSING_ENABLED=false`:

- Runtime path identical to today
- Stream-scoped mapping/enrichment/governance applied once
- Fan-out sends identical payload to all routes
- All existing streams continue without operator action

### 11.3 Existing stream behavior (flag on, pre-backfill)

When flag on but route config empty:

- Dual-read falls back to stream config for every route
- Behavior equivalent to flag off until route config populated
- Enables gradual rollout per stream or tenant

### 11.4 Data backfill (future)

For each stream with routes R1..Rn:

| Scenario | Auto-conversion |
|----------|-----------------|
| 1 stream, N routes, same transform | **Yes** — duplicate stream config to each route |
| 1 stream, 1 route | **Yes** — copy/move |
| Duplicate streams for different transforms (same source) | **No** — operator merge UI required |

Backfill tool is P4 (Gap Analysis §12); M13.1 defines the policy.

### 11.5 API compatibility

| Layer | Strategy |
|-------|----------|
| Stream endpoints | Remain; write-through during transition |
| Route endpoints | Additive; new clients use route scope |
| Runtime loader | Dual-read in `stream_loader` |
| UI | Legacy URLs redirect with banner |
| Backup import | Accept both shapes in `import_validator` |
| Tests | e2e passes flag off; new matrix flag on |

### 11.6 Deprecation path (post-M13)

Stream-scoped **writes** deprecated after Wizard + Route edit parity (P10). Stream-scoped **reads** may remain for aggregate views. Timeline not in M13.1 scope.

---

## 12. Risk Analysis

### 12.1 Runtime risk

| Risk | Severity | Mitigation |
|------|----------|------------|
| Orchestration refactor breaks existing streams | **High** | Feature flag default off; dual-read; extensive e2e with flag off |
| Stage ordering change (classification vs protection) | **Medium** | M13.4 explicitly owns order decision; M13.1 preserves slots only |
| N routes × transform cost | **Medium** | Shared extract once; batch rule loading; benchmark in P11 |
| Checkpoint semantics drift | **High** | M13.1 invariant: checkpoint on shared cursor, not route shapes |
| Dynamic routing / failover interaction | **Medium** | Lifecycle §6.2 preserves compatibility; test matrix in M13.6 |

### 12.2 Migration risk

| Risk | Severity | Mitigation |
|------|----------|------------|
| Data loss on schema change | **High** | Additive tables only; no drop of stream tables |
| Backfill incorrect for divergent routes | **Medium** | Dry-run report (P4); operator review |
| Duplicate streams same source (user workaround) | **Medium** | No auto-merge; operator merge UI |
| 213 files with `stream_id` assumptions | **Medium** | Phased review; route context injected at loader boundary |
| Import/export shape mismatch | **Low** | `import_validator` accepts both shapes |

### 12.3 UX risk

| Risk | Severity | Mitigation |
|------|----------|------------|
| Wizard step reorder confuses existing users | **Medium** | Banner, docs, optional legacy edit paths during transition |
| Governance workspace spec conflict | **Medium** | Adopt Wizard v5.2 order (§10.4) |
| Per-route complexity overload | **Medium** | Destination First: only show route tabs when N destinations; stream defaults reduce repetition |
| Internal engine names exposed | **Low** | UX Charter: Transform not Mapping/Enrichment in UI |

### 12.4 Performance risk

| Risk | Severity | Mitigation |
|------|----------|------------|
| Linear cost with route count | **Medium** | Shared phases O(1); route phases O(N); benchmark P11 |
| Rule loading N queries | **Low** | Batch load all route configs in `stream_loader` |
| Memory duplication of events | **Low** | SharedBatchContext read-only reference; copy-on-write at protection stage if needed |

### 12.5 Program risk

| Risk | Severity | Mitigation |
|------|----------|------------|
| WBS "100% complete" vs M13 work | **Low** | Treat M13.1–M13.6 as explicit post-GA phase (Gap Analysis Appendix C) |
| Scope creep into M13.2+ | **High** | This spec §13 boundaries enforced |
| Parallel pipeline proposed | **High** | Product Charter guardrail; architecture review gate |

---

## 13. Implementation Boundaries

### 13.1 IN scope (M13.1 deliverables)

| # | Deliverable | Description |
|---|-------------|-------------|
| 1 | **Architecture spec** | `specs/091-route-processing-architecture/spec.md` (companion to this doc) |
| 2 | **Route Configuration Model** | Conceptual schema for route-scoped config artifacts (§8.2) |
| 3 | **Route Runtime Context** | `RouteRuntimeContext` + `SharedBatchContext` definitions (§7) |
| 4 | **Route Processing Lifecycle** | Shared vs per-route phase contract (§6) |
| 5 | **Stream/Route responsibility split** | Authoritative boundary (§4, §5) |
| 6 | **Dual-read resolution contract** | Config fallback order (§7.3) |
| 7 | **Feature flag definition** | `GDC_ROUTE_PROCESSING_ENABLED` behavior (§7.4) |
| 8 | **StreamRunner orchestration contract** | Hook points for per-route loop without implementing stages |
| 9 | **API contract outline** | Route-scoped endpoint plan + compatibility shim policy (§9) |
| 10 | **Backward compatibility policy** | Flag, dual-read, dual-write, backfill rules (§11) |
| 11 | **Sample → Route Processing contract** | Union Schema payload shape (§4.4, Union Schema Spec §Route Processing Contract) |
| 12 | **Constitution / spec index update** | Reference M13.1 in `.specify/specs-index.md` |

### 13.2 OUT of scope (explicitly NOT M13.1)

| Milestone | Excluded work |
|-----------|---------------|
| **M13.2** | Route mapping/enrichment storage, route transform APIs, route transform UI, mapper invocation per route |
| **M13.3** | Route protection rules, protection override application, route protection UI |
| **M13.4** | Route classification rules, classification per route, stage ordering decision |
| **M13.5** | Route policy rules, policy evaluation per route, unknown field override runtime |
| **M13.6** | Route metrics, route health, delivery observability extensions |
| **Wizard P7** | Full Destination First step reorder and `step-route-processing.tsx` |
| **Governance P9** | Route-aware dashboard, violations route breakdown |
| **Union Schema P6** | 10–20 enforcement, 30% rare threshold, field detail panel |
| **Backfill P4** | Migration script execution |
| **Any** | New runtime, new delivery engine, new governance engine, Enterprise IAM (M25) |

### 13.3 M13.1 implementation sequence (recommended)

Aligned with Gap Analysis §14, scoped to foundation only:

| Step | Action | Output |
|------|--------|--------|
| 1 | Publish `specs/091-route-processing-architecture/spec.md` | Engineering authority |
| 2 | Add feature flag (default off) | Safe rollout gate |
| 3 | Define Route Configuration Model (additive tables, no data yet) | Schema design ready for M13.2 |
| 4 | Refactor `stream_loader` to emit `RouteRuntimeContext[]` | Loader contract |
| 5 | Refactor `StreamRunner` shared/per-route split (stages no-op) | Orchestration skeleton |
| 6 | Add `processing-readiness` conceptual endpoint stub | Deploy gating hook |
| 7 | Document Sample → Route contract in API spec | Wizard integration ready |

Steps 2–7 are **implementation work for subsequent tasks**, authorized by this spec — not performed during spec creation.

### 13.4 Acceptance criteria (M13.1 complete when)

1. `specs/091-route-processing-architecture/spec.md` exists and aligns with this document.
2. `StreamRunner` can execute shared phase + iterate routes with empty stage slots when flag on.
3. `stream_loader` produces `RouteRuntimeContext` with dual-read resolution.
4. Route Configuration Model documented with additive table design (no stream table breaking changes).
5. Feature flag off → byte-for-byte behavioral parity with current runtime (e2e verified).
6. No M13.2–M13.6 functionality shipped under M13.1 label.

---

## Appendix A — Source of Truth References

| Document | Relevant sections |
|----------|-------------------|
| Product Charter 1.2.1 | Route Based Processing, Technical Principles, Architecture Guardrails |
| Master WBS 1.2.1 | M13.1 scope; M13.2–M13.6 deferred |
| UX Charter 1.2.1 | §24–29 Route model, Destination First |
| Stream Wizard Charter v5.2 | 5-step order, Route Processing step |
| Governance UX Charter v1.1 | §12–14 Destination First Governance, Configuration vs Execution scope |
| Governance Workspace v1.1 | Route Architecture Extension, route_overrides model |
| Governance & Transform Policy v1.1 | §17–19 Route transform policy |
| Union Schema UX Spec v1.1 | Route Architecture Extension, Route Processing Contract |
| ChatGPT Guardrail v1.0 | No new governance categories; Runtime priority |

---

## Appendix B — Code Evidence Index

| Area | Path |
|------|------|
| StreamRunner | `app/runners/stream_runner.py` |
| Stream loader | `app/runners/stream_loader.py` |
| Route model | `app/routes/models.py` |
| Mapping model | `app/mappings/models.py` |
| Runtime API | `app/runtime/router.py` |
| Wizard state | `frontend/src/components/streams/wizard/wizard-state.ts` |
| Union Schema | `frontend/src/utils/unionSchema.ts` |
| Gap analysis | `docs/architecture/route-architecture-gap-analysis.md` |

---

## Appendix C — Related Specs

| Spec | Relationship |
|------|--------------|
| `specs/001-core-architecture/spec.md` | Entity rules; Stream execution unit |
| `specs/002-runtime-pipeline/spec.md` | Pipeline stages; requires M13.1 addendum |
| `specs/003-db-model/spec.md` | DB patterns; requires route scope extension |
| `specs/004-delivery-routing/spec.md` | Fan-out, checkpoint, failure policy |
| `specs/064-advanced-transform/spec.md` | Transform engine unchanged; config source moves to route |
| `specs/091-route-processing-architecture/spec.md` | **To be created** — engineering companion |

---

*End of M13.1 implementation specification. No code, database, API, runtime, or frontend changes were made.*
