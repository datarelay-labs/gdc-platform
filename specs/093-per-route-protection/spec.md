# M13.3 Per Route Protection

**Milestone:** M13.3 (Per Route Protection)
**Status:** CURRENT implementation spec for M13.3 (delivered). Original M13 rollout assumed flag default OFF; product default is ON as of P1-4 (`false` = rollback).
**Depends on:** M13.1 Route Processing Foundation (`specs/091-route-processing-architecture/spec.md`), M13.2 Per Route Transform (`specs/092-per-route-transform/spec.md`)
**Design review:** [`docs/architecture/m13-3-protection-design-review.md`](../../docs/architecture/m13-3-protection-design-review.md) (M13.3 findings incorporated); [`docs/architecture/m13-route-architecture-design-review.md`](../../docs/architecture/m13-route-architecture-design-review.md)
**Authority:** Product Charter 1.2.1, Master WBS 1.2.1, `.specify/memory/constitution.md`, Governance & Transform Policy v1.1, Governance UX Charter v1.1, Governance Workspace v1.1
**Architecture:** [`docs/architecture/route-processing-foundation-implementation-spec.md`](../../docs/architecture/route-processing-foundation-implementation-spec.md)
**Gap analysis:** [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)

---

## 1. Problem Statement

Protection is **Stream-scoped** today. One protection rule set applies to all destinations on a stream. After transform (currently also stream-scoped), `_prepare_delivery_events()` builds a **single masked outbound copy** that `_fan_out()` sends identically to every route.

```text
Stream
↓
Transform (stream-scoped)
↓
Protection once (stream-scoped)
↓
Fan-out (identical protected payload)
↓
Destinations
```

**Product violation:** Operators who need different protection per destination (e.g. Route A → internal syslog **Audit Only**, Route B → third-party SaaS **Mask**, Route C → data lake **Tokenize**) must **duplicate Streams** for the same source. Product Charter 1.2.1 and Governance Policy §20 explicitly forbid this: *목적지별 처리 차이는 Route를 통해 구성한다* and *users must not duplicate Streams because destinations require different processing*.

**Gap (evidence):** `stream_protection_rules.stream_id` FK only; no `route_id`; `_prepare_delivery_events()` in `app/runners/stream_runner.py` runs once per batch; `protect_batch()` in `app/protection/engine.py` receives stream rules only; Governance Workspace `route_overrides[]` model exists in SoT but not in runtime.

**M13.2 delivers:** Per-route Transform inside `process_route_pipeline()`; Protection **stub** (pass-through); stream-level `_prepare_delivery_events()` disabled when `GDC_ROUTE_PROCESSING_ENABLED=true`.

**M13.3 solves:** Activate the **Protection stage** inside the per-route pipeline using the **existing Protection Engine**, with **route-aware effective rules** (stream defaults + route override merge + optional route rule table fallback), **reusing stream-scoped Sensitive Detection results**, so each route can deliver a **different protected payload** without Stream duplication.

**Explicit non-goals in this spec:** Classification design (M13.4), Policy design (M13.5), Delivery observability extensions (M13.6).

---

## 2. Source Of Truth Alignment

| Document | Mandate relevant to M13.3 |
|----------|---------------------------|
| **Product Charter 1.2.1** | Route = Destination Specific Processing Unit; Protection route-applicable; Runtime Reuse First; No Parallel Pipeline; Core Pipeline includes Protection before Classification |
| **Master WBS 1.2.1** | M13.3 = Route Specific Protection, Route Protection Override |
| **UX Charter 1.2.1** | §24–27 Route model; per-destination governance via Route, not Stream duplication |
| **Stream Wizard Charter v5.2** | Step 4 Route Processing → Protection tab per route; Destination First → Route Processing Second |
| **Governance UX Charter v1.1** | §12–14 Configuration Scope = Stream, Execution Scope = Route; Route A Audit / Route B Mask / Route C Tokenize example |
| **Governance Workspace v1.1** | Governance Rule + `route_overrides[]`; Default Rule + Route Override UI; Route Preview per route |
| **Governance & Transform Policy v1.1** | §14–15 Data Protection MVP actions; §20 Route Protection Policy (Default + Route Override); §21 Route Aware Schema Drift (unknown field route override intent); §23 Route Aware Auto Protect |
| **Union Schema UX Spec v1.1** | Union Schema = shared input; protection configures **how** to protect detected fields, not field catalog |
| **M13 design review** | Protection dual-read = stream rules + `route_overrides[]` merge; shared-phase schema drift when flag ON |
| **M13.3 design review** | `RouteProtectionConfig`; fan-out protected only; Classification/Policy stubs remain NO-OP |
| **ChatGPT Guardrail v1.0** | No new governance categories; reuse runtime; no parallel engines |

**Constitution (unchanged):**

- Checkpoint updated only after successful Destination delivery
- Stream = execution unit; Route connects Stream → Destination
- Delivery failures logged structurally
- No parallel pipeline or governance engine

**Critical rules (task mandate):**

| Rule | M13.3 interpretation |
|------|----------------------|
| Reuse existing Protection Engine | Invoke `protect_batch()` / `protect_events_for_delivery()` — no rewrite |
| Reuse Sensitive Detection results | Input from `SharedBatchContext.sensitive_detection_result` — no re-detection per route |
| Do NOT create new Protection Engine | Config resolution and orchestration only |
| Do NOT create parallel runtime | Protection stage inside existing `process_route_pipeline()` |
| Route Protection additive | New tables/APIs; stream tables preserved |
| Existing Streams continue working | Dual-read + flag OFF parity |
| Fallback Route → Stream | Route config absent → stream protection rules |

---

## 3. Current Protection Model

### 3.1 Storage

| Entity | Scope | Key fields |
|--------|-------|------------|
| `stream_protection_rules` | Stream | `stream_id`, `field_path`, `sensitivity_class`, `protection_mode`, `enabled`, `source_finding_id` |
| `identity_vault_entries` | Stream | Tokenization vault keyed by `stream_id` + field path + value hash |
| `stream_sensitive_findings` | Stream | Sensitive Detection persistence (feeds rule creation) |
| Stream schema drift policy | Stream | `streams.config_json` — `unknown_normal_field_policy`, `unknown_sensitive_field_policy` |

**Evidence:** `app/protection/models.py` — no `route_id` on protection tables.

**Protection modes implemented today:** `full_mask`, `partial_mask`, `hash`, `tokenization` (`PROTECTION_MODES` in `app/protection/models.py`).

**Not implemented in engine:** `remove` (listed in Governance Workspace SoT dropdown but absent from `PROTECTION_MODES` and `apply_protection_mode()`).

### 3.2 Governance configuration model (SoT, not fully runtime-wired)

Governance Workspace v1.1 defines:

```text
Governance Rule
  field_path
  sensitivity_type
  default_protection_action
  default_delivery_behavior
  route_overrides[]
    route_id
    protection_action
    delivery_behavior
    enabled
```

**Evidence:** No `route_overrides` persistence or runtime merge in codebase (Gap Analysis Q5).

### 3.3 Runtime loading

`stream_loader` loads `stream_protection_rules` onto stream runtime dict. Routes carry **delivery fields only**.

### 3.4 Runtime execution (legacy + M13.2 target path)

**Flag OFF (legacy — unchanged):**

```text
_collect_and_transform_events()
  → Mapping → Enrichment → Sensitive Detection → Classification → Schema Drift Policy

→ _prepare_delivery_events()          ← stream Protection (protect_batch)
→ _evaluate_policies()               ← stream Policy (M13.5 scope)
→ _fan_out(delivery_events)          ← identical payload all routes
```

