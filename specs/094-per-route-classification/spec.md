# M13.4 Per Route Classification

**Milestone:** M13.4 (Per Route Classification)
**Status:** CURRENT implementation spec for M13.4 (delivered). Original M13 rollout assumed flag default OFF; product default is ON as of P1-4 (`false` = rollback). Wizard classification persist without a floor row remains `intent_only`.
**Depends on:** M13.1 Route Processing Foundation (`specs/091-route-processing-architecture/spec.md`), M13.2 Per Route Transform (`specs/092-per-route-transform/spec.md`), M13.3 Per Route Protection (`specs/093-per-route-protection/spec.md`)
**Design review:** [`docs/architecture/route-data-model-review.md`](../../docs/architecture/route-data-model-review.md), [`docs/architecture/m13-3-protection-design-review.md`](../../docs/architecture/m13-3-protection-design-review.md), [`docs/architecture/m13-4-classification-design-review.md`](../../docs/architecture/m13-4-classification-design-review.md), [`docs/architecture/m13-route-architecture-design-review.md`](../../docs/architecture/m13-route-architecture-design-review.md)
**Authority:** Product Charter 1.2.1, Master WBS 1.2.1, `.specify/memory/constitution.md`, Governance & Transform Policy v1.1, Governance UX Charter v1.1, Governance Workspace v1.1
**Architecture:** [`docs/architecture/route-processing-foundation-implementation-spec.md`](../../docs/architecture/route-processing-foundation-implementation-spec.md)
**Gap analysis:** [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)
**Engine spec:** [`specs/066-classification-engine/spec.md`](../066-classification-engine/spec.md)

---

## 1. Problem Statement

Classification is **Stream-scoped** today. One classification rule set resolves a **single batch-level** `classification_level` that is stamped on all events before fan-out. Every route on a stream receives events with the **same classification label**, regardless of destination sensitivity requirements.

```text
Stream
↓
Transform (stream-scoped or per-route — M13.2)
↓
Protection (stream-scoped or per-route — M13.3)
↓
Classification once (stream-scoped)
↓
Fan-out (identical classification stamp)
↓
Destinations
```

**Product violation:** Operators who need different classification posture per destination (e.g. Route A → internal SIEM **INTERNAL**, Route B → partner API **RESTRICTED**, Route C → archive **CONFIDENTIAL**) must **duplicate Streams** for the same source. Product Charter 1.2.1 forbids this: *목적지별 처리 차이는 Route를 통해 구성한다* and *users must not duplicate Streams because destinations require different processing*.

**Gap (evidence):** `stream_classification_rules.stream_id` FK only; no `route_id`; `classify_events_for_delivery()` in `app/classification/service.py` queries stream rules via `evaluate_batch()`; `_classify_events()` in `app/runners/stream_runner.py` runs once in the shared phase **before** protection on the legacy path; `process_route_pipeline()` records `classification_stub` as NO-OP pass-through (`app/runners/route_stage.py`).

**M13.3 delivers:** Per-route Protection inside `process_route_pipeline()`; Classification **stub** (pass-through); Policy **stub** (pass-through); stream-level classification **skipped** when `GDC_ROUTE_PROCESSING_ENABLED=true` (spec 092 §9.2).

**M13.4 solves:** Activate the **Classification stage** inside the per-route pipeline using the **existing Classification Engine** (`classify_batch()` / `resolve_classification_level()`), with **route-aware effective rules** (stream defaults + optional route rule table + governance override floor), **reusing stream-scoped Sensitive Detection results**, so each route can deliver events with a **different classification stamp** without Stream duplication.

**Stage order decision (M13.4 scope):** On the route path (flag ON), Classification runs **after Protection** on **post-protection route-shaped events**, matching Product Charter Core Pipeline (Protection → Classification → Policy). Legacy flag OFF path retains Classification **before** Protection — intentional dual behavior documented in §10.4.

**Explicit non-goals in this spec:** Policy design (M13.5), Quarantine workflow, Require Review workflow, Route Delivery observability redesign (M13.6).

---

## 2. Source Of Truth Alignment

| Document | Mandate relevant to M13.4 |
|----------|---------------------------|
| **Product Charter 1.2.1** | Route = Destination Specific Processing Unit; Transform / Protection / Classification / Policy route-applicable; Core Pipeline: Protection → Classification → Policy; Runtime Reuse First; No Parallel Pipeline |
| **Master WBS 1.2.1** | M13.4 = Per Route Classification, Route Specific Classification; Route Governance Extension — Route Classification Visibility |
| **UX Charter 1.2.1** | §24–27 Route model; per-destination governance via Route |
| **Stream Wizard Charter v5.2** | Step 4 Route Processing → Classification tab per route; Destination First → Route Processing Second |
| **Governance UX Charter v1.1** | Configuration Scope = Stream, Execution Scope = Route |
| **Governance Workspace v1.1** | Governance Rule + `route_overrides[]`; Route Preview per route |
| **Governance & Transform Policy v1.1** | Classification in data control pipeline; route-applicable processing |
| **Union Schema UX Spec v1.1** | Union Schema = shared input; classification labels **how sensitive** outbound data is, not field catalog |
| **Route data model review** | Additive `route_classification_rules`; dual-read list replacement; governance overrides via JSON |
| **M13.3 design review** | Classification input = post-protection events; extend `route_overrides[]` with `classification_level` |
| **ChatGPT Guardrail v1.0** | No new governance categories; reuse runtime; no parallel engines |

**Constitution (unchanged):**

- Checkpoint updated only after successful Destination delivery
- Stream = execution unit; Route connects Stream → Destination
- Delivery failures logged structurally
- No parallel pipeline or classification engine

**Critical rules (task mandate):**

| Rule | M13.4 interpretation |
|------|----------------------|
| Reuse existing Classification Engine | Invoke `classify_batch()` / `resolve_classification_level()` — no rewrite |
| Reuse Sensitive Detection results | Input from `SharedBatchContext.sensitive_detection_result` — no re-detection per route |
| Do NOT create new Classification Engine | Config resolution and orchestration only |
| Do NOT create parallel runtime | Classification stage inside existing `process_route_pipeline()` |
| Route Classification additive | New `route_classification_rules` table; stream table preserved |
| Existing Streams continue working | Dual-read + flag OFF parity |
| Feature flag rollback path | `GDC_ROUTE_PROCESSING_ENABLED=false` — legacy path unchanged (product default is `true` as of P1-4) |
| Do NOT redesign Route DB model | Additive `route_classification_rules` only (spec 091 Appendix A) |

---

## 3. Current Classification Model

### 3.1 Storage

| Entity | Scope | Key fields |
|--------|-------|------------|
| `stream_classification_rules` | Stream | `stream_id`, `name`, `enabled`, `condition_json`, `classification_level` |
| `stream_sensitive_findings` | Stream | Sensitive Detection persistence (feeds rule conditions) |

**Evidence:** `app/classification/models.py` — no `route_id` on classification tables.

**Classification levels:** `PUBLIC` < `INTERNAL` < `CONFIDENTIAL` < `RESTRICTED` (highest wins on multi-match — spec 066).

**Rule condition shape:** `condition_json.sensitivity_class` matched against finding classes from Sensitive Detection (`app/classification/engine.py`).

