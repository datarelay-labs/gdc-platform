# M13.6 Route Runtime Delivery

**Milestone:** M13.6 (Route Runtime Delivery)
**Status:** CURRENT implementation spec for M13.6 (delivered). Original M13 rollout assumed flag default OFF; product default is ON as of P1-4 (`false` = rollback). Failover and Replay reuse the shared StreamRunner delivery primitive on the route path.
**Depends on:** M13.1 Route Processing Foundation (`specs/091-route-processing-architecture/spec.md`), M13.2 Per Route Transform (`specs/092-per-route-transform/spec.md`), M13.3 Per Route Protection (`specs/093-per-route-protection/spec.md`), M13.4 Per Route Classification (`specs/094-per-route-classification/spec.md`), M13.5 Per Route Policy (`specs/095-per-route-policy/spec.md`)
**Design review:** [`docs/architecture/route-data-model-review.md`](../../docs/architecture/route-data-model-review.md), [`docs/architecture/m13-route-architecture-design-review.md`](../../docs/architecture/m13-route-architecture-design-review.md), [`docs/architecture/m13-5-policy-design-review.md`](../../docs/architecture/m13-5-policy-design-review.md), [`docs/architecture/m13-6-delivery-design-review.md`](../../docs/architecture/m13-6-delivery-design-review.md), [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)
**Authority:** Product Charter 1.2.1, Master WBS 1.2.1, `.specify/memory/constitution.md`, Governance & Transform Policy v1.1, Governance UX Charter v1.1, Governance Workspace v1.1
**Architecture:** [`docs/architecture/route-processing-foundation-implementation-spec.md`](../../docs/architecture/route-processing-foundation-implementation-spec.md)
**Gap analysis:** [`docs/architecture/route-architecture-gap-analysis.md`](../../docs/architecture/route-architecture-gap-analysis.md)

---

## 1. Problem Statement

M13.2–M13.5 established **per-route processing** (Transform → Protection → Classification → Policy) and M13.5 introduced **`delivery_allowed`** as a policy gate before fan-out. Delivery **execution**, **disposition tracking**, **route metrics**, **route health**, and **route observability** remain **underspecified and partially wired**:

```text
Today (flag ON, post-M13.5):
  Per-route pipeline produces RouteStageResult + delivery_allowed
  → StreamRunner filters route_payloads (delivery_allowed && events)
  → Existing _fan_out() + formatter + send (opaque success/failure)
  → Stream-scoped checkpoint
  → delivery_logs (partial route_id; no disposition taxonomy)
  → runtime_route_snapshot (delivery EPS only; no policy disposition dimension)
```

**Product violation:** Operators cannot reliably answer per destination:

- *Did this route deliver, block, quarantine, or require review?*
- *Why did Route B not receive data while Route A did on the same batch?*
- *Is Route health degraded because of policy blocks or destination failures?*

Product Charter 1.2.1 mandates **Route Based Delivery** with **Execution Unit = Stream**, **Processing Unit = Route**, **Delivery Unit = Route**. Master WBS 1.2.1 lists M13.6 deliverables: **Route Selection**, **Route Delivery**, **Route Metrics**, **Route Health**.

**Gap (evidence):**

| Area | Current state | Gap |
|------|---------------|-----|
| Delivery disposition | Implicit (`delivery_handoff` timeline entry only) | No typed `RouteDeliveryResult` or disposition enum |
| Route metrics | Policy counters on loop summary; delivery counters stream-aggregated | No `route_delivery_*` counters per batch/route |
| Route health | `runtime_route_snapshot` EPS/success from delivery_logs send outcomes | Policy blocks/quarantine not distinguished from send failures |
| Observability | `delivery_logs` route_id partial; policy stages exist | No unified “why not delivered” operator path per route |
| Checkpoint | Stream cursor advances on successful send events | Policy-blocked routes not attributed in checkpoint trace |

**M13.5 delivers:** Active `route_policy_stage()`; `RoutePolicyResult`; `delivery_allowed`; route-aware quarantine (`route_id`); policy audit stages; fan-out filter on `delivery_allowed`.

**M13.6 solves:** Formalize **route-aware delivery execution and disposition** on top of the **existing** `StreamRunner` fan-out, destination adapters, formatter, failure policy, rate limit, audit pipeline, `runtime_route_snapshot`, and `runtime_analytics_bucket_*` — without a new delivery engine, runtime, or runner.

**Explicit non-goals:**

- New delivery engine or parallel send pipeline
- New observability platform or dashboard redesign
- M18 Governance simulation / impact analysis
- Full Route Governance Extension UI (partial wiring acceptable)
- Reliability mode redesign (`DIRECT` / queue workers — spec 048)
- Checkpoint model change (stream cursor semantics unchanged)

---

## 2. Source Of Truth Alignment

| Document | Mandate relevant to M13.6 |
|----------|---------------------------|
| **Product Charter 1.2.1** | Route Based Delivery; Delivery Unit = Route; Runtime Reuse First; No Parallel Delivery Engine; checkpoint after successful delivery |
| **Master WBS 1.2.1** | M13.6 = Route Runtime Delivery — Route Selection, Route Delivery, Route Metrics, Route Health |
| **UX Charter 1.2.1** | §24–27 Route model; Runtime visibility per route; delivery failure attribution |
| **Stream Wizard Charter v5.2** | Route Processing → Delivery tab per route; Deploy Summary delivery readiness |
| **Governance UX Charter v1.1** | Execution Scope = Route; operators need route-level delivery posture |
| **Governance Workspace v1.1** | Quarantine / violations route context; Route Preview disposition hints |
| **Governance & Transform Policy v1.1** | §14–15 Policy actions; delivery behaviors; Require Review semantics |
| **Union Schema UX Spec v1.1** | Drift require_review / quarantine — stream signal consumed by route policy (M13.5) |
| **Spec 002 Runtime Pipeline** | Fan-out → formatter → send → checkpoint; checkpoint only on delivery ACK |
| **Spec 004 Delivery Routing** | Per-route formatter, failure policy, rate limit on `routes` table |
| **Spec 011 Runtime Analytics** | Route failure/retry analytics over `delivery_logs` |
| **Spec 012 Runtime Health Scoring** | Per-route health from delivery outcomes |
| **Route data model review** | M13.6 = observability extension on existing route-scoped delivery tables |
| **M13.5 design review** | Disposition taxonomy required; no M13.5 blockers for M13.6 |