**Flag ON + M13.2 (Protection stub — pre-M13.3):**

```text
Shared Phase → extracted_events + sensitive_detection_result
  (schema drift policy — required by M13.3 §8.1; gap if not wired)

→ process_route_pipeline() per route
     Transform (active)
     Protection stub (pass-through)
     Classification stub / Policy stub (NO-OP)
→ _fan_out(per-route RouteStageResult.events)   ← unprotected until M13.3 §4.6
```

**Flag ON + M13.3 (target):**

```text
Shared Phase → extracted_events + sensitive_detection_result
  + schema_drift_policy_result + ephemeral_auto_protect_rules

→ process_route_pipeline() per route
     Transform → Protection (active) → Classification stub → Policy stub
→ _fan_out(protected RouteStageResult.events only)
```

Stream `_prepare_delivery_events()` **must not** run when flag ON (spec 092 §9.2).

### 3.5 Sensitive Detection integration (current)

| Phase | Scope | Output |
|-------|-------|--------|
| Sensitive Detection | Stream (shared phase) | Findings / suggestions persisted to `stream_sensitive_findings`; context attached to runner |
| Schema Drift Policy | Stream (shared phase) | May emit `ephemeral_protection_rules` for Auto Protect on unknown sensitive fields |
| Protection | Stream (once) | Applies persisted rules + ephemeral rules via `protect_batch()` |

Route context is **not** considered when selecting protection mode today.

---

## 4. Target Protection Model

### 4.1 Topology (unchanged)

```text
One Stream → Many Routes → Many Destinations
Execution Unit: Stream
Processing Unit: Route (protection execution)
Configuration Scope: Stream (defaults + override catalog)
Execution Scope: Route (effective protection per destination)
```

### 4.2 Target pipeline (flag ON + M13.3)

```text
SHARED PHASE (once per batch)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → Schema Drift Policy (M13.3 prerequisite — mandatory when flag ON)
  → SharedBatchContext (
       extracted_events,
       sensitive_detection_result,
       schema_drift_policy_result,
       ephemeral_auto_protect_rules,
       schema_observation,
       union_schema, …
     )

PER-ROUTE LOOP — process_route_pipeline()
  → Transform           (M13.2 — active)
  → Protection          (M13.3 — ACTIVE)
  → Classification stub (M13.4)
  → Policy stub         (M13.5)
  → Delivery handoff    → RouteStageResult

Fan-out(per-route protected events only — see §4.6)
Checkpoint (stream cursor — unchanged)
```

### 4.6 Fan-out requirement (mandatory)

When `GDC_ROUTE_PROCESSING_ENABLED=true` and M13.3 is active:

- `_fan_out()` **must** consume `RouteStageResult.events` **after** the Protection stage completes.
- `_fan_out()` **must not** deliver unprotected route transform output.
- Each route receives its **protected** outbound copy; divergent protection per route is the product goal.

```text
route_payloads[route_id] = RouteStageResult.events   # post-protection only

_fan_out(..., route_payloads=route_payloads)
```

**Rejected:** Delivering M13.2 transform output while Protection stub is pass-through once M13.3 ships.

### 4.3 Protection input and output

| Aspect | Source | Notes |
|--------|--------|-------|
| **Input events** | `route_ctx.processing_state.current_events` | Post-route-transform shape — field paths must match transformed output |
| **Detection context** | `shared_batch.sensitive_detection_result` | Stream-scoped; reused for Auto Protect ephemeral rules and audit metadata |
| **Ephemeral rules** | `SharedBatchContext.ephemeral_auto_protect_rules` | From shared-phase schema drift policy; route may override resulting mode via effective config |
| **Drift policy result** | `SharedBatchContext.schema_drift_policy_result` | Shared batch artifact; quarantine/review signals for M13.5 (not enforced in M13.3) |
| **Config** | `route_ctx.effective_config.protection` (`RouteProtectionConfig`) | Resolver per §6.1; attached at load time |
| **Engine** | `app/protection/engine.py` — `protect_batch()` | Unchanged algorithm |
| **Output** | Updated `current_events` (protected copy) | Fed to Classification stub; checkpoint still references shared unprotected extract |

### 4.4 Per-route payload divergence (product example)

```text
Office365 Stream — shared Sensitive Detection finds $.user.email, $.user.id

Route A → Internal Syslog     → Audit Only (no field mutation)
Route B → Third-Party XDR     → Mask Partial on $.user.email
Route C → Data Lake           → Tokenize on $.user.email, Hash on $.user.id
```

Same stream, same detection, **different protected outbound events** per route — no Stream duplication.

### 4.5 Invariants

| Invariant | Source |
|-----------|--------|
| Sensitive Detection runs **once** per batch (stream scope) | Performance; Union Schema contract |
| Protection runs **N times** (enabled routes) | Route = Processing Unit |
| Existing Protection Engine algorithms unchanged | Rule 1, Rule 3 |
| Tokenization vault remains **stream-scoped** (`stream_id` key) | Existing `identity_vault_entries` — route_id not required for token reuse across routes on same stream |
| No parallel protection pipeline | Product Charter |
| Checkpoint not tied to route-specific protected shapes | specs/004-delivery-routing, spec 092 §9.3 |

---

## 5. Protection Ownership Model

### 5.1 Definitions

| Concept | Owner | Role in M13.3 |
|---------|-------|---------------|
| **Stream Protection** | Stream | Default protection rules (`stream_protection_rules`); stream-level governance defaults; container for `route_overrides[]` |
| **Route Protection Override** | Route (via override entry) | Per-route `protection_action` override for a stream governance rule (Governance Workspace model) |
| **Route Protection Rules** | Route (optional full set) | Additive `route_protection_rules` when operator configures a **complete** alternate rule set for one route |
| **Sensitive Detection Findings** | Stream (Sample / runtime) | Shared suggestions — **not** duplicated per route |
| **Unknown Field Auto Protect policy** | Stream default (+ route override intent) | Drives ephemeral rules; M13.3 applies effective mode per route at protection stage |
| **Delivery Behavior** (Continue / Quarantine / Block) | Policy (M13.5) | Stored alongside protection in governance UI; **not enforced in M13.3** — documented for config continuity only |

### 5.2 Inheritance

```text
Effective protection for route R:

  Step 1 — Persisted base (resolution order, full-bundle fallback):
    if route_protection_rules(R) has any enabled rules:
      persisted_base = route_protection_rules(R)
    else if stream_protection_rules(stream) has any enabled rules:
      persisted_base = stream_protection_rules(stream)
    else:
      persisted_base = empty

  Step 2 — Ephemeral Auto Protect (shared batch):
    ephemeral = SharedBatchContext.ephemeral_auto_protect_rules
    merged = merge_ephemeral_persisted(persisted_base, ephemeral)
    # ephemeral adds unknown-field rules; does not replace persisted paths unless override says so

  Step 3 — Route override merge (Governance Workspace):
    overrides = stream_governance.route_overrides where route_id = R and enabled
    effective = apply_route_overrides(merged, overrides)

  Step 4 — Empty config:
    if effective rules empty and no audit_only_paths → pass-through (no field mutation)
```

**Resolution order (normative fallback for persisted base):**

```text
route_protection_rules
↓
stream_protection_rules
↓
(empty persisted base — ephemeral applied in Step 2)
↓
ephemeral_auto_protect_rules (from shared batch)
↓
empty config (pass-through)
```

