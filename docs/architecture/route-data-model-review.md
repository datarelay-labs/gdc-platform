# Route Data Model Review

**Status:** SUPERSEDED (historical architecture review)  
**Superseded By:** [`specs/091–096`](../../specs/091-route-processing-architecture/spec.md), Runtime models

Architecture review only — no code, implementation, or migrations  
**Date:** 2026-06-15  
**Scope:** Current Route DB model (M13.1–M13.3) vs M13.4 (Classification), M13.5 (Policy), M13.6 (Delivery)  
**Inputs:**

| Source | Role |
|--------|------|
| `app/routes/models.py`, `app/route_transform/models.py`, `app/route_protection/models.py` | Implemented Route models |
| `app/classification/models.py`, `app/protection/models.py` | Stream-side rule models (dual-read targets) |
| `alembic/versions/20260614_0054_route_transform_tables.py` | M13.2 migration |
| `alembic/versions/20260615_0055_route_protection_rules.py` | M13.3 migration |
| `specs/091-route-processing-architecture/spec.md` Appendix A | Planned Route configuration artifacts |
| `specs/092-per-route-transform/spec.md`, `specs/093-per-route-protection/spec.md` | M13.2/M13.3 contracts |
| `docs/architecture/m13-route-architecture-design-review.md` | Prior lifecycle/context review |
| `docs/architecture/m13-3-protection-design-review.md` | Prior M13.3 → M13.4–M13.6 compatibility review |

---

## 1. Current Route Data Model

### 1.1 Core `routes` table (pre-M13 processing config)

Delivery configuration has always lived on `routes`:

| Column | Purpose |
|--------|---------|
| `stream_id`, `destination_id` | Topology link (UNIQUE pair per stream) |
| `enabled`, `status`, `disable_reason` | Route lifecycle |
| `failure_policy` | Delivery failure handling |
| `formatter_config_json` | Wire format / message prefix |
| `rate_limit_json` | Destination send rate limit |

Relationships added by M13.2:

- `route_mapping` → `route_mappings` (1:1)
- `route_enrichment` → `route_enrichments` (1:1)

No `processing_metadata_json` column exists yet (spec 091 lists it as optional future).

### 1.2 M13.2 — Transform tables (`20260614_0054`)

**Pattern: 1:1 bundle per route (full-bundle dual-read fallback)**

| Table | Key | Columns (summary) | Stream fallback |
|-------|-----|-------------------|-----------------|
| `route_mappings` | UNIQUE `route_id` | `field_mappings_json`, `raw_payload_mode`, timestamps | `mappings` (UNIQUE `stream_id`) |
| `route_enrichments` | UNIQUE `route_id` | `enrichment_json`, `override_policy`, `enabled`, timestamps | `enrichments` (UNIQUE `stream_id`) |

Characteristics:

- One row per route when operator diverges from stream defaults.
- Dual-read: entire bundle from route row, else stream row (spec 092).
- FK to `routes.id` **without** `ON DELETE CASCADE`.
- Config stored as generic `JSON` (not `JSONB`).

### 1.3 M13.3 — Protection table (`20260615_0055`)

**Pattern: 1:N field-path rules per route (mirrors stream protection)**

| Table | Key | Columns (summary) | Stream fallback |
|-------|-----|-------------------|-----------------|
| `route_protection_rules` | UNIQUE `(route_id, field_path)` | `field_path`, `sensitivity_class`, `protection_mode`, `enabled`, `source_finding_id`, `created_by`, timestamps | `stream_protection_rules` (UNIQUE `(stream_id, field_path)`) |

Characteristics:

- Structurally **isomorphic** to `stream_protection_rules` with `route_id` replacing `stream_id`.
- FK to `routes.id` **with** `ON DELETE CASCADE`.
- Optional full route rule set; absence triggers stream fallback.
- Governance **override merge** (`route_overrides[]`) is a **runtime/API layer** on top — **not yet persisted** in a dedicated table (see §4).

### 1.4 Stream-side counterparts (dual-read targets)

| Concern | Stream table | Cardinality | Rule shape |
|---------|--------------|-------------|------------|
| Transform (mapping) | `mappings` | 1:1 stream | JSON bundle |
| Transform (enrichment) | `enrichments` | 1:1 stream | JSON bundle |
| Protection | `stream_protection_rules` | 1:N field paths | Field-path keyed |
| Classification | `stream_classification_rules` | 1:N named rules | `name`, `condition_json`, `classification_level` |
| Policy | `stream_policy_rules` | 1:N named rules | `name`, `condition_json`, `action_type` |