**Constitution (unchanged):**

- Checkpoint updated **only** after successful Destination delivery
- Stream = execution unit; Route connects Stream → Destination
- Delivery failures logged structurally
- No parallel pipeline or delivery engine

**Critical rules (task mandate):**

| Rule | M13.6 interpretation |
|------|----------------------|
| Reuse StreamRunner | Extend orchestration inside existing transaction owner |
| Reuse delivery adapters | Syslog/Webhook send paths unchanged |
| Reuse fan-out | `_fan_out()` send primitive reused via injected `send_fn` — **no parallel send path**; M13.6 adds disposition + metrics around the existing adapter call |
| Reuse runtime metrics | Extend `RouteProcessingMetrics`, `delivery_logs`, snapshot updaters |
| Reuse runtime health | Extend `runtime_route_snapshot` inputs — no new health engine |
| Reuse audit pipeline | `delivery_logs` policy + delivery stages with `route_id` |
| Do NOT create new Delivery Engine | Disposition + observability orchestration only |
| Do NOT create new Runtime / Runner | No second scheduler or runner class |
| Feature flag rollback path | `GDC_ROUTE_PROCESSING_ENABLED=false` — legacy path unchanged (product default is `true` as of P1-4) |
| Existing Streams continue working | Dual path documented in §16 |

---

## 3. Current Delivery Model

### 3.1 Configuration (unchanged — no new delivery config table)

| Entity | Scope | Delivery fields |
|--------|-------|-----------------|
| `routes` | Route | `formatter_config_json`, `failure_policy`, `rate_limit_json`, `enabled`, `status` |
| `destinations` | Destination | Adapter type, connection config |
| `checkpoints` | Stream | Cursor — not per-route |

**Evidence:** `app/routes/models.py`; `app/runners/stream_loader.py` loads delivery fields on route runtime dict.

### 3.2 Runtime execution (flag ON, post-M13.5)

```text
StreamRunner._execute_route_pipeline()
  → process_route_pipeline() per enabled route
       Transform → Protection → Classification → Policy
       → delivery_handoff timeline entry (ready | blocked)
  → route_payloads = { route_id: events
                        if delivery_allowed and events }
  → _evaluate_dynamic_routes()
  → _fan_out(runtime_stream, reference_events,
             route_payloads=route_payloads)
       per route: formatter → rate limit → adapter send
       failure_policy / retry per route config
  → checkpoint update (stream-scoped, successful_events)
```

**Evidence:** `app/runners/stream_runner.py`, `app/runners/route_stage.py`.

### 3.3 Policy gate (M13.5)

| Policy decision | `delivery_allowed` (M13.5 impl) | Fan-out |
|-----------------|----------------------------------|---------|
| `allow` | `true` | Included |
| `audit` | `true` | Included (+ audit log) |
| `require_review` | `false` | Excluded |
| `block` | `false` | Excluded |
| `quarantine` | `false` | Excluded (+ quarantine row) |

**Evidence:** `app/route_policy/decision.py` — `delivery_allowed_for_decision()`.

### 3.4 Observability today

| Surface | Route awareness | Limitation |
|---------|-----------------|------------|
| `delivery_logs` | `route_id` in context (partial) | No disposition enum; policy vs send conflated |
| `RouteProcessingMetrics` | Policy counters only | No `route_delivery_*` counters |
| `runtime_route_snapshot` | Per-route EPS, success_rate | Send failures only; policy blocks invisible |
| `runtime_analytics_bucket_*` | `route_id` dimension | Delivery outcome stages only |
| Runtime API `/runtime/health/routes` | Spec 012 scoring | Penalizes send failures; not policy holds |
| `stage_timeline` | Per `RouteStageResult` | `delivery_handoff` only — no send result |

### 3.5 Legacy path (flag OFF)

```text
_collect_and_transform_events() → _prepare_delivery_events()
  → _evaluate_policies() [stream-scoped]
  → _fan_out(identical payload all routes)
  → checkpoint
```

Unchanged by M13.6 when flag OFF.

---

## 4. Target Delivery Model

### 4.1 Semantics (no topology change)

```text
Execution Unit:   Stream
Processing Unit:  Route
Delivery Unit:    Route
Topology:         One Stream → Many Routes → Many Destinations  (unchanged)
```

### 4.2 Runtime pipeline (flag ON, post-M13.6)

```text
StreamRunner (sole transaction owner)
  │
  ├─ SHARED PHASE (once)
  │    Fetch → Extract → Schema Observation → Sensitive Detection
  │    → Schema Drift Policy → SharedBatchContext
  │
  ├─ PER-ROUTE LOOP
  │    process_route_pipeline()
  │      Transform → Protection → Classification → Policy
  │      → route_delivery_stage()          # NEW — M13.6 (normative placement §4.5)
  │           ├─ disposition resolution (+ audit for policy-blocked routes)
  │           ├─ send (if allowed) via existing fan-out / adapter primitive
  │           ├─ RouteDeliveryResult
  │           └─ metrics emission
  │    → route_metrics_rollup() per route   # NEW — in-loop counters
  │
  ├─ POST-LOOP (batch coordination only — no second send)
  │    Aggregate RouteDeliveryResult list; checkpoint; dynamic routing (unchanged)
  │
  ├─ ROUTE HEALTH UPDATE (existing snapshot updater — extended inputs)
  │
  └─ SHARED PHASE
       Checkpoint (stream cursor — only delivered events contribute)
```

**Reuse rule (normative):** M13.6 **must** invoke the **existing** `_fan_out()` per-route send slice (formatter → rate limit → `DestinationAdapterRegistry` send). **Do NOT** create a parallel delivery engine or duplicate adapter code.

### 4.3 Stage order inside `process_route_pipeline()`

