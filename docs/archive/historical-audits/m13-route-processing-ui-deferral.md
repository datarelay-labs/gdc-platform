# M13 Route Processing UI — OSS v1 Deferral

**Date:** 2026-06-17  
**Status:** Active deferral (OSS v1 stabilization)  
**Related:** `docs/architecture/m13-destination-first-full-audit.md`, `docs/architecture/route-architecture-gap-analysis.md`, specs 091–096

---

## Purpose

OSS v1 안정화를 위해 **M13 Route Processing Operator UI**를 다음 마일스톤으로 명확히 분리한다.

이 문서는 현재 제품 상태를 고정하고, 사용자·운영자·개발자가 **이미 완성된 기능으로 오해하지 않도록** 한다.

**이번 마일스톤에서 하지 않는 것:** Route Processing UI 구현, Wizard v5.2 전환, per-route CRUD API, feature flag 제거.

---

## Current M13 State (Code-Based)

| # | Capability | Status | Code / config evidence |
|---|------------|--------|------------------------|
| 1 | Route Architecture Runtime | **Implemented** | `app/runners/route_stage.py`, `app/route_*` packages, `stream_runner.py` route pipeline branch |
| 2 | Route Data Model | **Implemented** | `routes` table; M13 tables `route_mappings`, `route_enrichments`, `route_protection_rules`, `route_classification_rules`, `route_policy_rules` (alembic 0054–0057) |
| 3 | One Stream → Many Routes → Many Destinations | **Implemented** | `app/routes/models.py`; wizard `routeDrafts[]` → `POST /routes/` |
| 4 | Destination fan-out delivery | **Implemented** | Legacy path (flag OFF): stream transform → same payload fan-out; flag ON: per-route pipeline → delivery |
| 5 | Per-route Transform / Protection / Classification / Policy **Runtime** | **Implemented behind flag** | `GDC_ROUTE_PROCESSING_ENABLED`; `process_route_pipeline()` when `true` |
| 6 | Per-route **Operator UI** | **Not implemented** | No route-scoped transform/protection/classification/policy editors; no `step-route-processing` |
| 7 | Destination First Wizard v5.2 | **Not implemented** | Wizard remains v3.0 step order (see below) |
| 8 | Route Processing Wizard Step | **Not implemented** | `frontend/` grep: no `Route Processing` user-facing step |

---

## Current UI Gap

### Wizard

- **Implemented steps** (`frontend/src/components/streams/wizard/wizard-state.ts`):

  ```
  Connect → Sample & Record Selection → Transform → Destinations → Deploy
  ```

- **Missing:** dedicated Route Processing step; per-route transform/protection/classification/policy configuration in wizard.
- **Create flow:** stream mapping/enrichment saved via `POST /runtime/streams/{id}/mapping-ui/save` (stream-scoped); routes created via `POST /routes/` with delivery metadata only (`new-stream-wizard-page.tsx`).

### Route / Stream operator surfaces

- **Stream-scoped:** Mapping, Enrichment, Protection, Classification, Policy panels (`protection-panel.tsx`, `classification-panel.tsx`, `policy-panel.tsx`) — all take `streamId`.
- **Route edit** (`route-edit-page.tsx`): delivery linkage (enabled, destination, failure policy, formatter/rate-limit). **Not** M13 `route_mappings` / rule tables.
- **No HTTP CRUD** for `route_mappings`, `route_enrichments`, `route_protection_rules`, `route_classification_rules`, `route_policy_rules`, or typed `route_overrides` API.

### Runtime APIs that exist today (route entity)

Delivery/ops oriented only: `/runtime/routes/{id}/ui/config|save`, formatter/failure-policy/enabled/rate-limit save, health, analytics, `preview/route-delivery`. These do **not** expose M13 processing rule bundles to operators.

---

## Source of Truth vs Current Implementation

### SoT target (Wizard v5.2 / Product Charter)

```
Connect
↓
Sample & Record Selection
↓
Destinations
↓
Route Processing
↓
Deploy
```

### Current OSS v1 implementation

```
Connect
↓
Sample & Record Selection
↓
Transform
↓
Destinations
↓
Deploy
```

### Decision (OSS v1)

**현재 구현을 유지한다.**

- Stream-scoped Transform + multi-route delivery는 OSS v1 GA에서 검증된 안정 경로이다.
- Wizard v5.2 (Destination First → Route Processing) 전환은 **별도 마일스톤**에서 수행한다.
- SoT 문서(`docs/source-of-truth/`)는 제품 목표를 정의하며, OSS v1 배포 동작은 **이 문서와 위 표**가 우선한다.

---

## Why Route Processing UI Is Excluded from OSS v1

1. **Operator cannot configure per-route processing** — DB tables and runtime resolvers exist, but no UI or CRUD API.
2. **Wizard does not collect per-route processing intent** — create flow ends at route linkage, not M13 rule bundles.
3. **Default runtime path is legacy (flag OFF)** — production behavior matches pre-M13 stream-scoped pipeline + fan-out.
4. **E2E wizard → flag-ON route processing** is not wired in frontend tests.
5. **Premature UI would imply feature completeness** while `GDC_ROUTE_PROCESSING_ENABLED` remains off by default.

---

## Feature Flag: `GDC_ROUTE_PROCESSING_ENABLED`

| Property | Value |
|----------|-------|
| Definition | `app/config.py` |
| Default | **`False`** (unchanged for OSS v1) |
| Production code usage | `app/runners/stream_runner.py` only |
| Frontend usage | **None** |

### Why the flag stays ON-capable but default OFF

