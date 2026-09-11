# DATA RELAY — Schema Drift Policy Runtime Spec

**Document:** `DATA-RELAY-SCHEMA-DRIFT-POLICY-RUNTIME-SPEC.md`  
**Status:** CURRENT — Stream-scoped Schema Drift Policy Runtime (Wizard → Deploy → StreamRunner)  
**Date:** 2026-06-14; intro aligned 2026-08-13  
**Related:** `specs/065-protection-engine/spec.md`, `specs/002-runtime-pipeline/spec.md`, `.specify/memory/constitution.md` (checkpoint rule)

---

## 1. Purpose

Stream Wizard에서 사용자가 선택한 **Schema Drift Policy**가 Runtime에서 실제로 적용되도록 한다.

정책은 **Stream scope**로 `streams.config_json.governance.schema_drift_policy`에 persist 된다 (Deploy). Unknown Field 기본값은 **Pass Through**. 새 필드 발견만으로 Confirmed Drift가 되지 않는다. 본 스펙은 **저장 위치, 적용 시점, 정책별 동작, 경로 변환, Checkpoint, Deploy 연동, Preview, 테스트**를 정의한다.

### Non-Goals

| 제외 | 이유 |
|------|------|
| 새 Drift Detection 엔진 | M1–M4 read-only 신호 유지 |
| 새 Policy DSL / Governance Policy 연동 | `StreamPolicyRule`·`governance_policies`와 혼동 방지 |
| `field_removed` / `field_type_changed` 정책 | Wizard 범위는 **Unknown Field**(신규 필드)만 |
| UI 재설계 | Deploy persist·Preview parity만 명시 (별도 UX 작업) |
| AI-assisted drift 처리 | Advanced Transform / AI 정책 금지 |

---

## 2. Policy Definitions (Wizard ↔ Runtime)

### 2.1 Unknown Normal Field

신규 필드가 **민감하지 않다**고 판정된 경우 적용한다.

| Wizard label | Runtime value | Default |
|--------------|---------------|---------|
| Pass Through | `pass_through` | **Yes** |
| Require Review | `require_review` | |
| Quarantine | `quarantine` | |

### 2.2 Unknown Sensitive Field

신규 필드가 **민감하다**고 판정된 경우 적용한다.

| Wizard label | Runtime value | Default |
|--------------|---------------|---------|
| Auto Protect | `auto_protect` | **Yes** |
| Require Review | `require_review` | |
| Quarantine | `quarantine` | |

### 2.3 Normative mapping

사용자가 Wizard에서 선택한 값이 Runtime에서 **동일 의미**로 적용되어야 한다. 아래 §5가 단일 진실 공급원이다.

---

## 3. Policy Storage

### 3.1 Location (normative)

정책은 Stream 단위로 `streams.config_json`에 저장한다.

```json
{
  "governance": {
    "schema_drift_policy": {
      "unknown_normal_field_policy": "pass_through",
      "unknown_sensitive_field_policy": "auto_protect"
    }
  }
}
```

### 3.2 Field contract

| Field | Type | Allowed values | Default when absent |
|-------|------|----------------|---------------------|
| `unknown_normal_field_policy` | string | `pass_through`, `require_review`, `quarantine` | `pass_through` |
| `unknown_sensitive_field_policy` | string | `auto_protect`, `require_review`, `quarantine` | `auto_protect` |

### 3.3 Validation

- Deploy 및 Stream PATCH 시 위 enum만 허용; 잘못된 값은 **422** 또는 Deploy 오류로 거부.
- `governance` 또는 `schema_drift_policy` 키가 없으면 **기본값** 적용 (기존 Stream 동작 유지).
- 정책은 `stream_protection_rules` / `stream_policy_rules`에 **중복 저장하지 않는다** (단일 소스: `config_json`).

### 3.4 Read API

Runtime/UI는 Stream read 시 `config_json.governance.schema_drift_policy`를 그대로 노출한다. 별도 테이블·Migration은 **1단계에서 불필요**하다.