```text
Transform
  → Protection
  → Classification
  → Policy (route_policy_stage)
  → Delivery (route_delivery_stage)   # normative — immediately after policy, before adapter send
  → Metrics (inline)                  # per-route counters attached to RouteStageResult
  → Health signals (defer to batch-end snapshot updater)
```

`delivery_handoff` timeline entry **merges into** `delivery` stage with disposition outcome.

### 4.4 Delivery decision vs delivery execution

| Layer | Owner | Output |
|-------|-------|--------|
| **Policy (M13.5)** | `route_policy_stage()` | `RoutePolicyResult`, `delivery_allowed` |
| **Delivery decision (M13.6)** | `route_delivery_stage()` | `delivery_disposition`, `RouteDeliveryResult` |
| **Delivery execution (M13.6)** | Reused fan-out / adapter send | `delivery_success`, `delivery_error`, adapter latency |

Policy **does not** re-run in delivery stage. Delivery stage **reads** `policy_result` and `delivery_allowed` only.

### 4.5 `route_delivery_stage()` placement (normative)

**Locked placement** (per [`m13-6-delivery-design-review.md`](../../docs/architecture/m13-6-delivery-design-review.md)):

```text
route_policy_stage()
  ↓
route_delivery_stage()     # disposition + audit; send when allowed
  ↓
fan-out adapter call       # existing _send_to_destination / adapter registry — NOT a new engine
```

| Rule | Requirement |
|------|-------------|
| **After** | `route_policy_stage()` completes; `RoutePolicyResult` and `delivery_allowed` available on `route_ctx.processing_state` |
| **Before** | Any destination adapter send for this route |
| **Inside** | `process_route_pipeline()` — one invocation per enabled route per batch |
| **Send primitive** | Injected `send_fn` wrapping the **existing** per-route fan-out send body (`formatter` → `rate_limit` → adapter) |
| **Forbidden** | Post-loop-only disposition without stage; parallel adapter implementation; second send after fan-out for the same route/batch |

When `delivery_allowed=false`, `route_delivery_stage()` **still runs** — it records disposition and audit **without** calling the adapter.

---

## 5. Delivery Disposition

### 5.1 Disposition enum (normative)

```python
DeliveryDisposition = Literal[
    "delivered",
    "delivered_review_required",  # legacy path only — see §20
    "blocked",
    "quarantined",
]
```

### 5.2 Disposition matrix

| Disposition | `delivered?` | `checkpointed?` | `retryable?` | Visible in metrics? | Visible in audit? |
|-------------|--------------|-----------------|--------------|---------------------|-------------------|
| **`delivered`** | Yes when `delivery_success=true`; send attempted when `delivery_success=false` | Yes — only when `delivery_success=true` | Send failure (`delivery_success=false`): yes (per `failure_policy`) | `route_delivery_success_count` or `route_delivery_failure_count` | `delivery_complete` or `delivery_failed` + `route_id` |
| **`delivered_review_required`** | Yes — legacy flag OFF drift path only (§20) | Yes | Per failure_policy | Legacy stream metrics only | `delivery_complete` + `review_required=true` |
| **`blocked`** | No — policy block or require_review on route path | No | No — disposition final for batch | `route_delivery_blocked_count` or `route_delivery_review_count` | `delivery_disposition` + `policy_blocked` / `policy_review_required` (required — §7.3) |
| **`quarantined`** | No — policy quarantine | No | No — release via quarantine flow | `route_delivery_quarantine_count` | `delivery_disposition` + `policy_quarantine` + quarantine row |

**Notes:**

- `checkpointed?` follows constitution: only successfully **delivered** events advance stream checkpoint.
- Policy-blocked routes **do not** penalize checkpoint; sibling routes may still advance checkpoint.
- `retryable?` applies to **adapter send failures** (`delivery_disposition=delivered` AND `delivery_success=false`) — not to policy dispositions.
- **Send failure encoding (normative):** adapter failure uses `delivery_disposition=delivered` AND `delivery_success=false` — **not** a fifth disposition value.

### 5.3 Disposition resolution (route path, flag ON)

```text
IF policy_result.decision == "quarantine"
  → disposition = quarantined

ELIF policy_result.decision == "block"
  → disposition = blocked

ELIF policy_result.decision == "require_review"
  → disposition = blocked                    # §20 — not delivered on route path
  → metrics bucket = route_delivery_review_count (subtype of blocked-for-delivery)

ELIF delivery_allowed AND send attempted
  IF adapter success
    → delivery_disposition = delivered
    → delivery_success = true
  IF adapter failure
    → delivery_disposition = delivered          # normative — NOT a new enum value
    → delivery_success = false
    → delivery_error set; adapter_stage = delivery_failed (see §7.4)

ELIF NOT delivery_allowed (block | require_review | quarantine)
  → disposition per branches above (blocked | quarantined)
  → delivery_success = None
  → MUST emit delivery_disposition audit row (§7.3) — never rely on route_skip / no_route_payload alone

ELIF policy_result.decision in ("allow", "audit") AND NOT delivery_allowed
  → implementation error — invariant violation

ELIF policy_result.decision in ("allow", "audit") AND events empty
  → delivery_disposition = delivered; delivery_success = true; event_count = 0; skip adapter call
```

### 5.4 Skipped routes and `skip_reason`

| Condition | Disposition | `skip_reason` | Metrics |
|-----------|-------------|---------------|---------|
| Route `enabled=false` | Not processed — no disposition row | — | Excluded from `route_delivery_attempt_count` |
| Destination `enabled=false` | Not sent | `destination_disabled` | Excluded or attempt per impl plan |
| Rate limited | Not sent | `rate_limited` | `route_delivery_attempt_count++`; no success/failure send count |
| Dynamic routing excluded route | Existing dynamic routing behavior | `dynamic_routing_excluded` | Unchanged |
| Route processing `processing_ready=false` | Timeline `skipped` | `processing_not_ready` | Excluded |
| Policy block / review / quarantine | `blocked` or `quarantined` | `policy_blocked` / `policy_review` / `policy_quarantine` | Per §8.1 |

Normative `skip_reason` values (extensible): `rate_limited`, `destination_disabled`, `policy_blocked`, `policy_review`, `policy_quarantine`, `processing_not_ready`, `dynamic_routing_excluded`, `no_events`.