### 1.5 Delivery / observability tables (existing, route-keyed)

| Table | Role for M13.6 |
|-------|----------------|
| `routes` | Authoritative delivery config (formatter, failure, rate limit) |
| `runtime_route_snapshot` | Per-route health, EPS, latency read model |
| `runtime_analytics_bucket_1m` / `_5m` | Time-bucketed route metrics |
| `delivery_logs` | `route_id` in log context (partial) |

M13.6 is primarily **observability extension** on an already route-scoped delivery surface, not a new configuration concern table.

### 1.6 Planned but not migrated (spec 091 Appendix A)

| Artifact | Milestone | Status |
|----------|-----------|--------|
| `route_classification_rules` | M13.4 | **Not created** |
| `route_policy_rules` | M13.5 | **Not created** |
| `route_governance_overrides` | M13.3+ | **Not created** |
| `routes.processing_metadata_json` | M13.1+ | **Not created** |
| Nullable `route_id` on quarantine | M13.5+ | **Not on `stream_quarantine_events`** |

---

## 2. Consistency Review

### 2.1 Two established Route configuration sub-patterns

The codebase uses **two** additive patterns, not one:

```text
Pattern A — 1:1 config bundle (Transform)
  route_mappings / route_enrichments
  UNIQUE(route_id)
  Full-bundle dual-read: route row ?? stream row

Pattern B — 1:N rule set (Protection, and by extension Classification/Policy)
  route_protection_rules  ↔  stream_protection_rules
  route_classification_rules (planned)  ↔  stream_classification_rules
  route_policy_rules (planned)  ↔  stream_policy_rules
  List dual-read: route rules if any, else stream rules
  (+ concern-specific override merge for governance)
```

Protection is **field-path keyed**. Classification and Policy are **named conditional rules** — they align with Pattern B at the *additive `route_*` + dual-read* level, but **not** with Protection's `(route_id, field_path)` uniqueness. M13.4/M13.5 should mirror `stream_classification_rules` / `stream_policy_rules`, not `route_protection_rules`.

### 2.2 Cross-table inconsistencies (technical debt)

| Item | `route_mappings` / `route_enrichments` | `route_protection_rules` | Risk |
|------|----------------------------------------|--------------------------|------|
| `ON DELETE CASCADE` | Absent | Present | Orphan / FK errors on route delete |
| JSON type | `JSON` | N/A (scalar columns) | Stream rules use `JSONB` for `condition_json` |
| Index strategy | `ix_*_route_id` UNIQUE | `(route_id, field_path)` UNIQUE + non-unique `route_id` index | Acceptable; different access patterns |
| `created_by` | Absent | Present | Minor audit gap on transform rows |
| Governance overrides | N/A | Expected via `route_overrides[]` | Overrides not in DB yet |

These are **reconciliation items**, not blockers for additive M13.4 tables.

### 2.3 Runtime context alignment

`RouteEffectiveConfig` (`app/runners/route_context.py`) reserves slots:

| Slot | Typed? | DB backing today |
|------|--------|------------------|
| `transform` | ✅ `RouteTransformConfig` | `route_mappings` + `route_enrichments` |
| `protection` | ✅ `RouteProtectionConfig` | `route_protection_rules` + stream fallback + overrides (runtime) |
| `classification` | ❌ `Any \| None` placeholder | None |
| `policy` | ❌ `Any \| None` placeholder | None |

Pipeline slot order in `process_route_pipeline()` is already **Transform → Protection → classification_stub → policy_stub → delivery_handoff** — consistent with target Product Charter order.

### 2.4 Verification — requested table pattern questions

#### Q1. Can Classification be added using the same pattern?

**Yes — additive `route_classification_rules` with stream dual-read.**

Recommended shape (mirror `stream_classification_rules`):

```text
route_classification_rules
  id, route_id FK → routes.id ON DELETE CASCADE
  name, enabled, condition_json (JSONB), classification_level
  created_at, updated_at
  index: (route_id, enabled)
```

Dual-read: if route has ≥1 enabled rule row, use route set; else `stream_classification_rules`.

Optional governance extension: `classification_level` on unified `route_governance_overrides` / `route_overrides[]` entry (per m13-3-protection-design-review §3.3).

**Not** the 1:1 bundle pattern of `route_mappings`. **Same architectural pattern** as spec 091 Appendix A and Protection's additive `route_*` table approach.

#### Q2. Can Policy be added using the same pattern?

**Yes — additive `route_policy_rules` mirroring `stream_policy_rules`.**

