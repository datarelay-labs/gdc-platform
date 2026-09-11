# M13 Route Architecture — Completion Audit

**Date:** 2026-06-16  
**Scope:** M13.1–M13.6 (Route Processing Foundation through Route Runtime Delivery)  
**Mode:** Read-only audit — no implementation, no spec changes  
**Authority chain:** `docs/source-of-truth/` → `specs/091`–`096` → `app/runners/`, `app/route_*`, migrations, APIs, frontend

---

## 1. Executive Summary

M13 Route Architecture is **substantially implemented in the working tree** as an uncommitted work-in-progress: runtime orchestration, per-route stage modules, additive DB migrations, and focused test files exist and align with specs 091–096 in structure and intent.

However, the milestone set is **not complete and not production-ready**. A **critical circular import** prevents `StreamRunner` from loading in the current tree (`app.route_policy.__init__` → `route_policy.stage` → `app.runners.route_context`). M13-focused tests fail at collection with the same error. Until resolved, neither flag ON nor flag OFF paths are executable in this workspace.

Additional gaps versus spec acceptance criteria:

| Area | Status |
|------|--------|
| Runtime pipeline (flag ON design) | Implemented in code |
| Runtime executability (current tree) | **Blocked** — import cycle |
| Route-scoped REST APIs (M13.2–M13.5) | **Largely missing** |
| Route Processing Wizard / per-route UI | **Not implemented** (stream-global Transform remains) |
| DB migrations | Present (untracked); FK consistency mixed |
| Flag OFF parity (design) | Legacy branch preserved in `stream_runner.py` |
| Flag OFF parity (current tree) | **Not verifiable** — import failure |
| E2E / M13 test gate | **Not passing** — collection error |

**Final verdict:** **B) M13 Route Architecture Incomplete**

**Primary blockers:** circular import; missing route-scoped APIs; missing Route Processing UI; unvalidated test gate.

---

## 2. M13.1 Audit — Route Processing Foundation

### Spec alignment (`specs/091-route-processing-architecture/spec.md`)

| Deliverable | Evidence | Status |
|-------------|----------|--------|
| `GDC_ROUTE_PROCESSING_ENABLED`, default `false` | `app/config.py` | ✅ |
| `SharedBatchContext` | `app/runners/route_context.py`, `route_context_builder.py` | ✅ |
| `RouteRuntimeContext` + `RouteEffectiveConfig` | `app/runners/route_context.py` | ✅ |
| `dual_read()` | `app/runners/route_context.py` | ✅ |
| `stream_loader` route batch load | `app/runners/stream_loader.py` | ✅ |
| Shared phase + per-route loop | `app/runners/stream_runner.py` `_execute_route_pipeline()` | ✅ |
| Stage slots (transform → … → delivery) | `app/runners/route_stage.py` `process_route_pipeline()` | ✅ (active, not M13.1 no-op) |
| Feature flag branch at run start | `stream_runner.py` L326 vs L475 | ✅ |
| Spec index entry | `.specify/specs-index.md` | ✅ |

### Gaps vs M13.1 AC

| Item | Gap |
|------|-----|
| AC-4 Flag OFF e2e green | **Cannot verify** — `StreamRunner` import fails |
| AC-14 No M13.2–M13.6 under M13.1 label | Stages are **fully active** (expected post-M13.6 WIP) |
| `processing_readiness` deploy gating | Hook fields exist; no API/UI gate |
| Sample → Route contract enforcement | Fields present; Union Schema hardening out of scope |

### Implemented %

**~92%** (code present; **0% deployable** until import fix)

---

## 3. M13.2 Audit — Per Route Transform

### Spec alignment (`specs/092-per-route-transform/spec.md`)

| Requirement | Evidence | Status |
|-------------|----------|--------|
| `route_mappings` / `route_enrichments` | Migration `20260614_0054`, `app/route_transform/models.py` | ✅ |
| Dual-read transform resolver | `app/runners/route_transform_config.py` | ✅ |
| Transform in per-route loop (pre-governance) | `route_stage.py` `_apply_route_transform()` | ✅ |
| Stream mapping/enrichment skipped when flag ON | `stream_runner.py` `_collect_and_transform_events()` L2068–2087 | ✅ |
| Existing mapper/enrichment engines | `apply_mappings_with_results`, `apply_enrichments_batch` | ✅ |
| Per-route fan-out wiring | Send inside `route_delivery_stage` via `send_fn`; `_fan_out(skip_base_route_delivery=True)` | ✅ |
| `RouteStageResult` → delivery | `process_routes()` → checkpoint reference | ✅ |