---

## 6. Route Delivery Contract

### 6.1 `RouteDeliveryResult` (normative typed model)

```python
@dataclass(frozen=True, slots=True)
class RouteDeliveryResult:
    route_id: int
    stream_id: int
    destination_id: int

    # Batch correlation (from SharedBatchContext / StreamRunner)
    batch_id: str
    run_id: str | None

    delivery_allowed: bool              # from RoutePolicyResult (M13.5)
    delivery_disposition: DeliveryDisposition
    delivery_success: bool | None       # None when send not attempted; false when send failed (§7.4)
    delivery_error: str | None          # adapter / formatter error message
    delivery_timestamp: datetime | None # UTC; set on send attempt or disposition-only outcome

    # Policy attribution (copied — no re-evaluation)
    policy_action: str                  # RoutePolicyResult.policy_action
    decision_reason: str                # RoutePolicyResult.decision_reason

    # Skip / hold context
    skip_reason: str | None             # when send not attempted — see §5.4

    # Send observability (when attempted)
    event_count: int
    latency_ms: int | None
    adapter_stage: str | None           # e.g. route_send_success | route_send_failed

    # Quarantine correlation (when disposition == quarantined)
    quarantine_event_id: int | None     # optional — stream_quarantine_events.id

    # Audit correlation
    delivery_log_id: int | None         # primary delivery_disposition audit row
```

### 6.2 Attachment to `RouteStageResult`

```python
# Additive fields on RouteStageResult (M13.6)
delivery_result: RouteDeliveryResult | None = None
delivery_duration_ms: int = 0
```

### 6.3 Invariants

| Invariant | Rule |
|-----------|------|
| Identity | `route_id`, `stream_id`, `destination_id` must match `RouteRuntimeContext` |
| Correlation | `batch_id` from `SharedBatchContext.batch_id`; `run_id` from active `StreamRunner` run when available |
| Policy immutability | Delivery stage must not mutate `policy_result` |
| Disposition-policy alignment | See §5.3 and §20 |
| Send gating | `delivery_success is not None` only when `delivery_disposition == "delivered"` (includes failed send with `delivery_success=false`) |
| Send failure encoding | Adapter failure: `delivery_disposition=delivered`, `delivery_success=false`, `delivery_error` set — §7.4 |
| Policy-blocked audit | `delivery_allowed=false` routes **must** emit `delivery_disposition` log — never only `route_skip` / `no_route_payload` |
| Audit required | Every disposition emits at least one `delivery_logs` row with `route_id`, `batch_id`, `delivery_disposition` |

---

## 7. Delivery Execution Model

### 7.1 Policy → execution mapping (normative)

```text
Allow
  → delivery_allowed = true
  → route_delivery_stage attempts send
  → disposition = delivered (on ACK) | send failure handled per §7.4

Audit
  → delivery_allowed = true
  → policy audit log (M13.5) + send attempt
  → disposition = delivered (on ACK)

Require Review
  → delivery_allowed = false
  → disposition only — NO adapter call
  → disposition = blocked (route path — §20)
  → audit: delivery_disposition + policy_review_required (required)

Block
  → delivery_allowed = false
  → disposition only — NO adapter call
  → disposition = blocked
  → audit: delivery_disposition + policy_blocked (required)

Quarantine
  → delivery_allowed = false
  → disposition only — NO adapter call (payload in quarantine row — M13.5)
  → disposition = quarantined
  → audit: delivery_disposition + policy_quarantine
  → quarantine_event_id on RouteDeliveryResult when available
```

### 7.2 Reuse boundaries (normative)

| Component | M13.6 usage |
|-----------|-------------|
| `_fan_out()` per-route send body | **Reused** — extracted as `send_fn` injected into `route_delivery_stage()`; same formatter, rate limit, adapter registry path |
| `DestinationAdapterRegistry` | **Unchanged** — Syslog/Webhook adapters |
| `app/formatters/message_prefix.py` | **Unchanged** |
| `app/destinations/adapters/*` | **Unchanged** |
| `_apply_failure_policy()` | **Unchanged** — applies to send failures only |
| Rate limiter | **Unchanged** — per `routes.rate_limit_json` |
| Batch `_fan_out()` loop | **Optional post-loop** — may aggregate results only; **must not** double-send routes already handled in `route_delivery_stage()` |

**Do NOT** fork send logic into a parallel code path. **Do NOT** create a new delivery engine.

### 7.3 `route_delivery_stage()` responsibilities

1. Read `RoutePolicyResult` and `delivery_allowed` from `route_ctx.processing_state`.
2. Set `batch_id` from `shared_batch.batch_id` and `run_id` from runner context.
3. Resolve `delivery_disposition` per §5.3.
4. **Policy-blocked routes (normative):** when `delivery_allowed=false`, emit `delivery_logs` stage `delivery_disposition` with full context (`route_id`, `policy_action`, `decision_reason`, `delivery_disposition`, `skip_reason`) **before** any fan-out skip. M13.5 policy stages may also exist; M13.6 disposition row is **required** and must not be replaced by `route_skip` / `no_route_payload` alone.
5. If send required: invoke injected `send_fn` wrapping the **existing** per-route fan-out send primitive (formatter → rate limit → adapter).
6. On quarantine: set `quarantine_event_id` when M13.5 recorded a row.
7. Build and return `RouteDeliveryResult`.
8. Append `stage_timeline` entry `{ stage: "delivery", disposition, delivery_success, skip_reason, ... }`.

### 7.4 Send failure on allowed routes (normative encoding)

When policy allows delivery and adapter send is attempted but fails:

| Field | Value |
|-------|-------|
| `delivery_disposition` | **`delivered`** — not a separate enum value |
| `delivery_success` | **`false`** |
| `delivery_error` | Adapter / formatter error message |
| `adapter_stage` | `route_send_failed` (or existing failure stage name) |
| `skip_reason` | `None` |

