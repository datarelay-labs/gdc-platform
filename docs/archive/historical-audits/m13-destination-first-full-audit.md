# M13 Route Architecture + Destination First Wizard — 전수 SoT 감사

**Date:** 2026-06-17  
**Branch:** `feature/sensitive-detection-m5-clean` (HEAD `5205960`)  
**Mode:** Read-only — 실제 코드 기준, 추측 없음  
**SoT:** `docs/source-of-truth/` (10문서)

---

## Executive Summary

| 영역 | 판정 |
|------|------|
| **토폴로지** (One Stream → Many Routes → Many Destinations) | **PASS** — 데이터 모델·wizard·UI fan-out 구현됨 |
| **M13 Route Processing 런타임** | **PARTIAL** — 코드·테스트 완비, **기본 flag OFF** |
| **Wizard v5.2 구조** | **FAIL** — `Transform` 단계 존재, **`Route Processing` 단계 없음** |
| **Per-route UI 설정** | **FAIL** — Transform/Protection/Classification/Policy route UI 없음 |
| **Unknown Normal Pass Through (runtime)** | **PASS** — schema drift policy 기본값·orchestrator·테스트 확인 |
| **Stream 복제 회피** | **PASS** — `routeDrafts` / multi-route, stream 복제 패턴 없음 |

**Route Architecture 점수:** **62 / 100**  
**Destination First UX 점수:** **52 / 100**  
**OSS v1 SoT 적합성:** **FAIL** (Product Charter Route Processing Model·Wizard v5.2 미충족; 기본 GA 경로는 stream-scoped fan-out)

---

## 1. SoT 준수 항목 (PASS)

| # | 항목 | SoT 근거 | 코드 근거 |
|---|------|----------|-----------|
| P1 | One Stream → Many Routes → Many Destinations | Product Charter, UX §24 | `routes` 테이블 `stream_id`+`destination_id`; wizard `routeDrafts[]` → `buildRouteCreatePayloads()` (`wizard-state.ts`); `StreamsConsole` RouteFanOut |
| P2 | Stream 복제 없이 destination별 전달 | Product Charter §504, UX §996 | Wizard: stream 1회 생성 + route N회 POST; `duplicateRouteDraft`는 route 복제만 |
| P3 | Execution Unit = Stream | Governance Policy §22 | `StreamRunner.run()` stream 단위 폴링·락·체크포인트 |
| P4 | M13 per-route 파이프라인 (flag ON) | WBS M13.1–M13.6, specs 091–096 | `route_stage.py`: Transform→Protection→Classification→Policy→Delivery; `app/route_*` 패키지; alembic 0054–0057 |
| P5 | Route dual-read (route 우선, stream fallback) | M13 foundation | `route_context.py` `dual_read()`; `route_transform_config.py` |
| P6 | Route override (runtime) | Governance Workspace §Route Governance | `route_overrides` in `stream_loader` → `route_protection/resolver.py`, `route_classification/resolver.py`, `route_policy/resolver.py`, `drift_gates.py` |
| P7 | Governance 설정 Scope = Stream | Governance Policy | `streams.config_json.governance.schema_drift_policy`; wizard `wizard-schema-drift-policy-persist.ts` |
| P8 | Unknown Normal → Pass Through (runtime) | Governance Policy §9–10 | `app/schema_drift_policy/schemas.py` `DEFAULT_UNKNOWN_NORMAL_POLICY = "pass_through"`; `orchestrator.py`; `tests/test_schema_drift_policy_runtime.py::test_unknown_normal_pass_through_delivers` |
| P9 | Unknown Sensitive → Auto Protect (default) | Governance Policy §10 | 동일 모듈 `auto_protect` default; wizard `wizard-state.ts` 동일 |
| P10 | Union Schema Sample 생성 (클라이언트) | Union Schema UX | `frontend/src/utils/unionSchema.ts` `buildUnionSchema()`; `step-api-test.tsx` 트리거 |
| P11 | Basic Transform Union Tree | Union Schema UX | `wizard-basic-mapping-panel.tsx` — union 있으면 `UnionSchemaTree` |
| P12 | Rare field 표시 (기본) | Union Schema UX | `union-schema-tree.tsx` amber `rare` badge; `isRareUnionField()` |
| P13 | Deploy Decision Center | Wizard v5.2 §Deploy | `step-deploy.tsx` — checklist, configuration summary, status banner |
| P14 | Routes 운영 콘솔 | UX delivery ops | `routes-overview-page.tsx`, `route-operational-panel.tsx` |
| P15 | Destinations 재사용·역참조 | UX §18–19 | `destinations-management-page.tsx`, `destination-detail-page.tsx` Routes 탭 |
| P16 | Stream Group (Streams 페이지) | UX §12 | `source-product-group.ts`, `streams-group-kpi-strip.tsx` |
| P17 | Governance = operations (not config in dashboard) | Governance UX §6 | Policy builder/wizard 분리; governance center는 violation/quarantine/replay |
| P18 | Quarantine reason humanization (B2) | Governance Workspace UX | `governance_violations/service.py` `_humanize_quarantine_reason`; frontend `humanize-quarantine-reason.ts` |
| P19 | Schema drift observability | UX troubleshooting | Commit A/B1 delivery log stages; protection panel auto-protect activity |
| P20 | Mapping unknown-field pass-through (동일 이벤트) | Mapper design | `app/mappers/pass_through.py` — schema drift와 별개 레이어 |

