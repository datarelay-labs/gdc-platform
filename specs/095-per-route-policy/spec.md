# M13.5 Per Route Policy

**Milestone:** M13.5 (Per Route Policy)
**Status:** CURRENT implementation spec for M13.5 (delivered). Original M13 rollout assumed flag default OFF; product default is ON as of P1-4 (`false` = rollback).
**Depends on:** M13.1 Route Processing Foundation (`specs/091-route-processing-architecture/spec.md`), M13.2 Per Route Transform (`specs/092-per-route-transform/spec.md`), M13.3 Per Route Protection (`specs/093-per-route-protection/spec.md`), M13.4 Per Route Classification (`specs/094-per-route-classification/spec.md`)
**Design review:** [`docs/architecture/route-data-model-review.md`](../../docs/architecture/route-data-model-review.md), [`docs/architecture/m13-route-architecture-design-review.md`](../../docs/architecture/m13-route-architecture-design-review.md), [`docs/architecture/m13-3-protection-design-review.md`](../../docs/architecture/m13-3-protection-design-review.md), [`docs/architecture/m13-4-classification-design-review.md`](../../docs/architecture/m13-4-classification-design-review.md), [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)
**Authority:** Product Charter 1.2.1, Master WBS 1.2.1, `.specify/memory/constitution.md`, Governance & Transform Policy v1.1, Governance UX Charter v1.1, Governance Workspace v1.1
**Architecture:** [`docs/architecture/route-processing-foundation-implementation-spec.md`](../../docs/architecture/route-processing-foundation-implementation-spec.md)
**Gap analysis:** [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)

---

## 1. Problem Statement

Policy evaluation and enforcement are **Stream-scoped** today. One policy rule set evaluates a **single batch-level** decision that applies identically before fan-out. Every route on a stream receives the same allow / audit / block / quarantine / require-review outcome, regardless of destination governance posture.

```text
Stream
↓
Transform (stream-scoped or per-route — M13.2)
↓
Protection (stream-scoped or per-route — M13.3)
↓
Classification (stream-scoped or per-route — M13.4)
↓
Policy once (stream-scoped)
↓
Fan-out (identical policy decision)
↓
Destinations
```

**Product violation:** Operators who need different policy behavior per destination (e.g. Route A → internal SIEM **Continue**, Route B → partner API **Quarantine on CONFIDENTIAL**, Route C → archive **Block on drift Require Review**) must **duplicate Streams** for the same source. Product Charter 1.2.1 forbids this: *목적지별 처리 차이는 Route를 통해 구성한다* and *users must not duplicate Streams because destinations require different processing*.

**Gap (evidence):** `stream_policy_rules.stream_id` FK only; no `route_id`; `_evaluate_policies()` in `app/runners/stream_runner.py` runs once on the legacy path after stream protection; `process_route_pipeline()` records `policy_stub` as NO-OP pass-through (`app/runners/route_stage.py`); `stream_quarantine_events` has `stream_id` only — no `route_id`; `evaluate_batch()` in `app/protection/policy_engine.py` queries stream rules via DB hardcoded to `stream_policy_rules`.

**M13.4 delivers:** Per-route Classification inside `process_route_pipeline()`; stamped `classification_level` / `classification_level_gdc` on classified route events; Policy **stub** (pass-through); stream-level `_evaluate_policies()` **skipped** when `GDC_ROUTE_PROCESSING_ENABLED=true` (spec 092 §9.2); M13.4 → M13.5 handoff contract in spec 094 §10.6.

**M13.5 solves:** Activate the **Policy stage** inside the per-route pipeline using the **existing Policy Engine** (`evaluate_batch()` / `evaluate_event()` with injected rules), with **route-aware effective rules** (stream defaults + optional route rule table + governance `delivery_behavior` override + shared schema drift signals), **consuming outputs from prior stages only**, so each route can **gate delivery independently** without Stream duplication.

**Stage order decision (M13.5 scope):** On the route path (flag ON), Policy runs **after Classification** on **post-classification route-shaped events**, matching Product Charter Core Pipeline (Protection → Classification → Policy). Legacy flag OFF path retains Policy **after** stream protection (classification before protection on legacy — intentional dual behavior documented in §13.4).

**Explicit non-goals in this spec:** Route Runtime Delivery redesign (M13.6), delivery observability / metrics redesign (M13.6), Governance catalog simulation redesign (M18), full Governance Dashboard route breakdown (Route Governance Extension — partial UI may trail runtime).

---

## 2. Source Of Truth Alignment

| Document | Mandate relevant to M13.5 |
|----------|---------------------------|
| **Product Charter 1.2.1** | Route = Destination Specific Processing Unit; Transform / Protection / Classification / Policy route-applicable; Core Pipeline ends with Policy before delivery; Runtime Reuse First; No Parallel Pipeline; Quarantine + Audit |
| **Master WBS 1.2.1** | M13.5 = Per Route Policy, Route Specific Policy Evaluation, Route Specific Policy Enforcement |
| **UX Charter 1.2.1** | §24–27 Route model; per-destination governance via Route; Quarantine Detail; Release Quarantine |
| **Stream Wizard Charter v5.2** | Step 4 Route Processing → Policy tab per route; Deploy Summary per-route policy source |
| **Governance UX Charter v1.1** | Configuration Scope = Stream, Execution Scope = Route; delivery behavior per route override |
| **Governance Workspace v1.1** | Governance Rule + `route_overrides[]` with `delivery_behavior`; Quarantine Rules; Route Preview |
| **Governance & Transform Policy v1.1** | §14–15 Policy actions; §20 Route Protection Policy; §21 Route Aware Schema Drift; Require Review / Quarantine / Block delivery behaviors |
| **Union Schema UX Spec v1.1** | Unknown field policies (pass_through, require_review, quarantine) — stream-scoped config; route override via governance |
| **Route data model review** | Additive `route_policy_rules`; dual-read list-replacement; nullable `route_id` on quarantine |
| **M13.4 design review** | Policy consumes stamped events; `RoutePolicyConfig` parallel to `RouteClassificationConfig`; JSON governance sufficient through M13.5 MVP |
| **ChatGPT Guardrail v1.0** | No new governance categories; reuse runtime; no parallel engines |

**Constitution (unchanged):**

- Checkpoint updated only after successful Destination delivery
- Stream = execution unit; Route connects Stream → Destination
- Delivery failures logged structurally
- No parallel pipeline or policy engine

**Critical rules (task mandate):**

| Rule | M13.5 interpretation |
|------|----------------------|
| Reuse existing Policy Engine | Invoke `evaluate_batch()` / `evaluate_event()` with injected rules — no rewrite |
| Reuse Classification results | Read stamps from `RouteStageResult.events` — no re-classification |
| Reuse Sensitive Detection results | Input from `SharedBatchContext.sensitive_detection_result` — no re-detection per route |
| Reuse Protection results | Policy input = post-protection classified events — no re-protection |
| Reuse Quarantine Engine | Existing `stream_quarantine_events` + recording pipeline — extend with `route_id` |
| Reuse Audit pipeline | Existing `delivery_logs` policy stages — extend with `route_id` |
| Do NOT create new Policy Engine | Config resolution and orchestration only |
| Do NOT create new Governance Engine | Runtime consumes governance JSON + rule tables — M18 catalog separate |
| Do NOT create parallel runtime | Policy stage inside existing `process_route_pipeline()` |
| Route Policy additive | New `route_policy_rules` table; stream table preserved |
| Existing Streams continue working | Dual-read + flag OFF parity |
| Feature flag rollback path | `GDC_ROUTE_PROCESSING_ENABLED=false` — legacy path unchanged (product default is `true` as of P1-4) |
| Do NOT redesign Route DB model | Additive `route_policy_rules` + nullable quarantine `route_id` only |