### 3.2 Runtime loading

`stream_loader` does not attach classification rules to `RouteRuntimeContext` today. Classification rules are loaded at runtime by `evaluate_batch()` querying `stream_classification_rules` by `stream_id`.

### 3.3 Runtime execution

**Flag OFF (legacy — unchanged by M13.4):**

```text
_collect_and_transform_events()
  → Mapping → Enrichment → Sensitive Detection
  → Classification (stream — _classify_events)     ← BEFORE Protection
  → Schema Drift Policy

→ _prepare_delivery_events()          ← stream Protection
→ _evaluate_policies()               ← stream Policy
→ _fan_out(delivery_events)
```

**Flag ON + M13.3 (Classification stub — pre-M13.4):**

```text
Shared Phase → extracted_events + sensitive_detection_result
  (+ schema_drift_policy_result when M13.3 wired)

→ process_route_pipeline() per route
     Transform (active)
     Protection (active)
     Classification stub (pass-through)    ← NO-OP
     Policy stub (NO-OP)
→ _fan_out(per-route RouteStageResult.events)
```

Stream `_classify_events()` **must not** run when flag ON (spec 092 §9.2). Classification stub records `classification_stub` in `stage_timeline` with `pass_through`.

### 3.4 Sensitive Detection integration (current)

| Phase | Scope | Output |
|-------|-------|--------|
| Sensitive Detection | Stream (shared phase) | Findings; `SharedBatchContext.sensitive_detection_result` |
| Classification | Stream (once, legacy path) | Batch `classification_level` stamped on events via `stamp_classification_level()` |
| Protection | Stream or Route | Field masking — runs after classification on legacy path only |

Route context is **not** considered when resolving classification level today.

### 3.5 Event fields (unchanged — spec 066)

| Field | Semantics |
|-------|-----------|
| `classification_level` | Stamped when absent on source event |
| `classification_level_gdc` | Stamped when source already has `classification_level` |

M13.4 does **not** change stamp field selection logic.

---

## 4. Target Classification Model

### 4.1 Topology (unchanged)

```text
One Stream → Many Routes → Many Destinations
Execution Unit: Stream
Processing Unit: Route (classification execution)
Configuration Scope: Stream (defaults + governance catalog)
Execution Scope: Route (effective classification per destination)
```

### 4.2 Target pipeline (flag ON + M13.4)

```text
SHARED PHASE (once per batch)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → Schema Drift Policy (M13.3 prerequisite when flag ON)
  → SharedBatchContext (
       extracted_events,
       sensitive_detection_result,
       schema_drift_policy_result,
       schema_observation,
       union_schema, …
     )
  → NO stream-level Classification when flag ON

PER-ROUTE LOOP — process_route_pipeline()
  → Transform           (M13.2 — active)
  → Protection          (M13.3 — active)
  → Classification      (M13.4 — ACTIVE)
  → Policy stub         (M13.5)
  → Delivery handoff    (RouteStageResult → fan-out)

POST-LOOP (stream scope)
  Dynamic routing → Checkpoint
```

### 4.3 Target pipeline diagram

```text
┌─────────────────────────────────────────────────────────────┐
│ STREAM SCOPE (once)                                          │
│  Extract → Observe → Sensitive Detection                     │
│  → Schema Drift Policy (flag ON — M13.3)                     │
│  → sensitive_detection_result on SharedBatchContext          │
│  → Classification NOT run here when flag ON                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ ROUTE SCOPE (per enabled route)                              │
│  Transform → route-transformed events                        │
│       ↓                                                      │
│  Protection → protected route-shaped events                  │
│       ↓                                                      │
│  Classification (ACTIVE) → classified events                 │
│       ↓                                                      │
│  Policy stub (NO-OP) → Delivery handoff → Fan-out            │
└─────────────────────────────────────────────────────────────┘
```

### 4.4 Classification input semantics (normative)

| Path | Classification input events | Order vs Protection |
|------|------------------------------|---------------------|
| Flag OFF (legacy) | Post-enrichment, **pre-protection** stream batch | Classification **before** Protection |
| Flag ON (route) | **Post-protection** route-shaped events | Classification **after** Protection |

**M13.4 must document and test this delta.** Operators comparing legacy vs route paths may see different classification stamps on the same logical event when protection mutates fields that influence finding-derived defaults — this is **expected** and aligns with Product Charter Core Pipeline.

### 4.5 Fan-out requirement

`_fan_out()` **must** receive **per-route classified events** from `RouteStageResult.events` after M13.4. Classification stamps are applied **before** Policy stub and delivery handoff.

---

## 5. Classification Ownership Model

### 5.1 Definitions

| Concept | Owner | Role in M13.4 |
|---------|-------|---------------|
| **Stream Classification** | Stream | Default classification rules (`stream_classification_rules`); stream-level governance defaults; container for `route_overrides[]` |
| **Route Classification Rules** | Route (optional full set) | Additive `route_classification_rules` when operator configures a **complete** alternate rule set for one route |
| **Route Classification Override** | Route (via governance entry) | Optional `classification_level` on `route_overrides[]` entry — route-level floor after rule resolution |
| **Sensitive Detection Findings** | Stream (Sample / runtime) | Shared suggestions — **not** duplicated per route |
| **Default level from findings** | Engine (spec 066) | When no rule matches: `default_level_from_findings(finding_classes)` |
| **Delivery Behavior / Quarantine** | Policy (M13.5) | **Not enforced in M13.4** — classification stamps only |

### 5.2 Inheritance

```text
Effective classification for route R:

  Step 1 — Persisted base (resolution order, list-replacement fallback):
    if route_classification_rules(R) has any enabled rules:
      persisted_rules = route_classification_rules(R)
    else if stream_classification_rules(stream) has any enabled rules:
      persisted_rules = stream_classification_rules(stream)
    else:
      persisted_rules = empty

  Step 2 — Engine resolution (shared findings):
  findings = SharedBatchContext.sensitive_detection_result
  finding_classes = extract from findings
  resolved_level, matched_count = resolve_classification_level(
    finding_classes=finding_classes,
    rules=persisted_rules,
  )
  # if persisted_rules empty → default_level_from_findings(finding_classes)

  Step 3 — Route governance classification floor:
  override_levels = [
    o.classification_level
    for o in governance.route_overrides
    where o.route_id = R and o.enabled and o.classification_level is set
  ]
  if override_levels:
    effective_level = max_level(resolved_level, *override_levels)
  else:
    effective_level = resolved_level

  Step 4 — Stamp and pass-through:
  classify_batch(events, rules=persisted_rules) with effective_level override
  OR stamp effective_level on all events in current_events
```

**Resolution order (normative for persisted base):**

```text
route_classification_rules
↓
stream_classification_rules
↓
empty config (engine default from findings)
```

**Inheritance summary:** Routes **inherit** stream classification rules by default. Routes **replace** the persisted rule set via `route_classification_rules`. Routes **raise** the resolved level via `route_overrides[].classification_level` (highest wins — consistent with spec 066).

### 5.3 Override