| Outcome | Metrics | Checkpoint |
|---------|---------|------------|
| `failure_policy=continue` | `route_delivery_failure_count++` | Per spec 002 — event may not checkpoint |
| `failure_policy=stop` | `route_delivery_failure_count++` | Partial batch rules per existing runner |
| Retry | `route_delivery_failure_count++` + retry metrics | Unchanged |

M13.6 **does not** change `failure_policy` semantics. Health and UI **must** treat `delivery_disposition=delivered` + `delivery_success=false` as **send failure**, not policy block.

---

## 8. Route Metrics

### 8.1 Per-batch counters (additive on `RouteProcessingMetrics`)

| Metric | Increment when |
|--------|----------------|
| `route_delivery_attempt_count` | Route processed and disposition resolved (includes disposition-only) |
| `route_delivery_success_count` | `delivery_disposition == "delivered"` AND `delivery_success == true` |
| `route_delivery_failure_count` | `delivery_disposition == "delivered"` AND `delivery_success == false` |
| `route_delivery_blocked_count` | `disposition == "blocked"` AND `policy_action == "block"` |
| `route_delivery_review_count` | `disposition == "blocked"` AND `policy_action == "require_review"` |
| `route_delivery_quarantine_count` | `disposition == "quarantined"` |

**Existing M13.5 policy counters** (`route_policy_*`) **remain** — delivery counters are **downstream** of policy and must not double-count policy stage internals.

### 8.2 Duration metrics (additive)

| Metric | Source |
|--------|--------|
| `route_delivery_duration_ms` | Sum of per-route `RouteStageResult.delivery_duration_ms` |
| Per-route `delivery_duration_ms` | `route_delivery_stage()` wall time including send |

### 8.3 Aggregation rules

| Level | Rule |
|-------|------|
| **Batch summary** | `StreamRunner` run summary JSON includes all `route_delivery_*` totals |
| **Per-route timeline** | `RouteStageResult.stage_timeline` delivery entry |
| **Time-series** | `runtime_analytics_bucket_1m` / `_5m` — extend bucket metadata or stage filters to include disposition dimensions (conceptual — see §13) |
| **Snapshot** | `runtime_route_snapshot` — map rolling delivery success/failure EPS; add optional `last_disposition` metadata (conceptual) |

### 8.4 Aggregation invariants

- Count each route **once per batch** at disposition resolution.
- Policy-blocked route: `route_delivery_attempt_count++`, success/failure send counters **unchanged**.
- Zero-event allowed route: attempt_count++ ; success_count++ if vacuously successful (no send) — document in implementation plan as `event_count=0` skip send.

---

## 9. Route Health

### 9.1 Health levels (route scope)

M13.6 adopts **operator-facing** three-level route health for Runtime UI badges (maps to spec 012 four-level scoring internally):

| Level | Meaning |
|-------|---------|
| **Healthy** | Recent delivery success; low failure rate; no sustained policy quarantine |
| **Warning** | Elevated send failures OR elevated policy review/block rate OR retry-heavy |
| **Failed** | Route disabled; sustained send failures; destination unreachable; or policy quarantine streak |

### 9.2 Health inputs (additive)

| Input | Source | Weight |
|-------|--------|--------|
| Delivery send failures | `delivery_logs` `delivery_failed` | High |
| Policy blocks | `delivery_logs` `policy_blocked` | Medium |
| Policy review holds | `delivery_logs` `policy_review_required` | Medium |
| Quarantine volume | `stream_quarantine_events` where `route_id` set | High |
| Destination failures | Destination adapter error codes | High |
| Inactivity | No successful delivery in window | Medium |

### 9.3 Health computation

- **Reuse** spec 012 scoring engine and `runtime_route_snapshot` updater.
- **Extend** factor list with `policy_block_rate` and `quarantine_rate` — no new health microservice.
- Route with **only** policy blocks (destination healthy) → **Warning**, not **Failed**.
- Route with **send failures** exceeding threshold → **Failed** (existing behavior).

### 9.4 `runtime_route_snapshot` extensions (conceptual)

| Field (conceptual) | Purpose |
|--------------------|---------|
| `last_disposition` | Most recent `DeliveryDisposition` |
| `policy_block_rate_5m` | Rolling policy block ratio |
| `quarantine_open_count` | Open quarantine rows for route |

---

## 10. Route Observability

### 10.1 Visibility layers

| Layer | Operator question | Primary surface |
|-------|-------------------|-----------------|
| **Runtime visibility** | Is this route delivering now? | Stream Runtime Detail — per-route delivery panel |
| **Audit visibility** | What happened on batch X? | `delivery_logs` filtered by `route_id` |
| **Route visibility** | Why is Route B different from Route A? | Route timeline + disposition badge |

### 10.2 “Why did this route not deliver?” decision tree

```text
1. Check RouteStageResult.stage_timeline delivery entry
     → disposition present?

2. IF disposition == quarantined
     → policy_action + quarantine row (route_id)
     → link to Quarantine Center

3. IF disposition == blocked AND policy_action == require_review
     → decision_reason (schema_drift | delivery_behavior)
     → audit stage policy_review_required

4. IF disposition == blocked AND policy_action == block
     → decision_reason + policy_blocked audit

5. IF delivery_disposition == delivered AND delivery_success == false
     → adapter error, failure_policy, destination health (NOT policy block)

6. IF skip_reason present
     → rate_limited | destination_disabled | policy_* per §5.4

7. IF route absent from batch without disposition row
     → implementation defect — every processed route must have RouteDeliveryResult
```

### 10.3 Audit stages (additive / normative)

| Stage | When |
|-------|------|
| `policy_complete` | Allow / audit policy (M13.5) |
| `policy_blocked` | Block |
| `policy_review_required` | Require review (route path) |
| `policy_quarantine` | Quarantine |
| `delivery_disposition` | **Required** — all outcomes including policy-blocked (normative §7.3) |
| `delivery_complete` / `route_send_success` | Send success (`delivery_success=true`) |
| `delivery_failed` / `route_send_failed` | Send failure (`delivery_disposition=delivered`, `delivery_success=false`) |

All policy and disposition stages **must** include: `route_id`, `stream_id`, `destination_id`, `batch_id`, `run_id` (when available), `policy_action`, `decision_reason`, `delivery_disposition`, `skip_reason` (when applicable).