---

## 2. SoT 위반 항목 (FAIL)

| # | 항목 | SoT 요구 | 실제 구현 |
|---|------|----------|-----------|
| F1 | **Wizard 5단계 구조** | Connect → Sample → **Destinations** → **Route Processing** → Deploy (`STREAM-WIZARD-UX-CHARTER-v5.2` L96–104) | `WIZARD_STEP_KEYS`: connect → sample → **transform** → destinations → deploy (`wizard-state.ts` L37–43). **Route Processing 단계 ID/컴포넌트 없음** (grep 0건) |
| F2 | **Destination First 순서** | Product Charter §409–413: Destination 선택 **이후** Route Processing | Transform(3)이 Destinations(4) **앞** |
| F3 | **Route Processing Wizard UX** | v5.2 Step 4 전용 UI | Per-route Transform/Protection/Classification/Policy 설정 화면 **없음**; `step-route-processing` 없음 |
| F4 | **Per-route Transform UI** | Product Charter §137, §199; WBS M13.2 | Mapping/Enrichment **stream-scoped** (`stream-edit-page`, wizard `transform`); frontend `route_mapping` API/UI **없음** |
| F5 | **Per-route Protection UI** | v5.2 §PROTECTION (Default + Route Override) | Data Protection은 wizard **stream** `step-data-protection.tsx`; route override UI 없음 |
| F6 | **Per-route Classification UI** | WBS M13.4 | Stream classification panels만; route classification UI 없음 |
| F7 | **Per-route Policy UI** | WBS M13.5 | Stream policy panel; route policy rules UI 없음 |
| F8 | **기본 runtime = Route Processing** | Product Charter Route Based Processing | `GDC_ROUTE_PROCESSING_ENABLED` **default `False`** (`app/config.py`); GA 경로 = stream transform → **동일 payload fan-out** (`stream_runner.py` legacy 분기) |
| F9 | **Navigation — Delivery** | UX Charter §5: Delivery = **Destinations only** | `app-navigation.tsx`: Delivery에 **Destinations + Routes** top-level |
| F10 | **Navigation — Governance top-level** | UX Charter §6 anti-pattern: Governance top menu 금지 | Sidebar에 **Governance** top-level 존재 |
| F11 | **Dashboard Stream Group P0** | UX Charter §8 P0: Healthy/Warning/Critical **Stream Groups** | `StreamGroupHealthPanel` **deprecated·미마운트**; Dashboard는 stream-centric KPI만 |
| F12 | **Route = Destination Specific Processing Unit (UX)** | UX §24, Product Charter §117 | Route edit = delivery policy/formatter/rate limit만 (`route-edit-page.tsx`); processing unit으로 표현 안 됨 |
| F13 | **Route 생성 UX** | Destination-first flow | `/routes/new` — **stream_id 선택 UI 없음** (로드된 route에서만 stream 표시) |
| F14 | **Union Schema 10–20 events** | Union Schema UX | API test가 이벤트 수 **미강제** |
| F15 | **Rare field 30% threshold** | Union Schema UX | `isRareUnionField`: `occurrence_count < total_events` (1/N도 rare) |
| F16 | **Sensitive suggestion = Detection engine** | Union Schema UX | `inferWizardSensitivityClass()` **이름 휴리스틱** only |
| F17 | **union_schema persist** | Union Schema → runtime contract | Wizard state only; `route_context_builder.py` `union_schema` 항상 `[]` fallback |
| F18 | **Governance 실행 Scope = Route (UI)** | Governance Workspace §Route Governance | Runtime route stage는 flag ON일 때만; **UI에서 route governance 차이 구성 불가** |
| F19 | **Edit Stream ≠ Wizard 모델** | v5.2 single journey | `streamWorkflow.ts` 별도 7단계; wizard 컴포넌트 **미재사용** |