- Per-route operator UI: **missing**
- Per-route CRUD API: **missing**
- Wizard Route Processing step: **missing**
- E2E validation for flag-ON operator path: **insufficient**

Enabling `GDC_ROUTE_PROCESSING_ENABLED=true` in an environment activates backend M13 runtime **without** operator-facing configuration surfaces. OSS v1 deployments should leave the flag **OFF** unless explicitly running internal/runtime validation (see `docs/architecture/m13-flag-on-runtime-validation.md`).

---

## What Users Can Use in OSS v1 (Exposed Scope)

| Area | Available |
|------|-----------|
| Stream onboarding wizard (v3.0 order) | Connect, Sample, **Transform** (stream mapping/enrichment), Destinations (route drafts), Deploy |
| Stream mapping / enrichment editing | Stream-scoped mapping UI, enrichment pages |
| Multi-route delivery | Create multiple routes per stream; fan-out to destinations |
| Route operations | Routes overview, route edit (delivery settings), route health/metrics |
| Stream governance (stream-scoped) | Protection, Classification, Policy panels in governance drawer |
| Schema drift policy | Stream `config_json.governance` (wizard + stream edit) |

**Not available to operators in OSS v1:**

- Per-route Transform (mapping/enrichment override UI)
- Per-route Protection / Classification / Policy rule editors
- Route override intent UI (`governance.route_overrides`)
- Route Processing wizard step
- Turning on per-route runtime as the default product path

---

## Prohibited Changes While This Deferral Is Active

- Wizard step order change (v5.2 transition)
- Adding Route Processing wizard step
- New CRUD APIs for `route_mappings`, `route_enrichments`, `route_protection_rules`, `route_classification_rules`, `route_policy_rules`
- `GDC_ROUTE_PROCESSING_ENABLED` default → `True`
- Removing or bypassing the feature flag without full UI/API/E2E completion
- Changing existing Stream Wizard create/save behavior in ways that assume per-route processing UI exists

---

## Next Milestone (Deferred Work)

Prioritized from gap analysis (`docs/architecture/m13-destination-first-full-audit.md`); **not in OSS v1 scope:**

### P0 — Route Processing Operator MVP

1. Backend CRUD for M13 route tables + route override contract
2. Route processing config bundle read (dual-read resolved view)
3. Frontend API client layer
4. Wizard: `Destinations` → `Route Processing` → `Deploy` (or equivalent v5.2 alignment)
5. `StepRouteProcessing` — per-route transform/protection/classification/policy intent
6. Wizard persist after route IDs exist
7. Deploy summary / readiness for Route Processing

### P1 — Operations completeness

- Route edit page: M13 rule bundle (replace placeholder panels)
- Routes overview: per-route processing status
- Dual-read inheritance UX (route / stream / override source labels)

### P2 — Flag graduation

- E2E wizard → flag-ON runtime
- `GDC_ROUTE_PROCESSING_ENABLED` default ON roadmap and flag removal criteria
- Route-path observability UI parity

---

## UI Misleading-Phrase Survey (frontend/)

Searched: `Route Processing`, `Per-route Transform`, `Per-route Protection`, `Per-route Policy`, `Destination First`, `M13`, `per-route`, `route processing`.

### No misleading matches (safe)

| Location | Text | Assessment |
|----------|------|------------|
| `wizard-state.ts` | Comment: `Per-route draft for wizard Destinations step` | Developer comment only; refers to route **draft** rows, not M13 processing |
| `step-delivery.tsx` | `Create a destination first` | Operational hint; not Destination First product term |
| `step-delivery.tsx` | `per route` (failure policy, rate limit tooltips) | Accurate: delivery settings **are** per route today |
| `step-data-protection.tsx` | `stream-scoped data protection intent` | Accurate scope disclosure |

### Potential misunderstanding (report only — no code change in this task)

| Location | Text | Risk | Recommendation (future milestone) |
|----------|------|------|-------------------------------------|
| `route-edit-page.tsx` | Panel title **"Event Transformation (Optional)"** with Enrichment Profile / Filter JSONPath | Users may believe per-route transform is fully supported; fields save to `formatter_config_json`, **not** `route_mappings` / M13 transform tables; runtime legacy path does not apply these as per-route transform | Add OSS v1 notice or disable/hide panel until Route Processing UI ships; wire to M13 APIs when ready |
| `route-edit-page.tsx` | **"Routing Conditions (Optional)"** / **"Advanced Settings (Optional)"** placeholder panels | Empty placeholders suggest unfinished features | Label as "Coming in a future release" or remove until implemented |
| `route-edit-page.tsx` | Footer: `formatter/rate-limit oriented settings` | Partially mitigates transform panel confusion | Keep; extend with explicit "stream handles mapping in OSS v1" when Route Processing UI is deferred in UI copy |

**Note:** `frontend/` contains **zero** user-visible strings for `Route Processing`, `M13`, `Destination First`, or `Per-route Transform/Protection/Policy` as product feature names. Primary confusion risk is **route-edit placeholder panels**, not wizard marketing copy.

---

## References

- Runtime: `app/runners/stream_runner.py`, `app/runners/route_stage.py`
- Config: `app/config.py` (`GDC_ROUTE_PROCESSING_ENABLED`)
- Wizard state: `frontend/src/components/streams/wizard/wizard-state.ts`
- Specs: `specs/091-route-processing-architecture/spec.md` through `specs/096-route-runtime-delivery/spec.md`
- Prior gap analysis: `docs/architecture/m13-destination-first-full-audit.md`

---

*This document fixes OSS v1 product posture. Update it when Route Processing UI milestone starts or completes.*
