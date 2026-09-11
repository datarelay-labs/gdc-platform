# Data Relay OSS v1 RC — Release Notes

**Status:** HISTORICAL RC SNAPSHOT (2026-06-19) — do not treat flag defaults below as current product truth.
**Current default:** `GDC_ROUTE_PROCESSING_ENABLED=true` (rollback `false`). SMTP operational email delivery is implemented (`SmtpEmailSender`; default `SMTP_ENABLED=false` skips send). Slack remains planned. See [`KNOWN-LIMITATIONS.md`](./KNOWN-LIMITATIONS.md) and [`source-of-truth-index.md`](../architecture/source-of-truth-index.md).

**Release candidate:** OSS v1 RC
**Validation commit:** `7623d94` — Fix frontend tests for Governance sidebar IA and route effective mocks.
**Date:** 2026-06-19

---

## 제품 소개

**Data Relay OSS v1 RC**는 오픈소스 데이터 릴레이 플랫폼의 첫 번째 Release Candidate입니다. 커넥터 기반 수집, 스트림 단위 변환·거버넌스, 멀티 라우트 전달을 하나의 운영 콘솔에서 구성·관측할 수 있습니다.

이 RC는 기능 동결(freeze) 상태이며, GA 전 최종 검증·패키징·문서화를 위한 후보 빌드입니다.

---

## 핵심 기능

| 영역 | 설명 |
|------|------|
| **Connector** | 소스 커넥터 카탈로그 및 연결 관리 |
| **Stream Wizard** | 스트림 생성·설정 마법사 (소스, 매핑, 라우트, 거버넌스 단계) |
| **Transform** | Basic JSONPath, Advanced JSONata, Expert `regex_extract` 변환 |
| **Multi Route Delivery** | 스트림당 다중 라우트 및 목적지 전달 |
| **Protection** | 스트림·라우트 단위 보호(마스킹/차단) 오버라이드 |
| **Classification** | 스트림·라우트 단위 분류 오버라이드 |
| **Policy** | 스트림·라우트 단위 정책 오버라이드 |
| **Governance Workspace** | 운영자용 거버넌스 관측 워크스페이스 (Read Only MVP) |
| **Route Processing Operator** | 라우트 편집·처리 개요 및 per-route 연산자 API/UI |

---

## 이번 RC에서 포함된 주요 마일스톤

- **M13.3 Protection Override** — 스트림·라우트 보호 오버라이드 및 레거시 fan-out 경로 연동
- **M13.4 Classification Override** — per-route 분류 오버라이드 C-lite 레거시 브리지
- **M13.5 Policy Override** — per-route 정책 연산자 API 및 Route Edit Policy 탭
- **Route Processing Overview** — 스트림 라우트 처리 개요 UI
- **Governance Workspace MVP** — Read Only 거버넌스 워크스페이스

---

## 제한 사항

### `GDC_ROUTE_PROCESSING_ENABLED`

| 항목 | 값 |
|------|-----|
| **기본값** | `False` (`app/config.py`) |
| **설명** | OSS v1 RC는 **stream-scoped runtime**을 기본으로 사용합니다. Per-route runtime pipeline은 **실험 기능**이며, 플래그를 명시적으로 `true`로 설정해야 활성화됩니다. |

플래그가 `false`일 때:

- 기존 stream-scoped Protection / Classification / Policy 경로가 유지됩니다.
- 레거시 fan-out 전달 동작과 동등한 운영 패턴을 권장합니다.

플래그가 `true`일 때:

- 라우트 루프 기반 처리 경로가 사용됩니다 (실험).
- 스트림 단위 Protection / Classification / Policy는 공유 pre-route 배치에서 실행되지 않습니다.

---

## Known Limitations

- **Governance Workspace** — Read Only MVP; 편집·승인 워크플로는 후속 버전 예정
- **Route Processing Flag** — 기본 OFF; 프로덕션에서는 stream-scoped 경로 권장
- **Route-scoped advanced runtime** — per-route 고급 런타임 파이프라인 전면 지원은 차기 버전 예정
- **Regex replace** — Advanced Transform MVP에서 제외 (`regex_extract`만 Expert 모드 지원)

---

## 배포 참고

- 플랫폼 이미지: `gdc-platform-frontend`, `gdc-platform-api` (`docker-compose.platform.yml`)
- 설치·업그레이드: `scripts/release/install.sh`, `scripts/release/upgrade.sh`
- 프로덕션 체크리스트: `docs/release/production-checklist.md`

---

## 검증 게이트 (RC 패키징)

| Gate | 명령 |
|------|------|
| Backend Full | `scripts/test/run-backend-full.sh` |
| Frontend Tests | `cd frontend && npm test` |
| Frontend Build | `cd frontend && npm run build` |
| Docker Build | `docker compose -f docker-compose.platform.yml build frontend api` |

---

*Data Relay OSS v1 RC — Release Candidate packaging document.*