---

## 4. Runtime Architecture

### 4.1 Design principle — compose existing engines

**새 엔진을 만들지 않는다.** 기존 컴포넌트를 조합하는 **얇은 오케스트레이터**만 추가한다.

| 액션 | 기존 컴포넌트 |
|------|----------------|
| Pass Through | Mapping pass-through (no-op at policy layer) |
| Require Review | Structured observability / `delivery_logs` (no delivery block) |
| Auto Protect | **Protection Engine** (`protect_batch` / `protect_events_for_delivery`) |
| Quarantine | **Policy + Quarantine** (`PolicyBatchResult` → `try_policy_quarantine_for_batch` → `record_policy_quarantine_event`) |

오케스트레이터 모듈(권장 경로): `app/schema_drift_policy/orchestrator.py`  
책임: 정책 로드, Unknown Field 판정, 경로 해석, 기존 엔진 호출만 수행. 감지 로직은 `app/schema_observation/`에 그대로 둔다.

### 4.2 Pipeline position (normative)

```text
Extract
  → Schema Observation (M1, extracted paths, read-only signals)
  → Mapping
  → Enrichment
  → Sensitive Detection (M5)
  → Classification (M13)
  → ★ Schema Drift Policy Orchestrator ★   ← NEW hook
  → Protection Engine (M6)
  → Policy Engine (M8)
  → Policy Quarantine (M12)
  → Dynamic Routing
  → Fan-out / Destination Send
  → Checkpoint (successful delivery only)
```

**적용 시점:** Sensitive Detection **이후**, Protection **이전**.

**이유:**

1. 신규 필드가 민감한지 배치 단위로 이미 판별됨 (`SensitiveDetectionContext`).
2. `auto_protect`는 Protection Engine이 enriched 경로에서 mask를 적용해야 함.
3. `quarantine`은 Protection이 적용된 **delivery copy**를 격리 스냅샷에 저장하는 기존 Quarantine 경로와 정합 (Protection → Policy → Quarantine 순서 유지).

### 4.3 Feature flag

| Setting | Default | Behavior when false |
|---------|---------|---------------------|
| `GDC_SCHEMA_DRIFT_POLICY_ENABLED` | `true` | Orchestrator no-op; 정책 저장값은 유지되나 Runtime 미적용 |

Drift **감지**는 `GDC_SCHEMA_DRIFT_DETECTION_ENABLED`에 종속 (기존과 동일). 정책 적용은 별도 flag.

### 4.4 “Unknown Field” 판정 (normative)

한 Run의 enriched 배치에서 필드 `F`가 **Unknown**이려면 **모두** 충족:

1. Stream에 open 상태의 `field_added` drift finding이 존재 (`stream_schema_field_drifts`, `category=field_added`, `status=open`).
2. 해당 finding의 `field_path`(추출 네임스페이스)가 §6 경로 해석을 통해 enriched 경로 `F'`로 매핑됨.
3. 현재 배치의 enriched 이벤트에 `F'`가 실제로 존재 (값 존재 여부는 mask/quarantine 판단에 사용).

**민감 / 비민감 분류:**

| 분류 | 조건 |
|------|------|
| **Unknown Sensitive** | Unknown `F`에 대해 현재 배치 `SensitiveDetectionContext.findings`에 동일 enriched 경로 `F'` (또는 동일 `sensitivity_class` hit)가 있음 |
| **Unknown Normal** | Unknown `F`이나 Sensitive hit 없음 |

Drift confirm gate (`GDC_SCHEMA_DRIFT_ADDED_CONFIRM_RUNS`) 및 Sensitive confirm gate (`GDC_SENSITIVE_DETECTION_CONFIRM_RUNS`)는 **기존 값 유지**. 정책은 confirm된 신호에만 반응한다.

배치에 Unknown Field가 **하나라도** 있으면 해당 정책을 평가한다. 여러 Unknown Field가 서로 다른 정책 결과를 내면 **가장 강한 액션**이 배치 전체를 지배한다.