---

## 3. Current Policy Model

### 3.1 Storage

| Entity | Scope | Key fields |
|--------|-------|------------|
| `stream_policy_rules` | Stream | `stream_id`, `name`, `enabled`, `condition_json`, `action_type` |
| `stream_quarantine_events` | Stream | `stream_id`, `quarantine_reason`, `quarantine_source`, `status`, `protected_payload_json`, `metadata_json` — **no `route_id`** |
| Stream schema drift policy | Stream | `streams.config_json` — `unknown_normal_field_policy`, `unknown_sensitive_field_policy` |
| Governance overrides (SoT) | Stream | `route_overrides[]` — `delivery_behavior`, `protection_action` (partial runtime) |

**Evidence:** `app/protection/models.py` — `StreamPolicyRule`; no `route_id` on policy tables. `app/quarantine/models.py` — `StreamQuarantineEvent` stream-scoped only.

**Policy action types implemented today:** `audit_only`, `quarantine` (`POLICY_ACTION_AUDIT_ONLY`, `POLICY_ACTION_QUARANTINE` in `app/protection/models.py`).

**Rule condition shape:** `condition_json.sensitivity_class` or `condition_json.classification_level` matched against shared findings and event stamps (`app/protection/policy_engine.py`).

### 3.2 Governance configuration model (SoT)

Governance Workspace v1.1 defines per Governance Rule:

```text
Governance Rule
  field_path
  sensitivity_type
  default_protection_action
  default_delivery_behavior      # Continue Delivery | Quarantine | Block
  route_overrides[]
    route_id
    protection_action
    delivery_behavior
    classification_level         # M13.4 additive
    enabled
```

**Delivery behavior values (SoT):** `continue`, `quarantine`, `block` (normalized). Require Review arises from **schema drift policy** (`require_review`) combined with route override context — not a separate `delivery_behavior` enum value in all SoT surfaces but **semantically distinct** in Governance & Transform Policy v1.1.

### 3.3 Runtime loading

`stream_loader` loads `stream_policy_rules` indirectly via runtime evaluation. Routes carry **delivery fields only** — no policy rules attached to route runtime dict today.

### 3.4 Runtime execution

**Flag OFF (legacy — unchanged by M13.5):**

```text
_collect_and_transform_events()
  → Mapping → Enrichment → Sensitive Detection
  → Classification (stream — before protection)
  → Schema Drift Policy

→ _prepare_delivery_events()          ← stream Protection
→ _evaluate_policies()               ← stream Policy (DB stream rules)
→ _fan_out(delivery_events)
```

**Flag ON + M13.4 (Policy stub — pre-M13.5):**

```text
Shared Phase → extracted_events + sensitive_detection_result + schema_drift_policy_result

→ process_route_pipeline() per route
     Transform (active)
     Protection (active)
     Classification (active — M13.4)
     Policy stub (pass-through)    ← NO-OP
     Delivery handoff
→ _fan_out(per-route RouteStageResult.events)
```

Stream `_evaluate_policies()` **must not** run when flag ON (spec 092 §9.2). Policy stub records `policy_stub` in `stage_timeline` with `pass_through`.

### 3.5 Quarantine integration (current)

| Trigger | Scope | Mechanism |
|---------|-------|-----------|
| Policy `quarantine` action match | Stream batch | `should_quarantine_batch()` → record quarantine row |
| Schema drift `quarantine` | Stream batch | Drift orchestrator signal (stream path) |
| Manual quarantine | Stream | Operator API |

Quarantine rows are **stream-scoped** — route attribution not persisted.

### 3.6 Audit integration (current)

Policy evaluation logs `policy_complete` / matched policy metadata on `delivery_logs` at **stream scope**. No per-route policy audit breakdown when flag ON.

---

## 4. Target Policy Model

### 4.1 Topology (unchanged)

```text
One Stream → Many Routes → Many Destinations
Execution Unit: Stream
Processing Unit: Route (policy execution)
Configuration Scope: Stream (defaults + governance catalog)
Execution Scope: Route (effective policy decision per destination)
```

### 4.2 Target pipeline (flag ON + M13.5)

```text
SHARED PHASE (once per batch)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → Schema Drift Policy
  → SharedBatchContext (
       extracted_events,
       sensitive_detection_result,
       schema_drift_policy_result,
       schema_observation,
       union_schema, …
     )
  → NO stream-level Policy when flag ON

PER-ROUTE LOOP — process_route_pipeline()
  → Transform           (M13.2 — active)
  → Protection          (M13.3 — active)
  → Classification      (M13.4 — active)
  → Policy              (M13.5 — ACTIVE)
  → Delivery handoff    (RouteStageResult → fan-out or quarantine/block)

POST-LOOP (stream scope)
  Dynamic routing → Checkpoint
```

### 4.3 Target pipeline diagram

```text
┌─────────────────────────────────────────────────────────────┐
│ STREAM SCOPE (once)                                          │
│  Extract → Observe → Sensitive Detection                     │
│  → Schema Drift Policy                                       │
│  → sensitive_detection_result + schema_drift_policy_result   │
│  → Policy NOT run here when flag ON                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ ROUTE SCOPE (per enabled route)                              │
│  Transform → route-transformed events                        │
│       ↓                                                      │
│  Protection → protected route-shaped events                  │
│       ↓                                                      │
│  Classification → stamped classified events                  │
│       ↓                                                      │
│  Policy (ACTIVE) → allow | audit | block | review | quarantine│
│       ↓                                                      │
│  Delivery handoff → Fan-out OR hold (quarantine/block/review)│
└─────────────────────────────────────────────────────────────┘
```

### 4.4 Policy input semantics (normative)

| Path | Policy input events | Prior stage outputs consumed |
|------|---------------------|------------------------------|
| Flag OFF (legacy) | Post-protection stream batch | Stream classification stamps; stream findings |
| Flag ON (route) | **Post-classification** route-shaped events | M13.4 stamps; shared findings; shared drift result |

**M13.5 must document and test this delta.** Policy on route path evaluates **per-route** classification stamps — routes may diverge after M13.4.

### 4.5 Delivery gating requirement

When Policy stage resolves **block**, **quarantine**, or **require_review**, that route's events **must not** proceed to destination send for that batch. Other routes on the same stream **continue independently** unless they also gate.

`_fan_out()` **must** receive only **policy-allowed** per-route payloads from `RouteStageResult.events` (or omit blocked routes from send map).

---

## 5. Policy Ownership Model

### 5.1 Definitions

