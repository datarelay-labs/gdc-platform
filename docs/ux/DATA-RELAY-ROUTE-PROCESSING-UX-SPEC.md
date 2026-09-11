# DATA RELAY ROUTE PROCESSING UX SPEC

**Document:** `DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md`  
**Version:** 1.3  
**Status:** CURRENT — UX authority for Route Processing (Wizard, Stream Edit, Route Edit, Governance Workspace)  
**Date:** 2026-06-19; persist kinds updated 2026-08-13  
**Related:** `specs/091-route-processing-architecture/spec.md`, `specs/092-per-route-transform/spec.md`, `specs/093-per-route-protection/spec.md`, `specs/094-per-route-classification/spec.md`, `specs/095-per-route-policy/spec.md`, `specs/096-route-runtime-delivery/spec.md`

---

## Purpose

이 문서는 Route Processing UX의 최종 설계 기준 문서이다.

기존 Charter에 정의된

```text
Route
=
Destination Specific Processing Unit
```

개념을 실제 UI로 구현하기 위한 문서이다.

본 문서는

* Wizard
* Stream Edit
* Route Edit
* Governance Workspace

모든 Route Processing UI의 기준이 된다.

---

# 1. Design Goal

현재 사용자는

```text
데이터를 가져온다
↓
변환한다
↓
보호한다
↓
전송한다
```

라고 생각한다.

하지만 실제 운영 환경에서는

같은 데이터를

```text
SIEM
XDR
Data Lake
Archive
```

등 여러 목적지로 동시에 보낸다.

각 목적지는

필요한 데이터가 다르다.

따라서 Route는

단순 Delivery 설정이 아니다.

---

Route는

```text
Destination Specific Processing Unit
```

이다.

즉

각 Route는

독립적인 Processing Chain을 가진다.

---

# 2. Mental Model

사용자가 이해해야 하는 모델

```text
Source
 ↓
Stream
 ↓
Shared Processing
 ↓
Routes
```

---

예시

```text
Office365 Stream
```

↓

```text
Shared Processing

Normalize Vendor
Normalize Product
Normalize Timestamp
```

↓

```text
Route A
(MSS Syslog)
```

↓

```text
Transform
Protection
Classification
Policy
Delivery
```

---

```text
Route B
(Stellar Cyber)
```

↓

```text
Transform
Protection
Classification
Policy
Delivery
```

---

```text
Route C
(Data Lake)
```

↓

```text
Transform
Protection
Classification
Policy
Delivery
```

---

# 3. Processing Model

각 Route는

아래 단계로 구성된다.

```text
Transform
↓
Protection
↓
Classification
↓
Policy
↓
Delivery
```

---

Route는

Global 설정을 상속한다.

필요 시 Override 한다.

---

# 4. Inheritance Model

모든 Route 설정은

기본적으로

```text
Inherit Global
```

이다.

---

예시

```text
Transform

☑ Inherit Global
```

---

의미

```text
Global Transform 사용
```

---

체크 해제

```text
Transform

☐ Inherit Global
```

↓

Route 전용 Transform 활성화

---

동일 규칙 적용

```text
Transform
Protection
Classification
Policy
```

---

# 5. Route Processing Layout

Wizard

Step 4

Route Processing

---

상단

```text
Shared Processing
```

---

하단

```text
Routes
```

---

레이아웃

```text
+---------------------------------------------------+
| Shared Processing                                 |
+---------------------------------------------------+

+---------------------------------------------------+
| Routes                                             |
|---------------------------------------------------|
| MSS Syslog                                         |
| Stellar Cyber                                      |
| Data Lake                                          |
+---------------------------------------------------+

+---------------------------------------------------+
| Route Details                                      |
+---------------------------------------------------+
```

---

# 6. Shared Processing Section

Shared Processing은

모든 Route의 기본값이다.

---

구성

```text
Transform
Protection
Classification
Policy
```

---

여기서 설정한 값은

모든 Route에 자동 적용된다.

---

# 7. Route List

Route 카드 표시

