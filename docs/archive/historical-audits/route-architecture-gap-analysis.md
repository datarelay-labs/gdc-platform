# Route Architecture Gap Analysis

**Status:** Investigation only — no implementation  
**Date:** 2026-06-14 (revised after Source of Truth document placement)  
**Authority:** `docs/source-of-truth/` (Product Charter 1.2.1, WBS 1.2.1, UX/Wizard/Governance/Union Schema charters)  
**Index:** [`source-of-truth-index.md`](source-of-truth-index.md)

---

## Executive Summary

The codebase **fully implements delivery fan-out** (`One Stream → Many Routes → Many Destinations`) but **does not implement Route as Destination Specific Processing Unit**. Transform, Protection, Classification, and Policy run **once per Stream** before fan-out; Route today carries **delivery configuration only** (formatter, failure policy, rate limit).

This is consistent with how the platform was built: Phase A Foundation delivered Stream-scoped Mapping/Enrichment and Route as a **link**; Data Control engines (M5–M13) were attached to Stream scope; OSS v1.0 GA shipped with that model. The new Product Charter 1.2.1 and WBS 1.2.1 define **Route Architecture Enablement** (M13.1–M13.6, Wizard Destination First) as the **next priority**, not as already-complete work.

**Product Charter alignment:** `Runtime Reuse First` and `No Parallel Pipeline` imply **re-orchestration of existing StreamRunner**, not a new delivery engine.

---

## Mandatory Questions — Direct Answers

### Q1. One Stream → Many Routes → Many Destinations — how far is it implemented?

| Layer | Status | Evidence |
|-------|--------|----------|
| **Entity model** | **Implemented** | `streams` → `routes` (N) → `destinations`; UNIQUE `(stream_id, destination_id)` |
| **CRUD / UI** | **Implemented** | Wizard route drafts, `/routes` console, stream edit delivery panel |
| **Runtime fan-out** | **Implemented** | `StreamRunner._fan_out()` sends to all enabled routes |
| **Per-route delivery config** | **Implemented** | `formatter_config_json`, `failure_policy`, `rate_limit_json`, `enabled` on `routes` |
| **Per-route processing** | **Not implemented** | Mapping/Enrichment/Protection/Classification/Policy are Stream-scoped |

**Verdict:** **Delivery topology yes; processing topology no.**

---

### Q2. Is Route a Destination Specific Processing Unit or a Destination Link?

**Today: Destination Link (delivery adapter configuration).**

```text
Route (current) = stream_id + destination_id + delivery policy + wire format
Route (target)  = above + Transform + Protection + Classification + Policy per destination
```

**Code:** `app/routes/models.py` — no mapping/enrichment/governance FKs or JSON processing blobs.  
**Loader:** `app/runners/stream_loader.py` — injects mapping/enrichment on **stream** dict; routes carry delivery fields only.

---

### Q3. Transform / Protection / Classification / Policy — Stream or Route scope?

| Concern | Current scope | Storage |
|---------|---------------|---------|
| **Mapping** | **Stream** | `mappings.stream_id` UNIQUE |
| **Enrichment** | **Stream** | `enrichments.stream_id` UNIQUE |
| **Protection** | **Stream** | `stream_protection_rules.stream_id` |
| **Classification** | **Stream** | `stream_classification_rules.stream_id` |
| **Policy (runtime M8)** | **Stream** | `stream_policy_rules.stream_id` |
| **Schema drift policy** | **Stream** | `streams.config_json` |
| **GovernancePolicy (M18)** | **Stream assignment** | `stream_policy_assignments`; not runtime-wired |
| **Formatter / failure / rate limit** | **Route** | `routes` table |

**Runtime order** (`app/runners/stream_runner.py`): single `_collect_and_transform_events()` → single `_prepare_delivery_events()` → `_fan_out()` with identical processed payload (modulo protection copy).

---

### Q4. How far is current Wizard from Destination First UX?