| Concept | Owner | Role in M13.5 |
|---------|-------|---------------|
| **Stream Policy** | Stream | Default policy rules (`stream_policy_rules`); stream-level governance defaults; container for `route_overrides[]` |
| **Route Policy Rules** | Route (optional full set) | Additive `route_policy_rules` when operator configures a **complete** alternate rule set for one route |
| **Route Policy Override** | Route (via governance entry) | Optional `delivery_behavior` on `route_overrides[]` entry — route-level delivery gate after rule evaluation |
| **Sensitive Detection Findings** | Stream (shared phase) | Shared suggestions — **not** duplicated per route |
| **Classification stamps** | Route (M13.4) | Consumed from events — **not** re-derived |
| **Schema Drift signals** | Stream (shared phase) | `SharedBatchContext.schema_drift_policy_result` — unknown field review/quarantine signals |
| **Quarantine / Review** | Policy (M13.5) | Enforcement + recording — uses existing quarantine engine |

### 5.2 Inheritance

```text
Effective policy for route R:

  Step 1 — Persisted base (resolution order, list-replacement fallback):
    if route_policy_rules(R) has any enabled rules:
      persisted_rules = route_policy_rules(R)
    else if stream_policy_rules(stream) has any enabled rules:
      persisted_rules = stream_policy_rules(stream)
    else:
      persisted_rules = empty

  Step 2 — Engine evaluation (shared findings + event stamps):
  findings = SharedBatchContext.sensitive_detection_result
  events = route_ctx.processing_state.current_events   # post-classification
  policy_result = evaluate_batch(
    rules=persisted_rules,
    events=events,
    findings=findings,
  )   # adapter — no stream DB query on route path

  Step 3 — Schema drift gate (shared batch, route-aware override):
  drift_result = SharedBatchContext.schema_drift_policy_result
  review_signal = derive_review_signal(drift_result, route_id=R, overrides)
  quarantine_signal = derive_quarantine_signal(drift_result, route_id=R, overrides)

  Step 4 — Route governance delivery_behavior override:
  delivery_behavior = resolve_delivery_behavior(
    route_overrides[] for R,
    governance defaults,
  )
  effective_decision = merge_decision(
    policy_result,
    delivery_behavior,
    review_signal,
    quarantine_signal,
  )

  Step 5 — Enforce and pass-through:
  if effective_decision allows delivery:
    RouteStageResult.events unchanged → fan-out
  else:
    record audit; quarantine/block/review as required; omit route from fan-out
```

**Resolution order (normative for persisted base):**

```text
route_policy_rules
↓
stream_policy_rules
↓
empty config (no named rules — drift + delivery_behavior still apply)
```

**Inheritance summary:** Routes **inherit** stream policy rules by default. Routes **replace** the persisted rule set via `route_policy_rules`. Routes **override delivery behavior** via `route_overrides[].delivery_behavior` after rule evaluation merge.

### 5.3 Override semantics (normative — not ambiguous)

| Override type | Mechanism | Semantics |
|---------------|-----------|-----------|
| **Full route rule set** | `route_policy_rules` rows for `route_id` | Replaces stream rule set as base (Step 1) — other routes unaffected |
| **Route delivery behavior** | `route_overrides[].delivery_behavior` for matching `route_id` | Gates delivery after policy + drift merge — **not** field-path keyed |
| **Classification floor (M13.4)** | `route_overrides[].classification_level` | **Not** policy override — consumed in Classification stage only |
| **Protection override (M13.3)** | `route_overrides[].protection_action` + `field_path` | **Not** policy override — consumed in Protection stage only |

**Operators and implementers must not conflate override models.** UI labels: *"Route delivery behavior"* vs *"Field protection override"* vs *"Route classification floor"*.

### 5.4 Stream Policy after M13.5

| Mode | Stream policy role |
|------|---------------------|
| Flag OFF | Authoritative — executed in `_evaluate_policies()` after stream protection (legacy) |
| Flag ON, no route rows / overrides | Fallback base + drift signals for every route via dual-read |
| Flag ON, route rules present | Route-specific base for that route only |
| Flag ON, override `delivery_behavior` present | Delivery gate applied per route after evaluation |

### 5.5 Relationship to M13.4 Classification

Policy **reads** `classification_level` / `classification_level_gdc` from classified events via `classification_levels_from_events()` — spec 094 §10.6 handoff. Policy **must not** invoke `classify_batch()`, `evaluate_batch()` (classification), or re-stamp events.

---

## 6. RoutePolicyConfig Contract

M13.5 **must** attach a typed `RoutePolicyConfig` to `RouteRuntimeContext.effective_config.policy` (replacing `Any | None` placeholder in `app/runners/route_context.py`).

### 6.0 Typed model (normative)

```text
RoutePolicyConfig
├── rules[]                         # effective persisted rules for evaluate_batch()
│     id                            # optional DB id
│     name
│     condition_json
│     action_type
│     enabled
│     source                        # route | stream
├── delivery_behavior               # resolved route delivery gate: continue | block | quarantine | require_review
├── override_delivery_behavior      # raw from route_overrides[] if set
├── resolution
│     persisted_source              # route | stream | empty
│     override_count                # int — entries with delivery_behavior for this route
│     fallback_used                 # bool — true when stream rules used
│     drift_review_required         # bool — from shared schema_drift_policy_result
│     drift_quarantine_required     # bool — from shared schema_drift_policy_result
└── empty                           # true when no persisted rules and no override delivery_behavior and no drift gate
```

```python
# Conceptual — not implementation authorized by this spec

@dataclass(frozen=True)
class RoutePolicyRuleEntry:
    name: str
    condition_json: dict
    action_type: str
    enabled: bool
    source: Literal["route", "stream"]
    id: int | None = None

@dataclass(frozen=True)
class RoutePolicyResolution:
    persisted_source: Literal["route", "stream", "empty"]
    override_count: int
    fallback_used: bool
    drift_review_required: bool = False
    drift_quarantine_required: bool = False

@dataclass(frozen=True)
class RoutePolicyConfig:
    rules: tuple[RoutePolicyRuleEntry, ...]
    delivery_behavior: str | None          # effective after merge
    override_delivery_behavior: str | None
    resolution: RoutePolicyResolution

    @property
    def empty(self) -> bool:
        return (
            len(self.rules) == 0
            and self.override_delivery_behavior is None
            and not self.resolution.drift_review_required
            and not self.resolution.drift_quarantine_required
        )

    def rules_as_engine_types(self) -> tuple:  # adapter → evaluate_batch() input protocol
        ...

@dataclass(frozen=True)
class RoutePolicyResult:
    decision: Literal["allow", "audit", "block", "require_review", "quarantine"]
    matched_policy_count: int
    persisted_source: Literal["route", "stream", "empty"]
    delivery_blocked: bool
    quarantine_recorded: bool
    review_required: bool
    override_applied: bool
    duration_ms: int = 0
    policy_batch_result: Any | None = None   # PolicyBatchResult reference for audit
```

**Attachment points:**

| Location | Type | When populated |
|----------|------|----------------|
| `RouteEffectiveConfig.policy` | `RoutePolicyConfig \| None` | Loader / `resolve_route_policy_config()` |
| `RouteProcessingState.policy_result` | `RoutePolicyResult \| None` | After `route_policy_stage()` completes |
| `RouteStageResult.policy_result` | `RoutePolicyResult \| None` | **Required** when policy stage runs — see §13.6 |