| Override type | Mechanism | Semantics |
|---------------|-----------|-----------|
| **Full route rule set** | `route_classification_rules` rows for `route_id` | Replaces stream rule set as base (Step 1) — other routes unaffected |
| **Route classification floor** | `route_overrides[].classification_level` for matching `route_id` | After rule resolution, `effective_level = max_level(resolved, override_levels)` |
| **Empty override** | No route rules, no override levels | Stream rules or engine defaults apply |

Override **does not** mutate stream defaults. Other routes continue using stream base unless they have their own rules or overrides.

### 5.4 Stream Classification after M13.4

| Mode | Stream classification role |
|------|------------------------------|
| Flag OFF | Authoritative — executed in `_classify_events()` before protection (legacy) |
| Flag ON, no route rows / overrides | Fallback base for every route via dual-read |
| Flag ON, route rules present | Route-specific base for that route only |
| Flag ON, override `classification_level` present | Floor applied per route after resolution |

### 5.5 Relationship to M13.3 Protection

Protection mutates field values (mask, hash, tokenize). Classification evaluates **finding classes** from shared Sensitive Detection and explicit rules — it does **not** re-run detection per route.

**Implication:** Classification level is primarily driven by **shared findings** + **route-specific rules/overrides**, not by post-protection field values. Protection may remove sensitive field values from the outbound copy; classification stamp still reflects governance label for the route's delivery context.

No ownership conflict: Protection owns field mutation; Classification owns sensitivity label stamp (spec 093 §5.5 analog).

---

## 6. Configuration Resolution Model

### 6.0 RouteClassificationConfig (typed model)

M13.4 **must** attach a typed `RouteClassificationConfig` to `RouteRuntimeContext.effective_config.classification` (replacing `Any | None` placeholder in `app/runners/route_context.py`).

```text
RouteClassificationConfig
├── rules[]                         # effective persisted rules for classify_batch()
│     id                            # optional DB id
│     name
│     condition_json
│     classification_level
│     enabled
│     source                        # route | stream
├── override_levels[]               # classification_level values from route_overrides[]
├── resolution
│     persisted_source              # route | stream | empty
│     override_count                # int — entries with classification_level
│     fallback_used                 # bool — true when stream rules used
│     matched_rule_count            # int — populated after stage (optional at resolve)
└── empty                           # true when no persisted rules and no override levels
```

Loader **must** populate persisted rules and override levels via `resolve_classification_config(route_id, stream_id)` before or at classification stage entry. `matched_rule_count` and final `effective_level` may be recorded on `stage_timeline` after engine execution.

### 6.1 Dual-read resolver algorithm (normative requirement)

Classification config resolution **must** follow this exact order. Governance override floors apply **only after** persisted base and engine resolution — never as a substitute for rule loading.

**Step A — Persisted base (list-replacement fallback):**

```text
route_classification_rules
↓
stream_classification_rules
↓
empty config
```

**Step B — Governance floor (after engine, not during rule load):**

```text
override_levels = [
  o.classification_level
  for o in governance.route_overrides
  where o.route_id == route_id and o.enabled and o.classification_level is set
]
effective_level = max_level(engine_resolved_level, *override_levels)
```