**Inheritance summary:** Routes **inherit** stream protection rules by default. Routes **override** specific fields via `route_overrides[]` or replace the entire persisted rule set via `route_protection_rules`.

### 5.3 Override

| Override type | Mechanism | Semantics |
|---------------|-----------|-----------|
| **Field-level route override** | `route_overrides[]` entry matching `route_id` + `field_path` | Replaces `protection_mode` / action for that field on that route only |
| **Full route rule set** | `route_protection_rules` rows for `route_id` | Replaces stream rule set as base (Step 1) — other routes unaffected |
| **Audit Only override** | Override action = Audit Only | No `stream_protection_rules` row required for that field on that route; skip field mutation; audit via delivery logs |

Override **does not** mutate stream defaults. Other routes continue using stream base unless they have their own overrides.

### 5.4 Stream Protection after M13.3

| Mode | Stream protection role |
|------|------------------------|
| Flag OFF | Authoritative — executed in `_prepare_delivery_events()` (legacy) |
| Flag ON, no route rows / overrides | Fallback base for every route via dual-read |
| Flag ON, route overrides present | Stream rules remain base; overrides applied per route |
| Flag ON, route_protection_rules present | Route-specific base for that route only |

### 5.5 Relationship to M13.2 Transform

Transform produces route-specific **field paths and shapes**. Protection evaluates rules against **route-transformed events**. A rule targeting `$.email` applies after transform renames or drops fields — operators must configure paths consistent with route transform output (Wizard Route Preview responsibility).

No ownership conflict: Transform owns shape; Protection owns outbound field mutation (spec 092 §5.5).

---

## 6. Configuration Resolution Model

### 6.0 RouteProtectionConfig (typed model)

M13.3 **must** attach a typed `RouteProtectionConfig` to `RouteRuntimeContext.effective_config.protection` (replacing `Any | None` placeholder).

```text
RouteProtectionConfig
├── rules[]                    # effective rules for protect_batch()
│     field_path
│     protection_mode          # full_mask | partial_mask | hash | tokenization
│     sensitivity_class
│     enabled
│     source                   # route | stream | route_override | ephemeral
├── audit_only_paths[]         # field paths with Audit Only override (no mutation)
├── resolution
│     persisted_source         # route | stream | empty
│     override_count           # int
│     ephemeral_rule_count     # int
│     fallback_used            # bool
└── empty                      # true when no rules and no audit-only paths
```

Loader **must** populate via `resolve_protection_config(route_id, stream_id, shared_batch)` before or at protection stage entry.

### 6.1 Dual-read and resolver algorithm (normative)

Protection resolution **differs from Transform dual-read** (design review §4.5): Transform uses full-bundle replace; Protection uses **persisted fallback chain + ephemeral merge + override merge**.

```text
resolve_protection_config(route_id, stream_id, shared_batch) -> RouteProtectionConfig:

  # Persisted base — full-bundle fallback
  route_rules = load_route_protection_rules(route_id, enabled_only=True)
  stream_rules = load_stream_protection_rules(stream_id, enabled_only=True)

  if route_rules is not empty:
    persisted_base = route_rules
    persisted_source = "route"
  elif stream_rules is not empty:
    persisted_base = stream_rules
    persisted_source = "stream"
  else:
    persisted_base = []
    persisted_source = "empty"

  # Ephemeral Auto Protect from shared batch (M13.3 prerequisite)
  ephemeral = shared_batch.ephemeral_auto_protect_rules   # may be empty

  merged = merge_ephemeral_persisted(persisted_base, ephemeral)

  # Route override merge (Governance Workspace)
  governance = load_stream_governance_config(stream_id)
  overrides = [
    o for o in governance.route_overrides
    if o.route_id == route_id and o.enabled
  ]

  effective_rules, audit_only_paths = apply_route_overrides(merged, overrides)

  return RouteProtectionConfig(
    rules=effective_rules,
    audit_only_paths=audit_only_paths,
    resolution={
      persisted_source: persisted_source,
      override_count: len(overrides),
      ephemeral_rule_count: len(ephemeral),
      fallback_used: persisted_source == "stream",
    },
    empty: len(effective_rules) == 0 and len(audit_only_paths) == 0,
  )
```

**Resolution order summary:**

| Step | Source | When used |
|------|--------|-----------|
| 1 | `route_protection_rules` | Any enabled row for `route_id` |
| 2 | `stream_protection_rules` | Step 1 empty — backward compatibility |
| 3 | `ephemeral_auto_protect_rules` | From `SharedBatchContext` — merged after persisted base |
| 4 | Empty config | No persisted rules, no ephemeral, no overrides → pass-through |

Route `route_overrides[]` **always** applied after Steps 1–3; override **wins** per `field_path`.

### 6.2 Route protection config exists → use route base

When `route_protection_rules` has **any** enabled row for `route_id`, that set is the **base** (Step 1). Stream rules are **not** merged field-by-field into route base — full-bundle replace (same pattern as Transform).

### 6.3 Route protection config missing → fallback to stream

No `route_protection_rules` rows → `stream_protection_rules` is base. This is the **backward compatibility path** for all existing streams.

### 6.4 Route override merge (normative)

```text
apply_route_overrides(base_rules, overrides):

  effective = copy(base_rules indexed by field_path)

  for override in overrides:
    action = map_protection_action_to_mode(override.protection_action)

    if action is AUDIT_ONLY:
      remove field_path from effective if present   # audit = no field rule
      record audit_only_paths += field_path
    elif action is not null:
      effective[field_path] = rule(
        field_path=override.field_path,
        protection_mode=action,
        enabled=True,
        source="route_override",
      )

  return (effective.values(), audit_only_paths)
```

**Matching key:** `field_path` (normalized JSONPath, same as `stream_protection_rules.field_path`).

**Precedence:** Route override **wins** over base rule for same `field_path`. Unmentioned fields inherit base.

### 6.5 Dual-read behavior summary

| Route rules table | Route override entries | Effective base | Override applied |
|-------------------|------------------------|----------------|------------------|
| absent | absent | stream rules | none |
| absent | present | stream rules | yes |
| present | absent | route rules | none |
| present | present | route rules | yes |

### 6.6 Loader integration

Pre-resolve `effective_config.protection` as **`RouteProtectionConfig`** per route at load time (or lazy-resolve at protection stage entry with batch cache). Attach to `RouteRuntimeContext` per spec 091 §7.3.

Resolver **must** receive `shared_batch` (or batch-scoped ephemeral accessor) when resolving ephemeral rules — loader-only resolution without batch context is insufficient for Auto Protect.

Recommended audit metadata on `RouteProtectionConfig.resolution`:

```text
persisted_source: "route" | "stream" | "empty"
override_count: int
ephemeral_rule_count: int
fallback_used: bool
```

### 6.7 Dual-write transition (compatibility)

During migration window, stream-scoped protection API writes may **mirror** to all routes or primary route (same policy as spec 091 §9.3). M13.3 implementation may defer dual-write until Wizard parity; dual-read alone preserves legacy behavior.

### 6.8 merge_ephemeral_for_route (normative)

Called inside `route_protection_stage()` when merging shared ephemeral rules with route-effective config:

```text
merge_ephemeral_for_route(ephemeral_rules, route_protection_config):

  for each ephemeral rule E (from shared_batch.ephemeral_auto_protect_rules):
    if field_path E.path in route_protection_config.audit_only_paths:
      skip E   # Audit Only override suppresses mutation
    elif field_path E.path has route_override mode:
      E.mode = override mode   # route override wins over ephemeral default
    elif field_path E.path in persisted effective rules:
      keep persisted mode   # persisted rule wins over ephemeral for same path
    else:
      include E in ephemeral_rules passed to protect_batch()

  return filtered_ephemeral_rules
```