---

## 7. Policy Resolution Model

### 7.1 Dual-read resolver algorithm (normative)

Policy resolution uses **list-replacement fallback** (same pattern as spec 094 §6.1 for classification; **not** Protection's ephemeral merge).

**Step A — Persisted base (list-replacement fallback):**

```text
route_policy_rules
↓
stream_policy_rules
↓
empty config
```

**Step B — Governance delivery behavior (after rule load, before/at stage):**

```text
override_delivery_behavior = first normalized(
  o.delivery_behavior
  for o in governance.route_overrides
  where o.route_id == route_id and o.enabled and o.delivery_behavior is set
)
```

**Step C — Shared drift signals (stream-scoped, route-aware evaluation at stage):**

```text
drift = SharedBatchContext.schema_drift_policy_result
drift_review_required = drift indicates require_review for this batch
drift_quarantine_required = drift indicates quarantine for this batch
# Route override may escalate delivery_behavior when drift present — see §10.2
```

```text
resolve_route_policy_config(route_id, stream_id, shared_batch) -> RoutePolicyConfig:

  route_rules = load_enabled_route_policy_rules(route_id)
  if route_rules:
    persisted = route_rules
    persisted_source = "route"
  else:
    stream_rules = load_enabled_stream_policy_rules(stream_id)
    if stream_rules:
      persisted = stream_rules
      persisted_source = "stream"
    else:
      persisted = []
      persisted_source = "empty"

  governance = load_stream_governance_config(stream_id)
  override_delivery_behavior = extract_delivery_behavior(governance.route_overrides, route_id)

  drift = shared_batch.schema_drift_policy_result
  drift_review, drift_quarantine = derive_drift_gates(drift)

  return RoutePolicyConfig(
    rules=map_to_rule_entries(persisted, source=persisted_source),
    delivery_behavior=None,   # resolved at stage after evaluate_batch merge
    override_delivery_behavior=override_delivery_behavior,
    resolution=RoutePolicyResolution(
      persisted_source=persisted_source,
      override_count=count_overrides_with_delivery_behavior(route_id, governance),
      fallback_used=(persisted_source == "stream"),
      drift_review_required=drift_review,
      drift_quarantine_required=drift_quarantine,
    ),
  )
```

Governance `delivery_behavior` overrides apply **during decision merge** (Step 4 in §5.2), not as a substitute for persisted rule loading.

### 7.2 Engine invocation contract — Policy Engine reuse (normative)

M13.5 **must reuse the existing Policy Engine** (`evaluate_batch()` / `evaluate_event()` in `app/protection/policy_engine.py`). **Do not** create a new policy engine or parallel runtime.

M13.5 **must not** call stream-scoped `evaluate_batch(db, stream_id=…)` on the route path if it performs a stream-only DB lookup for rules.

**ORM coupling / adapter requirement:**

If the current `evaluate_batch()` implementation is typed or coupled to `StreamPolicyRule` ORM objects, M13.5 **must** introduce an **adapter or protocol only** — map `RoutePolicyRuleEntry` / `RoutePolicyRule` → engine input shape — **without** changing policy matching algorithm or condition evaluation logic.

| Allowed | Forbidden |
|---------|-----------|
| Rule entry protocol / generic mapping layer | New `PolicyEngine` class |
| Inject resolved `rules[]` from `RoutePolicyConfig` | Duplicate condition matching |
| Optional typing on `evaluate_batch()` parameters | Re-run Classification per route |
| `rules_as_engine_types()` adapter on config | Re-run Sensitive Detection per route |
| | Re-run Protection per route |
| | New Governance Engine |

---

## 8. Governance Override Strategy

### 8.1 Decision (normative — not ambiguous)

**M13.5 adopts `streams.config_json.governance.route_overrides[]` as the canonical route override store for policy delivery behavior.**

| Option | M13.5 decision |
|--------|----------------|
| **`streams.config_json.governance.route_overrides[]`** | **SELECTED** — canonical persistence and API round-trip |
| **`route_governance_overrides` normalized table** | **NOT introduced in M13.5** — deferred to post-M13.5 governance query/audit hardening if indexed lookup is required |

**Rationale:**

1. Consistent with M13.3 (protection) and M13.4 (classification) governance decisions (spec 093 §7, spec 094 §7).
2. Governance Workspace v1.1 SoT models `route_overrides[]` as part of the stream governance document including `delivery_behavior`.
3. M13.4 design review confirms JSON store **sufficient through M13.5 MVP**.
4. Policy override is **optional additive field** on existing override entries — backward compatible.

**M13.5 does not require a new governance column.** Overrides live under existing `streams.config_json.governance`:

```json
{
  "governance": {
    "schema_drift_policy": { "...": "..." },
    "route_overrides": [
      {
        "route_id": 101,
        "protection_action": "full_mask",
        "classification_level": "RESTRICTED",
        "delivery_behavior": "quarantine",
        "enabled": true
      }
    ]
  }
}
```

### 8.2 `route_overrides[]` policy fields (normative)

| Field | Required | M13.5 semantics |
|-------|----------|-----------------|
| `route_id` | Yes | Route this override applies to |
| `enabled` | Yes | When `false`, entry ignored |
| `delivery_behavior` | No | Route-level delivery gate — see §10 |
| `protection_action` | No | M13.3 — not consumed by Policy |
| `classification_level` | No | M13.4 — not consumed by Policy |
| `field_path` | No | M13.3 Protection only |

**Normalized values:** `continue` | `block` | `quarantine` | `require_review` (alias map documented in implementation plan; SoT may use `continue_delivery` — normalize at load).

### 8.3 Nested SoT vs flat persistence (reconciliation)

Same normative loader behavior as spec 094 §7.2.2: nested Governance Rule `route_overrides[]` flattened at load to single canonical runtime array. **Single JSON document** — no second persistence path.

### 8.4 `route_governance_overrides` table — explicit deferral

Deferred to post-M13.5 governance hardening milestone. M13.5 implementations **must not** introduce unless separate spec authorizes.

---

## 9. Policy Evaluation Inputs

### 9.1 Required inputs (normative)

Policy stage **must consume** outputs from prior stages and shared batch — **read-only**.

| Input | Source | Re-run forbidden |
|-------|--------|------------------|
| **Protected + classified events** | `route_ctx.processing_state.current_events` after Classification | **Yes** — no Protection re-run |
| **Classification levels** | `classification_levels_from_events(current_events)` | **Yes** — no Classification re-run |
| **Classification result metadata** | `RouteStageResult.classification_result` / `processing_state.classification_result` | Optional observability — decision uses event stamps |
| **Sensitive findings** | `SharedBatchContext.sensitive_detection_result` → `findings_from_context()` | **Yes** — no re-detection |
| **Schema drift result** | `SharedBatchContext.schema_drift_policy_result` | **Yes** — no re-run drift orchestrator per route |
| **Resolved policy rules** | `RoutePolicyConfig.rules` via dual-read | Loaded at context build or stage entry |
| **Delivery behavior override** | `route_overrides[].delivery_behavior` for route | Governance JSON — not re-derived from protection |

### 9.2 Forbidden inputs / operations

Policy stage **must NOT**:

- Invoke `classify_batch()`, classification `evaluate_batch()`, or `stamp_classification_level()`
- Invoke `protect_batch()` or protection stage functions
- Invoke `detect_hits_for_batch()` when shared findings available
- Re-run `_apply_schema_drift_policy()` per route
- Query `stream_policy_rules` directly on route path (use injected rules via adapter)

### 9.3 Handoff from M13.4 (normative)

Spec 094 §10.6 is the upstream contract. M13.5 **inherits** it without modification. Policy evaluates **the same event list** Classification stamped.

---

## 10. Policy Actions

### 10.1 Supported actions — SoT mapping

| Action | Runtime decision | Engine / mechanism | M13.5 scope |
|--------|------------------|-------------------|-------------|
| **Allow** | `allow` | Default when no match and `delivery_behavior=continue` | **In scope** |
| **Audit** | `audit` | Matched rule `action_type=audit_only`; audit log emission | **In scope** |
| **Block** | `block` | Matched rule escalation OR `delivery_behavior=block`; route omitted from fan-out | **In scope** |
| **Require Review** | `require_review` | Schema drift `require_review` signal OR `delivery_behavior=require_review`; deliver with review flag OR hold per product decision — see §10.3 | **In scope** |
| **Quarantine** | `quarantine` | Matched rule `action_type=quarantine` OR `delivery_behavior=quarantine` OR drift quarantine; record quarantine row | **In scope** |

### 10.2 Decision merge precedence (normative)

When multiple signals apply, **most restrictive wins** for delivery gating:

```text
precedence (highest wins for blocking):
  quarantine > block > require_review > audit > allow
```

Within same tier: explicit matched `route_policy_rules` / `stream_policy_rules` **and** governance `delivery_behavior` **and** drift signals merged per §5.2 Step 4.

**Audit** is additive — matched audit rules emit audit records even when delivery continues.

### 10.3 Require Review semantics (M13.5)

Require Review is **not** a separate `stream_policy_rules.action_type` today. M13.5 implements Require Review via:

1. **Schema drift policy** — `unknown_*_field_policy = require_review` on stream config (shared signal)
2. **Governance override** — `delivery_behavior = require_review` on `route_overrides[]`

**M13.5 behavior (normative MVP):**

- Events **may still deliver** to destination with `review_required=true` metadata on `delivery_logs` and route timeline — matching existing stream drift require_review tests (`tests/test_schema_drift_policy_runtime.py` pattern), **unless** `delivery_behavior=block` also applies.
- Operator queue / Governance Workspace review UX may trail runtime — audit record **required**.

**Post-M13.5:** Full review queue UI (M19 Operations Center) — not blocking M13.5 runtime gate.

### 10.4 M13.5 vs later milestones

| Capability | M13.5 | Later |
|------------|-------|-------|
| Per-route policy rule evaluation | **Yes** | — |
| Per-route delivery_behavior enforcement | **Yes** | — |
| Route-aware quarantine recording | **Yes** | — |
| Route-aware policy audit logs | **Yes** | — |
| Require Review operator queue UI | Partial (audit + flag) | M19 |
| Governance Dashboard route breakdown | Partial | Route Governance Extension |
| Policy simulation / impact analysis | **No** | M18 catalog |
| AI policy extensions | **No** | M22 (separate engine section) |
| New policy action types beyond SoT | **No** | Governance hardening |

---

## 11. Route Aware Quarantine

### 11.1 Decision — nullable `route_id` on existing table (normative)

**M13.5 adopts additive nullable `route_id` on `stream_quarantine_events`** — not a new quarantine table.

| Option | M13.5 decision |
|--------|----------------|
| **Nullable `route_id` on `stream_quarantine_events`** | **SELECTED** — additive migration |
| **New `route_quarantine_events` table** | **NOT selected** — duplicates persistence |
| **Store route_id only in `metadata_json`** | **NOT sufficient alone** — must be queryable column for Route Governance Extension |

**Rationale:** Route data model review D6; M13.4 design review R12; existing quarantine engine, release, and discard flows preserved.

### 11.2 Quarantine recording contract

When Policy stage resolves `quarantine` for route R:

```text
record_quarantine(
  stream_id=stream_id,
  route_id=route_id,                    # NEW — nullable for legacy rows
  protected_payload_json=current_events,
  quarantine_source="policy",
  quarantine_reason=build_quarantine_reason(policy_result, drift, override),
  metadata_json={
    "route_id": route_id,
    "destination_id": destination_id,
    "policy_matched": [...],
    "classification_level": classification_result.effective_level,
    "delivery_behavior_override": override_delivery_behavior,
  },
)
```

**Legacy rows:** `route_id=NULL` — stream-scoped quarantine from flag OFF path unchanged.

### 11.3 Release behavior

Existing release/discard APIs (`/runtime/streams/{stream_id}/quarantine/...`) **extended** to filter and display by `route_id` when present. Release delivery uses existing `release_delivery` pipeline — route context passed when available.

**Flag OFF:** Quarantine continues stream-scoped (`route_id=NULL`).

### 11.4 Audit visibility

Quarantine list UI (Governance Workspace / Operations) **should** show route name when `route_id` set — conceptual §16; may trail runtime.

---

## 12. Route Aware Audit

### 12.1 Audit record requirements

Policy stage **must** emit structured audit via existing `delivery_logs` pipeline:

| Field | Required | Source |
|-------|----------|--------|
| `stage` | Yes | `policy_complete`, `policy_blocked`, `policy_quarantine`, `policy_review_required` |
| `stream_id` | Yes | Route context |
| `route_id` | Yes (flag ON) | Route context |
| `decision` | Yes | `RoutePolicyResult.decision` |
| `matched_policy_count` | Yes | Engine result |
| `persisted_source` | Yes | `route` \| `stream` \| `empty` |
| `delivery_behavior_override` | When set | Governance override |
| `drift_review_required` | When true | Shared drift |
| `classification_levels` | Recommended | From event stamps (not full payload) |

**Must not** log full sensitive raw payload (existing rule).

### 12.2 Policy decision visibility

| Surface | M13.5 |
|---------|-------|
| `RouteStageResult.stage_timeline` | `policy` entry with decision, matched count, duration |
| `RouteStageResult.policy_result` | Typed result for debug / M13.6 metrics prep |
| `delivery_logs` | Per-route policy stages when flag ON |
| Governance Dashboard route breakdown | **Partial** — API metadata; full UI may trail |

### 12.3 Route audit vs stream audit

Flag OFF: existing stream policy audit unchanged. Flag ON: **per-route** audit entries — N routes may emit N policy log records for same batch.

---

## 13. Runtime Integration

### 13.1 `process_route_pipeline()` integration

Replace `policy_stub` NO-OP with `route_policy_stage()`:

```text
process_route_pipeline(route_ctx, shared_batch):
  ... transform stage (M13.2) ...
  ... protection stage (M13.3) ...
  ... classification stage (M13.4) ...
  current_events = classified stamped events

  if policy_evaluation_enabled():   # GDC_POLICY_ENABLED or equivalent existing flag
    config = route_ctx.effective_config.policy
    if config is not None:
      current_events, policy_result = route_policy_stage(
        route_ctx, shared_batch, log_fn=log_fn, db=db
      )
      timeline.append(policy_timeline_entry(policy_result, config))
      if policy_result.delivery_blocked:
        current_events = []   # or retain for quarantine payload — implementation detail
    else:
      timeline.append({"stage": "policy", "status": "skipped", "reason": "no_config"})
  else:
    timeline.append({"stage": "policy", "status": "skipped", "reason": "disabled"})

  ... delivery_handoff ...

  return RouteStageResult(
    route_id=route_ctx.route_id,
    events=current_events,              # only if delivery allowed
    policy_result=policy_result,
    policy_duration_ms=...,
    delivery_allowed=not policy_result.delivery_blocked,
    ...
  )
```

### 13.2 StreamRunner flag ON guards

| Legacy call | Flag ON behavior |
|-------------|------------------|
| `_evaluate_policies()` after stream protection | **Must not run** |
| Stream policy quarantine before fan-out | **Must not run** — per-route stage handles |
| `process_route_pipeline()` policy stage | **Active** |

### 13.3 SharedBatchContext requirements

| Field | Required for M13.5 |
|-------|-------------------|
| `sensitive_detection_result` | **Yes** — policy conditions |
| `schema_drift_policy_result` | **Yes** — review/quarantine signals |
| `extracted_events` | Transform input only — policy uses post-classification `current_events` |
| `shared_runtime_data.route_overrides` | **Yes** — delivery_behavior |

**Recommended additive accessor:**

```text
SharedBatchContext.quarantine_batch_signal  # derived from schema_drift_policy_result — optional convenience
```

### 13.4 Fan-out integration

```text
route_payloads = {
  result.route_id: result.events
  for result in route_pipeline.stage_results
  if result.delivery_allowed and result.events
}
```

Blocked / quarantined routes **excluded** from send map; checkpoint semantics unchanged — spec 004 / constitution.

### 13.5 Loader integration

Pre-resolve `effective_config.policy` per route at load time (mirror M13.4):

```text
for route in enabled_routes:
  route_ctx.effective_config.policy = resolve_route_policy_config(
    route_id=route.id,
    stream_id=stream.id,
    shared_batch_ref=...,   # or drift signals resolved at stage from shared_batch
  )
```

Route policy rules loaded in batch query (no N+1 per route).

### 13.6 `RouteStageResult` — `policy_result` attachment (normative)

| Field | Type | Required |
|-------|------|----------|
| `policy_result` | `RoutePolicyResult \| None` | **Yes (field present)** |
| `policy_duration_ms` | `int \| None` | Recommended |
| `delivery_allowed` | `bool` | **Yes** — fan-out gate |
| `events` | `list[dict]` | Post-policy allowed events only |

### 13.7 Legacy vs route path — stage order

| Path | Policy position | Input event shape |
|------|-----------------|-------------------|
| Flag OFF | After stream protection | Post-protection stream batch |
| Flag ON | After Classification | Post-classification per-route batch |

**Regression matrix required** (§19): document and test both paths.

---

## 14. Database Impact

Conceptual only — no SQL, no migrations authorized by this document.

### 14.1 Current tables (reuse)

| Table | M13.5 role |
|-------|------------|
| `stream_policy_rules` | Fallback base rules — **unchanged** |
| `stream_quarantine_events` | Quarantine persistence — **extend** with nullable `route_id` |
| `streams.config_json` | Governance + schema drift — **unchanged**; `route_overrides[].delivery_behavior` enforced |

### 14.2 Required future additions (additive)

| Artifact | Key | Purpose |
|----------|-----|---------|
| **`route_policy_rules`** | `route_id` FK + index `(route_id, enabled)` | Optional full route-specific rule set — **mirrors** `stream_policy_rules` shape |
| **`stream_quarantine_events.route_id`** | Nullable FK → `routes.id` ON DELETE SET NULL | Route-aware quarantine attribution |
| **`streams.config_json.governance.route_overrides[]`** | Stream-scoped JSON | Canonical override store; enforce `delivery_behavior` (§8) |

**`route_policy_rules` conceptual columns:**

```text
id PK
route_id FK → routes.id ON DELETE CASCADE
name VARCHAR(128) NOT NULL
enabled BOOLEAN NOT NULL DEFAULT true
condition_json JSONB NOT NULL
action_type VARCHAR(32) NOT NULL
created_at, updated_at TIMESTAMPTZ
INDEX (route_id, enabled)
```

Mirror `stream_policy_rules` column types. Named rules — no field-path uniqueness.

### 14.3 Explicitly NOT in M13.5

| Artifact | Status |
|----------|--------|
| `route_governance_overrides` table | **Deferred** (§8.4) |
| Alter `stream_policy_rules` | **Forbidden** |
| New quarantine table | **Forbidden** |

### 14.4 Unchanged

No truncate of user policy rules. Checkpoint semantics unchanged.

---

## 15. API Impact

Conceptual only — no endpoint implementation authorized by this document.

### 15.1 Current APIs (retained)

```text
GET/POST/PATCH/DELETE /runtime/streams/{stream_id}/policy-rules
GET                   /runtime/streams/{stream_id}/quarantine/...
```

Stream endpoints remain for fallback and aggregate views.

### 15.2 Required future APIs (M13.5)

```text
GET/POST/PATCH/DELETE /runtime/routes/{route_id}/policy-rules
GET                   /runtime/routes/{route_id}/policy/effective

GET/PUT               /runtime/streams/{stream_id}/governance
                      (+ route_overrides[].delivery_behavior enforcement metadata)

POST                  /runtime/preview/policy
                      (+ route_id — dual-read; classified sample input when flag ON)

POST                  /runtime/preview/route-pipeline
                      (extend chain: transform + protection + classification + policy)

GET                   /runtime/streams/{stream_id}/quarantine
                      (+ optional route_id filter query param)
```

### 15.3 Response metadata (recommended)

```json
{
  "route_id": 42,
  "stream_id": 7,
  "resolution": {
    "persisted_source": "stream",
    "override_count": 1,
    "fallback_used": true,
    "drift_review_required": false
  },
  "effective_decision": "allow",
  "delivery_behavior": "continue",
  "rules": []
}
```

### 15.4 Compatibility shim

| Caller | Behavior |
|--------|----------|
| Stream policy CRUD (legacy UI) | Unchanged; writes stream rules only |
| Preview without `route_id` | Stream rules only (legacy preview) |
| Quarantine list without `route_id` filter | Returns all stream events including `route_id=NULL` legacy |

---

## 16. Frontend Impact

Conceptual only — no UI implementation authorized by this document.

### 16.1 Route Processing UI (Wizard Charter v5.2)

| Surface | Change |
|---------|--------|
| Route Processing step — **Policy tab** | Per-route rule editor; effective decision from dual-read |
| Route Preview | Side-by-side Route A / B policy decision after full preview chain |
| Deploy Summary | Per-route policy source: `route` \| `stream` \| `drift` \| `override` |

### 16.2 Governance Workspace

| Surface | Change |
|---------|--------|
| Governance Rule Editor — Route Overrides | `delivery_behavior` dropdown enforced in preview |
| Quarantine Events list | Show `route_id` / route name when present |
| Route Policy Visibility (WBS) | Effective decision per route in governance context panel |

### 16.3 Governance Dashboard

| Surface | Change |
|---------|--------|
| Violations summary | Route breakdown **partial** in M13.5 — stream aggregate retained |
| Policy impact | Link to per-route effective config API |

### 16.4 Non-scope UI

- Full route-aware governance dashboard (Route Governance Extension — post-M13.5)
- M13.6 delivery metrics panels
- Destination First Wizard reorder

---

## 17. Backward Compatibility

### 17.1 Feature flag OFF

`GDC_ROUTE_PROCESSING_ENABLED=false` (rollback; product default is `true`):

- **Zero behavior change** vs pre-M13.5 baseline
- Stream policy runs in `_evaluate_policies()` after stream protection
- No `route_policy_rules` consulted
- Quarantine rows remain `route_id=NULL`
- E2E regression suite must pass unchanged

### 17.2 Feature flag ON — parity cases

| Scenario | Expected behavior |
|----------|-------------------|
| No `route_policy_rules`; no `delivery_behavior` overrides | Same effective decision as stream rules for all routes |
| No stream rules; no route rules | Allow + drift signals only |
| Route A has rules; Route B does not | A uses route rules; B uses stream fallback |
| Route A `delivery_behavior=block`; Route B `continue` | A blocked; B delivers |

### 17.3 Stream fallback

When `route_policy_rules` absent or all disabled for route R:

```text
effective persisted rules = stream_policy_rules(stream_id)
```

### 17.4 Dual-read without backfill

Existing deployments with stream rules only: **no migration required** beyond `route_policy_rules` table + nullable quarantine column. Routes inherit stream policy automatically when flag ON.

### 17.5 Rollback

| Trigger | Action |
|---------|--------|
| Regression with flag ON | Set `GDC_ROUTE_PROCESSING_ENABLED=false` — immediate legacy path |
| Policy bug | Disable policy evaluation flag if available — global skip |
| Route config error | Delete route policy rules — fallback to stream |

No data migration rollback required for flag OFF. Nullable `route_id` column may remain unused on legacy path.

---

## 18. Acceptance Criteria

M13.5 is **complete** when all criteria pass.

### 18.0 Task-mandate gates

- [ ] **AC-0a** `RouteEffectiveConfig.policy` is **`RoutePolicyConfig`** (typed) — not `Any | None`.
- [ ] **AC-0b** `route_overrides[]` JSON shape documents `delivery_behavior` with §8.2 semantics.
- [ ] **AC-0c** Resolver order: `route_policy_rules` → `stream_policy_rules` → empty config; then governance + drift merge.
- [ ] **AC-0d** Policy engine reused via adapter — no new policy engine; no stream DB rule query on route path.
- [ ] **AC-0e** Policy does **not** re-run Classification, Protection, or Sensitive Detection.
- [ ] **AC-0f** `RouteStageResult.policy_result` attached; `delivery_allowed` gates fan-out.
- [ ] **AC-0g** Flag ON order: **Transform → Protection → Classification → Policy → Delivery handoff**.
- [ ] **AC-0h** Flag OFF legacy order unchanged.

### 18.1 Prerequisites (M13.2–M13.4)

- [ ] **AC-1** M13.4 acceptance criteria satisfied — classification active, stamped events.
- [ ] **AC-2** `SharedBatchContext.schema_drift_policy_result` available on route path.
- [ ] **AC-3** Stream `_evaluate_policies()` **not** called when `GDC_ROUTE_PROCESSING_ENABLED=true`.

### 18.2 Policy stage activation

- [ ] **AC-4** `policy_stub` replaced with `route_policy_stage()` invoking existing engine.
- [ ] **AC-5** Policy runs **after** Classification in `process_route_pipeline()`.
- [ ] **AC-6** `_fan_out()` receives only **policy-allowed** per-route events.
- [ ] **AC-7** No new Policy Engine class or parallel pipeline.

### 18.3 Config resolution

- [ ] **AC-8** Resolution order: `route_policy_rules` → `stream_policy_rules` → empty config.
- [ ] **AC-9** Route rules present → route rule set replaces stream base (list-replacement).
- [ ] **AC-10** `route_overrides[].delivery_behavior` enforced per route after rule evaluation.
- [ ] **AC-11** `RouteRuntimeContext.effective_config.policy` populated as typed **`RoutePolicyConfig`**.

### 18.4 Product scenarios

- [ ] **AC-12** Same stream, Route A allow, Route B quarantine — divergent delivery outcomes.
- [ ] **AC-13** Operator achieves destination-specific policy **without** duplicating streams.
- [ ] **AC-14** Sensitive Detection runs once per batch — not N times per route.

### 18.5 Engine reuse

- [ ] **AC-15** `evaluate_batch()` / condition matching used unchanged in algorithm.
- [ ] **AC-16** Stream-scoped policy DB query **not** called from route path.
- [ ] **AC-17** If engine coupled to `StreamPolicyRule` ORM, adapter maps route entries only.

### 18.6 Quarantine

- [ ] **AC-18** Quarantine rows record nullable **`route_id`** when flag ON.
- [ ] **AC-19** Legacy quarantine (`route_id=NULL`) unchanged when flag OFF.
- [ ] **AC-20** Existing quarantine release/discard flows work with route-attributed rows.

### 18.7 Audit

- [ ] **AC-21** `delivery_logs` policy entries include **`route_id`** when flag ON.
- [ ] **AC-22** Policy preview accepts `route_id` and uses effective route config.

### 18.8 Boundaries

- [ ] **AC-23** M13.6 delivery metrics / health **not** implemented.
- [ ] **AC-24** `route_governance_overrides` normalized table **not** introduced (§8.4).
- [ ] **AC-25** No truncate of user `stream_policy_rules`.

### 18.9 Metrics (M13.5 scope)

- [ ] **AC-26** `route_policy_count`, `route_policy_duration_ms`, `route_policy_blocked_count` emitted on route loop summary.

---

## 19. Test Strategy

### 19.1 Unit tests

| Area | Cases |
|------|-------|
| `resolve_route_policy_config` | Route rules win; stream fallback; empty; delivery_behavior extract |
| Decision merge | Override block; drift review; quarantine precedence |
| Rule entry mapping | Route vs stream `source` attribution |
| `RoutePolicyConfig.empty` | No rules, no override, no drift |
| Governance JSON parse | `delivery_behavior` optional; invalid value rejected |
| Adapter | Route entries → engine protocol |

### 19.2 Integration tests

| Area | Cases |
|------|-------|
| `process_route_pipeline()` | Policy after classification; timeline entries |
| Dual routes divergent | Route A stream rules; Route B route rules — different decisions |
| Override block only | No route rules; override blocks delivery |
| Quarantine | Policy quarantine records `route_id`; route excluded from fan-out |
| Require Review | Drift signal + audit; delivery per §10.3 |
| Flag OFF | Stream path unchanged — spy confirms `_evaluate_policies` |
| Flag ON | Stream `_evaluate_policies` not called; route stage called N times |
| No re-run prior stages | Mock confirms no classify/protect/detect from policy stage |
| Engine reuse | Mock confirms injected `evaluate_batch` — not stream DB query |

### 19.3 Regression tests

- Full e2e flag OFF — no expectation changes
- Existing stream policy rule CRUD — unchanged
- M13.4 classification stamps consumed by policy — not re-derived
- Protection + classification + policy order flag ON vs OFF matrix

### 19.4 Performance tests

| Case | Threshold (guidance) |
|------|----------------------|
| N routes × policy | Linear O(N); shared detection + drift O(1) |
| Loader batch rule load | No N+1 queries for route policy resolution |
| Policy stage | Comparable to single stream batch (rule count bounded) |

---

## 20. Implementation Boundaries

### 20.1 IN scope (M13.5)

| Deliverable | Description |
|-------------|-------------|
| `route_policy_rules` | Additive schema + repository |
| `stream_quarantine_events.route_id` | Nullable FK — route-aware quarantine |
| `streams.config_json.governance.route_overrides[].delivery_behavior` | Enforcement + validation |
| `resolve_route_policy_config()` | Dual-read → typed `RoutePolicyConfig` |
| `route_policy_stage()` | Active stage in `process_route_pipeline()` |
| Loader `effective_config.policy` | Typed config per route |
| Replace `policy_stub` | Active stage + timeline + `RouteStageResult.policy_result` |
| Policy engine adapter/protocol | Decouple from `StreamPolicyRule` ORM if coupled |
| Route-aware quarantine recording | Reuse existing quarantine engine |
| Route-aware policy audit logs | Extend `delivery_logs` with `route_id` |
| Require Review decision model | Drift + override — audit required |
| Route policy APIs + effective config + preview `route_id` | §15 |
| Route Processing Policy tab + governance delivery_behavior | Conceptual §16 — may trail runtime |
| Metrics: `route_policy_count`, `route_policy_duration_ms`, `route_policy_blocked_count` | Route loop observability |
| Tests | §19 |

### 20.2 OUT of scope (M13.6+)

| Milestone | Excluded from M13.5 |
|-----------|---------------------|
| **M13.6** | Route delivery metrics redesign, route health, delivery observability extensions |
| **M18** | Governance catalog simulation, policy builder redesign |
| **M19** | Full Operations Center review queue UI (runtime audit may precede UI) |
| **Governance** | `route_governance_overrides` normalized table |
| **Any** | New Policy Engine; new Governance Engine; parallel runtime |
| **Wizard P7** | Full Destination First reorder |

### 20.3 M13.5 implementation order (recommended)

| Step | Work | Exit criteria |
|------|------|---------------|
| **A** | Confirm M13.4 gates (AC-1) | M13.4 complete — stamped events |
| **B** | Additive DB: `route_policy_rules` + quarantine `route_id` | AC-18, AC-25 |
| **C** | Governance JSON `delivery_behavior` enforcement metadata | AC-0b, AC-10 |
| **D** | `resolve_route_policy_config()` → typed `RoutePolicyConfig` + loader | AC-0a, AC-8–AC-11 |
| **E** | `route_policy_stage()` — wire policy engine + adapter; attach `policy_result` | AC-4–AC-7, AC-15–AC-17 |
| **F** | Quarantine + audit route_id wiring | AC-18–AC-21 |
| **G** | Fan-out gate — exclude blocked/quarantined routes | AC-6, AC-0f |
| **H** | Route APIs + effective config + preview `route_id` | AC-22 |
| **I** | Frontend Policy tab + governance fields | AC-12, AC-13 |
| **J** | Regression + parity tests | AC-0h, AC-23–AC-26 |

### 20.4 Dependencies

| Dependency | Relationship |
|------------|--------------|
| M13.1 | Context contracts, feature flag, orchestration slots |
| M13.2 | Transform stage — **hard prerequisite** |
| M13.3 | Protection stage, governance overrides pattern — **hard prerequisite** |
| M13.4 | Classification stamps, handoff §9 — **hard prerequisite** |
| M13.6 | Per-route delivery metrics; optional `policy_duration_ms` on result |
| spec 094 §10.6 | Classification handoff — policy consumes stamps only |

---

## Appendix A — Verification mapping (task checklist)

| # | Task requirement | Spec section |
|---|------------------|--------------|
| 1 | Problem Statement | §1 |
| 2 | Source Of Truth Alignment | §2 |
| 3 | Current Policy Model | §3 |
| 4 | Target Policy Model | §4 |
| 5 | Policy Ownership Model | §5 |
| 6 | RoutePolicyConfig Contract | §6 |
| 7 | Policy Resolution Model | §7 |
| 8 | Governance Override Strategy | §8 |
| 9 | Policy Evaluation Inputs | §9 |
| 10 | Policy Actions | §10 |
| 11 | Route Aware Quarantine | §11 |
| 12 | Route Aware Audit | §12 |
| 13 | Runtime Integration | §13 |
| 14 | Database Impact | §14 |
| 15 | API Impact | §15 |
| 16 | Frontend Impact | §16 |
| 17 | Backward Compatibility | §17 |
| 18 | Acceptance Criteria | §18 |
| 19 | Test Strategy | §19 |
| 20 | Implementation Boundaries | §20 |

---

## Appendix B — Related specs

| Spec | Relationship |
|------|--------------|
| `specs/091-route-processing-architecture/spec.md` | Foundation contracts; `route_policy_rules` in Appendix A |
| `specs/092-per-route-transform/spec.md` | Transform stage; policy stub placeholder |
| `specs/093-per-route-protection/spec.md` | Protection stage; `delivery_behavior` stored, enforced in M13.5 |
| `specs/094-per-route-classification/spec.md` | Classification stage; M13.5 handoff §10.6 / spec 095 §9 |
| `specs/004-delivery-routing/spec.md` | Fan-out, checkpoint unchanged |
| `docs/architecture/route-data-model-review.md` | DB pattern — additive, quarantine `route_id` |
| `docs/architecture/m13-4-classification-design-review.md` | M13.5 prerequisites R11–R12 |

---

## Appendix C — Key implementation files (future — not authorized now)

| File | M13.5 change |
|------|--------------|
| `app/runners/route_stage.py` | Replace `policy_stub` with `route_policy_stage()` |
| `app/runners/route_context.py` | `RoutePolicyConfig`, `RoutePolicyResult` types |
| `app/runners/stream_runner.py` | Guard `_evaluate_policies()` when flag ON; fan-out gate |
| `app/runners/stream_loader.py` | Resolve policy config per route; load route policy rules |
| `app/route_policy/` (new) | config, resolver, stage — mirror `route_classification/` |
| `app/protection/policy_engine.py` | Accept generic rule protocol (adapter — no algorithm change) |
| `app/quarantine/models.py` | Nullable `route_id` on `StreamQuarantineEvent` |
| `app/quarantine/recording.py` | Pass `route_id` when recording from route policy stage |

---

*End of M13.5 companion spec. No code, database, API, UI, or runtime changes authorized by this document.*