Classification resolution uses **list-replacement fallback** (same pattern as spec 091 §dual-read for classification; **not** Protection's ephemeral merge).

```text
resolve_classification_config(route_id, stream_id) -> RouteClassificationConfig:

  route_rules = load_enabled_route_classification_rules(route_id)
  if route_rules:
    persisted = route_rules
    persisted_source = "route"
  else:
    stream_rules = load_enabled_stream_classification_rules(stream_id)
    if stream_rules:
      persisted = stream_rules
      persisted_source = "stream"
    else:
      persisted = []
      persisted_source = "empty"

  governance = load_stream_governance_config(stream_id)
  # Canonical store: streams.config_json.governance (§7)
  override_levels = [
    normalize_level(o.classification_level)
    for o in governance.route_overrides
    if o.route_id == route_id
    and o.enabled
    and o.classification_level is not None
    and normalize_level(o.classification_level) is not None
  ]

  return RouteClassificationConfig(
    rules=map_to_rule_entries(persisted, source=persisted_source),
    override_levels=tuple(override_levels),
    resolution=RouteClassificationResolution(
      persisted_source=persisted_source,
      override_count=len(override_levels),
      fallback_used=(persisted_source == "stream"),
    ),
    empty=(persisted_source == "empty" and len(override_levels) == 0),
  )
```

**Normative resolution order (persisted base only):**

```text
route_classification_rules
↓
stream_classification_rules
↓
empty config
```

Governance `classification_level` overrides apply **after** rule resolution (Step 3 in §5.2), not as a substitute for persisted rule loading.

### 6.2 Engine invocation contract — `classify_batch` reuse (normative)

M13.4 **must reuse the existing Classification Engine** (`classify_batch()` / `resolve_classification_level()` per spec 066). **Do not** create a new classification engine or parallel runtime.

M13.4 **must not** call `evaluate_batch()` on the route path (stream DB query hardcoded to `stream_classification_rules`).

**ORM coupling / adapter requirement:**

If the current `classify_batch()` implementation is typed or coupled to `StreamClassificationRule` ORM objects, M13.4 **must** introduce an **adapter or protocol only** — e.g. map `RouteClassificationRuleEntry` / `RouteClassificationRule` → engine input shape — **without** changing classification algorithm, stamp field selection, or default-level logic.

| Allowed | Forbidden |
|---------|-----------|
| Rule entry protocol / generic mapping layer | New `ClassificationEngine` class |
| Inject resolved `rules[]` from `RouteClassificationConfig` | Duplicate `resolve_classification_level()` |
| Optional typing on `classify_batch()` parameters | Re-run Sensitive Detection per route |
| `rules_as_engine_types()` adapter on config | Fork stamp logic |

**Stage invocation (normative):**

```text
route_classification_stage(route_ctx, shared_batch):
  config = route_ctx.effective_config.classification
  findings = findings_from_context(shared_batch.sensitive_detection_result)
  result = classify_batch(
    events=route_ctx.processing_state.current_events,
    stream_id=route_ctx.stream_id,
    rules=config.rules_as_engine_types(),   # adapter maps route/stream entries → engine input
    findings=findings,
  )
  if config.override_levels:
    effective = max_level(result.classification_level, *config.override_levels)
    restamp_events(current_events, effective)
  else:
    effective = result.classification_level
  classification_result = RouteClassificationResult(
    effective_level=effective,
    matched_rule_count=result.matched_rule_count,
    persisted_source=config.resolution.persisted_source,
    override_applied=len(config.override_levels) > 0,
  )
  route_ctx.processing_state.classification_result = classification_result
  return current_events, classification_result
```

`classify_batch()` and `resolve_classification_level()` remain **unchanged in algorithm**. Only the **rule list source**, **adapter mapping**, and **call site** change.

### 6.3 Dual-write transition (optional)

During migration window, stream-scoped classification API writes may **mirror** to all routes (same policy as spec 091 §9.3). M13.4 implementation may defer dual-write until Wizard parity; **dual-read alone** preserves legacy behavior.

---

## 7. Governance Override Model

### 7.1 Decision (normative — not ambiguous)

**M13.4 adopts `streams.config_json.governance.route_overrides[]` as the canonical route override store.**

| Option | M13.4 decision |
|--------|----------------|
| **`streams.config_json.governance.route_overrides[]`** | **SELECTED** — canonical persistence and API round-trip |
| **`route_governance_overrides` normalized table** | **NOT introduced in M13.4** — deferred to post-M13.5 governance query/audit hardening if indexed lookup is required |

**Rationale:**

1. `streams.config_json.governance` already stores `schema_drift_policy` (runtime evidence: `app/schema_drift_policy/schemas.py`, Wizard deploy).
2. Governance Workspace v1.1 SoT models `route_overrides[]` as part of the stream governance document.
3. Spec 093 and route data model review prefer governance JSON + additive concern tables over a second override persistence path in the same milestone window.
4. Classification override is **optional additive field** on existing override entries — backward compatible.

**M13.4 does not require a new governance column.** Overrides live under existing `streams.config_json.governance`:

```json
{
  "governance": {
    "schema_drift_policy": { "...": "..." },
    "route_overrides": [
      {
        "route_id": 101,
        "protection_action": "full_mask",
        "delivery_behavior": "continue",
        "classification_level": "RESTRICTED",
        "enabled": true
      }
    ]
  }
}
```

### 7.2 `route_overrides[]` JSON shape (normative)

Each entry in `streams.config_json.governance.route_overrides[]` **must** conform to the following shape. M13.4 **must** document this schema in API validation and operator-facing docs.

**Canonical runtime entry (flat array — loader target):**

```json
{
  "route_id": 101,
  "enabled": true,
  "protection_action": "full_mask",
  "delivery_behavior": "continue",
  "classification_level": "RESTRICTED"
}
```

**Required fields for every override entry:**

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `route_id` | `integer` | **Yes** | Route this override applies to; must match an enabled route on the stream |
| `enabled` | `boolean` | **Yes** | When `false`, entry is ignored for all concerns (protection, classification, policy) |

**Classification-specific field (M13.4 additive):**

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `classification_level` | `string` enum | No | Route-level **minimum classification floor** — see §7.2.1 |

**Other concern fields (unchanged — not M13.4 scope):**

| Field | Type | Required | Owner |
|-------|------|----------|-------|
| `protection_action` | `string` enum | No | M13.3 |
| `delivery_behavior` | `string` enum | No | M13.5 — stored only in M13.4 |
| `field_path` | `string` | No | M13.3 — **Protection only**; not used by Classification |

**Minimal classification-only override example:**

```json
{
  "route_id": 202,
  "enabled": true,
  "classification_level": "CONFIDENTIAL"
}
```

Entries without `classification_level` do not participate in classification floor merge. Invalid `classification_level` values **must** be rejected at validation (`PUBLIC` \| `INTERNAL` \| `CONFIDENTIAL` \| `RESTRICTED` only).

#### 7.2.1 `classification_level` semantics (normative — not ambiguous)

`route_overrides[].classification_level` is a **route-level minimum classification floor**, applied **after** persisted rule resolution via `max_level(resolved_level, override_levels)`.

| Property | Classification override | Protection override (contrast) |
|----------|-------------------------|--------------------------------|
| Granularity | **Route-wide batch floor** | **Field-path keyed** (`field_path` + `protection_action`) |
| Mechanism | Raises resolved level when override is higher | Merges ephemeral protection rules per field |
| Purpose | Destination sensitivity posture for the route | Field masking / tokenization on outbound copy |
| Requires `field_path` | **No** | Yes (when scoped to a governance rule field) |

**Operators and implementers must not conflate the two override models.** UI labels should distinguish *"Route classification floor"* from *"Field protection override"* (design review R5).

Classification override is **not** a field-path protection override and **does not** replace or bypass `route_classification_rules` / `stream_classification_rules` — it only **raises** the effective stamp when the resolved level would otherwise be lower.

#### 7.2.2 Nested SoT vs flat persistence (reconciliation)

Governance Workspace SoT may nest `route_overrides[]` under per-field Governance Rules. M13.4 **must** reconcile to a **single canonical JSON document** under `streams.config_json.governance` with **no second persistence path**.

**Normative loader behavior:**

```text
load_stream_governance_config(stream_id):
  governance = streams.config_json.governance
  if governance.rules[] present (nested SoT):
    flat_overrides = flatten(
      for each rule in governance.rules:
        for each entry in rule.route_overrides[]:
          { route_id, enabled, field_path?, protection_action, classification_level, delivery_behavior }
    )
  else:
    flat_overrides = governance.route_overrides or []

  return GovernanceConfig(route_overrides=validated(flat_overrides))
```

Either nested (persist per SoT, flatten at load) or flat (persist flat array) is acceptable; runtime **always** consumes the flattened shape in §7.2.

### 7.3 `route_governance_overrides` table — explicit deferral

A normalized `route_governance_overrides` table remains a **future option** for governance workspace query performance. M13.4 implementations **must not** introduce it unless a separate governance hardening spec authorizes it. If introduced later, it **mirrors** the JSON document (same fields) — no pipeline redesign.

### 7.4 API load path

```text
load_stream_governance_config(stream_id):
  config_json = streams.config_json
  governance = config_json.get("governance") or {}
  route_overrides = governance.get("route_overrides") or []
  return GovernanceConfig(route_overrides=validated(route_overrides))
```

---

## 8. RouteClassificationConfig Contract (normative typed model)

M13.4 **must** replace the `Any | None` placeholder on `RouteEffectiveConfig.classification` with the typed contract below. This is a **hard deliverable** — stage activation must not land without typed config (design review R2).

Full typed contract for `RouteRuntimeContext.effective_config.classification`:

```python
# Conceptual — not implementation authorized by this spec

@dataclass(frozen=True)
class RouteClassificationRuleEntry:
    name: str
    condition_json: dict
    classification_level: str
    enabled: bool
    source: Literal["route", "stream"]
    id: int | None = None

@dataclass(frozen=True)
class RouteClassificationResolution:
    persisted_source: Literal["route", "stream", "empty"]
    override_count: int
    fallback_used: bool

@dataclass(frozen=True)
class RouteClassificationConfig:
    rules: tuple[RouteClassificationRuleEntry, ...]
    override_levels: tuple[str, ...]   # from route_overrides[].classification_level for this route_id
    resolution: RouteClassificationResolution

    @property
    def empty(self) -> bool:
        return len(self.rules) == 0 and len(self.override_levels) == 0

    def rules_as_engine_types(self) -> tuple:  # adapter → classify_batch() input protocol
        ...

@dataclass(frozen=True)
class RouteClassificationResult:
    effective_level: str
    matched_rule_count: int
    persisted_source: Literal["route", "stream", "empty"]
    override_applied: bool
```

**Attachment points:**

| Location | Type | When populated |
|----------|------|----------------|
| `RouteEffectiveConfig.classification` | `RouteClassificationConfig \| None` | Loader / `resolve_classification_config()` — `None` only when `GDC_CLASSIFICATION_ENABLED=false` |
| `RouteProcessingState.classification_result` | `RouteClassificationResult \| None` | After `route_classification_stage()` completes |
| `RouteStageResult.classification_result` | `RouteClassificationResult \| None` | **Required** when classification stage runs or is skipped with prior result — see §9.6 |

**Resolver → config → override floor (normative sequence):**

```text
1. resolve_classification_config(route_id, stream_id)
     persisted base (list-replacement):
       route_classification_rules
       ↓
       stream_classification_rules
       ↓
       empty config
     + extract override_levels from route_overrides[] where route_id matches

2. classify_batch(events, rules=config.rules_as_engine_types(), findings=shared)

3. effective_level = max_level(engine_level, *config.override_levels)

4. stamp events; attach RouteClassificationResult to processing_state + RouteStageResult
```

**Audit metadata on `stage_timeline` (recommended):**

```json
{
  "stage": "classification",
  "status": "completed",
  "classification_level": "CONFIDENTIAL",
  "matched_rule_count": 2,
  "persisted_source": "stream",
  "override_count": 1,
  "fallback_used": true,
  "duration_ms": 3
}
```

---

## 9. Runtime Integration

### 9.1 `process_route_pipeline()` integration

Replace `classification_stub` NO-OP with `route_classification_stage()`:

```text
process_route_pipeline(route_ctx, shared_batch):
  ... transform stage (M13.2) ...
  ... protection stage (M13.3) ...
  current_events = protected events

  if classification_enabled() and GDC_ROUTE_PROCESSING_ENABLED:
    config = route_ctx.effective_config.classification
    if config is not None and not config.empty_or_disabled():
      current_events, cls_result = route_classification_stage(
        route_ctx, shared_batch, log_fn=log_fn
      )
      timeline.append(classification_timeline_entry(cls_result, config))
    else:
      timeline.append({"stage": "classification", "status": "skipped", "reason": "empty_config"})
  else:
    timeline.append({"stage": "classification", "status": "skipped", "reason": "disabled"})

  ... policy_stub (NO-OP until M13.5) ...
  ... delivery_handoff ...

  return RouteStageResult(
    route_id=route_ctx.route_id,
    events=current_events,
    modified=...,
    stage_timeline=timeline,
    classification_result=classification_result,
    classification_duration_ms=...,
  )
```

### 9.2 StreamRunner flag ON guards

| Legacy call | Flag ON behavior |
|-------------|------------------|
| `_classify_events()` in `_collect_and_transform_events()` | **Must not run** |
| Stream `classify_events_for_delivery()` before fan-out | **Must not run** |
| `process_route_pipeline()` classification stage | **Active** |

### 9.3 SharedBatchContext requirements

| Field | Required for M13.4 |
|-------|-------------------|
| `sensitive_detection_result` | **Yes** — shared findings for all routes |
| `extracted_events` | Transform input only — classification uses post-protection `current_events` |
| `schema_drift_policy_result` | No direct consumption in M13.4 — M13.5 |

### 9.4 Global classification flag

`GDC_CLASSIFICATION_ENABLED=false` → classification stage skipped on route path (same as legacy pass-through). `GDC_ROUTE_PROCESSING_ENABLED` and `GDC_CLASSIFICATION_ENABLED` are independent.

### 9.5 Loader integration

Pre-resolve `effective_config.classification` per route at load time (or lazy-resolve at stage entry with batch cache):

```text
for route in enabled_routes:
  route_ctx.effective_config.classification = resolve_classification_config(
    route_id=route.id,
    stream_id=stream.id,
  )
```

Route classification rules loaded in batch query (no N+1 per route).

### 9.6 `RouteStageResult` — `classification_result` attachment (normative)

M13.4 **must** attach classification output to the route processing result. `RouteStageResult` **must** include:

| Field | Type | Required | Semantics |
|-------|------|----------|-----------|
| `classification_result` | `RouteClassificationResult \| None` | **Yes (field present)** | Populated when classification stage runs; `None` when globally disabled or explicitly skipped before stage |
| `classification_duration_ms` | `int \| None` | Recommended | Stage wall time — M13.6 observability prep |
| `events` | `list[dict]` | Yes (existing) | **Post-classification** stamped events passed to Policy stub and fan-out |

**Normative return shape:**

```text
return RouteStageResult(
  route_id=route_ctx.route_id,
  events=current_events,                    # stamped after classification
  modified=...,
  stage_timeline=timeline,
  classification_result=classification_result,
  classification_duration_ms=...,
)
```

`classification_result.effective_level` **must** match the batch stamp applied to `events`. Downstream Policy (M13.5) and fan-out **must** receive these stamped events — not pre-classification copies.

---

## 10. Classification Lifecycle

### 10.1 Stage sequence (normative)

```text
RouteStageResult from Protection (protected events)
  ↓
Resolve RouteClassificationConfig (if not pre-resolved)
  ↓
Extract findings from SharedBatchContext.sensitive_detection_result
  ↓
classify_batch(
  events = current_events,
  stream_id = route_ctx.stream_id,
  rules = config.rules,
  findings = findings,
)
  ↓
Apply override floor: max_level(engine_level, override_levels)
  ↓
Stamp classification_level / classification_level_gdc on events
  ↓
Record stage_timeline: classification (completed)
  ↓
classified RouteStageResult
  ↓
Policy stub (NO-OP in M13.4)
  ↓
Delivery handoff → Fan-out
```

### 10.2 Lifecycle diagram

```text
Protection RouteStageResult
  events: [ post-protection route-shaped dicts ]
       │
       ▼
┌──────────────────────────────────────┐
│ route_classification_stage()         │
│  findings ← shared batch (once)      │
│  rules ← dual-read config            │
│  level ← resolve + override floor    │
│  stamp events in place               │
└──────────────────────────────────────┘
       │
       ▼
classified RouteStageResult
  events: [ stamped dicts ]
  stage_timeline: [ ..., classification, policy_stub, delivery_handoff ]
       │
       ▼
Policy stub → Delivery handoff → _fan_out()
```

### 10.3 Audit and logging

| Event | Log stage | Scope |
|-------|-----------|-------|
| Classification batch complete | `classification_complete` | Include `route_id`, `classification_level`, `matched_rule_count` (spec 066) |
| Classification skipped | `classification` | `reason`: disabled / empty_config |
| Field stamp | (in batch metadata) | No per-field log — batch-level stamp |

Structured logging must **not** include full sensitive raw payload (existing rule).

### 10.4 Legacy vs route path — stage order

| Path | Classification position | Input event shape |
|------|-------------------------|-------------------|
| Flag OFF | Before Protection (stream) | Post-enrichment stream batch |
| Flag ON | After Protection (route) | Post-protection per-route batch |

**Regression matrix required** (§16): document and test both paths; flag OFF must show **zero** behavior change vs pre-M13.4 baseline.

### 10.5 Preview lifecycle

Classification Preview (Wizard / Governance Route Preview) runs the **route classification stage** against sample events:

- Input: **route-protected** sample events (transform + protection preview chain)
- Config: `resolve_classification_config(route_id, stream_id)`
- Engine: same `classify_batch()` as runtime
- Output: Route A / Route B side-by-side classification level display

### 10.6 M13.5 handoff — Policy consumes stamps, does not re-run Classification (normative)

M13.4 **must** establish the handoff contract for M13.5. Policy **must consume stamped classification fields on events**; it **must not** re-run Classification or Sensitive Detection.

**Handoff contract:**

```text
Classification stage (M13.4)
  → stamps classification_level / classification_level_gdc on every event in current_events
  → attaches RouteClassificationResult to RouteStageResult
       ↓
Policy stage (M13.5 — stub in M13.4)
  → reads classification_levels_from_events(current_events)   # event stamps only
  → reads finding_classes from SharedBatchContext.sensitive_detection_result  # shared once
  → evaluates route-resolved policy rules (M13.5 dual-read — out of M13.4 scope)
  → MUST NOT invoke classify_batch(), evaluate_batch(), or re-run Sensitive Detection
```

| Input to Policy (M13.5) | Source | Re-run forbidden? |
|---------------------------|--------|-------------------|
| `classification_level` / `classification_level_gdc` on events | M13.4 stamp on `RouteStageResult.events` | **Yes — consume stamps only** |
| `finding_classes` | `SharedBatchContext.sensitive_detection_result` | **Yes — shared batch only** |
| `delivery_behavior` | `route_overrides[]` for route | Read from governance — no classification re-derive |
| `schema_drift_policy_result` | `SharedBatchContext` | Shared batch — M13.5 |

**Evidence alignment:** Policy engine today reads `classification_levels_from_events(events)` (`app/protection/policy_engine.py`). M13.4 ensures route-classified events carry stamps **before** Policy stub is replaced in M13.5.

### 10.7 Boundaries to M13.5 (workflow scope)

| Workflow | M13.4 | M13.5 |
|----------|-------|-------|
| Policy evaluation | **Not implemented** — stub NO-OP | Policy stub → active; consumes stamped events |
| Quarantine on classification condition | **Not implemented** | Existing policy `quarantine` action on stamped level |
| Require Review | **Not implemented** | Policy + drift |
| `delivery_behavior` enforcement | **Not implemented** | Reads override; blocks/quarantines delivery |

M13.4 stamps classification; M13.5 **gates delivery** based on stamped level and policy rules — **without** re-running classification.

---

## 11. Database Impact

Conceptual only — no SQL, no migrations authorized by this document.

### 11.1 Current tables (reuse)

| Table | M13.4 role |
|-------|------------|
| `stream_classification_rules` | Fallback base rules — **unchanged** |
| `stream_sensitive_findings` | Detection persistence — **unchanged** |
| `streams.config_json` | Governance + schema drift — **unchanged**; `governance.route_overrides[]` extended |

### 11.2 Required future additions (additive)

| Artifact | Key | Purpose |
|----------|-----|---------|
| **`route_classification_rules`** | `route_id` FK + index `(route_id, enabled)` | Optional full route-specific rule set — **mirrors** `stream_classification_rules` shape |
| **`streams.config_json.governance.route_overrides[]`** | Stream-scoped JSON | Canonical override store; add optional `classification_level` per entry (§7) |

**`route_classification_rules` conceptual columns:**

```text
id PK
route_id FK → routes.id ON DELETE CASCADE
name VARCHAR(128) NOT NULL
enabled BOOLEAN NOT NULL DEFAULT true
condition_json JSONB NOT NULL
classification_level VARCHAR(32) NOT NULL
created_at, updated_at TIMESTAMPTZ
INDEX (route_id, enabled)
```

**Preference:** Mirror `stream_classification_rules` column types (`JSONB` for `condition_json`). Do **not** use field-path uniqueness (unlike protection) — named rules allow duplicates across names with different conditions.

### 11.3 Explicitly NOT in M13.4

| Artifact | Status |
|----------|--------|
| `route_governance_overrides` table | **Deferred** (§7.3) |
| `routes.processing_metadata_json` | Optional — M13.6 / deploy readiness |
| Alter `stream_classification_rules` | **Forbidden** |

### 11.4 Unchanged

No truncate of user classification rules. No change to event stamp field names.

### 11.5 Backfill (future tool — not M13.4)

For streams with N routes and identical classification needs: **no route rows required** — dual-read stream fallback preserves behavior. Backfill copies stream rules to `route_classification_rules` only when operator explicitly diverges routes.

---

## 12. API Impact

Conceptual only — no endpoint implementation authorized by this document.

### 12.1 Current APIs (retained)

```text
GET/POST/PATCH/DELETE /runtime/streams/{stream_id}/classification-rules
GET                   /runtime/streams/{stream_id}/classification/summary
```

Stream endpoints remain for fallback and aggregate views.

### 12.2 Required future APIs (M13.4)

```text
GET/POST/PATCH/DELETE /runtime/routes/{route_id}/classification-rules
GET                   /runtime/routes/{route_id}/classification/summary
GET                   /runtime/routes/{route_id}/classification/effective

GET/PUT               /runtime/streams/{stream_id}/governance
                      (+ route_overrides[].classification_level)

POST                  /runtime/preview/classification
                      (+ route_id — dual-read; protected sample input when flag ON)

POST                  /runtime/preview/route-pipeline
                      (extend chain: transform + protection + classification)
```

### 12.3 Response metadata (recommended)

```json
{
  "route_id": 42,
  "stream_id": 7,
  "resolution": {
    "persisted_source": "stream",
    "override_count": 1,
    "fallback_used": true
  },
  "effective_level": "CONFIDENTIAL",
  "rules": []
}
```

### 12.4 Compatibility shim

| Caller | Behavior |
|--------|----------|
| Stream classification CRUD (legacy UI) | Unchanged; writes stream rules only |
| Stream write-through (transition) | Optional mirror to all routes — not required for M13.4 MVP |
| Preview without `route_id` | Stream rules only (legacy preview) |

---

## 13. Frontend Impact

Conceptual only — no UI implementation authorized by this document.

### 13.1 Route Processing UI (Wizard Charter v5.2)

| Surface | Change |
|---------|--------|
| Route Processing step — **Classification tab** | Per-route rule editor; shows effective level from dual-read |
| Route Preview | Side-by-side Route A / B classification level after transform + protection preview |
| Deploy Summary | Per-route classification source: `route` \| `stream` \| `default` |

### 13.2 Governance Workspace

| Surface | Change |
|---------|--------|
| Governance Rule Editor — Route Overrides | Optional `classification_level` dropdown per route override row |
| Route Classification Visibility (WBS) | Effective level per route in governance context panel |
| Violations / Quarantine | **No route breakdown in M13.4** — M13.5+ |

### 13.3 Stream edit / route edit pages

| Surface | Change |
|---------|--------|
| `route-edit-page.tsx` | Classification section (effective config + link to rules) |
| Stream-global classification page | Retained as default editor; banner when route overrides exist |

### 13.4 Non-scope UI

- Destination First Wizard reorder (may parallel M13.4)
- Full route-aware governance dashboard (WBS Route Governance Extension — partial)

---

## 14. Backward Compatibility

### 14.1 Feature flag OFF

`GDC_ROUTE_PROCESSING_ENABLED=false` (rollback; product default is `true`):

- **Zero behavior change** vs pre-M13.4 baseline
- Stream classification runs in `_collect_and_transform_events()` **before** protection
- No `route_classification_rules` consulted
- E2E regression suite must pass unchanged

### 14.2 Feature flag ON — parity cases

| Scenario | Expected behavior |
|----------|-------------------|
| No `route_classification_rules`; no `classification_level` overrides | Same effective level as stream rules for all routes |
| No stream rules; no route rules | Engine defaults from shared findings (spec 066) |
| Route A has rules; Route B does not | A uses route rules; B uses stream fallback |
| `GDC_CLASSIFICATION_ENABLED=false` | Stage skipped; events unstamped by classification stage |

### 14.3 Stream fallback

When `route_classification_rules` absent or all disabled for route R:

```text
effective persisted rules = stream_classification_rules(stream_id)
```

Stream table remains authoritative default. No operator action required for single-classification multi-route streams.

### 14.4 Dual-read without backfill

Existing deployments with stream rules only: **no migration required**. Routes inherit stream classification automatically when flag ON.

### 14.5 Rollback

| Trigger | Action |
|---------|--------|
| Regression with flag ON | Set `GDC_ROUTE_PROCESSING_ENABLED=false` — immediate legacy path |
| Classification bug | Set `GDC_CLASSIFICATION_ENABLED=false` — global skip |
| Route config error | Delete route classification rules — fallback to stream |

No data migration rollback required for flag OFF.

---

## 15. Acceptance Criteria

M13.4 is **complete** when all criteria pass.

### 15.0 Task-mandate gates (design review R1–R8)

- [ ] **AC-0a** `RouteEffectiveConfig.classification` is **`RouteClassificationConfig`** (typed) — not `Any | None`.
- [ ] **AC-0b** `route_overrides[]` JSON shape documented with required `route_id`, optional `classification_level`, and §7.2.1 floor semantics (not field-path override).
- [ ] **AC-0c** Resolver order enforced: `route_classification_rules` → `stream_classification_rules` → empty config; then `route_overrides[].classification_level` floor via `max_level()`.
- [ ] **AC-0d** `classify_batch()` reuses existing engine; ORM coupling resolved via adapter/protocol only — no new classification engine.
- [ ] **AC-0e** `RouteStageResult.classification_result` attached after classification stage.
- [ ] **AC-0f** M13.5 handoff documented: Policy consumes stamped events — does not re-run classification (§10.6).
- [ ] **AC-0g** Flag ON stage order: **Transform → Protection → Classification → Policy stub** (unchanged stub).
- [ ] **AC-0h** Flag OFF legacy order unchanged: Classification **before** Protection on stream path.

### 15.1 Prerequisites (M13.2 + M13.3)

- [ ] **AC-1** M13.2 acceptance criteria satisfied — route loop, transform, fan-out wiring.
- [ ] **AC-2** M13.3 acceptance criteria satisfied — protection stage active, protected fan-out.
- [ ] **AC-3** `SharedBatchContext.sensitive_detection_result` available to classification stage.
- [ ] **AC-4** Stream `_classify_events()` **not** called when `GDC_ROUTE_PROCESSING_ENABLED=true`.

### 15.2 Classification stage activation

- [ ] **AC-5** `classification_stub` replaced with `route_classification_stage()` invoking existing engine.
- [ ] **AC-6** Classification runs **after** Protection in `process_route_pipeline()`.
- [ ] **AC-7** `_fan_out()` delivers **classified** per-route events from `RouteStageResult.events`.
- [ ] **AC-8** No new Classification Engine class or parallel pipeline.

### 15.3 Config resolution

- [ ] **AC-9** Resolution order: `route_classification_rules` → `stream_classification_rules` → empty config.
- [ ] **AC-10** Route rules present → route rule set replaces stream base for that route (list-replacement).
- [ ] **AC-11** Route-level classification floor: `route_overrides[].classification_level` applies via `max_level()` **after** rule resolution — not as field-path protection override.
- [ ] **AC-12** `RouteRuntimeContext.effective_config.classification` populated as typed **`RouteClassificationConfig`**.
- [ ] **AC-13** `RouteClassificationConfig.resolution` metadata exposed in effective config API/debug.

### 15.4 Product scenarios

- [ ] **AC-14** Same stream, Route A INTERNAL, Route B RESTRICTED — outbound stamps differ accordingly.
- [ ] **AC-15** Operator achieves destination-specific classification **without** duplicating streams.
- [ ] **AC-16** Sensitive Detection runs once per batch — not N times per route.

### 15.5 Engine reuse

- [ ] **AC-17** `classify_batch()` / `resolve_classification_level()` used unchanged in algorithm.
- [ ] **AC-18** `evaluate_batch()` **not** called from route path (no stream-only DB query in route stage).
- [ ] **AC-19** If `classify_batch()` coupled to `StreamClassificationRule` ORM, adapter/protocol maps route entries — no algorithm fork.
- [ ] **AC-20** Stamp fields `classification_level` / `classification_level_gdc` per spec 066.

### 15.6 Stage order regression

- [ ] **AC-21** Flag OFF: Classification before Protection — **unchanged legacy order** (zero behavior change).
- [ ] **AC-22** Flag ON: **Transform → Protection → Classification → Policy stub** on post-protection route events.
- [ ] **AC-23** Regression matrix documents delta between legacy and route paths.

### 15.7 Compatibility

- [ ] **AC-24** Flag OFF: zero behavior change vs pre-M13.4 baseline (e2e green).
- [ ] **AC-25** Flag ON, no route config: classification parity with flag OFF when transform + protection parity holds.
- [ ] **AC-26** No truncate of user `stream_classification_rules`.

### 15.8 Observability and route result

- [ ] **AC-27** `RouteStageResult.classification_result` populated with `effective_level`, `matched_rule_count`, `persisted_source`, `override_applied`.
- [ ] **AC-28** `delivery_logs` `classification_complete` entries include `route_id` when flag ON.
- [ ] **AC-29** Classification preview accepts `route_id` and uses effective route config.

### 15.9 Boundaries (stubs and deferred work)

- [ ] **AC-30** Policy engine **not** invoked in M13.4 — stub remains NO-OP; M13.5 will consume stamps only (§10.6).
- [ ] **AC-31** Quarantine and Require Review workflows **not** implemented (M13.5).
- [ ] **AC-32** Route delivery metrics / health **not** implemented (M13.6).
- [ ] **AC-33** `route_governance_overrides` normalized table **not** introduced (§7.3).

---

## 16. Test Strategy

### 16.1 Unit tests

| Area | Cases |
|------|-------|
| `resolve_classification_config` | Route rules win; stream fallback; empty; override floor merge |
| `max_level` with overrides | Override raises level; no override preserves engine level |
| Rule entry mapping | Route vs stream `source` attribution |
| `RouteClassificationConfig.empty` | No rules and no overrides |
| Governance JSON parse | `classification_level` optional; invalid level rejected |

### 16.2 Integration tests

| Area | Cases |
|------|-------|
| `process_route_pipeline()` | Classification after protection; timeline entries |
| Dual routes divergent | Route A stream rules; Route B route rules — different stamps |
| Override floor only | No route rules; override raises above default |
| Flag OFF | Stream path unchanged — spy confirms `_classify_events` in shared phase |
| Flag ON | Stream `_classify_events` not called; route stage called N times |
| `GDC_CLASSIFICATION_ENABLED=false` | Stage skipped both paths |
| Engine reuse | Mock confirms `classify_batch` entry — not `evaluate_batch`; adapter used if ORM-coupled |
| `RouteStageResult.classification_result` | Present after stage; `effective_level` matches event stamps |
| M13.5 handoff | Policy stub receives stamped events; no classification re-invocation |

### 16.3 Regression tests

- Full e2e flag OFF — no expectation changes
- Existing stream classification rule CRUD — unchanged
- Backup import stream-only classification config — valid with dual-read
- Protection + classification order flag ON vs OFF matrix

### 16.4 Performance tests

| Case | Threshold (guidance) |
|------|----------------------|
| N routes × classification | Linear O(N); shared detection O(1) |
| Loader batch rule load | No N+1 queries for route classification resolution |
| Classification stage | Comparable to single stream batch (rule count bounded) |

Benchmark alongside M13.2/M13.3 route count matrix (formal gate post-M13.6).

---

## 17. Implementation Boundaries

### 17.1 IN scope (M13.4)

| Deliverable | Description |
|-------------|-------------|
| `route_classification_rules` | Additive schema + repository |
| `streams.config_json.governance.route_overrides[].classification_level` | Schema extension + validation |
| `resolve_classification_config()` | Dual-read → typed `RouteClassificationConfig` (§6.1, §8) |
| `route_classification_stage()` | Active stage; `classify_batch()` + adapter if ORM-coupled (§6.2) |
| Loader `effective_config.classification` | Typed `RouteClassificationConfig` per route |
| Replace `classification_stub` | Active stage + timeline + `RouteStageResult.classification_result` (§9.6) |
| `classify_batch` adapter/protocol | Decouple from `StreamClassificationRule` ORM if coupled — no new engine |
| M13.5 handoff contract | §10.6 — Policy consumes stamped events; no classification re-run |
| Route classification APIs + effective config endpoint | §12 |
| Classification preview `route_id` | Same engine as runtime |
| Route classification UI (Wizard tab, governance override field) | Conceptual §13 — may trail runtime |
| Stage order documentation + regression matrix | §10.4, AC-0g–AC-0h, AC-21–AC-23 |
| Tests | §16 |

### 17.2 OUT of scope (M13.5+)

| Milestone | Excluded from M13.4 |
|-----------|---------------------|
| **M13.5** | Policy evaluation; `delivery_behavior` enforcement; unknown field Require Review / Quarantine workflows |
| **M13.6** | Route metrics, route health, delivery observability extensions |
| **Governance** | `route_governance_overrides` normalized table |
| **Any** | New Classification Engine; parallel runtime; Sensitive Detection re-run per route |
| **Wizard P7** | Full Destination First reorder (may parallel M13.4) |
| **Policy quarantine** | Classification-condition quarantine via policy engine |

### 17.3 M13.4 implementation order (recommended)

| Step | Work | Exit criteria |
|------|------|---------------|
| **A** | Confirm M13.3 gates (AC-1, AC-2) | M13.3 complete |
| **B** | Additive DB + repos for `route_classification_rules` | AC-26 |
| **C** | Governance JSON `classification_level` on `route_overrides[]` + §7.2 schema | AC-0b, AC-11 |
| **D** | `resolve_classification_config()` → typed `RouteClassificationConfig` + loader | AC-0a, AC-9–AC-13 |
| **E** | `route_classification_stage()` — wire `classify_batch()` + adapter; attach `classification_result` | AC-0d, AC-0e, AC-5–AC-8, AC-17–AC-20 |
| **F** | Stage order guards — skip stream classification when flag ON | AC-4, AC-0g–AC-0h, AC-21–AC-23 |
| **G** | Route APIs + effective config + preview `route_id` | AC-13, AC-29 |
| **H** | Frontend Route Classification tab + governance field | AC-14, AC-15 |
| **I** | Regression + parity tests; verify Policy stub NO-OP + M13.5 handoff doc | AC-0f, AC-24–AC-26, AC-30–AC-33 |

### 17.4 Dependencies

| Dependency | Relationship |
|------------|--------------|
| M13.1 | Context contracts, feature flag, orchestration slots |
| M13.2 | Transform stage, fan-out wiring, shared batch — **hard prerequisite** |
| M13.3 | Protection stage, post-protection event shape — **hard prerequisite** |
| M13.5 | Policy follows classification; may gate delivery on stamped level |
| M13.6 | Per-route delivery metrics; optional `classification_duration_ms` |
| spec 066 | Engine levels, defaults, stamp fields — unchanged |

---

## Appendix A — Verification mapping (task checklist)

| # | Task requirement | Spec section |
|---|------------------|--------------|
| 1 | Problem Statement | §1 |
| 2 | Source Of Truth Alignment | §2 |
| 3 | Current Classification Model | §3 |
| 4 | Target Classification Model | §4 |
| 5 | Classification Ownership Model | §5 |
| 6 | Configuration Resolution Model | §6 |
| 7 | Governance Override Model (`route_overrides[]` JSON shape, floor semantics) | §7 |
| 8 | RouteClassificationConfig Contract + RouteClassificationResult | §8 |
| 9 | Runtime Integration (`RouteStageResult.classification_result`) | §9 |
| 10 | Classification Lifecycle + M13.5 handoff | §10 |
| 11 | Database Impact | §11 |
| 12 | API Impact | §12 |
| 13 | Frontend Impact | §13 |
| 14 | Backward Compatibility | §14 |
| 15 | Acceptance Criteria | §15 |
| 16 | Test Strategy | §16 |
| 17 | Implementation Boundaries | §17 |

---

## Appendix B — Related specs

| Spec | Relationship |
|------|--------------|
| `specs/091-route-processing-architecture/spec.md` | Foundation contracts; `route_classification_rules` in Appendix A |
| `specs/092-per-route-transform/spec.md` | Transform stage; classification stub placeholder |
| `specs/093-per-route-protection/spec.md` | Protection stage; governance override pattern; classification follows protection |
| `specs/066-classification-engine/spec.md` | Engine reuse — levels, defaults, stamps |
| `specs/004-delivery-routing/spec.md` | Fan-out, checkpoint unchanged |
| `docs/architecture/route-data-model-review.md` | DB pattern confirmation — additive, no redesign |
| `docs/architecture/m13-4-classification-design-review.md` | Design review — typed config, JSON shape, engine adapter, M13.5 handoff |

---

## Appendix C — Key implementation files (future — not authorized now)

| File | M13.4 change |
|------|--------------|
| `app/runners/route_stage.py` | Replace `classification_stub` with `route_classification_stage()` |
| `app/runners/route_context.py` | `RouteClassificationConfig` types |
| `app/runners/stream_runner.py` | Guard `_classify_events()` when flag ON |
| `app/runners/stream_loader.py` | Resolve classification config per route |
| `app/classification/models.py` | `RouteClassificationRule` model |
| `app/classification/engine.py` | Accept generic rule protocol via adapter — no algorithm change |
| `app/classification/service.py` | Route stage wrapper — not `evaluate_batch()` on route path |
| `app/runtime/router.py` | Route classification endpoints |

---

*End of M13.4 companion spec. No code, database, API, UI, or runtime changes authorized by this document.*