### 10.4 Correlation

- `run_id` / `batch_id` links stream batch → per-route timelines.
- `delivery_log_id` on `RouteDeliveryResult` enables drill-down from Runtime to Logs Explorer.

---

## 11. Checkpoint Behavior

### 11.1 Constitution rule (unchanged)

Checkpoint updates **only** after **successful destination delivery** (adapter ACK). Policy disposition without send **never** advances checkpoint.

### 11.2 Per-disposition checkpoint interaction

| Disposition | Checkpoint effect |
|-------------|-------------------|
| **`delivered`** (`delivery_success=true`) | Contributing events eligible for checkpoint candidate set |
| **`delivered`** (`delivery_success=false`) | No checkpoint contribution — send failed per `failure_policy` |
| **`delivered_review_required`** | Legacy path only — same as delivered success (§20) |
| **`blocked`** | No checkpoint contribution from this route's events |
| **`quarantined`** | No checkpoint contribution |

### 11.3 Multi-route batch

```text
Stream batch with Route A delivered, Route B blocked:
  → checkpoint may advance based on Route A successful events only
  → checkpoint trace must attribute partial route success (spec 010 pattern)
```

### 11.4 Checkpoint trace extensions (conceptual)

`delivery_logs` checkpoint stages include per-route disposition summary:

```json
{
  "stage": "checkpoint_candidate",
  "route_dispositions": [
    { "route_id": 1, "disposition": "delivered", "event_count": 10 },
    { "route_id": 2, "disposition": "blocked", "policy_action": "require_review" }
  ]
}
```

---

## 12. Runtime Integration

### 12.1 `process_route_pipeline()` — post-M13.6 (normative placement)

```python
def process_route_pipeline(...) -> RouteStageResult:
    # ... transform, protection, classification ...
    policy_events, policy_result, _ = route_policy_stage(...)   # M13.5

    delivery_started = time.monotonic()
    delivery_result = route_delivery_stage(
        route_ctx,
        shared_batch,
        send_fn=single_route_fan_out_send,  # wraps existing adapter path — §7.2
        log_fn=log_fn,
        run_id=run_id,
    )
    delivery_duration_ms = ...

    timeline.append({
        "stage": "delivery",
        "disposition": delivery_result.delivery_disposition,
        "delivery_success": delivery_result.delivery_success,
        "skip_reason": delivery_result.skip_reason,
        "policy_action": delivery_result.policy_action,
        "decision_reason": delivery_result.decision_reason,
        "duration_ms": delivery_duration_ms,
    })

    return RouteStageResult(
        ...,
        events=policy_events if delivery_result.delivery_success else [],
        delivery_result=delivery_result,
        delivery_duration_ms=delivery_duration_ms,
        delivery_allowed=policy_result.delivery_allowed,
    )
```

**Order invariant:** `route_policy_stage()` → `route_delivery_stage()` → adapter send (inside stage when allowed). See §4.5.

### 12.2 `StreamRunner` integration

```text
route_pipeline = _execute_route_pipeline(...)
  → each RouteStageResult includes RouteDeliveryResult from route_delivery_stage()

# Post-loop: aggregate metrics + checkpoint — NO second adapter send per route
summary.update(route_delivery_* counters from route_pipeline.metrics)

checkpoint_reference_events = events from routes where
  delivery_disposition == delivered AND delivery_success == true
```

`StreamRunner` **must not** filter policy-blocked routes only via `route_payloads` omission without a corresponding `RouteDeliveryResult` and `delivery_disposition` audit row.

### 12.3 Stream-level policy skip (unchanged)

When `GDC_ROUTE_PROCESSING_ENABLED=true`, `_evaluate_policies()` **must not** run. Delivery observability is **per-route** only on this path.

### 12.4 Module placement (implementation plan — not binding)

| Module | Responsibility |
|--------|----------------|
| `app/route_delivery/config.py` | `RouteDeliveryResult`, `DeliveryDisposition` |
| `app/route_delivery/stage.py` | `route_delivery_stage()` |
| `app/runners/route_stage.py` | Pipeline wiring |
| `app/runners/route_context.py` | Typed result fields |
| `app/runners/stream_runner.py` | Summary rollup, checkpoint attribution |

---

## 13. Database Impact

**Concept only — no SQL in this spec.**

### 13.1 Route metrics persistence

| Store | Impact |
|-------|--------|
| `delivery_logs` | Primary write path — disposition + send stages with `route_id` |
| `runtime_analytics_bucket_1m` / `_5m` | Extend bucket aggregation to count disposition stages — optional new counter columns or JSON `metadata` |
| Run summary JSON | Ephemeral batch counters — no migration |

### 13.2 Route health persistence

| Store | Impact |
|-------|--------|
| `runtime_route_snapshot` | Optional additive columns: `last_disposition`, `policy_block_rate_5m`, `quarantine_open_count` |
| `runtime_stream_snapshot` | Rollup `healthy_route_count` / `failed_route_count` — may include policy-warning routes |

### 13.3 Route observability persistence

| Store | Impact |
|-------|--------|
| `delivery_logs` | Sufficient for MVP audit trail |
| `stream_quarantine_events.route_id` | Already nullable (M13.5) — query for route quarantine observability |
| No new `route_delivery_events` table | **Rejected** — duplicates `delivery_logs` |

### 13.4 Migration policy

- Prefer **zero migration MVP**: disposition in `delivery_logs.context_json` / message fields.
- Optional additive migration for snapshot columns — implementation choice, not required for AC.

---

## 14. API Impact

**Concept only — no endpoint definitions in this spec.**

### 14.1 Runtime read APIs (extend)

| Area | Extension |
|------|-----------|
| `GET /api/v1/runtime/streams/{id}` | Include per-route `last_disposition`, delivery metrics |
| `GET /api/v1/runtime/routes/{id}` | `RouteDeliveryResult` summary fields |
| `GET /api/v1/runtime/analytics/*` | Disposition breakdown dimension |
| `GET /api/v1/runtime/health/routes` | Policy-aware health factors |

### 14.2 Logs API (extend)