---

## 3. 부분 구현 (PARTIAL)

| # | 항목 | 구현됨 | 미구현 |
|---|------|--------|--------|
| PA1 | **Transform route 단위** | `route_stage.py` `_apply_route_transform` (flag ON) | Wizard/stream UI는 stream mapping만 |
| PA2 | **Protection route 단위** | `route_protection/stage.py`, `route_overrides` | Wizard protection stream-scoped; route rule CRUD UI 없음 |
| PA3 | **Classification route 단위** | `route_classification/stage.py` | Stream `ClassificationPanel` only |
| PA4 | **Policy route 단위** | `route_policy/stage.py`, `drift_gates.py` route override | Stream `PolicyPanel`; route policy UI 없음 |
| PA5 | **Governance Route Override** | Backend `route_overrides` resolver | Frontend override 편집 UX 없음 |
| PA6 | **Destination별 Governance 차이** | Route policy resolver + overrides (runtime) | Operator가 UI로 destination/route별 정책 구성 **불가** (DB 직접/테스트만) |
| PA7 | **Union Schema → Transform** | Basic mapping tree | Full-event transform, preview = **single event** |
| PA8 | **Deploy Summary** | `step-deploy.tsx` categories | Route Processing 요약 블록 없음 (protection/drift만) |
| PA9 | **Routes Overview** | Flat ops table stream+destination | Per-route processing 상태/설정 미표시 |
| PA10 | **Schema drift at route** | `route_policy/drift_gates.py` | Shared-phase drift stream config; route UI 없음 |
| PA11 | **M13 tests** | `test_per_route_*.py`, `test_route_runtime_delivery.py` | E2E wizard→runtime route processing 미연결 |
| PA12 | **Runtime UI route save** | `gdcRuntimeUi.ts` `POST /runtime/routes/{id}/ui/save` | Route edit page에서 M13 rule bundle **미노출** |

---

## 4. 특별 확인 항목 (A–H)

