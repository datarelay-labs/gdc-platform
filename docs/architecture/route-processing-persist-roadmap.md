# Route Processing Persist Roadmap (v1.x Backlog)

**Status:** Design record — persist kinds updated 2026-08-13 (P1-3 SoT alignment); flag default ON noted 2026-08-15 (P1-4)
**Date:** 2026-06-20 (original); current persist kinds reflect wizard-deploy-projection.ts
**Branch context:** historical `feature/sensitive-detection-m5-clean`; verify against current Runtime + wizard persist
**Authority:** PRODUCT-CHARTER + [`source-of-truth-index.md`](source-of-truth-index.md)
**Related:**

- `docs/ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md` (§24 Deploy Projection, §25 Effective Status Alignment)
- `docs/architecture/m13-route-processing-ui-deferral.md` (OSS v1 deferral baseline)
- `docs/architecture/route-architecture-gap-analysis.md`
- Specs 091–096 (route processing architecture)

**Purpose:** Officially define **Route Processing Full Persist MVP** as v1.x backlog. This document records design intent only. **OSS v1 deploy behavior is unchanged.**

---

## 1. Current State

### 1.1 Shared Processing Persist (OSS v1 — complete)

At wizard deploy, stream-scoped processing is persisted before routes are created:

| Concern | Wizard surface | Persist target | Deploy hook |
|---------|----------------|----------------|-------------|
| Transform | Route Processing → Shared Processing | `StreamMapping`, `StreamEnrichment` | `POST /runtime/streams/{id}/mapping-ui/save` |
| Protection | Data Protection intents | `StreamProtectionRule` | `persistWizardDataProtectionIntents()` |
| Classification | Data Protection intents (derived) | `StreamClassificationRule` | same |
| Policy | Data Protection intents (derived) | `StreamPolicyRule` | same |
| Schema drift | Data Protection policies | `stream.config_json.governance.schema_drift_policy` | `persistWizardSchemaDriftPolicy()` |

Code: `frontend/src/components/streams/new-stream-wizard-page.tsx` (create flow).

### 1.2 Governance Route Override Persist (OSS v1 — complete)

After `POST /routes/` returns route IDs, governance document is persisted:

| Override type | Wizard source | Persist target | Runtime merge |
|---------------|---------------|----------------|-----------------|
| Field protection action | `dataProtection.routeOverrides[]` | `stream.config_json.governance.route_overrides[].protection_action` | `resolve_route_protection_config()` |
| Classification floor | `dataProtection.routeClassificationOverrides[]` | `route_overrides[].classification_level` | `resolve_route_classification_config()` |
| Delivery behavior (field) | `routeOverrides[].deliveryBehavior` | `route_overrides[].delivery_behavior` | `resolve_route_policy_config()` |
| Stream default rules | `dataProtection.intents[]` | `governance.rules[]` | stream-scoped engines |

Code: `wizard-governance-persist.ts` → `putStreamGovernance()`.

Post-deploy Effective API `processing_status` reflects governance overrides (P2.1, `app/runtime/route_processing_status.py`).

### 1.3 Delivery Persist (OSS v1 — complete)

Route delivery metadata persists at route creation:

- `enabled`, `failure_policy`, `formatter_config_json`, `rate_limit_json` via `POST /routes/`
- Code: `buildRouteCreatePayloads()` in `wizard-state.ts`

### 1.4 Deploy Intent Model (OSS v1 — by design)

Wizard Route Processing collects per-route **intent** that may not persist. Deploy Summary projects status via pure function (no runtime resolver):

```text
projectRouteProcessingStatusFromDeployIntent(draft, dataProtection)
  → processing_status: Inherited | Overridden | Mixed
  → persistKind: none | intent_only | governance | route_transform | route_protection
```