| Area | Extension |
|------|-----------|
| Logs Explorer filters | `delivery_disposition`, `policy_action` |
| Route-scoped log queries | Default `route_id` when drilling from route panel |

### 14.3 No breaking changes

- Existing response fields **preserved**.
- New fields **additive** only.

---

## 15. Frontend Impact

**Concept only — no component implementation in this spec.**

### 15.1 Surfaces

| Surface | M13.6 visibility |
|---------|------------------|
| **Route Processing UI** (Wizard Step 4) | Delivery tab shows disposition legend; Deploy Summary per-route last disposition |
| **Runtime Page** (`stream-runtime-detail-page`) | Per-route disposition badge; delivery success/failure vs policy hold |
| **Governance Workspace** | Quarantine / violations link to route disposition context |
| **Dashboard** | Route health indicators — Warning for policy review/block (not full redesign) |
| **Route Health Indicators** | Healthy / Warning / Failed badge on route rows |

### 15.2 Operator UX rules

- **Policy hold** (blocked/review/quarantine) **must not** display as destination send failure.
- **Send failure** **must not** display as policy block.
- Disposition color coding: delivered=green, review/block=amber, quarantine=red, send failure=red with different icon.

### 15.3 Deferred UI

- Full Governance Dashboard route breakdown → Route Governance Extension.
- M18 simulation overlays → out of scope.

---

## 16. Backward Compatibility

### 16.1 Flag OFF (`GDC_ROUTE_PROCESSING_ENABLED=false`)

| Behavior | Status |
|----------|--------|
| Stream-scoped pipeline | **Unchanged** |
| `_evaluate_policies()` | **Unchanged** |
| `_fan_out()` identical payload | **Unchanged** |
| M13.6 disposition model | **Not applied** — legacy logging only |
| `delivered_review_required` | **May occur** on legacy drift require_review path (§20) |

### 16.2 Flag ON rollback

Disable flag → immediate revert to legacy path. No migration rollback required for disposition fields (additive logs).

### 16.3 Stream fallback

Routes without per-route processing config continue dual-read fallback (M13.2–M13.5). M13.6 delivery execution uses same `routes` delivery config regardless of transform fallback.

### 16.4 API consumers

Clients ignoring new fields continue to function. Clients parsing `stage_timeline` see `delivery` replace/enrich `delivery_handoff`.

---

## 17. Acceptance Criteria

Implementation-ready checklist:

- [ ] **AC-1** `RouteDeliveryResult` typed model with all §6.1 fields (`batch_id`, `run_id`, `skip_reason`, `quarantine_event_id` included).
- [ ] **AC-2** `DeliveryDisposition` enum with four values per §5.1.
- [ ] **AC-3** `route_delivery_stage()` immediately after `route_policy_stage()`, before adapter send (§4.5).
- [ ] **AC-4** Allow + Audit → adapter send attempted; `delivery_disposition=delivered`, `delivery_success=true` on ACK.
- [ ] **AC-4b** Send failure → `delivery_disposition=delivered`, `delivery_success=false` (§7.4).
- [ ] **AC-5** Block → disposition only; `blocked`; `delivery_disposition` audit row; no adapter call.
- [ ] **AC-6** Quarantine → disposition only; `quarantined`; `delivery_disposition` audit row; `quarantine_event_id` when available.
- [ ] **AC-7** Require Review → disposition only; `blocked` on route path per §20; `delivery_disposition` audit row; no adapter call.
- [ ] **AC-8** `route_delivery_*` metrics on `RouteProcessingMetrics` per §8.1.
- [ ] **AC-9** Batch run summary includes delivery metrics.
- [ ] **AC-10** `delivery_logs` include `route_id`, `batch_id`, `policy_action`, `decision_reason`, `delivery_disposition`, `skip_reason` (when applicable).
- [ ] **AC-11** Policy stage not re-run in delivery stage.
- [ ] **AC-12** Existing fan-out send body and adapters reused via `send_fn` — no parallel send engine; no double-send.
- [ ] **AC-12b** Policy-blocked routes never rely on `route_skip` / `no_route_payload` alone — disposition audit required (§7.3).
- [ ] **AC-13** Checkpoint advances only on successful delivery per §11.
- [ ] **AC-14** Policy-blocked routes do not advance checkpoint.
- [ ] **AC-15** `runtime_route_snapshot` updater receives disposition signals (directly or via logs).
- [ ] **AC-16** Route health distinguishes policy warning vs send failure per §9.
- [ ] **AC-17** Operator can determine why route did not deliver per §10.2.
- [ ] **AC-18** Feature flag OFF — zero behavior change (regression tests).
- [ ] **AC-19** Feature flag ON — full disposition path active.
- [ ] **AC-20** No new delivery engine, runtime, or runner class.
- [ ] **AC-21** No API breaking changes.
- [ ] **AC-22** No UI breaking changes (additive badges/fields only).
- [ ] **AC-23** All existing tests pass.
- [ ] **AC-24** M13.6 test suite per §18 passes.

---

## 18. Test Strategy

### 18.1 Unit tests

| Test | Assert |
|------|--------|
| Disposition resolution | Each policy decision maps to correct disposition |
| `RouteDeliveryResult` builder | All fields populated |
| Metrics counters | Each disposition increments correct counter |
| Send failure encoding | `delivered` + `delivery_success=false` |
| Policy-blocked disposition audit | `delivery_disposition` row; not `route_skip` only |
| `skip_reason` on rate limit | `rate_limited` |
| Fan-out reuse | Same adapter path via `send_fn` |
| Invariant: no adapter on block/review/quarantine | `delivery_success is None`; `skip_reason` set |
| Invariant: policy not re-evaluated | Mock policy stage not called from delivery stage |

### 18.2 Integration tests

| Test | Assert |
|------|--------|
| Allow delivers | Adapter called; `delivery_disposition=delivered`, `delivery_success=true` |
| Send failure | Adapter called; `delivery_disposition=delivered`, `delivery_success=false`; `route_delivery_failure_count` |
| Audit delivers | Send + audit log |
| Block disposition only | No adapter call; `blocked`; `delivery_disposition` audit required |
| Review disposition only | No adapter call; `route_delivery_review_count`; `delivery_disposition` audit required |
| Quarantine disposition only | No adapter call; quarantine row + `quarantine_event_id` when available |
| Multi-route partial delivery | Route A delivered, Route B blocked; checkpoint from A only |
| Fan-out reuse | Same adapter invocation path as pre-M13.6 |