| ID | 질문 | 판정 | 근거 |
|----|------|------|------|
| **A** | Wizard = Connect / Sample / Destinations / Route Processing / Deploy? | **FAIL** | 실제: connect, sample, **transform**, destinations, deploy |
| **B** | Route Processing 존재? | **PARTIAL** | Backend `route_stage.py` + flag; **Wizard step 없음** |
| **C** | Transform route 단위? | **PARTIAL** | flag ON 시 per-route; **default OFF + UI stream-only** |
| **D** | Protection route 단위? | **PARTIAL** | 동일 |
| **E** | Classification route 단위? | **PARTIAL** | 동일 |
| **F** | Policy route 단위? | **PARTIAL** | 동일 |
| **G** | Destination별 처리 위해 Stream 복제 필요? | **PASS** | `routeDrafts` multi-route; 복제 패턴 없음 |
| **H** | One Stream → Many Routes → Many Destinations 코드 반영? | **PASS** | DB, wizard, streams console, routes overview |

---

## 5. Union Schema 감사

| # | 확인 항목 | 판정 |
|---|-----------|------|
| 1 | Sample 단계 Union Schema 생성 | **PASS** (클라이언트 `buildUnionSchema`) |
| 2 | Transform Single Event Tree | **PARTIAL** — Basic은 union, full-event/preview는 single |
| 3 | Transform Union Schema 사용 | **PARTIAL** — Basic mapping만 |
| 4 | Rare Field 표시 | **PARTIAL** — badge 있음, 30% 규칙 없음 |
| 5 | Sensitive Suggestion | **PARTIAL** — 휴리스틱 badge, detection engine 아님 |
| 6 | Unknown Field Pass Through (runtime) | **PASS** — `pass_through` default + delivery 테스트 |

---

## 6. Governance 감사

| # | 확인 항목 | 판정 |
|---|-----------|------|
| 1 | 설정 Scope = Stream | **PASS** |
| 2 | 실행 Scope = Route | **PARTIAL** — runtime only when `GDC_ROUTE_PROCESSING_ENABLED` |
| 3 | Route Override | **PARTIAL** — backend `route_overrides`; UI 없음 |
| 4 | Destination별 Governance 차이 | **PARTIAL** — route resolver; UI 없음 |
| 5 | Governance 때문에 Stream 복제 필요? | **PASS** — 복제 요구 없음 |

---

## 7. UX 감사

| # | 확인 항목 | 판정 |
|---|-----------|------|
| 1 | Destination First → Route Processing 순서 | **FAIL** — Transform 선행, Route Processing 단계 없음 |
| 2 | Route 생성 UX | **PARTIAL** — wizard OK; standalone `/routes/new` 불완전 |
| 3 | Deploy Summary | **PASS** (Route Processing 섹션 제외) |
| 4 | Stream Group UX | **PARTIAL** — Streams 페이지만; Dashboard 없음 |
| 5 | Dashboard 구조 | **PARTIAL** — stream KPI; charter P0 group/issues gap |
| 6 | Route 개념 UI 자연스러움 | **PARTIAL** — fan-out·ops는 있음; processing unit 인지 약함 |

---

## 8. 점수

### Route Architecture: **62 / 100**

| 가중 요소 | 점수 근거 |
|-----------|-----------|
| Backend M13 (091–096) | +35 — 구현·마이그레이션·테스트 존재 |
| Default production path | +5 — flag OFF → stream fan-out |
| Data topology | +15 — stream/route/destination 모델 정합 |
| Per-route UI/API | +5 — delivery 설정만 |
| Route override runtime | +7 — resolver 구현 |
| Wizard/operator configurability | −5 — route rule UI 부재 |

### Destination First UX: **52 / 100**

| 가중 요소 | 점수 근거 |
|-----------|-----------|
| Multi-destination wizard | +20 — `step-delivery`, routeDrafts |
| v5.2 step order | −15 — transform 삽입, route processing 없음 |
| Destination-first mental model | −10 — mapping before destinations |
| Routes/Destinations ops UI | +20 |
| Navigation charter | −8 — routes top-level, governance top-level |
| Route create completeness | −5 |
| Dashboard destination-first | +10 — data flow partial |
| Processing unit UX | −10 |

---

## 9. OSS v1 적합성

**판정: FAIL** (Product Charter + Wizard v5.2 + UX Charter Route/Destination First 기준)