```text
MSS Syslog

Destination
Enabled

Processing Status
```

---

상태

```text
Inherited
Overridden
Mixed
```

---

예시

```text
Transform      Inherited
Protection     Overridden
Classification Inherited
Policy         Mixed
```

---

# 8. Route Detail Panel

Route 선택 시 표시

---

구성

```text
Transform
Protection
Classification
Policy
Delivery
```

---

각 섹션

```text
☑ Inherit Global
```

또는

```text
☐ Inherit Global
```

---

# 9. Transform Section

기존 Mapping UI 재사용

```text
Field Mapping

Transform Rules

Preview
```

---

Inherit Global

ON

↓

읽기 전용

---

OFF

↓

수정 가능

---

# 10. Protection Section

기존 Data Protection UI 재사용

---

구성

```text
Schema Drift Policy

Protection Rules
```

---

Inherit Global

ON

↓

읽기 전용

---

OFF

↓

Route 전용 정책

---

# 11. Classification Section

구성

```text
Classification Rules

Default Classification

Classification Floor
```

---

동작

Global 상속

또는

Route Override

---

# 12. Policy Section

구성

```text
Policy Rules

Delivery Behavior
```

---

지원

```text
Continue

Review

Quarantine

Block
```

---

Global 상속 가능

---

# 13. Delivery Section

Route 고유 설정

상속 없음

---

구성

```text
Destination

Failure Policy

Rate Limit

Burst Limit

Enable / Disable
```

---

항상 Route 전용

---

# 14. Unknown Field Handling

Global 기본 정책

```text
Unknown Field

Pass Through
```

---

Route Override 가능

---

예시

Route A

```text
Pass Through
```

---

Route B

```text
Drop
```

---

Route C

```text
Require Review
```

---

# 15. Protection Rule Actions

지원

```text
Audit

Mask Partial

Mask Full

Tokenize

Hash

Drop
```

---

Drop 의미

```text
필드 제거
```

---

예시

```json
{
  "email": "test@test.com",
  "user": "admin"
}
```

↓

```json
{
  "user": "admin"
}
```

---

# 16. Delivery Behaviors

지원

```text
Continue
Review
Quarantine
Block
```

---

Block 의미

```text
이벤트 전체 전송 중단
```

---

예시

```json
{
  "email":"a@a.com"
}
```

↓

전송 안함

---

Drop 과 차이

```text
Drop
=
필드 제거

Block
=
이벤트 제거
```

---

# 17. Design Principle

기본 목표

```text
90%

Shared Processing 사용
```

---

예외

```text
10%

특정 Route만 Override
```

---

따라서 UX는

```text
Shared First

Route Override Second
```

모델을 따른다.

---

# 18. Definition Of Done

Route Processing 구현 완료 기준

* Shared Processing 존재
* Route List 존재
* Route Detail Panel 존재
* Inherit / Override 지원
* Transform Override 지원
* Protection Override 지원
* Classification Override 지원
* Policy Override 지원
* Delivery 설정 지원
* Unknown Field Override 지원
* Drop 지원
* Effective Preview 지원
* Wizard 지원
* Stream Edit 지원
* Route Edit 지원
* Governance Workspace 지원

위 조건을 모두 충족해야

Route Processing 구현 완료로 간주한다.

---

# 19. Drop Policy (v1.1)

Drop removes **fields** from the output event. Block stops **entire event** delivery.

| Surface | Option | Default | Drop meaning |
|---------|--------|---------|--------------|
| Field Mapping | Unmapped Field Behavior: Pass Through / Drop | Pass Through | Remove unmapped source fields from mapped output |
| Schema Drift | Unknown Normal / Sensitive Field: Drop | Pass Through / Auto Protect | Remove newly discovered field; event continues |
| Protection Rules | Protection Action: Drop | — | Remove matched field from event |

Block applies only to delivery behavior (Policy / Protection delivery controls), not field mapping.

---

# 20. Deploy Summary Route Overrides (v1.1)

Deploy summary shows route count plus per-concern override counts for deployment review:

```text
Routes: 3

Route Overrides
- Transform: 2
- Protection: 1
- Classification: 0
- Policy: 1
```

Counts reflect routes where the concern is not fully Inherited (Overridden or Mixed).

---

# 21. Deploy Route Readiness (v1.2)

Deploy is a **Deployment Decision Center**, not a configuration dump. Operators must answer:

1. Can we deploy?
2. Which route has a problem?
3. Why is it a problem?
4. After deploy, which processing does each route receive?

## Route Readiness Summary

Deploy aside shows per-route readiness:

```text
Routes
3 Configured

Route Readiness
✓ MSS Syslog        Ready
⚠ Stellar Cyber     Warning
✓ Data Lake         Ready

Ready Routes
2 / 3

Warning Routes
1 / 3
```

### Status rules

| Status | Label | Conditions |
|--------|-------|------------|
| READY | Ready | Route has destination, no validation error, no active warnings |
| WARNING | Warning | Route override in use, stream transform warning, data protection warning, or connectivity not verified |
| ERROR | Needs Attention | Enabled route without destination, destination not found, or connectivity test failed |

Disabled routes with missing destinations surface as Warning, not Error.

## Route Override Visibility

Aggregate override counts remain visible. Deploy also lists **which routes** override shared processing:

```text
Overrides

MSS Syslog
- Transform
- Policy

Stellar Cyber
- Protection
```

No configuration dump — concern names only.

## Shared Processing Impact

Deploy shows stream-level shared processing and how many routes it applies to:

```text
Shared Processing
Transform
Protection
Classification
Policy

Applied To
3 Routes
```

`Applied To` uses total configured routes. Shared processing is the stream default; per-route overrides replace individual concerns.

## Route Health Cards

Main Deploy column shows read-only **Route Health** cards (one per route):

```text
MSS Syslog
Status: Ready

Processing
Transform      Override
Protection     Shared
Classification Shared
Policy         Override
```

Processing cells use `Shared` (Inherited) or `Override` (Overridden / Mixed).

Cards are deploy-summary only — no inline editing.

---

# 22. Route Processing UX Polish (v1.3)

## Visual status badges

Route cards and tables use pill badges with text labels (never color alone):

| Internal status | Display label | Badge tone |
|-----------------|---------------|------------|
| Inherited | Shared | Subtle / stable |
| Overridden | Override | Emphasized |
| Mixed | Mixed | Warning |
| Deploy error | Needs Attention | Error |

Delivery uses **Enabled** / **Disabled** badges.

Deploy readiness uses **Ready**, **Warning**, **Needs Attention** badges.

## Active route state

When a route is selected in Wizard or Stream Edit:

- Card/row shows **Active** pill
- Selected card uses ring + violet border
- Table row uses inset left accent bar
- `aria-current="true"` on selected control

## Route Detail header

All Route Detail panels share:

```text
Route Detail
{Route name}
Destination: {Destination name}
Processing: Transform / Protection / Classification / Policy / Delivery
```

Wizard uses destination name as route label when no separate route name exists.

## UI consistency

Wizard Route Processing, Stream Edit Route Processing Overview, and Deploy Route Health Cards share:

- **Shared Processing** naming (not Global Processing)
- **Inherit Shared** toggle label
- Concern order: Transform → Protection → Classification → Policy → Delivery
- Shared badge components for status display
- Drop vs Block helper on Policy tab: Block stops entire event; Drop removes fields only

## Empty and warning copy

| Situation | Message |
|-----------|---------|
| No routes | No routes configured. / Select a destination to create route processing. |
| Missing destination | Destination missing. / This route needs a destination before deploy. |
| All inherited | All processing is inherited from Shared Processing. |
| No route selected | Select a route to view processing details. |

Do not expose engine, runtime, or internal terminology in operator-facing copy.

---

# 23. Route Processing Status SSOT (v1.4)

## Post-deploy display authority

After a stream is deployed, **Effective API `processing_status`** is the Single Source of Truth for route processing status display in:

- Stream Edit → Route Processing Overview (table badges and detail inherit mirrors)
- Route Edit (processing status header and tab context)
- Governance Workspace (per-route status columns and summary counts)

Each concern exposes status via:

```text
GET /api/v1/runtime/routes/{route_id}/transform/effective
GET /api/v1/runtime/routes/{route_id}/protection/effective
GET /api/v1/runtime/routes/{route_id}/classification/effective
GET /api/v1/runtime/routes/{route_id}/policy/effective
```

Response field: `processing_status` — one of `Inherited`, `Overridden`, `Mixed`.

## Status semantics (operator-facing)

| `processing_status` | Display label | Meaning |
|---------------------|---------------|---------|
| **Inherited** | Shared | The entire concern resolves from **Shared Processing** (stream-scoped config). |
| **Overridden** | Override | The entire concern resolves from the **route override bundle** (route-scoped persisted config). |
| **Mixed** | Mixed | Within the concern, route and stream sources are combined — e.g. transform mapping from route and enrichment from stream, or the runtime resolver classified the route as mixed (such as disabled orphan route rule rows while stream rules apply). |

Deploy Health Cards use **Shared**, **Override**, and **Mixed** badges (three-value projected status). Do not collapse Mixed into Override on Deploy.

## Wizard draft vs runtime truth

**Wizard draft status** (`draft.inherit`, `computeWizardRouteProcessingStatuses`) is **not** runtime truth. It expresses operator **intent** before routes exist in the API.

- Wizard Route Processing list and Deploy preview/projection use draft intent.
- Post-deploy surfaces must use Effective API status, not wizard draft computation.
- Do not imply that toggling Stream Edit inherit controls changes runtime config — Stream Edit inherit mirrors are **read-only** and reflect Effective API status; edits belong in Route Edit.

## Stream Edit inherit mirror (read-only)

In Stream Edit Route Processing detail tabs:

- Inherit Shared checkbox is **disabled** and mirrors Effective API `processing_status`.
- **Inherited** → checked, **Shared** badge.
- **Overridden** → unchecked, **Override** badge.
- **Mixed** → unchecked, **Mixed** badge.
- Status unavailable (API failure or not loaded) → **Unavailable** — never default to Shared.

Provide **Open Route Edit** / **Full Route Edit** CTA for changes; do not allow inline inherit toggling on Stream Edit.

---

# 24. Deploy Projection Model (v1.5)

## Deploy Intent vs post-deploy truth

**Deploy Intent** is what the operator configured in the Wizard Route Processing step before stream creation. It is **not** post-deploy Effective API truth.

**Projected Status** is the frontend pure-function estimate of how each route concern will appear after deploy, derived from wizard draft (`draft.inherit`, governance field overrides, etc.). No API calls; no runtime resolver execution at deploy time.

Deploy Summary, Route Health Cards, and projected count lists must be labeled as **Deploy Intent** / **Projected Status** so operators do not confuse them with Stream Edit or Governance effective status.

## Projection function

```text
projectRouteProcessingStatusFromDeployIntent(draft, dataProtection)
  → statuses: Inherited | Overridden | Mixed (per concern)
  → persistKind: none | intent_only | governance | route_transform | route_protection
```

| `persistKind` | Operator label | Meaning |
|---------------|----------------|---------|
| **none** | — | Shared Processing only; no route-level deploy intent. |
| **intent_only** | Intent only | Incomplete override; shown in Deploy but **not saved** for that concern. |
| **governance** | Persisted through governance rules | Field-level protection/classification/policy overrides saved via governance `route_overrides` at deploy. |
| **route_transform** | Persisted through route transform | Route mapping/enrichment bundle saved at deploy. |
| **route_protection** | Persisted through route protection | Route protection intents saved at deploy. |

## Deploy Summary display rules

1. Show **Route Processing Intent** notice in Deploy aside and Route Health subtitle.
2. **Projected Status Counts** list per concern: `Override: N · Mixed: M` (never combine into a single override count).
3. **Deploy Intent by Route** lists concern, projected status badge label, and persist label when applicable.
4. Route Health Cards show three-value badges: **Shared**, **Override**, **Mixed**.
5. When `persistKind === intent_only`, show **Intent only** gap callout on the route card.