Ephemeral rules **must** originate from shared-phase schema drift policy (§8.1) — not re-computed per route.

---

## 7. Protection Lifecycle

Conceptual execution order inside `process_route_pipeline()` — no code.

### 7.1 Stage sequence

```text
Shared Phase
  → Sensitive Detection completes
  → Schema Drift Policy runs on extracted_events (flag ON — M13.3 prerequisite)
  → schema_drift_policy_result + ephemeral_auto_protect_rules on SharedBatchContext

Per Route (after Transform)
  → Resolve effective_config.protection (RouteProtectionConfig)
  → merge_ephemeral_for_route(shared_batch.ephemeral_auto_protect_rules, config)
  → protect_batch(
       events = current_events,
       rules = config.rules,
       stream_id = stream_id,
       ephemeral_rules = merged_ephemeral,
     )
  → current_events = protected events
  → Record stage_timeline entry: protection (modified, counts, warnings)
  → Pass to Classification stub (NO-OP in M13.3)
  → Pass to Policy stub (NO-OP in M13.3)
  → Delivery handoff → RouteStageResult (protected events only)
```

### 7.2 Lifecycle diagram

```text
┌─────────────────────────────────────────────────────────────┐
│ STREAM SCOPE (once)                                          │
│  Extract → Observe → Sensitive Detection                     │
│  → Schema Drift Policy (flag ON — mandatory)                 │
│  → schema_drift_policy_result + ephemeral_auto_protect_rules │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ ROUTE SCOPE (per enabled route)                              │
│  Transform → route-transformed events                      │
│       ↓                                                      │
│  Resolve RouteProtectionConfig (dual-read + overrides)       │
│       ↓                                                      │
│  Protection Evaluation (existing engine)                     │
│       ↓                                                      │
│  Protected Event (route-specific outbound copy)              │
│       ↓                                                      │
│  Classification stub (NO-OP) → Policy stub (NO-OP)           │
│       ↓                                                      │
│  Delivery handoff → RouteStageResult → Fan-out                 │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 Audit and logging

| Event | Log stage | Scope |
|-------|-----------|-------|
| Field protection applied | `protection` | Include `route_id`, `field_path`, `protection_mode`, `rule_id` |
| Field protection warning | `protection` | Existing `ProtectionFieldWarning` semantics + `route_id` |
| Protection batch complete | `protection_complete` | Per route when flag ON |
| Audit Only path | `protection` | Log `audit_only` action without field mutation |
| Auto Protect ephemeral | `schema_drift_policy_auto_protect_applied` | Stream batch + route_id in route pipeline |

Structured logging must **not** include full sensitive raw payload (existing rule).

### 7.4 Preview lifecycle

Protection Preview (Wizard / Governance Workspace Route Preview) runs the **route protection stage** against sample events:

- Input: route-transformed sample events (from route transform preview or shared sample + route transform)
- Config: `resolve_protection_config(route_id, stream_id)`
- Engine: same `protect_batch()` as runtime
- Output: Route A / Route B side-by-side protected preview (Governance Workspace §Route Preview)

---

## 8. Runtime Integration

### 8.0 SharedBatchContext requirements (M13.3)

Extend spec 091 `SharedBatchContext` with **mandatory** fields when flag ON:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| **`schema_drift_policy_result`** | object | **Yes** | Full orchestrator output from shared-phase drift policy evaluation |
| **`ephemeral_auto_protect_rules`** | list | **Yes** (may be empty) | Ephemeral rules for Auto Protect; accessor over drift result |

```text
SharedBatchContext.ephemeral_auto_protect_rules
  := schema_drift_policy_result.ephemeral_protection_rules
     (or equivalent normalized list)
```

Built **after** shared-phase schema drift policy runs on `extracted_events` — **before** any route loop.

### 8.1 M13.3 prerequisites (mandatory)

M13.3 **must not** ship until:

**From M13.2:**

- `process_route_pipeline()` with Transform active and governance stubs
- Route loop **before** stream `_prepare_delivery_events()`
- `RouteStageResult` wired to `_fan_out()`
- `SharedBatchContext.extracted_events` and `sensitive_detection_result` populated

**M13.3-specific (design review R1):**

When `GDC_ROUTE_PROCESSING_ENABLED=true`, the route-processing path **must** call **schema drift policy in the shared phase** (same orchestrator as legacy path: `apply_schema_drift_policy_to_batch()` on `extracted_events`) **before** building `SharedBatchContext`.

| Requirement | Rationale |
|-------------|-----------|
| Shared-phase schema drift policy | Auto Protect ephemeral rules; M13.5 quarantine signal source |
| `schema_drift_policy_result` on shared batch | Protection stage + future Policy stage consume without re-run |
| `ephemeral_auto_protect_rules` accessor | Route protection merge per §6.8 |

**Rejected:** Skipping schema drift policy when flag ON — breaks Auto Protect and downstream Policy signals (design review §2.2 gap).

### 8.2 Protection stage activation

Replace M13.2 Protection stub with:

```text
route_protection_stage(route_ctx, shared_batch):
  input_events = route_ctx.processing_state.current_events
  config = route_ctx.effective_config.protection   # RouteProtectionConfig

  merged_ephemeral = merge_ephemeral_for_route(
    shared_batch.ephemeral_auto_protect_rules,
    config,
  )

  result = protect_events_for_delivery(
    db,
    stream_id=route_ctx.stream_id,
    enriched_events=input_events,
    rules=config.rules,
    ephemeral_rules=merged_ephemeral,
  )

  route_ctx.processing_state.current_events = result.events
  append_stage_timeline(route_ctx, "protection", result)

  # Classification stub — NO-OP (M13.4)
  # Policy stub — NO-OP (M13.5)
  return result