| `persistKind` | Operator label | Meaning |
|---------------|----------------|---------|
| `none` | — | Shared Processing only |
| `intent_only` | Intent only | Incomplete override; **not saved** at deploy for that concern |
| `governance` | Persisted through governance rules | Field-level / policy overrides in `governance.route_overrides` |
| `route_transform` | Persisted through route transform | Route mapping/enrichment saved at deploy |
| `route_protection` | Persisted through route protection | Route protection intents saved at deploy |

Code: `wizard-deploy-projection.ts`. UX spec: §24.

**Current posture:** Complete Transform and Protection overrides persist at deploy. Remaining `intent_only` cases are incomplete classification/protection payloads. Deploy Intent still is not post-deploy Effective API truth for `intent_only` concerns.

---

## 2. Remaining Gaps

Complete Transform / Protection / Policy overrides persist at wizard deploy. Remaining `intent_only` cases:

| Gap | Wizard trigger | Current `persistKind` | Notes |
|-----|----------------|----------------------|-------|
| **Classification without floor** | `inherit.classification = false` without floor override row | `intent_only` | No `RouteClassificationRule` row from wizard alone |
| **Incomplete protection** | Protection override without ready non-audit intents | `intent_only` | Complete intents → `route_protection` |
| **Incomplete concern payload** | Override flag without editor content | `intent_only` | Operator must complete payload or save post-deploy |

**Already persisted (not gaps):** Transform bundle (`route_transform`), protection bundle with ready intents (`route_protection`), policy / field-level governance (`governance`), shared stream processing, route delivery metadata.

**Workaround for remaining intent_only:** Stream / Route Edit APIs after deploy.

---

## 3. v1.x MVP Scope

**Milestone name:** Route Processing Full Persist MVP (v1.1)

**Goal:** When an operator sets `inherit.<concern> = false` in Wizard Route Processing and deploys, the corresponding route-scoped bundle is persisted and post-deploy Effective API reflects **Overridden** (or **Mixed** where applicable).

**Status note (2026-08-15):** Complete Transform, Protection (ready non-audit intents), and Policy/governance overrides already persist at wizard deploy. Remaining work is the `intent_only` cases in §2 (classification without floor; incomplete protection payload). Do not treat the original P0/P1 lists below as an unstarted backlog. Flag default ON is already shipped (P1-4); Failover/Replay on the route path are already shipped.

### In scope (P0 — v1.1)

1. **Transform bundle persist** — After route IDs exist, for each route with `inherit.transform === false`, call route mapping/enrichment save APIs with draft override content.
2. **Policy bundle persist** — Persist route-level delivery behavior from `draft.overrides.policy` to `RoutePolicyRule` and/or governance `delivery_behavior` (design choice: prefer `RoutePolicyRule` for bundle parity with Route Edit).
3. **Deploy projection update** — New or extended `persistKind` (e.g. `route_bundle`) for concerns that will persist; remove `(Intent only)` for successfully persisted bundles.
4. **Deploy readiness** — Warn or block when persist fails per route (TBD: Warning vs Error policy in implementation spec).
5. **Tests** — Unit tests for persist orchestration; integration tests for wizard deploy → Effective API alignment (Transform, Policy first).

### In scope (P1 — v1.1–v1.2)

6. **Protection bundle persist** — Route-scoped intents → `RouteProtectionRule` rows (distinct from governance field overrides).
7. **Classification bundle persist** — Route-scoped classification → `RouteClassificationRule` or documented floor-only governance path (avoid duplicate semantics with existing floor persist).
8. **Mixed-state clarity** — Deploy Summary and Route Edit show consistent status when stream + route bundle + governance override combine.

### Explicitly deferred past MVP (v1.2+)

- Flag removal (`GDC_ROUTE_PROCESSING_ENABLED` remains as rollback)
- Wizard step order changes beyond persist wiring
- New governance schema versions

---

## 4. API Impact

**No new endpoints required for MVP.** Existing route-scoped APIs are sufficient:

| Concern | Existing API (frontend client) | Persist payload source |
|---------|-------------------------------|------------------------|
| Transform | `saveRouteMappingUiConfig`, `saveRouteEnrichmentUiConfig` | `draft.overrides.transform` |
| Protection | `createRouteProtectionRule` (bulk if added) | `draft.overrides.protection.intents` |
| Classification | `createRouteClassificationRule` | route classification draft / floor |
| Policy | `createRoutePolicyRule` | `draft.overrides.policy.deliveryBehavior` |

**Optional additive changes (implementation phase only):**

- Bulk route-bundle save helper endpoint (convenience, not required for MVP)
- Effective API: no schema change expected; status should naturally become `Overridden` once rows exist

**Governance API:** `putStreamGovernance` unchanged for field-level overrides; bundle persist must not break existing `route_overrides` merge order.

**OSS v1:** No API contract changes until v1.x MVP ships.

---

## 5. Runtime Impact

| Layer | Impact |
|-------|--------|
| **Resolvers** | No resolver logic change required — dual-read already supports route rows |
| **Legacy path (flag OFF)** | Persisted route rows exist in DB but legacy fan-out may ignore route transform bundles; governance overrides already apply on legacy path |
| **Route pipeline (flag ON)** | Full benefit — `process_route_pipeline()` consumes persisted route bundles |
| **Effective API** | Already aligned for governance (P2.1); bundle persist closes remaining `intent_only` → `Inherited` gap |

**Important:** Persist MVP does **not** depend on the route-processing flag. Persisted config is durable and visible in Route Edit / Effective API on both the default route path and the legacy rollback path.

**Current runtime default (P1-4):** `GDC_ROUTE_PROCESSING_ENABLED=true`. Flag OFF remains rollback only.

---

## 6. Migration Impact

| Item | Assessment |
|------|------------|
| **Database migration** | **None required** — M13 tables exist (`route_mappings`, `route_enrichments`, `route_protection_rules`, `route_classification_rules`, `route_policy_rules`, alembic 0054–0057) |
| **Existing streams** | Unaffected — additive wizard deploy path only |
| **Existing governance documents** | Unaffected — bundle persist is orthogonal to `route_overrides` |
| **Wizard draft format** | May add persist metadata in outcome; backward-compatible draft migration preferred |

---

## 7. Feature Flag Strategy

| Flag | Current default | MVP behavior | Graduation (post-MVP) |
|------|-----------------|--------------|------------------------|
| `GDC_ROUTE_PROCESSING_ENABLED` | `True` (`app/config.py`, P1-4) | Persist MVP did not flip default; P1-4 graduated default ON | Flag OFF remains rollback; removal is a later candidate |

**Principles:**

1. **Persist remains independent of the flag** — Operators can configure and store route bundles on either runtime path.
2. **No silent behavior change on deploy** — Switching the flag in an environment is an explicit ops decision.
3. **Legacy path parity** — Governance overrides already work on flag OFF; document which bundle types require flag ON for full runtime effect (especially Transform).

---

## 8. E2E Verification Plan

### 8.1 Unit / integration (CI)

| Test | Assertion |
|------|-----------|
| Transform bundle deploy | `inherit.transform=false` → route mapping/enrichment rows created |
| Policy bundle deploy | `inherit.policy=false` → `RoutePolicyRule` or equivalent persisted |
| Protection bundle deploy (P1) | `inherit.protection=false` → `RouteProtectionRule` rows |
| Classification bundle deploy (P1) | floor/bundle → persisted + Effective API status |
| Governance regression | field `route_overrides` still persist when bundle persist added |
| Deploy projection | `persistKind !== intent_only` for persisted bundles |

Existing tests to preserve: `test_route_*_effective.py`, `wizard-governance-persist.test.ts`, `wizard-deploy-projection.test.ts`.

### 8.2 E2E smoke (post-implementation)