```text
route_policy_rules
  id, route_id FK → routes.id ON DELETE CASCADE
  name, enabled, condition_json (JSONB), action_type
  created_at, updated_at
  index: (route_id, enabled)
```

Dual-read identical to Classification. `delivery_behavior` enforcement is runtime (M13.5); may reuse override fields planned for governance (`route_overrides[].delivery_behavior`).

Policy also consumes **stream-scoped** `schema_drift_policy_result` on `SharedBatchContext` — no new drift table per route required for MVP.

#### Q3. Can Delivery configuration be added using the same pattern?

**Partially — delivery config does not need a new `route_*` rules table.**

| Delivery aspect | Where it lives | M13.6 action |
|-----------------|----------------|--------------|
| Formatter, failure policy, rate limit | `routes` columns (existing) | Extend observability, not schema redesign |
| Health / EPS / latency | `runtime_route_snapshot` | Wire pipeline-stage metrics into snapshot updater |
| Time-series analytics | `runtime_analytics_bucket_*` | Optional new stage-duration columns or metadata JSON |
| Processing readiness hash | `routes.processing_metadata_json` (planned) | Optional additive column |

M13.6 follows a **extend existing route + snapshot tables** pattern, not Pattern A or B.

#### Q4. Would a generic Route Configuration model have been better?

**No — for this codebase, separate `route_*` tables remain the better fit.**

| Approach | Pros | Cons |
|----------|------|------|
| **Current: per-conern `route_*` tables** | Matches stream tables; typed columns; clear migrations; independent milestone delivery; engine code reuse | Multiple tables; slight FK/JSON inconsistency to reconcile |
| **Generic `route_configurations(route_id, concern, config_json)`** | Single loader abstraction | Loses column-level constraints; harder queries; conflicts with existing `mappings`/`stream_*_rules` shapes; rewrite of M13.2/M13.3 |

Spec 091 Appendix A explicitly **prefers additive `route_*` tables** over altering stream UNIQUE constraints or introducing EAV. M13.2 and M13.3 investments reinforce that decision.

A shared **`resolve_effective_config(route_id, concern)`** helper (runtime, not DB) is the right unification layer — not a single configuration table.

---

## 3. Future Milestone Compatibility

### 3.1 M13.4 Classification

| Aspect | Compatible without redesign? | Notes |
|--------|------------------------------|-------|
| New `route_classification_rules` table | ✅ | Additive migration |
| Dual-read fallback | ✅ | Same list-replacement semantics as stream |
| Engine reuse (`app/classification/engine.py`) | ✅ with refactor | `evaluate_batch()` today hardcodes `StreamClassificationRule` + `stream_id` query — resolver must accept route rule list |
| Governance overrides | ⚠️ | Extend `route_overrides[]` with optional `classification_level`; table TBD |
| Stage input | ✅ | Post-protection route events (stub slot exists) |
| Stage order vs legacy OSS | ⚠️ Runtime, not DB | Flag OFF: Classification before Protection; flag ON route path: Protection before Classification — M13.4 spec must document |

**DB verdict:** No table redesign. One additive migration + typed `RouteClassificationConfig` in `effective_config`.

### 3.2 M13.5 Policy

| Aspect | Compatible without redesign? | Notes |
|--------|------------------------------|-------|
| New `route_policy_rules` table | ✅ | Mirror `stream_policy_rules` |
| Dual-read fallback | ✅ | |
| Quarantine / review | ⚠️ | `stream_quarantine_events` is `stream_id` only — **nullable `route_id`** additive migration likely needed |
| Unknown-field / drift override | ⚠️ | Consumes `SharedBatchContext.schema_drift_policy_result`; route-aware evaluation is runtime |
| `delivery_behavior` on overrides | ⚠️ | Persisted in governance config (M13.3 scope); enforced in M13.5 |

**DB verdict:** No redesign of M13.2/M13.3 tables. Additive `route_policy_rules` + likely `route_id` on quarantine + governance override persistence.

### 3.3 M13.6 Delivery

| Aspect | Compatible without redesign? | Notes |
|--------|------------------------------|-------|
| Delivery config | ✅ | Already on `routes` |
| Per-route metrics | ✅ | `runtime_route_snapshot`, analytics buckets exist |
| Pipeline stage timeline | ✅ | `RouteStageResult.stage_timeline` — extend with classification/policy/delivery timings |
| `processing_metadata_json` | Optional | Readiness hash / config version for deploy gate |

**DB verdict:** Observability extensions only; no new route configuration taxonomy.

### 3.4 Compatibility matrix (summary)