**액션 강도 (배치):** `pass_through` / `require_review` (0) &lt; `auto_protect` (1, 필드 마스킹만) &lt; `quarantine` (2, 배치 격리).

동일 강도면: Sensitive 정책이 Normal 정책보다 우선 (민감 데이터가 더 위험).

---

## 5. Policy Actions (normative)

### 5.1 Unknown Normal Field

#### `pass_through`

| 항목 | 동작 |
|------|------|
| Mapping | 기존 `merge_unknown_field_pass_through` 유지 — 미매핑 소스 구조가 enriched 출력에 병합됨 |
| Orchestrator | **no-op** |
| Protection | 기존 `stream_protection_rules`만 적용 |
| Policy / Quarantine | 추가 평가 없음 |
| Delivery | **계속** |
| Checkpoint | 성공 배달 시 **갱신** (헌법 준수) |
| Observability | 선택: `stage=schema_drift_policy`, `action=pass_through`, `unknown_normal_paths=[...]` (경로만, 값 없음) |

#### `require_review`

| 항목 | 동작 |
|------|------|
| Drift / Sensitive DB | 기존 open finding 유지 (이미 생성됨) |
| Orchestrator | structured log 1건: `stage=schema_drift_policy_review`, `policy=unknown_normal`, `field_paths=[...]`, `drift_finding_ids=[...]` |
| Governance UI | 기존 `deriveGovernanceIssues` schema-drift / sensitive 경고 유지 |
| Delivery | **계속** (차단 없음) |
| Checkpoint | 성공 배달 시 **갱신** |

#### `quarantine`

| 항목 | 동작 |
|------|------|
| Orchestrator | 배치에 Unknown Normal Field가 있으면 **quarantine 요청** 발생 |
| Protection | **선행 실행** — 이후 단계에서 delivery copy 생성 (기존 파이프라인 순서 유지) |
| Policy / Quarantine | Orchestrator가 `PolicyBatchResult`에 **가상 matched quarantine evaluation**을 주입하거나, 동등하게 `try_policy_quarantine_for_batch`가 `true`를 반환하도록 함. `quarantine_reason`: `schema_drift:unknown_normal` (또는 `schema_drift:unknown_normal,<path>`) |
| `quarantine_source` | `policy` 유지 (기존 M12 경로 재사용). `metadata_json`에 `schema_drift_policy: unknown_normal`, `field_paths`, `drift_finding_ids` 포함 |
| Fan-out | **스킵** |
| Checkpoint | **갱신하지 않음** (§7) |
| Observability | `stage=quarantine_applied`, `update_reason=policy_quarantine` (기존과 동일 패턴) |

### 5.2 Unknown Sensitive Field

#### `auto_protect`

| 항목 | 동작 |
|------|------|
| Orchestrator | Unknown Sensitive enriched 경로 목록 산출 |
| Protection Engine | 해당 경로에 **배치 한정 가상 규칙** 적용: `protection_mode = default_mode_for_class(sensitivity_class)` (`app/protection/operator_workflow.default_mode_for_class`). `stream_protection_rules`에 **영구 INSERT 하지 않음** (M6 수동 acknowledge 흐름과 분리) |
| DB protection rules | 기존 enabled rules와 **합산** 적용 (가상 규칙 + persisted rules) |
| Policy / Quarantine | 추가 없음 (unless 별도 StreamPolicyRule이 sensitivity_class로 quarantine 요구) |
| Delivery | **계속** (masked delivery copy) |
| Checkpoint | 성공 배달 시 **갱신** (enriched 원본은 checkpoint cursor용으로 비변경 — M6 동일) |
| Observability | `stage=schema_drift_policy`, `action=auto_protect`, `protected_paths=[...]`, `modes={...}` (값 없음) |
| Sensitive finding | 자동 resolve **하지 않음** — 운영자 워크플로 open/acknowledged 유지 |