### Gaps

| Item | Gap |
|------|-----|
| AC-8 Flag OFF regression | Blocked by import |
| AC-16 Route mapping/enrichment APIs | **Not found** — no `/runtime/routes/{id}/mapping-ui/*` |
| AC-17 Preview `route_id` | **Not found** |
| Route transform persistence API | Tables exist; **no write endpoints** |
| `route_mappings` FK `ON DELETE` | FK to `routes.id` **without CASCADE** (inconsistent with M13.3+) |

### Implemented %

**~78%** (runtime core yes; APIs/UI no)

---

## 4. M13.3 Audit — Per Route Protection

### Spec alignment (`specs/093-per-route-protection/spec.md`)

| Requirement | Evidence | Status |
|-------------|----------|--------|
| `route_protection_rules` table | Migration `20260615_0055`, `app/route_protection/models.py` | ✅ |
| `RouteProtectionConfig` + resolver | `app/route_protection/config.py`, `resolver.py` | ✅ |
| `route_overrides[]` from `streams.config_json.governance` | `stream_loader.py` L136–137, `211` | ✅ |
| Override merge + audit-only | `resolver.apply_route_overrides()` | ✅ |
| Shared-phase schema drift when flag ON | `_execute_route_pipeline()` calls `_apply_schema_drift_policy()` | ✅ |
| `ephemeral_auto_protect_rules` accessor | `SharedBatchContext.ephemeral_auto_protect_rules` | ✅ |
| `route_protection_stage()` + `protect_batch` reuse | `app/route_protection/stage.py` | ✅ |
| Stream `_prepare_delivery_events()` skipped flag ON | Legacy branch only when flag OFF | ✅ |
| Protected events to fan-out/delivery | Events flow through pipeline to `route_delivery_stage` | ✅ |

### Gaps

| Item | Gap |
|------|-----|
| Route protection CRUD APIs | **Not found** (`/runtime/routes/{id}/protection-rules`) |
| Effective config / preview `route_id` | **Not found** |
| Remove action | Correctly deferred per spec §9.4 |
| `delivery_behavior` enforcement | Deferred to M13.5 (by design) |
| Governance nested → flat flatten loader | Partial — reads flat `route_overrides` only |

### Implemented %

**~82%**

---

## 5. M13.4 Audit — Per Route Classification

### Spec alignment (`specs/094-per-route-classification/spec.md`)

| Requirement | Evidence | Status |
|-------------|----------|--------|
| `route_classification_rules` | Migration `20260616_0056`, `app/route_classification/models.py` | ✅ |
| `RouteClassificationConfig` typed | `app/route_classification/config.py` | ✅ |
| Dual-read list-replacement | `app/route_classification/resolver.py` | ✅ |
| `route_overrides[].classification_level` floor | Resolver + `max_level` in stage | ✅ |
| Classification after Protection | `route_stage.py` order | ✅ |
| `classify_batch` via adapter | `app/route_classification/engine_adapter.py` | ✅ |
| Stream `_classify_events()` skipped flag ON | Classification only in route loop | ✅ |
| `RouteStageResult.classification_result` | `route_context.py` | ✅ |
| M13.5 handoff (stamps on events) | Policy reads `current_events` | ✅ |

### Gaps

| Item | Gap |
|------|-----|
| Route classification CRUD / effective APIs | **Not found** |
| Classification preview `route_id` | **Not found** |
| Flag OFF / ON order regression tests | Blocked by import |
| `evaluate_batch()` stream DB path on route | Correctly avoided via injected rules |

### Implemented %

**~80%**

---

## 6. M13.5 Audit — Per Route Policy

### Spec alignment (`specs/095-per-route-policy/spec.md`)