1. Wizard: 2 routes, route A transform override, route B shared → deploy → Effective API route A `Overridden`, route B `Inherited`.
2. Wizard: policy override on one route → deploy → policy effective `Overridden`; delivery gate matches behavior.
3. Wizard: governance field override + shared inherit → still `Mixed` / governance path (P2.1 regression).
4. Flag OFF: verify legacy delivery still succeeds; persisted rows visible in Route Edit.
5. Flag ON (test env): verify `process_route_pipeline` applies route transform bundle end-to-end.

Run via `./scripts/testing/run-smoke-tests.sh` after `./scripts/testing/start-test-stack.sh` when runtime-related.

---

## 9. Definition of Done

Route Processing Full Persist MVP is **done** when:

- [ ] Wizard deploy persists **Transform** and **Policy** route bundles (`inherit=false`) for all created routes
- [ ] Wizard deploy persists **Protection** and **Classification** route bundles (P1 scope)
- [ ] Deploy Summary `persistKind` reflects actual persist outcome (no `(Intent only)` for persisted bundles)
- [ ] Post-deploy Effective API `processing_status` matches wizard intent for all four concerns (within Mixed/Overridden rules in UX spec §25)
- [ ] Governance field overrides continue to work; no regression in P2.1 alignment tests
- [ ] Route Edit can load and edit wizard-persisted bundles without data loss
- [ ] Unit/integration tests cover persist orchestration per concern
- [ ] E2E smoke (§8.2) passes in test stack
- [ ] UX spec updated (new section or §24 extension for `route_bundle` persist kind)
- [ ] **OSS v1 deploy path behavior documented** — no undocumented breaking changes to streams created before v1.1

**Not required for MVP DoD:** flag removal, Enterprise-only features. (`GDC_ROUTE_PROCESSING_ENABLED` default ON was delivered in P1-4.)

---

## 10. Out of Scope

The following remain **out of v1.x Full Persist MVP**:

| Item | Rationale |
|------|-----------|
| OSS v1 deploy behavior changes | This roadmap is backlog definition only |
| New DB tables or alembic migrations | Tables already exist |
| Runtime resolver / enforcement changes | Persist-only; runtime already dual-reads |
| Wizard Deploy Persist work for unrelated concerns | e.g. union schema, connector materialization |
| Flag removal | Rollback flag remains; default ON already shipped (P1-4) |
| Route Processing UI net-new surfaces | Route Edit / Wizard editors largely exist; MVP is persist wiring |
| AI-assisted transform, regex_replace, raw code execution | Product charter exclusions |
| Enterprise-only governance features | Core route persist is OSS scope |
| Collapsing Deploy Intent model entirely | Deploy remains Decision Center; truth shifts from projected to effective post-deploy |
| Stream duplication for per-destination processing | Violates Product Charter |

---

## Appendix: Persist Matrix (Reference)

| Concern | Config type | Current persist | Remaining gap |
|---------|-------------|-----------------|---------------|
| Transform | Shared | YES | — |
| Transform | Route bundle (`inherit=false`) | YES (complete override at deploy) | — |
| Protection | Shared intents | YES | — |
| Protection | Governance field override | YES | — |
| Protection | Route bundle (`inherit=false`) | YES when non-audit intents are ready | Incomplete payload → `intent_only` |
| Classification | Shared rules | YES | — |
| Classification | Governance floor | YES | — |
| Classification | Route bundle | Floor override only | Override without floor → `intent_only` |
| Policy | Shared rules | YES | — |
| Policy | Governance delivery (field) | YES | — |
| Policy | Route bundle (`inherit=false`) | YES via governance persist | — |
| Delivery | Route metadata | YES | — |

---

## Revision History

| Date | Change |
|------|--------|
| 2026-06-20 | Initial v1.x backlog definition (P2.2 Scope Decision) |
| 2026-08-13 | Persist kinds aligned to wizard-deploy-projection.ts (P1-3) |
| 2026-08-15 | Remove stale “flag default ON is future P2”; P1-4 already graduated default ON |