| 기준 | 결과 |
|------|------|
| Data Delivery Gateway 기본 전달 | **동작** — stream + routes fan-out |
| Product Charter Route Processing Model | **미충족** — per-route UI·default runtime |
| Wizard v5.2 | **미충족** — step 구조 불일치 |
| Guardrail DoD (UI Complete) | M13 route processing **UI incomplete** |
| AI Gateway 금지 등 guardrail | **준수** — 해당 코드 없음 |

**운영 관점:** 기존 OSS GA(stream mapping + multi-route delivery)는 **사용 가능**. SoT가 정의한 **Destination First + Route Processing** 제품 완성도 기준에서는 **미완**.

---

## 10. 수정 필요 항목 우선순위

### P0 (아키텍처·Charter 정합)

1. **Wizard v5.2 step 재구성** — `transform`을 Route Processing에 흡수하거나 순서를 Destinations → Route Processing → Deploy로 변경 (`wizard-state.ts`, stepper, gates).
2. **Route Processing wizard step 신설** — per-route transform/protection/classification/policy intent (최소 MVP: route draft별 요약 + stream default 상속 표시).
3. **`GDC_ROUTE_PROCESSING_ENABLED` 운영 전략** — default ON 로드맵 또는 OSS scope 문서화; GA와 M13 경계 명확화.
4. **Per-route 설정 UI/API** — M13 테이블(`route_mappings`, `route_protection_rules`, etc.)에 대한 operator CRUD (route edit 또는 wizard embed).

### P1 (UX·운영)

5. `/routes/new` stream 바인딩 필수화 (destination-first create flow).
6. Dashboard Stream Group P0 KPI 복원 (`dashboard-overview.tsx`).
7. Navigation charter 정렬 — Routes를 Destinations 하위 컨텍스트로 이동 검토.
8. `union_schema` wizard → `streams.config_json` persist + runtime contract.
9. Edit Stream와 Wizard journey 정렬 (또는 explicit dual-mode 문서화).

### P2 (Union Schema· polish)

10. Union sample 10–20 event 정책 enforcement.
11. Rare field 30% threshold (`unionSchema.ts`).
12. Sensitive detection at union build (backend preview API 연동).
13. Operational Issues panel Dashboard 마운트.
14. Violation/Replay detail에 `quarantineSource` 전달 (B2 follow-up).

---

## 11. 검증에 사용한 테스트 (read-only 실행)

| Suite | Result |
|-------|--------|
| M13 / governance backend (sample) | 35 passed (prior B2 audit subset) |
| Schema drift runtime | 29 passed (Commit A on origin) |
| B1/B2 frontend vitest | green (observability/humanization) |

**본 감사는 전체 regression 미실행.** 파일·구조·플래그·grep·서브시스템 탐색 기준.

---

## 12. 핵심 코드 인덱스

```
Wizard
  frontend/src/components/streams/wizard/wizard-state.ts
  frontend/src/components/streams/new-stream-wizard-page.tsx
  frontend/src/components/streams/wizard/step-delivery.tsx
  frontend/src/components/streams/wizard/step-mapping-combined.tsx
  frontend/src/components/streams/wizard/step-deploy.tsx

M13 Runtime
  app/config.py  (GDC_ROUTE_PROCESSING_ENABLED)
  app/runners/stream_runner.py
  app/runners/route_stage.py
  app/route_transform|protection|classification|policy|delivery/

Union Schema
  frontend/src/utils/unionSchema.ts
  frontend/src/components/streams/union-schema-tree.tsx

Schema Drift
  app/schema_drift_policy/
  frontend/src/lib/stream-schema-drift-policy.ts

Routes/Destinations UX
  frontend/src/components/routes/
  frontend/src/components/destinations/
  frontend/src/config/app-navigation.tsx
```

---

*Audit read-only 2026-06-17. HEAD 5205960.*