| Milestone | New tables likely | Redesign existing Route tables? | Blocker from current model? |
|-----------|-------------------|---------------------------------|-----------------------------|
| M13.4 Classification | `route_classification_rules` | No | No |
| M13.5 Policy | `route_policy_rules`; optional quarantine `route_id`; governance overrides | No | No |
| M13.6 Delivery | Optional `processing_metadata_json`; optional snapshot column extensions | No | No |

---

## 4. Database Risks

### 4.1 Debt to address before M13.4 begins

| # | Debt | Severity | Recommendation |
|---|------|----------|----------------|
| **D1** | `route_governance_overrides` / `route_overrides[]` not persisted | **High** | Land in M13.3 (or immediately before M13.4); Classification overrides depend on same extension pattern |
| **D2** | `effective_config.classification` untyped | **Medium** | Define `RouteClassificationConfig` + resolver in M13.4 design |
| **D3** | Classification engine coupled to `stream_id` DB query | **Medium** | Inject resolved rule list; do not query stream table when route rules exist |
| **D4** | FK `ON DELETE` inconsistency across route tables | **Low** | Align `route_mappings`/`route_enrichments` to `ON DELETE CASCADE` in dedicated migration (non-blocking) |
| **D5** | `JSON` vs `JSONB` for new rule `condition_json` | **Low** | Use `JSONB` on new tables to match stream side |
| **D6** | `stream_quarantine_events` lacks `route_id` | **Medium** (M13.5) | Plan nullable `route_id` before M13.5; not blocking M13.4 table creation |
| **D7** | `processing_metadata_json` absent on `routes` | **Low** | Optional before M13.6 deploy readiness |
| **D8** | `schema_drift_policy_result` on shared batch when flag ON | **High** (runtime) | Shared-phase drift policy must run for Auto Protect and M13.5 signals — not a Route table issue but blocks correct downstream behavior |

### 4.2 Risks if patterns are misapplied

| Risk | Description | Mitigation |
|------|-------------|------------|
| Wrong uniqueness for Classification | Using `(route_id, field_path)` like Protection | Mirror stream classification: named rules, no field_path key |
| 1:1 bundle for Policy | Storing policy as JSON on `routes` | Use `route_policy_rules` list table |
| Skipping dual-read | Route table always required | Empty route rule set → stream fallback (parity with M13.2/M13.3) |
| Override-only Classification | Only `route_overrides[]` without base table | Support both full route rule set and stream default + override |

### 4.3 Will M13.4–M13.6 require table redesign?

**No.**

Existing tables remain valid. Future work is:

- **Additive** `route_classification_rules`, `route_policy_rules`
- **Additive** governance override storage
- **Additive** optional columns (`route_id` on quarantine, `processing_metadata_json` on routes)
- **Optional** FK/CASCADE alignment migration for M13.2 tables

No ALTER of `mappings`/`enrichments` UNIQUE constraints. No merge of `route_mappings` + `route_enrichments` into a single table. No migration of delivery config off `routes`.

---

## 5. Recommended Adjustments

### 5.1 Before M13.4 spec / implementation

| # | Adjustment | Owner |
|---|------------|-------|
| **R1** | Publish M13.4 spec with `route_classification_rules` DDL mirroring `stream_classification_rules` (route_id FK, JSONB `condition_json`) | Spec |
| **R2** | Document dual-read: route rules if present, else stream rules; optional override merge via extended `route_overrides[]` | Spec |
| **R3** | Resolve governance override persistence (D1) — normalized `route_governance_overrides` or `streams.governance_config_json` — before Classification overrides | M13.3/M13.4 boundary |
| **R4** | Add `RouteClassificationConfig` type; replace `classification: Any` placeholder | M13.4 design |
| **R5** | Document classification input = **post-protection** route events; regression matrix flag OFF vs ON | M13.4 spec |

### 5.2 Before M13.5

| # | Adjustment |
|---|------------|
| **R6** | `route_policy_rules` mirroring `stream_policy_rules` |
| **R7** | Nullable `route_id` on `stream_quarantine_events` (or successor quarantine table) |
| **R8** | `RoutePolicyConfig` + policy resolver consuming `schema_drift_policy_result` |

### 5.3 Before M13.6

| # | Adjustment |
|---|------------|
| **R9** | Extend `RouteProcessingMetrics` / `runtime_route_snapshot` with per-stage durations from `stage_timeline` |
| **R10** | Optional `routes.processing_metadata_json` for deploy readiness |

### 5.4 Housekeeping (non-blocking, any milestone)