```

**Reuse:** `app/protection/service.py` → `protect_events_for_delivery()` → `protect_batch()` — no fork.

### 8.3 Feature flag matrix

| `GDC_ROUTE_PROCESSING_ENABLED` | Protection behavior |
|--------------------------------|---------------------|
| `false` | Legacy `_prepare_delivery_events()` once; identical fan-out |
| `true`, no route config | Dual-read stream rules per route; same rules applied N times (may produce identical protected output if transform identical) |
| `true`, route overrides / route rules | Per-route effective rules; divergent protected payloads |
| `GDC_PROTECTION_ENABLED=false` | Engine pass-through (existing global kill switch) — per route when flag ON |

### 8.4 StreamRunner changes (flag ON)

| Component | M13.3 change |
|-----------|--------------|
| Shared phase (flag ON) | **Add** schema drift policy call before `build_shared_batch_context()` |
| `_prepare_delivery_events()` | Remains **disabled** on shared batch (M13.2) |
| `process_route_pipeline()` Protection stub | **Replaced** with `route_protection_stage()` |
| `process_route_pipeline()` Classification / Policy stubs | **Remain NO-OP** in M13.3 |
| `_fan_out()` | Delivers **protected** per-route events from `RouteStageResult` only (§4.6) |
| Stream-level protection in shared phase | **Must not** run when flag ON |

### 8.5 Interaction with Sensitive Detection

| Concern | Behavior |
|---------|----------|
| Detection execution | **Once** in shared phase — no per-route re-run |
| Findings storage | `stream_sensitive_findings` — stream-scoped (unchanged) |
| Rule `source_finding_id` | Preserved on stream rules; route overrides may omit finding link |
| Auto Protect | Ephemeral rules generated in shared schema drift phase; protection mode may be **overridden per route** at merge step |
| Suggestions in UI | Union Schema / Governance Workspace show stream-level detections; Route Preview shows route-effective outcome |

### 8.6 No parallel runtime

Same `StreamRunner`, same `process_route_pipeline()`, same `protect_batch()`. No `RouteProtectionRunner`.

### 8.7 Milestone scope (M13.3 active vs stub vs deferred)

| Stage / concern | M13.3 status | Owner |
|-----------------|--------------|-------|
| **Transform** | Active (M13.2) | Per-route mapping + enrichment |
| **Protection** | **Active (M13.3)** | `route_protection_stage()`; `protect_batch()`; Auto Protect ephemeral application |
| **Auto Protect ephemeral rules** | **Active (M13.3)** | Shared-phase drift → per-route merge → engine |
| **Classification** | **Stub (NO-OP)** | Pass-through; M13.4 activates |
| **Policy** | **Stub (NO-OP)** | Pass-through; M13.5 activates |
| **Require Review workflow** | **Deferred (M13.5)** | Not implemented in M13.3 |
| **Quarantine workflow** | **Deferred (M13.5)** | Not implemented in M13.3 |
| **Delivery behavior enforcement** | **Deferred (M13.5)** | Stored on overrides; not enforced at protection stage |
| **Route delivery metrics / health** | **Deferred (M13.6)** | Fan-out exists; observability extensions later |

M13.3 **must not** invoke Classification or Policy engines. Stubs record `pass_through` in `stage_timeline` unchanged from M13.2.

---

## 9. Protection Actions

Actions align with Product Charter, Governance Policy §14, and Governance Workspace §Protection Action dropdown. Mapping to **existing engine** modes is normative for M13.3.

### 9.1 Supported actions (M13.3 in scope)

| Product / UX action | Internal mode | Engine behavior | Persisted rule? |
|--------------------|---------------|-----------------|-----------------|
| **Audit Only** | *(no mutation)* | Event field unchanged; log audit metadata | No rule row — audit path only |
| **Mask Partial** | `partial_mask` | `partial_mask_value()` | Yes |
| **Mask Full** | `full_mask` | `full_mask_value()` | Yes |
| **Tokenize** | `tokenization` | Identity vault token; `stream_id`-scoped vault | Yes |
| **Hash** | `hash` | HMAC-SHA256 digest; `stream_id`-scoped key | Yes |

**UX labels (Governance Workspace):** Audit Only, Mask (maps to Partial or Full per field class default), Tokenize, Hash.

**Wizard mapping (existing):** `wizardProtectionActionToMode()` in `frontend/src/api/gdcProtection.ts` — M13.3 route UI reuses same mapping.

### 9.2 Audit Only semantics

Audit Only is **not** a `protection_mode` in `PROTECTION_MODES`. It means:

- Do **not** invoke `apply_protection_mode()` for that field on that route
- Record protection decision in delivery logs / governance audit trail
- Delivery Behavior (Continue / Quarantine / Block) evaluated in **M13.5 Policy** — M13.3 does not block delivery

This matches existing wizard behavior: `protectionActionNeedsFieldRule('audit') === false` (`wizard-data-protection-persist.ts`).

### 9.3 Auto Protect default modes (unknown sensitive fields)

When schema drift policy triggers Auto Protect, ephemeral rules use existing defaults (`app/schema_drift_policy/orchestrator.py`):

| Sensitivity class | Default mode |
|-------------------|--------------|
| `secret`, `security_metadata` | `full_mask` |
| `pii` (default) | `partial_mask` |

Route override may replace ephemeral rule mode for that `field_path` on that route (§6.4).

### 9.4 Remove — explicit evaluation

| Aspect | Finding |
|--------|---------|
| **SoT status** | Governance Workspace v1.1 and Governance Policy §14 list **Remove** as MVP Protection Action |
| **Engine status** | **Not implemented** — `apply_protection_mode()` has no remove branch; `PROTECTION_MODES` excludes remove |
| **UI status** | Wizard `WizardProtectionAction` excludes `remove`; draft migration maps legacy `remove` → `mask_partial` |
| **Rule 1 / Rule 3 constraint** | M13.3 **cannot** add Remove without extending the Protection Engine — out of scope for "reuse only" milestone |

**M13.3 decision:**

| Option | Decision |
|--------|----------|
| Implement Remove in M13.3 | **Rejected** — requires new engine mode (violates Rule 3) |
| Document Remove in route UI as selectable | **Deferred** — show only engine-supported actions until engine extension approved |
| Route Remove override | **Deferred** to post-M13.3 engine milestone or product exception process |

**Operator workaround (interim):** Use Mask Full or route Transform to drop fields — Transform is M13.2 scope, not Protection.

**Future path (not M13.3):** Add `PROTECTION_MODE_REMOVE` to engine with field deletion semantics; then enable Remove in Governance Workspace dropdown and `route_overrides[]`.

### 9.5 Delivery Behavior (config only in M13.3)

Governance Workspace stores `delivery_behavior` alongside `protection_action` on rules and overrides:

| Behavior | Runtime owner |
|----------|---------------|
| Continue Delivery | M13.5 Policy (`audit_only`) |
| Quarantine | M13.5 Policy |
| Block | M13.5 Policy |

M13.3 **persists and returns** `delivery_behavior` on governance config APIs where applicable but **does not enforce** quarantine/block at protection stage.

---

## 10. Unknown Field Protection

Aligns with Governance Policy §8–10, §21–23 and Union Schema drift preparation. M13.3 covers **protection execution**; **policy gating** (Require Review, Quarantine) is M13.5 — boundaries explicit below.

### 10.1 Field categories

| Category | Definition | Default (stream) |
|----------|------------|------------------|
| **Unknown Normal Field** | New field observed; no sensitive detection match | Pass Through (Governance Policy §9) |
| **Unknown Sensitive Field** | New field + Sensitive Detection match | Auto Protect (Governance Policy §10) |

Classification labels (Likely Sensitive, Confirmed Sensitive) — **M13.4 scope**; M13.3 consumes detection match boolean from shared batch only.

### 10.2 Stream default policies

Stored in `streams.config_json` schema drift policy (existing):

| Policy key | Allowed values | Protection stage effect |
|------------|----------------|------------------------|
| `unknown_normal_field_policy` | `pass_through`, `require_review`, `quarantine` | Normal unknown: **no ephemeral protection rule** under Pass Through |
| `unknown_sensitive_field_policy` | `auto_protect`, `require_review`, `quarantine` | Sensitive unknown: ephemeral rules when `auto_protect` |

**Product default:** Unknown Field → Pass Through (Governance Policy §25).

### 10.3 Route override (intent — config in M13.3, drift policy enforcement split)

Governance Policy §21 defines route-aware schema drift overrides (e.g. Route B Require Review for unknown normal).

| Override target | M13.3 responsibility | M13.5 responsibility |
|-----------------|----------------------|----------------------|
| Unknown Normal → Pass Through | No protection action | No quarantine |
| Unknown Normal → Require Review | No protection action | Review / quarantine signal |
| Unknown Normal → Quarantine | No protection action | Quarantine |
| Unknown Sensitive → Auto Protect | Ephemeral protect; **route may override protection mode** | Delivery continue unless policy says otherwise |
| Unknown Sensitive → Require Review | Optional ephemeral protect per stream policy | Review workflow |
| Unknown Sensitive → Quarantine | Optional ephemeral protect | Quarantine |

**M13.3 normative scope:** When Auto Protect generates ephemeral rules in shared phase, the **protection mode applied at delivery** respects route override for that route's protection action. Stream-level `unknown_*_field_policy` selects **whether** ephemeral rules are generated; route override selects **how** (Audit / Mask / Tokenize / Hash) for that destination.

**Route override storage (conceptual):** Extend governance config with optional per-route schema drift override block, or reuse `route_governance_overrides` table from spec 091 Appendix A — populated in M13.3 config model; full drift orchestrator route awareness may require M13.5 coordination.

### 10.4 Pass Through

Unknown normal fields (and unknown sensitive when policy = pass-through equivalent) are **not mutated** by protection. Events deliver with new fields intact — aligns with Data Delivery Gateway philosophy (Governance Policy §7–9).

### 10.5 Auto Protect

Existing stream orchestrator (`app/schema_drift_policy/orchestrator.py`) generates `ephemeral_protection_rules`. M13.3:

1. Shared phase attaches ephemeral rules to batch context
2. Per route, merge with route-effective persisted rules
3. Apply route override to ephemeral rule modes where `field_path` matches
4. Invoke `protect_batch()` including ephemeral rules (existing engine path)

Sensitive Detection results **must not** be re-run per route.

### 10.6 Require Review and Quarantine

These are **policy outcomes**, not protection modes. **Deferred to M13.5** — not implemented in M13.3.

| Workflow | M13.3 | M13.5 |
|----------|-------|-------|
| Require Review | **Not implemented** | Review queue / hold signal from `schema_drift_policy_result` |
| Quarantine | **Not implemented** | Quarantine creation; route-aware drift override evaluation |

M13.3:

- Does **not** implement review queues or quarantine creation for unknown fields
- **Does** run shared-phase schema drift policy and attach `schema_drift_policy_result` to `SharedBatchContext` for M13.5 consumption
- May apply Auto Protect ephemeral masking **before** policy quarantine when stream policy is `auto_protect` (protection stage only)
- Classification and Policy stubs remain **NO-OP** — no engine invocation

### 10.7 Union Schema alignment

Union Schema defines **what fields exist** on the stream sample. Unknown field handling applies to **runtime-observed** fields not in baseline — not Union Schema editor state. Route Processing Protection tab shows detected fields from shared Union Schema / findings; per-route override edits `route_overrides[]`.

---

## 11. Database Impact

Conceptual only — no SQL, no migrations authorized by this document.

### 11.1 Current tables (reuse)

| Table | M13.3 role |
|-------|------------|
| `stream_protection_rules` | Fallback base rules — **unchanged** |
| `identity_vault_entries` | Tokenization — **unchanged** (`stream_id` scope) |
| `stream_sensitive_findings` | Detection persistence — **unchanged** |
| `streams.config_json` | Schema drift + governance defaults — **unchanged** |

### 11.2 Required future additions (additive)

| Artifact | Key | Purpose |
|----------|-----|---------|
| **`route_protection_rules`** | `route_id` FK + UNIQUE `(route_id, field_path)` | Optional full route-specific rule set |
| **`route_governance_overrides`** or JSON on stream governance | `route_id`, `field_path`, `protection_action`, `delivery_behavior`, `enabled` | Normalized override storage (alternative: JSONB `route_overrides[]` on stream governance document) |
| **`streams.governance_config_json`** (if not exists) | Stream-scoped | Holds default rules + `route_overrides[]` per Governance Workspace API examples |

**Preference:** Additive `route_protection_rules` table + governance JSON column — do **not** break `stream_protection_rules` UNIQUE constraints.

### 11.3 Optional future columns

| Column | Table | Purpose |
|--------|-------|---------|
| `route_id` | `delivery_logs` context | Already partial — ensure protection stage logs include route_id |
| `protection_source` | log metadata | `stream` \| `route` \| `route_override` \| `ephemeral` |

### 11.4 Unchanged

No truncate of user protection rules. No change to `identity_vault_entries` key structure.

### 11.5 Backfill (future tool — not M13.3)

For streams with N routes and identical protection needs: **no route rows required** — dual-read stream fallback preserves behavior. Backfill copies stream rules to `route_protection_rules` only when operator explicitly diverges routes.

---

## 12. API Impact

Conceptual only — no endpoint implementation authorized.

### 12.1 Current APIs (retained)

```text
GET/POST/PATCH/DELETE /runtime/streams/{stream_id}/protection-rules
GET                   /runtime/streams/{stream_id}/protection/summary
GET                   /runtime/streams/{stream_id}/protection-rules/...
```

Stream endpoints remain for fallback and aggregate views.

### 12.2 Required future APIs (M13.3)

```text
GET/POST/PATCH/DELETE /runtime/routes/{route_id}/protection-rules
GET                   /runtime/routes/{route_id}/protection/summary
GET                   /runtime/routes/{route_id}/protection/effective   # resolved config for UI/debug