| Requirement | Evidence | Status |
|-------------|----------|--------|
| `route_policy_rules` | Migration `20260616_0057`, `app/route_policy/models.py` | ✅ |
| `stream_quarantine_events.route_id` nullable FK | Same migration, `ON DELETE SET NULL` | ✅ |
| `RoutePolicyConfig` + resolver | `app/route_policy/config.py`, `resolver.py` | ✅ |
| `route_policy_stage()` + engine adapter | `app/route_policy/stage.py`, `engine_adapter.py` | ✅ |
| Policy after Classification | Pipeline order | ✅ |
| `delivery_allowed` gates send | `route_delivery_stage`, `process_route_pipeline` | ✅ |
| Route quarantine recording | `app/quarantine/recording.py` `record_route_policy_quarantine_event` | ✅ |
| Stream `_evaluate_policies()` skipped flag ON | Legacy branch L481+ only when flag OFF | ✅ |
| Drift gates + `delivery_behavior` merge | `drift_gates.py`, `decision.py` | ✅ |
| Policy metrics on loop summary | `stream_runner.py` summary fields | ✅ |

### Gaps

| Item | Gap |
|------|-----|
| **Circular import** | `app/route_policy/__init__.py` imports `stage` → imports `route_context` mid-init | ❌ **BLOCKER** |
| Route policy CRUD / effective APIs | **Not found** |
| Policy preview `route_id` | **Not found** |
| `GET/PUT /runtime/streams/{id}/governance` | **Not found** as dedicated endpoint |
| Require Review delivers on route path | **No** — frozen per M13.6 §20 (matches implementation) |

### Implemented %

**~80%** (design complete; **runtime blocked**)

---

## 7. M13.6 Audit — Route Runtime Delivery

### Spec alignment (`specs/096-route-runtime-delivery/spec.md`)

| Requirement | Evidence | Status |
|-------------|----------|--------|
| `RouteDeliveryResult` + `DeliveryDisposition` | `app/route_delivery/config.py` | ✅ |
| `route_delivery_stage()` after policy | `route_stage.py` L280–331 | ✅ |
| Disposition matrix (blocked/quarantine/delivered) | `route_delivery/stage.py` `resolve_delivery_disposition()` | ✅ |
| Send failure = `delivered` + `delivery_success=false` | Stage + spec §7.4 | ✅ |
| `delivery_disposition` audit log | `_emit_disposition_log()` stage | ✅ |
| Reuse fan-out send via `send_fn` | `_deliver_single_route()`, `_make_route_delivery_send_fn()` | ✅ |
| No double-send base routes | `_fan_out(skip_base_route_delivery=True)` | ✅ |
| `route_delivery_*` metrics | `RouteProcessingMetrics`, run summary | ✅ |
| Route health level (timeline) | `route_delivery/health.py` | ✅ |
| Checkpoint route disposition trace | `checkpoint_candidate` includes `route_dispositions` | ✅ |
| Require Review route path = blocked | M13.6 §20 decision documented in code behavior | ✅ |

### Gaps

| Item | Gap |
|------|-----|
| `runtime_route_snapshot` `last_disposition`, `policy_block_rate_5m` | **Not found** in `operational_snapshot_repository` |
| Analytics API disposition dimension | **Not extended** |
| Runtime API per-route disposition fields | **Partial** — frontend `stream-runtime-detail-page.tsx` modified (WIP) |
| Performance tests §18.4 | Not evidenced |
| `delivery_log_id` on result | Field exists; population unclear |

### Implemented %

**~85%**

---

## 8. Runtime Architecture Audit

### Target pipeline (flag ON) — spec 091–096

```text
SHARED PHASE (once)
  Fetch → Extract → Schema Observation → Sensitive Detection
  → Schema Drift Policy → SharedBatchContext

PER-ROUTE LOOP (process_route_pipeline)
  Transform → Protection → Classification → Policy → Delivery

POST-LOOP
  Dynamic routing → Checkpoint (stream cursor)
```

### Implementation evidence