| Aspect | Target (SoT) | Current (code) | Gap |
|--------|--------------|----------------|-----|
| **Step order** | Connect → Sample → **Destinations** → **Route Processing** → Deploy | Connect → Sample → **Transform** → Destinations → Deploy | **Step reorder** |
| **Step count** | 5 (Wizard Charter v5.2 file; internal v3.0 text) | 5 (`wizard-state.ts` v3.0) | Same count, **wrong order & semantics** |
| **Processing unit** | Per-route tabs (Transform, Protection, Classification, Policy, Delivery) | Single stream-global Transform step | **Per-route UI missing** |
| **Destination auto-route** | Each destination creates a Route automatically | Manual route draft in delivery step | Partial (draft model exists, not auto from step 3) |
| **User mental model** | "Where should data go?" before "How to transform?" | Transform before destinations | **Inverted** |
| **Mapping/Enrichment exposure** | Unified "Transform" only | Transform step exposes mapping + enrichment | Partial (Transform merge exists) |
| **Governance in wizard** | Optional in Route Processing | Optional drawer in Transform step (stream-scoped) | Wrong step + wrong scope |

**File:** `frontend/src/components/streams/wizard/wizard-state.ts` — comments still say "Stream Wizard UX Charter v3.0", steps `transform` before `destinations`.

---

### Q5. Is Governance Route Aware?

| Area | Route aware? | Notes |
|------|--------------|-------|
| **Runtime enforcement** | **No** | All rules keyed by `stream_id` |
| **API** | **No** | `/runtime/streams/{id}/protection-rules` etc.; no `route_overrides` |
| **Stream governance drawer** | **No** | Panels are stream-scoped |
| **Governance Workspace** | **No** | Dashboard, violations, quarantine, replay — stream/tenant level; no route breakdown |
| **Policy catalog assignment** | **No** | `stream_policy_assignments` only |
| **Logs / replay context** | **Partial** | `route_id` in delivery_logs context; not in governance rule model |

SoT requires: **Configuration Scope = Stream**, **Execution/Processing Scope = Route**, with **Route overrides** (Governance Workspace spec extension). **Neither override model nor route-aware dashboard exists.**

---

### Q6. Union Schema Spec vs implementation?