GET/PUT               /runtime/streams/{stream_id}/governance
                      (+ route_overrides[], default_protection_action per field)

POST                  /runtime/preview/protection
                      (+ route_id — dual-read + override merge; same engine as runtime)

POST                  /runtime/preview/route-pipeline
                      (+ route_id — transform + protection preview chain)
```

### 12.3 Response metadata (recommended)

```text
{
  "route_id": "...",
  "stream_id": "...",
  "resolution": {
    "base_source": "stream" | "route",
    "override_count": 2,
    "fallback_used": true | false
  },
  "rules": [...]
}
```

### 12.4 Compatibility shim

| Caller | Behavior |
|--------|----------|
| Stream protection write | Optional dual-write to all routes during transition (TBD) |
| Stream protection read | Stream rules only (not merged) |
| Route protection read | Effective rules after dual-read + override merge |
| Preview without `route_id` | Stream-effective (legacy) |
| Preview with `route_id` | Route-effective |

---

## 13. Frontend Impact

Conceptual only — no UI implementation authorized.

### 13.1 Wizard (Stream Wizard Charter v5.2)

| Surface | Change |
|---------|--------|
| Step 4 Route Processing | **Protection tab** per route (alongside Transform, future Classification/Policy) |
| Default inheritance | Show stream protection defaults; indicate overrides |
| Route override editor | Per detected field: protection action dropdown (Audit, Mask Partial, Mask Full, Tokenize, Hash — **not Remove until engine supports**) |
| Deploy Summary | Per-route protection summary: base source, override count, action breakdown |

Move stream-global governance drawer protection intents from Transform step to **Route Processing** scope (Wizard Charter order).

### 13.2 Route Processing / Route Edit

| Surface | Change |
|---------|--------|
| `route-edit-page.tsx` | Protection tab — route-effective rules + override editor |
| Route operational panel | Protection readiness indicator |
| Stream protection panel | Banner: "Stream defaults — override per route in Route Processing" |

### 13.3 Governance Workspace

| Surface | Change |
|---------|--------|
| Data Protection Workspace | Left panel: Default Rule + **Route Overrides** section (Governance Workspace v1.1) |
| Center panel | Route Override Section per route |
| Right panel | **Route Preview** — Route A / Route B protected output side-by-side |
| Summary panel | Route-level protection action counts |

Reuse existing protection action labels; wire to route-scoped APIs.

### 13.4 Deploy Summary

Show per route:

- Effective protection source (stream fallback vs route rules)
- Override count
- Actions: Audit / Mask / Tokenize / Hash counts
- Warnings: fields with Audit Only to third-party destinations (informational)

---

## 14. Backward Compatibility

### 14.1 Legacy stream behavior (flag OFF)

When `GDC_ROUTE_PROCESSING_ENABLED=false`:

- **Identical** to OSS GA — stream protection once, identical fan-out
- No operator action required
- Route APIs may exist but runtime ignores route loop

### 14.2 Flag ON, no route protection config

When flag ON and no `route_protection_rules` / no `route_overrides`:

- Dual-read stream rules for **each** route
- If all routes share identical transform (M13.2 fallback), protected outputs **match** legacy flag OFF behavior
- **Parity requirement:** byte-equivalent protected delivery vs flag OFF when transform parity holds

### 14.3 Flag ON, partial route config

Routes without overrides use stream fallback. Routes with overrides diverge only where configured.

### 14.4 Migration strategy

| Phase | Action |
|-------|--------|
| M13.3 schema | Additive tables/columns only |
| Default | No backfill required |
| Optional backfill tool | Copy stream → route rules when operator enables per-route editing |
| Dual-write window | Stream API mirrors to routes (optional, post-M13.3) |

**Preserve user entities:** No truncate of `stream_protection_rules` (workspace rule).

### 14.5 Rollback strategy

| Trigger | Action |
|---------|--------|
| Route protection regression | Set `GDC_ROUTE_PROCESSING_ENABLED=false` — immediate legacy path |
| Route config error | Delete route overrides / route rules — fallback to stream |
| Engine issue | Set `GDC_PROTECTION_ENABLED=false` — global pass-through |

No data migration rollback required for flag OFF.

---

## 15. Acceptance Criteria

M13.3 is **complete** when all criteria pass.

### 15.1 Prerequisites (M13.2 + shared phase)

- [ ] **AC-1** M13.2 acceptance criteria satisfied — route loop, transform, fan-out wiring.
- [ ] **AC-2** `RouteRuntimeContext.effective_config.protection` populated as **`RouteProtectionConfig`** by resolver.
- [ ] **AC-3** `SharedBatchContext.sensitive_detection_result` available to protection stage.
- [ ] **AC-3a** When flag ON, shared phase **calls schema drift policy** on `extracted_events` before route loop.
- [ ] **AC-3b** `SharedBatchContext.schema_drift_policy_result` populated after shared-phase drift policy.
- [ ] **AC-3c** `SharedBatchContext.ephemeral_auto_protect_rules` accessor available (may be empty list).

### 15.2 Protection stage activation

- [ ] **AC-4** Protection stub replaced with `route_protection_stage()` invoking existing engine.
- [ ] **AC-5** Stream `_prepare_delivery_events()` **not** called when flag ON.
- [ ] **AC-6** `_fan_out()` delivers **protected** per-route events from `RouteStageResult` **only** — not unprotected transform output (§4.6).
- [ ] **AC-7** No new Protection Engine class or parallel pipeline.

### 15.3 Config resolution

- [ ] **AC-8** Resolution order: `route_protection_rules` → `stream_protection_rules` → ephemeral merge → empty config.
- [ ] **AC-9** Route rules present → route rule set replaces stream base for that route (full-bundle).
- [ ] **AC-10** `route_overrides[]` merge replaces per-field action for matching `route_id`; override **wins** over stream/default rules.
- [ ] **AC-11** Audit Only override skips field mutation and logs audit metadata.
- [ ] **AC-12** `RouteProtectionConfig.resolution` metadata exposed in effective config API/debug.

### 15.4 Product scenarios

- [ ] **AC-13** Same stream, Route A Audit Only, Route B Mask — outbound payloads differ accordingly.
- [ ] **AC-14** Operator achieves destination-specific protection **without** duplicating streams.
- [ ] **AC-15** Sensitive Detection runs once per batch — not N times per route.

### 15.5 Engine reuse and actions

- [ ] **AC-16** `protect_batch()` / `apply_protection_mode()` used unchanged for Mask / Tokenize / Hash.
- [ ] **AC-17** Tokenization vault remains stream-scoped — tokens consistent across routes on same stream.
- [ ] **AC-18** Remove **not** exposed in route runtime until engine supports it (documented deferral §9.4).

### 15.6 Unknown field / Auto Protect

- [ ] **AC-19** Auto Protect creates ephemeral protection rules in shared phase when drift policy triggers.
- [ ] **AC-20** Ephemeral Auto Protect rules applied in route protection stage via `merge_ephemeral_for_route()`.
- [ ] **AC-21** Route override can change Auto Protect mode per destination.
- [ ] **AC-22** Pass Through unknown normal fields deliver unmutated on all routes (when policy = pass_through).

### 15.7 Compatibility

- [ ] **AC-23** Flag OFF: zero behavior change vs pre-M13.3 baseline (e2e green).
- [ ] **AC-24** Flag ON, no route config: delivery parity with flag OFF when transform parity holds.
- [ ] **AC-25** No truncate of user `stream_protection_rules`.

### 15.8 Observability

- [ ] **AC-26** `delivery_logs` protection entries include `route_id` when flag ON.
- [ ] **AC-27** Protection preview accepts `route_id` and uses effective route config.

### 15.9 Boundaries (stubs and deferred work)

- [ ] **AC-28** Classification engine **not** invoked in M13.3 — stub remains NO-OP.
- [ ] **AC-29** Policy engine **not** invoked in M13.3 — stub remains NO-OP.
- [ ] **AC-30** Require Review and Quarantine workflows **not** implemented in M13.3 (M13.5).
- [ ] **AC-31** Route delivery metrics / health **not** implemented in M13.3 (M13.6).

---

## 16. Test Strategy

### 16.1 Unit tests

| Area | Cases |
|------|-------|
| `resolve_protection_config` | Resolution order; RouteProtectionConfig shape; override merge |
| `merge_ephemeral_for_route` | Auto Protect + route override interaction |
| Shared batch builder | `schema_drift_policy_result`, `ephemeral_auto_protect_rules` |
| Fan-out wiring | Protected payloads only; reject unprotected transform output |
| Action mapping | UX action → `protection_mode`; Audit → no rule |
| Remove deferral | Remove action rejected or unmapped in M13.3 API validation |

### 16.2 Integration tests

| Case | Expected |
|------|----------|
| Flag OFF | Legacy stream protection — regression gate |
| Flag ON, shared schema drift | Drift policy invoked; ephemeral rules on shared batch |
| Flag ON, no route config | Stream rules applied per route; parity with flag OFF |
| Flag ON, route override Audit vs Mask | Different **protected** payloads per route |
| Flag ON, fan-out | Destinations receive post-protection events only |
| Flag ON, route_protection_rules full set | Route base replaces stream for that route only |
| Sensitive Detection | Single detection call per batch |
| Auto Protect + route override | Ephemeral mode overridden per route |
| Classification / Policy stubs | Engines not called when flag ON |
| Tokenization | Same vault entries across routes on stream |
| Engine reuse | Mock/spy confirms `protect_batch` entry point — no duplicate engine |

### 16.3 Regression tests

- Full e2e flag OFF — no expectation changes
- Existing protection rule CRUD on stream — unchanged
- Identity vault entries — no corruption when N routes tokenize same field
- Backup import stream-only protection config — valid with dual-read

### 16.4 Performance tests

| Case | Threshold (guidance) |
|------|----------------------|
| N routes × protection | Linear O(N); acceptable if shared detection O(1) |
| Loader batch rule load | No N+1 queries for route protection resolution |
| Tokenization batch | Existing batch token API reused per route stage |

Benchmark alongside M13.2 route count matrix (post-M13.6 formal gate).

---

## 17. Implementation Boundaries

### 17.1 IN scope (M13.3)

| Deliverable | Description |
|-------------|-------------|
| `route_protection_rules` (optional full set) | Additive schema + repository |
| `route_overrides[]` persistence | Governance config storage + merge algorithm |
| `resolve_protection_config()` | Dual-read + override merge → `RouteProtectionConfig` |
| Shared-phase schema drift (flag ON) | Prerequisite gate §8.1 |
| `route_protection_stage()` | Active stage in `process_route_pipeline()` |
| Loader `effective_config.protection` | Typed `RouteProtectionConfig` per route |
| Route protection APIs + effective config endpoint | §12 |
| Protection preview `route_id` | Same engine as runtime |
| Route protection UI (Wizard tab, Governance overrides) | Conceptual §13 — implementation may trail runtime |
| Tests | §16 |
| Remove evaluation documentation | §9.4 — defer implementation |

### 17.2 OUT of scope (M13.4+)

| Milestone | Excluded from M13.3 |
|-----------|---------------------|
| **M13.4** | Classification engine invocation; stage order finalization |
| **M13.5** | Policy evaluation; delivery_behavior enforcement; unknown field Require Review / Quarantine workflows |
| **M13.6** | Route metrics, route health, delivery observability extensions |
| **Engine** | `PROTECTION_MODE_REMOVE` / field deletion semantics |
| **Any** | New Protection Engine; parallel runtime; Sensitive Detection re-run per route |
| **Wizard P7** | Full Destination First reorder (may parallel M13.3) |
| **Governance P9** | Full route-aware dashboard (partial overlap with Route Preview) |

### 17.3 M13.3 implementation order (recommended)

| Step | Work | Exit criteria |
|------|------|---------------|
| **0** | **Shared-phase schema drift policy when flag ON** — populate `schema_drift_policy_result` + `ephemeral_auto_protect_rules` | AC-3a, AC-3b, AC-3c |
| **A** | Confirm M13.2 gates (AC-1) | M13.2 complete |
| **B** | Additive DB + repos for route protection + governance overrides | AC-25 |
| **C** | `resolve_protection_config()` → `RouteProtectionConfig` + loader attachment | AC-8–AC-12 |
| **D** | `route_protection_stage()` — wire existing engine; fan-out protected payloads only | AC-4–AC-7, AC-16, AC-6 |
| **E** | Ephemeral Auto Protect via `merge_ephemeral_for_route()` | AC-19–AC-22 |
| **F** | Route APIs + effective config + preview `route_id` | AC-12, AC-27 |
| **G** | Frontend Route Protection tab + governance overrides | AC-13, AC-14 |
| **H** | Regression + parity tests; verify Classification/Policy stubs NO-OP | AC-23, AC-24, AC-28, AC-29 |

Step **0** is **not deferrable**. Do not ship M13.3 without shared-phase schema drift policy when flag ON.

### 17.4 Dependencies

| Dependency | Relationship |
|------------|--------------|
| M13.1 | Context contracts, feature flag, orchestration slots |
| M13.2 | Transform stage, fan-out wiring, shared batch semantics — **hard prerequisite** |
| M13.4 | Classification follows protection in pipeline |
| M13.5 | Policy follows classification; delivery_behavior enforcement |
| M13.6 | Per-route delivery metrics |

---

## Appendix A — Override merge example

```text
Stream rule:  $.user.email → partial_mask (PII)
Stream rule:  $.user.api_key → full_mask (secret)