| Stage | Location | Active |
|-------|----------|--------|
| Shared extract + detect | `stream_runner._collect_and_transform_events()` | ✅ |
| Shared drift (route path) | `_execute_route_pipeline()` | ✅ |
| Route transform | `route_stage._apply_route_transform()` | ✅ |
| Route protection | `route_protection_stage()` | ✅ |
| Route classification | `route_classification_stage()` | ✅ |
| Route policy | `route_policy_stage()` | ✅ |
| Route delivery | `route_delivery_stage()` + `_deliver_single_route()` | ✅ |

### Legacy paths still active?

| Path | When | Status |
|------|------|--------|
| Stream transform + classify in shared phase | Flag OFF | ✅ Preserved (`stream_runner.py` L2089+) |
| `_prepare_delivery_events()` stream protection | Flag OFF | ✅ L477 |
| `_evaluate_policies()` stream policy | Flag OFF | ✅ L482 |
| Legacy `_fan_out()` identical payload | Flag OFF | ✅ L527 |
| `_execute_route_processing_foundation()` | Deprecated stub | ✅ No-op (L906) |
| Double delivery on flag ON | Prevented | ✅ `skip_base_route_delivery=True` |

### Critical runtime defect

```text
app.runners.route_context
  → app.route_policy.config
    → app.route_policy (__init__ imports stage)
      → app.route_policy.stage
        → app.runners.route_context  (CYCLE)
```

Reproduction: `python3 -c "from app.runners.stream_runner import StreamRunner"` → `ImportError`.

**Impact:** Entire runtime pipeline non-importable; M13 tests fail at collection.

---

## 9. Database Audit

### Tables

| Table | Migration | UNIQUE / FK | ON DELETE | Notes |
|-------|-----------|-------------|-----------|-------|
| `route_mappings` | `20260614_0054` | UNIQUE `route_id` | **None** on `routes.id` | Orphan risk on route delete |
| `route_enrichments` | `20260614_0054` | UNIQUE `route_id` | **None** | Same |
| `route_protection_rules` | `20260615_0055` | UNIQUE `(route_id, field_path)` | **CASCADE** | ✅ |
| `route_classification_rules` | `20260616_0056` | INDEX `(route_id, enabled)` | **CASCADE** | ✅ |
| `route_policy_rules` | `20260616_0057` | INDEX `(route_id, enabled)` | **CASCADE** | ✅ |
| `stream_quarantine_events.route_id` | `20260616_0057` | nullable FK | **SET NULL** | ✅ per spec 095 |

### Migration consistency

- Chain: `0053_product_group` → `0054` → `0055` → `0056` → `0057` — linear, consistent.
- Migrations are **untracked** in git (`??`) — deployment state unknown.
- Stream-scoped tables **unchanged** — aligns with additive policy.

### Naming

- Consistent `route_*` prefix across concern tables.
- Models under `app/route_transform/`, `app/route_protection/`, etc.

---

## 10. API Audit

### Retained (unchanged)

Stream-scoped endpoints remain: `/runtime/streams/{id}/mapping-ui/*`, `protection-rules`, `classification-rules`, `policy-rules`, quarantine, etc.

### Missing vs specs 092–096

| Spec endpoint (conceptual) | Present |
|----------------------------|---------|
| `/runtime/routes/{id}/mapping-ui/config\|save` | ❌ |
| `/runtime/routes/{id}/enrichment-ui/*` | ❌ |
| `/runtime/routes/{id}/protection-rules` | ❌ |
| `/runtime/routes/{id}/protection/effective` | ❌ |
| `/runtime/routes/{id}/classification-rules` | ❌ |
| `/runtime/routes/{id}/policy-rules` | ❌ |
| `/runtime/streams/{id}/governance` (route_overrides) | ❌ dedicated |
| Preview APIs with `route_id` | ❌ |

### Existing route APIs (delivery-only)

- `/runtime/routes/{id}/ui/config|save` — formatter/delivery UI, not transform/governance
- `/runtime/routes/{id}/formatter|failure-policy|enabled|rate-limit/save`

### API breakage risk

- No evidence of **breaking** changes to stream APIs.
- **Hidden route requirement:** None — flag OFF path does not require route config (when import fixed).
- Flag ON without route rows uses dual-read stream fallback (by design).

---

## 11. Frontend Audit

### Current state