#### `require_review`

| 항목 | 동작 |
|------|------|
| Drift / Sensitive DB | 기존 신호 유지 |
| Orchestrator | `stage=schema_drift_policy_review`, `policy=unknown_sensitive`, `field_paths=[...]`, `sensitivity_classes=[...]` |
| Protection | persisted rules만 (가상 규칙 없음) |
| Delivery | **계속** (cleartext 가능 — 운영자 리뷰 전제) |
| Checkpoint | 성공 배달 시 **갱신** |

#### `quarantine`

| 항목 | 동작 |
|------|------|
| Orchestrator | Unknown Sensitive Field가 배치에 있으면 quarantine 요청 |
| Protection | 선행 실행 (masked copy가 quarantine payload에 저장될 수 있음 — 기존 policy quarantine과 동일) |
| Policy / Quarantine | `quarantine_reason`: `schema_drift:unknown_sensitive` (+ policy/sensitivity 메타). `try_policy_quarantine_for_batch` 경로 |
| Fan-out | **스킵** |
| Checkpoint | **갱신하지 않음** (§7) |

### 5.3 상호작용 요약

| Normal \\ Sensitive (같은 배치) | 결과 |
|--------------------------------|------|
| pass_through + auto_protect | Normal pass, Sensitive paths masked, **delivery 계속** |
| quarantine + pass_through | **quarantine** (강한 액션 우선) |
| require_review + require_review | delivery 계속, review 로그 2종 |
| quarantine + quarantine | quarantine 1회, checkpoint 미갱신 |

---

## 6. Path Handling

### 6.1 Two namespaces

| Stage | Path namespace | Example |
|-------|----------------|---------|
| Schema Observation / Drift | **Extracted** (Mapping 전 raw event) | `$.user.email` |
| Sensitive Detection / Protection / Delivery | **Enriched** (Mapping + Enrichment 후) | `$.email` |

Drift finding `field_path`는 **추출 네임스페이스에 저장** (기존 M1–M4 변경 없음).

### 6.2 What to store (unchanged)

| Store | Path form |
|-------|-----------|
| `stream_observed_schemas.paths_json` | Extracted |
| `stream_schema_field_drifts.field_path` | Extracted |
| `stream_sensitive_findings.field_path` | Enriched |
| `stream_protection_rules.field_path` | Enriched |
| Quarantine / Replay payload | Enriched (protected delivery copy) |

### 6.3 Runtime resolution (extracted → enriched)

Orchestrator는 Stream의 Mapping·Enrichment 설정으로 **alias map**을 구성한다. 알고리즘은 Wizard `resolveProtectionFieldPath` / `buildProtectionPathAliasMap`과 **동일 우선순위**를 따른다.

**Resolution order** (for drift `field_path` `E`):

1. **Exact enriched match** — `E`가 배치 enriched path set에 있으면 `E` 사용.
2. **Mapping alias** — `field_mappings_json`의 source JSONPath → output field (Basic JSONPath: `$.user.email` → `$.email`). Full-event JSONata/regex 모드는 해당 규칙의 source/output 매핑 테이블 사용.
3. **Enrichment alias** — normalize 등 enrichment rule의 source → target field.
4. **Leaf segment match** — leaf가 유일하면 해당 enriched path 사용.
5. **Failure** — §6.4

구현 모듈(권장): `app/schema_drift_policy/path_resolve.py` (Wizard 로직과 테스트 parity 유지).

### 6.4 Resolution failure

| 항목 | 동작 |
|------|------|
| Policy effect | 해당 필드는 정책 enforcement **제외** |
| Delivery | **계속** (배치 전체 quarantine으로 승격하지 않음) |
| Observability | `stage=schema_drift_policy_path_unresolved`, `extracted_path=...`, `stream_id=...` |
| Operator | Governance 이슈에 “경로 해석 실패” warning (선택, post-MVP) |
| Safe default | `require_review`에 준하는 로그만 남기고 **차단·mask 없음** |