## Copy constraints

Allowed: Deploy Intent, Projected Status, Intent only, Persisted through governance rules, Persisted through route transform, Persisted through route protection.

Forbidden in operator copy: Runtime Resolver, Persist Layer, Database Row, Internal Engine.

---

# 25. Effective Status Alignment (v1.6)

## Problem

Runtime route processing for **Protection**, **Classification**, and **Policy** merges `governance.route_overrides[]` from `stream.config_json` on top of persisted stream/route rule rows. Prior Effective API `processing_status` computation ignored governance overrides and inspected only `Route*Rule` / `Stream*Rule` rows — causing post-deploy badges to show **Shared (Inherited)** while runtime applied per-route governance overrides.

**Transform** is unchanged: governance `route_overrides[]` does not affect transform resolution (mapping/enrichment dual-read only).

## Runtime vs Effective inputs

| Concern | Runtime override source | Effective status source (post-alignment) |
|---------|-------------------------|------------------------------------------|
| **Transform** | None (no governance merge) | `RouteMapping` / `RouteEnrichment` vs stream mapping/enrichment |
| **Protection** | `governance.route_overrides[].protection_action` merged in `resolve_route_protection_config` | Same resolver + governance overrides loaded from stream config |
| **Classification** | `governance.route_overrides[].classification_level` floor in `resolve_route_classification_config` | Same resolver + governance overrides loaded from stream config |
| **Policy** | `governance.route_overrides[].delivery_behavior` in `resolve_route_policy_config` | Same resolver + governance overrides loaded from stream config |

Effective API services load `governance.route_overrides` from the parent stream and pass them to the same resolver functions runtime uses. **No runtime enforcement, persist, or new endpoints change.**

## Status rules (per concern)

Shared function: `compute_route_processing_status(persisted_source, route_rule_rows, has_governance_override)`.

| `processing_status` | Display label | Criteria |
|---------------------|---------------|----------|
| **Inherited** | Shared | Persisted bundle is stream-scoped (`persisted_source == stream`) and no active governance override for this route/concern; no disabled orphan route rule rows. |
| **Overridden** | Override | Persisted bundle is route-scoped only (`persisted_source == route`) with no governance override; **or** governance-only override with no stream/route rule rows (`persisted_source == empty` + active governance override). |
| **Mixed** | Mixed | Stream-scoped persisted bundle **plus** active governance override for the route/concern; **or** route-scoped bundle **plus** governance override; **or** disabled orphan route rule rows while stream rules apply. |

### Concern-specific governance detection

| Concern | Active governance override when |
|---------|----------------------------------|
| **Protection** | Enabled override for route with mappable `protection_action` (excluding inherit/audit-only for status purposes audit_only still counts as override presence via action mapping) |
| **Classification** | Enabled override for route with valid `classification_level` |
| **Policy** | Enabled override for route with valid `delivery_behavior` |

## Transform — No Change

Transform effective status continues to derive from mapping/enrichment dual-read only. Governance field overrides do not apply to transform.

## Affected surfaces

Post-deploy badges and inherit mirrors that consume Effective API `processing_status`:

- Stream Edit → Route Processing Overview
- Route Edit processing header and tabs
- Governance Workspace per-route status columns and summary counts
- Deploy Verification (post-deploy effective reads only; Deploy projection unchanged)

Badge mapping unchanged: **Shared** / **Override** / **Mixed**.

## Examples

| Scenario | Protection status |
|----------|-------------------|
| Stream protection rules only | Inherited (Shared) |
| Route protection rules only | Overridden (Override) |
| Stream rules + governance `protection_action` override for route | Mixed |
| Governance `protection_action` only (no stream/route rows) | Overridden (Override) |
| Stream rules + disabled route rule rows | Mixed |

Classification and Policy follow the same table with `classification_level` and `delivery_behavior` governance fields respectively.