- Wizard (`wizard-state.ts`): **Connect → Sample → Transform → Destinations → Deploy** (stream-global Transform).
- SoT target: **Destinations → Route Processing** (per-route Transform/Protection/Classification/Policy tabs).
- **No** `step-route-processing.tsx` or Route Processing step.

### WIP frontend touches (git status)

- `stream-runtime-detail-page.tsx` — runtime visibility (partial M13.6)
- `delivery-log-stages.ts`, `logs-explorer-page.tsx` — log stage labels
- Governance panels — quarantine/violation route context (partial)

### Immediate UI required?

**No** for flag OFF / default deploy — runtime changes are behind `GDC_ROUTE_PROCESSING_ENABLED=false`.

**Yes** before flag ON production — operators cannot configure per-route transform/governance without APIs + UI.

### Future UI work (separate from runtime gate)

| Item | Milestone |
|------|-----------|
| Destination First wizard reorder | Wizard P7 |
| Route Processing step + per-route tabs | M13.2–M13.5 UX |
| Route Preview (transform + protection + classification + policy chain) | Governance Workspace |
| Disposition badges on runtime route rows | M13.6 |
| Governance `route_overrides[]` editor | M13.3–M13.5 |
| Deploy Summary per-route source breakdown | Wizard |

---

## 12. Backward Compatibility Audit

### Existing streams

| Condition | Expected | Current tree |
|-----------|----------|--------------|
| Flag OFF | Legacy stream pipeline | Code preserved; **not runnable** (import) |
| Flag ON, no route rows | Dual-read stream config per route | Implemented in loader/resolvers |
| User stream/mapping/route data | No truncate | ✅ Additive migrations only |
| Checkpoint semantics | After successful delivery | ✅ Constitution preserved in both paths |

### Flag OFF identical behavior?

- **Design intent:** Yes — separate `elif` branch at L475 uses legacy path.
- **Verified parity:** **No** — cannot execute tests or import `StreamRunner`.
- **Production note:** Deployed image may still run pre-M13 `stream_runner` until WIP is merged; this audit reflects **current workspace**.

### Parity gap (flag ON vs OFF)

- Classification **before** Protection (OFF) vs **after** Protection (ON) — documented intentional delta (spec 094 §10.4).
- Require Review may deliver on legacy drift path but **not** on route path (M13.6 §20).

---

## 13. Technical Debt Register

### HIGH

| ID | Item | Impact |
|----|------|--------|
| TD-H1 | Circular import `route_policy.__init__` ↔ `route_context` | Runtime and tests non-importable |
| TD-H2 | Route-scoped REST APIs missing (M13.2–M13.5) | Cannot configure per-route processing without DB |
| TD-H3 | M13 migrations untracked / apply status unknown | Schema drift across environments |
| TD-H4 | M13 test suite cannot run | No regression gate for flag ON/OFF |

### MEDIUM

| ID | Item | Impact |
|----|------|--------|
| TD-M1 | `route_mappings` / `route_enrichments` FK without CASCADE | Orphan rows on route delete |
| TD-M2 | `checkpoint_reference_events` keeps **last** successful route only in `process_routes()` | Multi-route checkpoint attribution imprecise |
| TD-M3 | `runtime_route_snapshot` lacks disposition columns | Health conflates policy hold vs send failure |
| TD-M4 | Governance nested `rules[].route_overrides[]` flatten not implemented | SoT nested JSON may not load |
| TD-M5 | No dual-write during stream API edits | Operators must use stream APIs only |
| TD-M6 | Wizard order inverted vs SoT | UX debt; not runtime blocker for flag OFF |

### LOW

| ID | Item | Impact |
|----|------|--------|
| TD-L1 | `processing_readiness` / deploy gating hook unused | No readiness API |
| TD-L2 | Remove protection action deferred | Documented spec exception |
| TD-L3 | `route_governance_overrides` table deferred | JSON store sufficient for MVP |
| TD-L4 | Performance benchmarks N routes post-M13.6 | Not formalized |
| TD-L5 | `delivery_log_id` on `RouteDeliveryResult` may be unset | Audit drill-down incomplete |

---

## 14. Architecture Alignment Review

### One Stream → Many Routes → Many Destinations