### 6.5 Ambiguous leaf match

Leaf segment가 복수 enriched path와 매칭되면 **실패** 처리 (§6.4와 동일).

### 6.6 Transform으로 경로가 바뀐 필드 — 예시

| Extracted (drift) | Mapping | Enriched (runtime) | Policy applies at |
|-------------------|---------|-------------------|-------------------|
| `$.user.email` | `email` ← `$.user.email` | `$.email` | `$.email` |
| `$.items[].sku` | `sku` ← `$.items[].sku` | `$.items[].sku` or `$.sku` | resolved path |
| Full-event JSONata reshape | expression-defined | expression output paths | alias from preview compile |

테스트는 §10 “Transform으로 경로가 바뀐 필드” 케이스로 고정한다.

---

## 7. Checkpoint Policy

헌법: **Checkpoint는 Destination 배달 성공 후에만 갱신.**

| Outcome | Checkpoint |
|---------|------------|
| Normal delivery success | **갱신** (`last_success_event` 등 기존 규칙) |
| Schema Drift Policy **quarantine** (Normal or Sensitive) | **갱신하지 않음** |
| Dry-run | 갱신하지 않음 (기존) |
| Delivery failure → Replay | 갱신하지 않음 (기존 `specs/068-replay-engine`) |

Quarantine 시 `StreamRunner` summary:

- `checkpoint_updated: false`
- `update_reason: policy_quarantine` (기존 문자열 유지) 또는 `schema_drift_quarantine` (구현 시 하나로 통일, observability만 구분)

Enriched 원본 배치는 checkpoint cursor 추출에 사용하지 않음 (quarantine 시 fan-out 없음).

---

## 8. Deploy Integration

### 8.1 Requirement

Wizard Review/Deploy에 표시된 Schema Drift Policy는 Deploy 성공 시 **반드시** `streams.config_json.governance.schema_drift_policy`에 저장되어야 한다. Draft에만 존재해서는 **안 된다**.

### 8.2 Deploy sequence (normative)

```text
1. Stream / Mapping / Routes / … (기존 Deploy)
2. persistWizardDataProtectionIntents() (기존 — intents만, drift policy 제외)
3. persistWizardSchemaDriftPolicy(streamId, state.dataProtection)  ← NEW
   → PATCH streams.config_json with merge (기존 governance 키 보존)
4. Deploy outcome에 schemaDriftPolicySaved: boolean 반영
```

### 8.3 Frontend contract (implement later)

| 함수 (권장) | 책임 |
|-------------|------|
| `persistWizardSchemaDriftPolicy(streamId, dataProtection)` | enum 정규화 후 API PATCH |
| `buildSchemaDriftPolicyPersistPayload()` | Review/Deploy 표시와 동일 payload 생성 |

정규화는 `normalizeUnknownNormalFieldPolicy` / `normalizeUnknownSensitiveFieldPolicy` (Wizard 기본값과 동일).

### 8.4 Deploy failure

Policy PATCH 실패 시 Deploy outcome `errors`에 포함; Stream은 생성되었으나 정책 미저장이면 `schemaDriftPolicySaved: false` 및 경고 메시지.

### 8.5 Stream edit (post-MVP note)

Runtime Stream 설정 UI에서 정책 변경 시 동일 `config_json` 경로 사용 (본 스펙 범위 외, 동일 contract 재사용).

---

## 9. Preview / Review Parity

### 9.1 Review & Deploy display

Review·Deploy 화면의 `schemaDriftPolicyReviewSummary()` 출력은 **저장될 JSON 값과 1:1 대응**해야 한다.

| UI label | Stored value |
|----------|--------------|
| Pass Through | `pass_through` |
| Require Review | `require_review` |
| Quarantine | `quarantine` |
| Auto Protect | `auto_protect` |

### 9.2 Runtime Preview