| Requirement (Union Schema UX Spec v1.1) | Implementation | Gap |
|----------------------------------------|----------------|-----|
| Union Schema from multiple events | **Yes** | `buildUnionSchema()` in `frontend/src/utils/unionSchema.ts` |
| Union Schema Tree (not single-event tree) | **Yes** | `union-schema-tree.tsx` used in wizard transform |
| Field frequency `N/M` display | **Yes** | `formatUnionOccurrence()` |
| Rare field (<30%) | **Partial** | `isRareUnionField()` marks any field with `occurrence_count < total_events`, not **30% threshold** |
| Sensitive suggestion (no auto-apply) | **Partial** | Client-side `inferWizardSensitivityClass()` heuristics; not full Sensitive Detection engine at schema build |
| Sample values (max 5) | **Yes** | `MAX_SAMPLE_VALUES = 5` |
| API Test 10–20 events minimum | **No enforced policy** | Uses whatever fetch returns; single-event paths still exist in some flows |
| Event Root scoped analysis | **Partial** | Union built from extracted events post path selection; not always 10–20 |
| Field detail panel (type, frequency, samples) | **Partial** | Tree shows inline; no dedicated right panel per spec |
| Generated Fields logical group | **No** | Add Field exists; no "Generated Fields" grouping under Union Schema |
| Sample → Transform JSON contract | **No formal contract** | Wizard state fields, not documented API payload |
| Union Schema shared across all Routes | **N/A (routes don't have transform yet)** | Schema is stream/sample scoped — aligns with target **input** model |
| Route Processing consumes Union Schema | **No** | Transform is pre-destination, stream-global |

**Overall:** Union Schema **MVP largely present** for wizard transform; **gaps in collection policy, rare threshold, detail panel, and route-processing integration.**

---

### Q7. Reusable components for Route Architecture?

**High reuse (config-driven engines):**

| Component | Path |
|-----------|------|
| Mapping engine (JSONPath, JSONata, regex) | `app/mappers/mapper.py`, `mapping_rules.py` |
| Enrichment apply | `app/enrichments/` |
| Protection engine | `app/protection/engine.py` |
| Classification service | `app/classification/service.py` |
| Policy evaluator | stream policy rules evaluation in `stream_runner.py` |
| Schema drift / sensitive detection | `app/schema_observation/`, `app/sensitive_detection/` |
| Destination adapters | `app/destinations/adapters/` |
| Formatter / message prefix | `app/formatters/message_prefix.py` |
| Failure policy / retry | `StreamRunner._apply_failure_policy()` |
| Fan-out / checkpoint / transaction owner | `StreamRunner` core |
| Union Schema builder / tree | `frontend/src/utils/unionSchema.ts`, `union-schema-tree.tsx` |
| Wizard route drafts / delivery UI | `step-delivery.tsx`, `gdcRoutes.ts` |
| Route operational panel | `route-operational-panel.tsx` |
| Governance intent UI (drawer) | `wizard-data-protection-*`, `stream-governance-drawer.tsx` |

**Refactor required (scope/orchestration, not rewrite):**

| Component | Change |
|-----------|--------|
| `stream_loader.py` | Load per-route processing config |
| `StreamRunner` | Split shared fetch vs per-route process loop |
| `mappings` / `enrichments` models & repos | Route scope or route override tables |
| `stream_*_rules` tables | Route rules + optional stream defaults |
| Runtime API router | Route-scoped endpoints + dual-read fallback |
| Wizard state & steps | Destination First + Route Processing step |
| Governance workspace pages | Route dimension in violations/quarantine/dashboard |

---

### Q8. New Runtime vs re-orchestration?

**Re-orchestration only.** Product Charter explicitly forbids parallel pipelines:

- `Runtime Reuse First`
- `No Parallel Pipeline`
- `No Parallel Delivery Engine`
- `No Parallel Governance Engine`

**Target shape:**

```text
StreamRunner (unchanged transaction owner)
  Shared: Source fetch → Extract → Schema observation → Sensitive detection (optional)
  Per Route: Mapping → Enrichment → Classification → Protection → Policy → Format → Send
  Shared: Checkpoint (stream cursor, post-delivery ACK)
```

No new scheduler, no second runner class required — **orchestration refactor** inside `StreamRunner` + **config model extension**.

---

## 1. Current Architecture

### 1.1 Entity model

```text
Connector → Source → Stream (execution unit)
                      ├─ Mapping        (1:1)
                      ├─ Enrichment     (1:1)
                      ├─ Checkpoint     (1:1)
                      ├─ stream_protection_rules
                      ├─ stream_classification_rules
                      ├─ stream_policy_rules
                      └─ Route (N) → Destination
                           └─ delivery config only
```

### 1.2 Why this structure exists

| Decision | Rationale |
|----------|-----------|
| Stream = execution unit | Source fetch, polling, checkpoint, status isolation per API endpoint |
| Route = delivery link first | Foundation phase connected multi-destination before per-destination transform was specified |
| Stream-scoped Data Control | M5–M13 engines implemented with `stream_id` FK; simpler operator MVP |
| Governance control plane separate | M18 policies for catalog/simulation; M8 `stream_policy_rules` for runtime |
| OSS v1.0 GA scope | Shipped Stream-scoped transform + Route fan-out; Route Processing deferred to post-GA |

This was the correct incremental path to multi-destination delivery and governance without blocking the GA release.

### 1.3 Runtime pipeline (implemented)

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
  → Checkpoint (stream, enriched originals, after ACK)
```

**Key files:** `app/runners/stream_runner.py`, `app/runners/stream_loader.py`

### 1.4 Frontend (implemented)

| Surface | Model |
|---------|-------|
| Wizard v3 | 5 steps: Connect → Sample → Transform → Destinations → Deploy |
| Edit | Separate pages: mapping, enrichment, edit, runtime (no unified edit wizard) |
| Union Schema | Built in sample/API test; tree in Transform step |
| Stream groups | `streams-console.tsx` groups by source product (UX Charter aligned) |
| Governance | `/governance/*` workspace + stream governance drawer |
| Destinations | Global library + route attachment in wizard/edit |

---

## 2. Target Architecture (Source of Truth)

From **Product Charter 1.2.1**, **UX Charter 1.2.1**, **Stream Wizard Charter v5.2**, **WBS 1.2.1**:

### 2.1 Core model

```text
Execution Unit:     Stream   (fetch, checkpoint, status)
Processing Unit:    Route    (= Destination Specific Processing Unit)
Topology:           One Stream → Many Routes → Many Destinations
```

### 2.2 User flow

```text
Collect Data → Select Destinations → Configure Route Processing → Deploy
(Destination First → Route Processing Second)
```

### 2.3 Per-route processing

Each Route supports (independently):

- Transform (Mapping + Enrichment unified in UX)
- Protection (default + route override)
- Classification
- Policy
- Delivery settings (already present)

### 2.4 Governance model

```text
Configuration Scope:  Stream (ownership, optional defaults)
Execution Scope:      Route (behavior, overrides)
```

### 2.5 Union Schema

- Built at Sample from 10–20 events at selected Event Root
- **Shared input** for all Routes on a Stream
- Route Processing configures **how** to transform/protect, not **what fields exist**

### 2.6 WBS planned work (not yet in code)

WBS lists under **Next Priority**:

- Route Architecture Enablement (M13.1–M13.6)
- Destination First Wizard UX

Note: WBS "Current State 100%" refers to **delivered milestones through OSS GA and AI Gateway**; M13.1–M13.6 Route Processing items are **forward work**, not reflected in the current codebase.

---

## 3. Gap Analysis

| Area | Current | Target | Severity |
|------|---------|--------|----------|
| Route semantics | Delivery link | Processing unit | **Critical** |
| Mapping/Enrichment scope | Stream | Route | **Critical** |
| Protection/Classification/Policy | Stream | Route (+ stream defaults) | **Critical** |
| Wizard step order | Transform → Destinations | Destinations → Route Processing | **High** |
| Per-route wizard UI | None | Route tabs for transform/governance | **High** |
| Governance route overrides | None | Default + route_overrides[] | **High** |
| Governance dashboard route view | Stream only | Stream + Route | **Medium** |
| Union Schema 10–20 policy | Not enforced | Enforced at sample | **Medium** |
| Rare field threshold | Any partial occurrence | <30% | **Low** |
| API surface | Stream-centric runtime | Route-centric + compatibility | **High** |
| DB schema | Stream 1:1 mapping/enrichment | Route processing tables | **High** |
| Specs in repo | 001–004 Stream-scoped | New 091-route-processing spec needed | **Medium** |

### Alignment already strong

- Multi-route fan-out and failure policies
- Stream vs Destination separation
- Mapping/Enrichment separation at engine level (can stay internal)
- Union Schema foundation in frontend
- Stream group by source product
- Governance workspace operational surfaces (M18–M20)
- AI Gateway (Phase E) — orthogonal to Route Processing
- Checkpoint-after-delivery rule unchanged

---

## 4. Database Impact

### 4.1 New or extended tables (conceptual)

| Artifact | Approach |
|----------|----------|
| Route mapping | `route_mappings` UNIQUE `route_id` OR nullable `route_id` on mappings |
| Route enrichment | `route_enrichments` |
| Route protection/classification/policy rules | `route_*_rules` or `route_id` on existing tables |
| Route governance overrides | `route_governance_overrides` JSON or normalized |
| Quarantine/replay | Add nullable `route_id` |
| `routes` | May hold processing summary JSON during migration |

### 4.2 Unchanged

`connectors`, `sources`, `streams`, `destinations`, `checkpoints`, core `routes` FK shape

### 4.3 Migration scale

- **8–15** additive Alembic migrations (phased)
- **~10–12** model/repository files
- Backfill: copy stream config to each existing route (O(routes))
- **213** Python files reference `stream_id` — review for route context

---

## 5. API Impact

### 5.1 Add (representative)

```text
GET/POST /runtime/routes/{route_id}/mapping-ui/config|save
GET/POST /runtime/routes/{route_id}/enrichment-ui/config|save
GET/POST /runtime/routes/{route_id}/protection-rules
GET/POST /runtime/routes/{route_id}/classification-rules
GET/POST /runtime/routes/{route_id}/policy-rules
GET/PUT  /runtime/streams/{id}/governance  (+ route_overrides[])
POST     /runtime/preview/*  (route_id parameter)
```

### 5.2 Deprecate gradually

~47 `/runtime/streams/{id}/...` processing endpoints → compatibility shim (propagate to all routes or primary route)

### 5.3 Governance API

Extend violations/quarantine/replay responses with `route_id`; simulation/impact accept route filter

---

## 6. Runtime Impact

### 6.1 Orchestration change

**Before:** process once → fan-out same payload  
**After:** fan-out loop includes per-route transform/governance chain OR nested `_process_route_batch()`

### 6.2 Checkpoint

Remain **stream-scoped** on source cursor; enriched reference events from **shared extract**, not route-specific shapes (Product Charter unchanged)

### 6.3 Performance

N routes × transform cost — mitigate with shared extract, batch rule loading, optional caching

### 6.4 Preview / pipeline debug

Must accept `route_id`; show per-route stage timeline

---

## 7. Frontend Impact

| Area | Change |
|------|--------|
| `wizard-state.ts` | Reorder steps; `WizardRouteDraft` gains transform/governance state |
| New `step-route-processing.tsx` | Per-route tabs (Transform, Protection, Policy, Delivery) |
| `step-mapping-combined.tsx` | Move under route processing or become route-scoped |
| `stream-mapping-page.tsx` | Route selector or redirect to route edit |
| `route-edit-page.tsx` | Expand from delivery-only to full processing |
| `union-schema-tree.tsx` | Keep stream/sample scoped; consumed per route tab |
| Navigation | UX Charter: minimize top-level engine menus (partially done) |

---

## 8. Wizard Impact

### Current deploy sequence

1. POST stream  
2. Save stream mapping + enrichment  
3. Persist stream-scoped protection intents  
4. POST routes (delivery fields only)

### Target deploy sequence

1. POST stream (source + sample config)  
2. POST routes (from destination selection)  
3. For each route: save mapping, enrichment, protection, classification, policy  
4. Deploy readiness per route + aggregate

### Blocking rules (SoT)

- No destination → block (already)  
- Transform warnings → do not block (align with Deploy charter)  
- Per-route transform gate → new

---

## 9. Governance Impact

### Target (SoT)

- Wizard: Route Processing step with Protection/Classification/Policy (optional)  
- Default rule at stream + **route overrides**  
- Dashboard: route-aware visibility (Route A: Audit, Route B: Mask)  
- Workspace: intent UI, not engine names (partially implemented)

### Current gaps

- No `route_overrides` in data model or API  
- Governance Workspace pages lack route breakdown  
- Stream governance drawer is stream-only  
- Governance Workspace Implementation Spec wizard position (Step 4 Data Processing) **conflicts** with Wizard v5.2 (Route Processing after Destinations) — resolve in implementation spec update

---

## 10. Union Schema Impact

### Keep

- `buildUnionSchema`, `UnionSchemaTree`, occurrence display, sample values  
- Stream-level shared schema across routes (SoT Route Architecture Extension)

### Fix / add

| Item | Action |
|------|--------|
| 10–20 event collection | Enforce or warn in Sample step |
| Rare threshold | Change to `< 30%` of total events |
| Sensitive suggestions | Integrate detection engine suggestions at schema build |
| Field detail panel | Add right panel per spec |
| Generated Fields group | Visual grouping for Add Field outputs |
| Formal sample→route contract | Document in API + wizard state |

### Unchanged at runtime

SoT AC #10: "기존 Mapping Runtime 변경 없음" at engine level — scope change is **config source**, not mapper algorithm

---

## 11. Reusable Components

See **Q7** above. Estimated **60–70% runtime reuse**, **40–50% wizard UI reuse** (much layout repurposable, flow restructure required).

---

## 12. Migration Strategy

### Principles

1. **Additive DB** — no truncate of user streams/routes/mappings  
2. **Feature flag** — `GDC_ROUTE_PROCESSING_ENABLED`  
3. **Dual-read** — route config if present, else stream fallback  
4. **Dual-write transition** — stream APIs mirror to all routes

### Data backfill

For each stream with routes R1..Rn: copy stream mapping/enrichment/rules to each route identically.

### Auto-conversion limits

| Scenario | Auto? |
|----------|-------|
| 1 stream, N routes, same transform | **Yes** — duplicate to each route |
| 1 stream, 1 route | **Yes** — move |
| Duplicate streams for different transforms (same source) | **No** — operator merge UI |

---

## 13. Backward Compatibility Strategy

| Layer | Strategy |
|-------|----------|
| API | Stream endpoints remain; write-through to routes during transition |
| Runtime | Dual-read in `stream_loader` |
| UI | Legacy URLs redirect with banner; `/streams/:id/mapping` → route-aware view |
| Tests | e2e passes with flag off; new matrix with flag on |
| Backup import | Accept both shapes in `import_validator` |

---

## 14. Recommended Implementation Order

Aligned with **WBS Next Priority** and Product Charter guardrails:

| Phase | Deliverable | Depends on |
|-------|-------------|------------|
| **P0** | `specs/091-route-processing-architecture/spec.md`; update constitution refs | SoT (done) |
| **P1** | DB additive schema + dual-read repos | P0 |
| **P2** | `stream_loader` + `StreamRunner` per-route loop (flag off default) | P1 |
| **P3** | Route runtime APIs (mapping, enrichment, protection, classification, policy) | P2 |
| **P4** | Backfill tool + dry-run report | P1 |
| **P5** | Preview / pipeline-debug route parity | P3 |
| **P6** | Union Schema hardening (10–20, 30% rare, detail panel) | Independent |
| **P7** | Wizard: Destinations → Route Processing reorder | P3, P6 |
| **P8** | Route edit page processing tabs | P3 |
| **P9** | Governance route overrides + route-aware dashboard | P3 |
| **P10** | Deprecate stream-scoped writes; docs | P7–P9 |
| **P11** | E2E + performance benchmarks | P10 |

**Do not start:** Enterprise IAM (M25), parallel runtime engines, or new governance feature categories (Guardrail freeze).

---

## Appendix A — SoT vs Code Quick Reference

| SoT statement | Code reality |
|---------------|--------------|
| Processing Unit = Route | Processing Unit = Stream |
| Destination First wizard | Transform First wizard |
| Route unit Transform/Protection/Policy | Stream unit |
| Governance Route Aware dashboard | Stream only |
| Union Schema 10–20 events | Best-effort multi-event |
| Runtime Reuse First | Compatible — re-orchestrate, don't rewrite |
| No Parallel Pipeline | Compatible — single StreamRunner |
| WBS M13.2 Per Route Transform | Not implemented |
| OSS v1 Stabilization current goal | Matches repo GA v1.0.2 state |

---

## Appendix B — Key File Index

### Backend

| Area | Path |
|------|------|
| Stream / Route models | `app/streams/models.py`, `app/routes/models.py` |
| Mapping / Enrichment | `app/mappings/models.py`, `app/enrichments/models.py` |
| Governance rules | `app/protection/models.py`, `app/classification/models.py` |
| StreamRunner | `app/runners/stream_runner.py` |
| Stream loader | `app/runners/stream_loader.py` |
| Runtime API | `app/runtime/router.py` |

### Frontend

| Area | Path |
|------|------|
| Wizard state | `frontend/src/components/streams/wizard/wizard-state.ts` |
| Transform step | `frontend/src/components/streams/wizard/step-mapping-combined.tsx` |
| Destinations step | `frontend/src/components/streams/wizard/step-delivery.tsx` |
| Union Schema | `frontend/src/utils/unionSchema.ts`, `union-schema-tree.tsx` |
| Governance shell | `frontend/src/components/governance/governance-shell.tsx` |
| Route edit | `frontend/src/components/routes/route-edit-page.tsx` |

### Source of Truth

| Document | Path |
|----------|------|
| Product Charter | `docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt` |
| Master WBS | `docs/source-of-truth/MASTER-WBS-Version-1.2.1-FINAL.txt` |
| UX Charter | `docs/source-of-truth/DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt` |
| Wizard Charter | `docs/source-of-truth/DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt` |
| Union Schema | `docs/source-of-truth/DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt` |
| Index | `docs/architecture/source-of-truth-index.md` |

---

## Appendix C — Risk Register

| Risk | Mitigation |
|------|------------|
| WBS "100% complete" vs M13 route work | Treat M13.1–M13.6 as explicit post-GA phase; track separately |
| Wizard spec internal version mismatch (v3.0 text in v5.2 file) | Follow step **order** and Route Processing semantics from SoT |
| Performance (N × transform) | Benchmark; shared extract; lazy route evaluation |
| Governance spec wizard position conflict | Adopt Wizard v5.2 order; update governance workspace spec in P0 |
| User stream duplication workaround | Migration merge UI for duplicate streams same source |

---

*End of investigation. No code, DB, API, runtime, or frontend changes were made.*