Route B overrides:
  $.user.email → tokenization

Effective for Route B:
  $.user.email → tokenization   (override wins)
  $.user.api_key → full_mask    (inherited from stream base)

Effective for Route A (no overrides):
  $.user.email → partial_mask
  $.user.api_key → full_mask
```

---

## Appendix B — Design review cross-reference

| Finding | Spec 093 response |
|---------|-------------------|
| Shared-phase schema drift when flag ON | §8.0, §8.1, AC-3a–AC-3c, Step 0 |
| `schema_drift_policy_result` on SharedBatchContext | §8.0 |
| `ephemeral_auto_protect_rules` accessor | §8.0, §6.8 |
| `RouteProtectionConfig` typed model | §6.0 |
| `resolve_protection_config()` resolver | §6.1 |
| Resolution order route → stream → ephemeral → empty | §5.2, §6.1, AC-8 |
| Fan-out protected payloads only | §4.6, AC-6 |
| Protection dual-read + override merge | §6.1–§6.4 |
| Classification / Policy NO-OP stubs | §8.7, AC-28, AC-29 |
| Require Review / Quarantine deferred M13.5 | §8.7, §10.6, AC-30 |
| Loop inside `process_route_pipeline()` after Transform | §7, §8 |
| Reuse `app/protection/engine.py` | §8.2, Rule 1 |
| Sensitive detection stream-scoped | §8.5, §10.5 |

Source: [`m13-3-protection-design-review.md`](../../docs/architecture/m13-3-protection-design-review.md), [`m13-route-architecture-design-review.md`](../../docs/architecture/m13-route-architecture-design-review.md)

---

## Appendix C — Engine reuse

| Component | Path | M13.3 usage |
|-----------|------|-------------|
| Protection batch | `app/protection/engine.py` — `protect_batch()` | Per route in pipeline |
| Protection service | `app/protection/service.py` — `protect_events_for_delivery()` | Stage wrapper |
| Mode applicators | `app/protection/modes.py` | Unchanged |
| Identity vault | `app/protection/identity_vault.py` | Stream-scoped tokenization |
| Schema drift ephemeral | `app/schema_drift_policy/orchestrator.py` | Shared phase input |
| Operator workflow | `app/protection/operator_workflow.py` | Route API validation reuse |

Config source and orchestration change; algorithms unchanged.

---

## Appendix D — Related specs

| Spec | Relationship |
|------|--------------|
| `specs/091-route-processing-architecture/spec.md` | M13.1 foundation — lifecycle slots, dual-read policy |
| `specs/092-per-route-transform/spec.md` | M13.2 prerequisite — pipeline order, fan-out |
| `docs/architecture/m13-3-protection-design-review.md` | M13.3 design review — findings incorporated |
| `docs/architecture/m13-route-architecture-design-review.md` | Override merge, loop debt |
| `specs/004-delivery-routing/spec.md` | Fan-out, checkpoint |
| `specs/064-advanced-transform/spec.md` | Transform output shapes protection targets |

---

## Appendix E — Key files (implementation reference)

| File | M13.3 change |
|------|--------------|
| `app/runners/route_stage.py` | Replace Protection stub with `route_protection_stage()` |
| `app/runners/stream_loader.py` | Resolve `effective_config.protection` |
| `app/runners/route_context.py` | `RouteProtectionConfig`; SharedBatchContext drift fields |
| `app/runners/route_context_builder.py` | `schema_drift_policy_result`, `ephemeral_auto_protect_rules` on shared batch |
| `app/runners/stream_runner.py` | Shared-phase schema drift when flag ON; protected fan-out |
| `app/protection/engine.py` | **No algorithm change** — call site moves to route stage |
| `app/protection/models.py` | Add `RouteProtectionRule` model (future) |
| `app/runtime/router.py` | Route protection endpoints |
| `frontend/src/components/streams/wizard/` | Route Processing Protection tab |
| `frontend/src/components/governance/` | Route overrides + Route Preview |

---

*End of M13.3 companion spec. No code, database migrations, API, UI, or runtime changes authorized by this document.*