`preview_service` / pipeline-debug preview는 다음을 **실제 Runtime과 동일 orchestrator**로 시뮬레이션한다 (DB commit 없음):

| Preview output (additive) | Description |
|---------------------------|-------------|
| `schema_drift_policy.normal` | 적용될 normal 정책 값 |
| `schema_drift_policy.sensitive` | 적용될 sensitive 정책 값 |
| `schema_drift_policy.would_quarantine` | boolean |
| `schema_drift_policy.would_auto_protect_paths` | enriched path list (값 없음) |
| `schema_drift_policy.unresolved_paths` | extracted paths that failed §6.4 |

Preview는 open drift DB row가 없을 수 있으므로, **시뮬레이션 모드**에서는 “이 배치에 baseline 대비 신규 path가 있다면” 가정하거나 Wizard sample + baseline fixture를 사용한다. 상세는 구현 시 `preview_service` 테스트로 고정.

### 9.3 Wizard Deploy readiness

`wizard-deploy-readiness`는 정책 값 유효성만 검사 (항상 complete — 기본값 있음). 별도 blocking 조건 없음.

---

## 10. Observability

### 10.1 Allowed log fields

| Field | OK |
|-------|-----|
| `stream_id`, `policy`, `action`, `field_path`, `extracted_path`, `enriched_path`, `drift_finding_id`, `sensitivity_class`, `protection_mode` | Yes |
| Raw field values, samples, payloads | **Forbidden** |

### 10.2 Stages

| stage | When |
|-------|------|
| `schema_drift_policy` | pass_through / auto_protect applied |
| `schema_drift_policy_review` | require_review |
| `schema_drift_policy_path_unresolved` | §6.4 |
| `quarantine_applied` | quarantine (기존) |

---

## 11. Testing Plan

### 11.1 Unit / integration (backend)

| # | Case | Assert |
|---|------|--------|
| T1 | Unknown Normal = `pass_through` | Delivery proceeds; no quarantine; no extra mask beyond existing rules |
| T2 | Unknown Normal = `require_review` | `schema_drift_policy_review` log; delivery proceeds; checkpoint updated on success |
| T3 | Unknown Normal = `quarantine` | `try_policy_quarantine_for_batch` true; fan-out skipped; **checkpoint not updated** |
| T4 | Unknown Sensitive = `auto_protect` | Protection applied on resolved enriched paths with `default_mode_for_class`; delivery proceeds; **no** new `stream_protection_rules` row |
| T5 | Unknown Sensitive = `require_review` | Review log; cleartext delivery (no ephemeral rules); checkpoint updated on success |
| T6 | Unknown Sensitive = `quarantine` | Quarantine recorded; fan-out skipped; **checkpoint not updated** |
| T7 | Quarantine → checkpoint | Explicit assert `checkpoint_updated is false`, `update_reason` in allowed set |
| T8 | Transform path remap | Drift `$.user.email`, mapping → `$.email`, policy applies at `$.email` |
| T9 | Path resolution failure | No quarantine; `schema_drift_policy_path_unresolved` log; delivery continues |
| T10 | Ambiguous leaf | Same as T9 |
| T11 | Policy absent in config_json | Defaults `pass_through` + `auto_protect` |
| T12 | `GDC_SCHEMA_DRIFT_POLICY_ENABLED=false` | No-op regardless of stored policy |

### 11.2 Deploy / frontend (later)

| # | Case | Assert |
|---|------|--------|
| D1 | Deploy with custom policies | GET stream → `config_json.governance.schema_drift_policy` matches Wizard |
| D2 | Review summary | Labels match stored enums |
| D3 | Draft migration | Legacy draft without keys → defaults on load; persisted on deploy |

### 11.3 Regression

기존 suites **PASS 유지**:

- `tests/test_schema_field_drift.py` (detection unchanged)
- `tests/test_sensitive_findings_api.py`
- `tests/test_protection_api.py`
- `tests/test_governance_quarantine_m19_2.py`
- E2E smoke when StreamRunner touched