| Principle | Alignment |
|-----------|-----------|
| Topology unchanged | ✅ |
| Execution Unit = Stream | ✅ `StreamRunner` sole transaction owner |
| Processing Unit = Route | ✅ `process_route_pipeline()` per route |
| Delivery Unit = Route | ✅ `route_delivery_stage()` + per-route send |
| No parallel pipeline | ✅ Same engines, orchestration split |
| Mapping/Enrichment separate internally | ✅ Transform stage runs both |
| Checkpoint after delivery success | ✅ Constitution preserved |

### Drift from SoT (non-runtime)

- Wizard: Transform before Destinations (SoT: Destinations first).
- Governance Workspace route-aware dashboards partial.
- Union Schema enforcement thresholds — parallel work, not M13 core.

### Drift from specs (runtime)

- M13.1 stage slots were spec-no-op; implementation correctly activates M13.2–M13.6 stages (expected progression).
- Spec 095 §10.3 vs M13.6 §20 Require Review — **resolved in implementation** (route path does not deliver).

---

## 15. Completion Scorecard

| Milestone | Implemented % | Complete? | Notes |
|-----------|---------------|-----------|-------|
| **M13.1** Foundation | 92% | No | Import blocker |
| **M13.2** Per Route Transform | 78% | No | APIs/UI missing |
| **M13.3** Per Route Protection | 82% | No | APIs/UI missing |
| **M13.4** Per Route Classification | 80% | No | APIs/UI missing |
| **M13.5** Per Route Policy | 80% | No | Import blocker + APIs |
| **M13.6** Route Runtime Delivery | 85% | No | Snapshot/API extensions partial |
| **Overall M13** | **~83%** | **No** | See blockers |

### Acceptance criteria rollup (representative)

| Category | Pass | Fail | Blocked |
|----------|------|------|---------|
| Runtime orchestration (code review) | ~45 | ~5 | — |
| Executability / tests | 0 | 1 | ~20 |
| APIs per spec §12 | 0 | ~15 | — |
| Frontend per spec §13 | 0 | ~10 | — |
| DB additive model | ~8 | 2 | — |

---

## 16. Go / No-Go Recommendation

### Recommendation: **NO-GO** for enabling `GDC_ROUTE_PROCESSING_ENABLED=true` in any environment

### Rationale

1. **Runtime is not importable** in the current tree (TD-H1).
2. **Test gate cannot execute** (TD-H4).
3. **Operators cannot configure** per-route differences without route APIs/UI (TD-H2).
4. Migrations may not be applied consistently (TD-H3).

### Safe today

- **NO-GO for flag ON** globally or per staging without fixing TD-H1 and running full regression.
- **GO for flag OFF** only on **deployed builds that do not include this WIP** — default `GDC_ROUTE_PROCESSING_ENABLED=false` preserves OSS behavior on those builds.

### Exact blockers (must clear before “Complete”)

1. Fix `app.route_policy` package `__init__.py` circular import (e.g. lazy import or remove `stage` from package `__init__`).
2. Verify `StreamRunner` import and full M13 test matrix green.
3. Apply and commit migrations `20260614_0054`–`20260616_0057`.
4. Implement route-scoped CRUD/effective APIs per specs 092–095 (minimum for operability).
5. Confirm flag OFF e2e regression unchanged post-fix.
6. Confirm flag ON parity case: no route rows → byte-equivalent delivery vs flag OFF.

### Remaining technical debt (if blockers cleared — not blocking “runtime MVP” label)

- Route Processing Wizard + Destination First reorder (TD-M6).
- `runtime_route_snapshot` disposition columns (TD-M3).
- FK CASCADE on `route_mappings` / `route_enrichments` (TD-M1).
- Governance nested override flatten (TD-M4).
- Full Governance Dashboard route breakdown (Route Governance Extension).

---

## Final Verdict

### **B) M13 Route Architecture Incomplete**

The architecture is **designed correctly** and **largely coded** in alignment with specs 091–096 and Product Charter 1.2.1 (Stream execution, Route processing, Route delivery). The working tree is **not shippable** due to the import cycle, missing route APIs, absent Route Processing UI, and unverified test gate.

---

*Audit performed read-only against workspace state 2026-06-16. No code, migrations, specs, or deployments were modified.*