### 18.3 Regression tests

| Test | Assert |
|------|--------|
| Flag OFF parity | Legacy path identical — no disposition stages |
| M13.2–M13.5 tests | Continue passing |
| `test_schema_drift_policy_runtime.py` | Legacy review path unchanged |
| Quarantine release | `route_id` context preserved (M13.5) |

### 18.4 Performance tests

| Test | Assert |
|------|--------|
| Per-route overhead | Delivery stage adds &lt; 5ms median ex-send per route |
| Batch with N routes | Linear O(routes); no N² log writes |
| Snapshot updater | No full table scan per batch |

---

## 19. Implementation Boundaries

### 19.1 IN scope (M13.6)

| Item | Description |
|------|-------------|
| Route delivery disposition | Typed model + resolution |
| Route delivery stage | `route_delivery_stage()` in pipeline |
| Route metrics | `route_delivery_*` counters |
| Route health inputs | Policy-aware health factors |
| Route observability | Audit stages + operator decision tree |
| Checkpoint attribution | Per-route disposition in trace |
| `RouteDeliveryResult` on `RouteStageResult` | Typed handoff |

### 19.2 OUT of scope

| Item | Milestone |
|------|-----------|
| New delivery engine | **Forbidden** |
| New runtime architecture | **Forbidden** |
| New runner class | **Forbidden** |
| New observability platform | **Forbidden** |
| M18 Governance simulation | M18 |
| Dashboard redesign | Route Governance Extension |
| Delivery queue / DLQ redesign | Spec 048 future |
| Require Review operator queue UI | M19 Operations Center |
| Changing M13.5 `delivery_allowed` semantics | **Frozen** — M13.6 records, does not reopen |

### 19.3 Dependency graph

```text
M13.5 (policy gate + delivery_allowed)
  ↓
M13.6 (disposition + metrics + health + observability)
  ↓
Route Governance Extension (UI depth)
  ↓
M18 / M19 (governance simulation + operations)
```

---

## 20. Require Review Behavior

### 20.1 Problem

Three documents disagree on Require Review delivery:

| Source | Semantics |
|--------|-----------|
| **Spec 095 §10.3** | Events **may still deliver** with `review_required=true` audit metadata |
| **M13.5 implementation** | `delivery_allowed_for_decision()` — `require_review` → `delivery_allowed=false` |
| **M13.5 design review** | M13.6 must distinguish delivered-with-review vs held |

### 20.2 Decision (normative — NOT ambiguous)

**Route processing path (`GDC_ROUTE_PROCESSING_ENABLED=true`): Option A — Require Review does NOT deliver.**

```text
policy_result.decision == "require_review"
  → delivery_allowed = false          # frozen from M13.5
  → delivery_disposition = blocked    # not delivered
  → metrics: route_delivery_review_count
  → audit: policy_review_required + decision_reason
  → delivered_review_required: NOT USED on route path
```

**Rationale:**

1. M13.5 is **implemented and tested** with `delivery_allowed=false` for `require_review`.
2. Task mandate execution model: **Require Review → Disposition only** (no send).
3. Operators must not see ambiguous “delivered but needs review” on route path until M19 review queue exists.
4. `route_delivery_review_count` provides distinct observability from `route_delivery_blocked_count`.

### 20.3 Legacy path (`GDC_ROUTE_PROCESSING_ENABLED=false`): Option B preserved

```text
Stream schema drift unknown_*_field_policy = require_review
  → existing stream path may deliver with review flag
  → delivery_disposition = delivered_review_required
  → audit: review_required=true on delivery_logs
```

This preserves `tests/test_schema_drift_policy_runtime.py` and flag OFF parity.

### 20.4 Future reconsideration (post-M13.6)

Aligning route path with Spec 095 §10.3 delivery-with-flag requires:

- M19 Operations Center review queue
- Explicit product decision amending §20.2
- New disposition usage of `delivered_review_required` on route path

**Out of M13.6 scope** — document only.

### 20.5 Summary table

| Path | Require Review delivers? | Disposition |
|------|--------------------------|-------------|
| Flag ON (route pipeline) | **No** | `blocked` + `policy_action=require_review` |
| Flag OFF (legacy drift) | **Yes** (existing) | `delivered_review_required` |

---

## Appendix A — File Impact (implementation plan)

| File | Action |
|------|--------|
| `app/route_delivery/config.py` | **Create** — `RouteDeliveryResult`, `DeliveryDisposition` |
| `app/route_delivery/stage.py` | **Create** — `route_delivery_stage()` |
| `app/runners/route_context.py` | **Modify** — delivery fields on `RouteStageResult`, `RouteProcessingMetrics` |
| `app/runners/route_stage.py` | **Modify** — wire delivery stage |
| `app/runners/stream_runner.py` | **Modify** — summary metrics, checkpoint attribution |
| `app/runtime/runtime_snapshot_repository.py` | **Modify** — disposition-aware health inputs |
| `tests/test_route_runtime_delivery.py` | **Create** — M13.6 test suite |

---

## Appendix B — M13.5 → M13.6 Handoff Contract

| M13.5 output | M13.6 consumer |
|--------------|----------------|
| `RoutePolicyResult` | Disposition input — read-only |
| `delivery_allowed` | Send gate |
| `RouteStageResult.events` | Send payload when allowed |
| `quarantine_recorded` | Skip adapter; disposition `quarantined`; `quarantine_event_id` |
| `stage_timeline` policy entry | Correlate with delivery entry |
| `route_policy_*` metrics | Upstream — not replaced by delivery metrics |
| `SharedBatchContext.batch_id` | `RouteDeliveryResult.batch_id` |
| M13.5 quarantine row id | `RouteDeliveryResult.quarantine_event_id` (optional) |

---

*End of spec — M13.6 Route Runtime Delivery.*