---

## 12. Implementation File List (reference)

구현 시 예상 변경 (본 문서 작성만 수행, 코드 미변경):

### Backend

| File | Change |
|------|--------|
| `app/schema_drift_policy/orchestrator.py` | **NEW** — policy load, unknown field classification, action dispatch |
| `app/schema_drift_policy/path_resolve.py` | **NEW** — extracted → enriched resolution |
| `app/schema_drift_policy/schemas.py` | **NEW** — config validation helpers |
| `app/runners/stream_runner.py` | Hook between classification and `_prepare_delivery_events` |
| `app/protection/service.py` | Optional: accept ephemeral rules list for one batch |
| `app/protection/engine.py` | Merge ephemeral + persisted rules in `protect_batch` |
| `app/quarantine/service.py` | Accept orchestrator-injected quarantine signal (no DSL change) |
| `app/runtime/preview_service.py` | Preview parity fields |
| `app/streams/schemas.py` | Validate `governance.schema_drift_policy` on PATCH |
| `app/config.py` | `GDC_SCHEMA_DRIFT_POLICY_ENABLED` |

### Frontend (Deploy only)

| File | Change |
|------|--------|
| `frontend/src/components/streams/wizard/wizard-schema-drift-policy-persist.ts` | **NEW** |
| `frontend/src/components/streams/wizard/new-stream-wizard-page.tsx` | Call persist on deploy |
| `frontend/src/components/streams/wizard/wizard-state.ts` | Outcome type `schemaDriftPolicySaved` |

### Tests

| File | Change |
|------|--------|
| `tests/test_schema_drift_policy_runtime.py` | **NEW** — T1–T12 |
| `tests/test_wizard_schema_drift_policy_persist.ts` | **NEW** — D1–D3 |

### Spec index (follow-up)

| File | Change |
|------|--------|
| `specs/091-schema-drift-policy-runtime/spec.md` | Short pointer to this doc (optional) |
| `.specify/specs-index.md` | Entry add (optional) |

---

## 13. Acceptance Criteria

1. Wizard에서 선택한 6가지 정책 조합이 Runtime에서 §5와 동일하게 동작한다.
2. Deploy 후 `streams.config_json.governance.schema_drift_policy`에 값이 저장된다.
3. Review/Deploy 표시와 저장값이 일치한다.
4. Quarantine 시 checkpoint가 갱신되지 않는다.
5. Extracted ↔ enriched 경로 변환이 §6.3–6.4대로 동작한다.
6. 새 Drift Detection 엔진 없이 기존 Protection / Policy / Quarantine만 사용한다.
7. §11 테스트가 PASS한다.

---

## Appendix A — Default policy matrix (quick reference)

| User intent | Runtime storage | Delivery | Protection | Quarantine | Checkpoint on success |
|-------------|-----------------|----------|------------|------------|---------------------|
| Normal: Pass Through | `pass_through` | Continue | As-is | No | Update |
| Normal: Require Review | `require_review` | Continue | As-is | No | Update |
| Normal: Quarantine | `quarantine` | Block | Pre-quarantine mask | Yes | **No update** |
| Sensitive: Auto Protect | `auto_protect` | Continue | Ephemeral mask | No | Update |
| Sensitive: Require Review | `require_review` | Continue | As-is | No | Update |
| Sensitive: Quarantine | `quarantine` | Block | Pre-quarantine mask | Yes | **No update** |

---

## Appendix B — Relation to existing Wizard data protection intents

`dataProtection.intents` → `stream_protection_rules` / `stream_policy_rules` (sensitivity **class** 기반)는 **유지**한다.

`schema_drift_policy` → **신규 필드** (drift `field_added` + batch presence) 기반으로 **추가** 적용한다.

동일 배치에서 intents의 quarantine policy rule과 drift quarantine이 동시에 매칭되면 **하나의 quarantine 이벤트**로 합침 (기존 `record_policy_quarantine_event` metadata에 both reasons).