| # | Adjustment |
|---|------------|
| **R11** | Align `route_mappings` / `route_enrichments` FK to `ON DELETE CASCADE` |
| **R12** | Unified `resolve_effective_config(route_id, concern)` wrapping transform / protection / classification / policy resolvers |

---

## 6. Go / No-Go

### 6.1 Current Route data model for M13.4–M13.6

| Decision | **GO** |
|----------|--------|
| Rationale | M13.2 (1:1 bundle) and M13.3 (1:N field rules) establish the intended **additive `route_*` + dual-read** strategy. Classification and Policy fit the **rule-list** variant of that strategy without altering existing tables. Delivery config and observability are already route-scoped. |
| Caveat | Two sub-patterns (bundle vs rule list) are intentional; do not force Classification/Policy into `route_mappings`-style 1:1 JSON bundles. |

### 6.2 M13.4 Classification start

| Decision | **Conditional GO** |
|----------|---------------------|
| Proceed if | R1–R5 accepted; governance override persistence path chosen (R3) |
| Block if | Attempting to store classification only in `routes` JSON or only via overrides without stream fallback contract |

### 6.3 M13.5 Policy start

| Decision | **GO** (after M13.4 or in parallel spec work) |
|----------|-----------------------------------------------|
| Block if | Quarantine remains stream-only when route-scoped quarantine is required |

### 6.4 M13.6 Delivery start

| Decision | **GO** |
|----------|--------|
| Rationale | No new configuration taxonomy; extend metrics on existing `routes` + snapshot tables |

### 6.5 Generic configuration model pivot

| Decision | **NO-GO** |
|----------|-----------|
| Rationale | Would invalidate M13.2/M13.3 migrations and stream-table symmetry without meaningful gain |

---

## Appendix A — Schema reference (implemented)

### `route_mappings`

```text
id PK, route_id FK UNIQUE → routes.id
field_mappings_json JSON NOT NULL
raw_payload_mode VARCHAR(64) NULL
created_at, updated_at TIMESTAMPTZ
```

### `route_enrichments`

```text
id PK, route_id FK UNIQUE → routes.id
enrichment_json JSON NOT NULL
override_policy VARCHAR(64) NOT NULL
enabled BOOLEAN NOT NULL
created_at, updated_at TIMESTAMPTZ
```

### `route_protection_rules`

```text
id PK, route_id FK → routes.id ON DELETE CASCADE
field_path TEXT NOT NULL
sensitivity_class VARCHAR(32) NOT NULL
protection_mode VARCHAR(16) NOT NULL
enabled BOOLEAN NOT NULL
source_finding_id FK NULL → stream_sensitive_findings.id ON DELETE SET NULL
created_by VARCHAR(128) NOT NULL
created_at, updated_at TIMESTAMPTZ
UNIQUE (route_id, field_path)
```

## Appendix B — Proposed artifacts (not implemented; design reference only)

### `route_classification_rules` (M13.4)

```text
id PK, route_id FK → routes.id ON DELETE CASCADE
name VARCHAR(128) NOT NULL
enabled BOOLEAN NOT NULL DEFAULT true
condition_json JSONB NOT NULL
classification_level VARCHAR(32) NOT NULL
created_at, updated_at TIMESTAMPTZ
INDEX (route_id, enabled)
```

### `route_policy_rules` (M13.5)

```text
id PK, route_id FK → routes.id ON DELETE CASCADE
name VARCHAR(128) NOT NULL
enabled BOOLEAN NOT NULL DEFAULT true
condition_json JSONB NOT NULL
action_type VARCHAR(32) NOT NULL
created_at, updated_at TIMESTAMPTZ
INDEX (route_id, enabled)
```

---

## Appendix C — Verification checklist

| # | Question | Answer |
|---|----------|--------|
| 1 | Can Classification use the same pattern as current Route tables? | **Yes** — additive `route_classification_rules` + dual-read (rule-list variant of Pattern B) |
| 2 | Can Policy use the same pattern? | **Yes** — additive `route_policy_rules` + dual-read |
| 3 | Can Delivery use the same pattern? | **Different pattern** — config on `routes`; M13.6 extends observability, not new rules tables |
| 4 | Would generic Route Configuration be better? | **No** — per-concern tables match stream model and shipped M13.2/M13.3 |
| 5 | Will M13.4–M13.6 require table redesign? | **No** — additive migrations and optional columns only |
| 6 | Database debt before M13.4? | **D1–D8** in §4.1; highest: governance override persistence, shared-phase drift result (runtime) |

---

*End of route data model review. No code, implementation, migrations, or redesign performed.*
