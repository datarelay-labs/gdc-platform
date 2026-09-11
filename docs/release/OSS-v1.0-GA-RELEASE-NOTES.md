# Data Relay OSS v1.0 GA — Release Notes

**Status:** HISTORICAL GA SNAPSHOT (2026-06-20) — do not treat Known Gaps or env defaults below as current product truth.
**Current defaults:** Route Processing ON (`GDC_ROUTE_PROCESSING_ENABLED=true`); Schema Drift fleet count = confirmed open `StreamSchemaFieldDrift` (Runtime Snapshot); SMTP operational email delivery implemented (`SmtpEmailSender`; default `SMTP_ENABLED=false` skips send). Slack remains planned.
**Current reading order:** [`source-of-truth-index.md`](../architecture/source-of-truth-index.md), [`KNOWN-LIMITATIONS.md`](./KNOWN-LIMITATIONS.md), [`OSS-v1-ARCHITECTURE.md`](../architecture/OSS-v1-ARCHITECTURE.md)

**Release:** OSS v1.0 GA
**Branch:** `feature/sensitive-detection-m5-clean`
**Date:** 2026-06-20
**Prior release:** [OSS v1 RC Release Notes](./OSS-v1-RC-RELEASE-NOTES.md)
**Stabilization audit:** GO WITH KNOWN GAPS (2026-06-20)

---

## 제품 소개

**Data Relay OSS v1.0 GA**는 오픈소스 **Enterprise Data Control Gateway**의 첫 General Availability 릴리스입니다.

기업 데이터가 외부 시스템으로 전달되기 전에 **수집 · 변환 · 전달 · 관측**하고, 필요 시 **보호 · 분류 · 정책 · 격리 · 재처리**를 적용할 수 있는 단일 운영 콘솔을 제공합니다.

Data Relay는 **Data Delivery Gateway**가 핵심이며, Governance(보호·정책·감사)는 **선택적** 부가 기능입니다.

**Authority:** [`PRODUCT-CHARTER-Version-1.2.1-FINAL.txt`](../source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt)

---

## 주요 기능

| 영역 | 설명 |
|------|------|
| **Connectors** | HTTP API, Webhook, Database Query 등 소스 커넥터 연결 관리 |
| **Streams** | 실행 단위; Mapping → Enrichment → Governance → Delivery 파이프라인 |
| **Stream Wizard** | 5단계 온보딩 (Connect → Sample → Destinations → Route Processing → Deploy) |
| **Transform** | Basic JSONPath, Advanced JSONata, Expert `regex_extract` |
| **Multi-Route Delivery** | One Stream → Many Routes → Many Destinations |
| **Route Processing** | Shared Processing + per-route override (Transform, Protection, Classification, Policy) |
| **Protection & Classification** | Stream-scoped + route governance field overrides |
| **Policy & Quarantine** | Delivery gate, quarantine center, release workflow |
| **Schema Drift & Sensitive Detection** | Runtime observation and policy integration |
| **Replay & Failover** | Replay center; active/standby failover (legacy delivery path) |
| **Dashboard & Operations** | Overall health, group KPI, problem-first Streams console |
| **Governance** | Violations, Quarantine, Replay, Approvals, Audit, Notifications (RBAC) |
| **RBAC** | Operator / governance personas; role-based sidebar |

---

## 완료된 마일스톤 (RC → GA)

| Milestone | Summary |
|-----------|---------|
| **M13 Route Processing** | Per-route Transform, Protection, Classification, Policy operator API/UI |
| **M13.7 Route Processing UX** | Wizard, Stream Edit, Route Edit, Effective Status alignment |
| **Governance Workspace MVP** | Read-only stream/route governance overview |
| **Dashboard Operational Monitoring** | Charter-aligned health, group KPI, operational issues, drill-down |
| **Streams Operations UX** | Product-group table, problem-first sort, problem panel, runtime navigation |
| **Performance P0** | Runtime detail dedupe, catalog caches, snapshot_id stabilization |
| **Performance P1** | Streams mapping-ui lazy load, lazy runtime/dashboard routes, recharts chunk |
| **OSS v1 Stabilization Audit** | Product/UX/Runtime/Governance PASS; documented known gaps |

---

## Known Gaps (GA에서 명시)

GA는 **추가 기능 개발 없이** RC 기능을 문서화·온�oarding·운영 가이드와 함께 제공합니다. 아래 gap은 **릴리스 blocker가 아닙니다**. 상세: [`KNOWN-LIMITATIONS.md`](./KNOWN-LIMITATIONS.md)

| Gap | Impact | Workaround |
|-----|--------|------------|
| **Route Bundle Persist** | Wizard에서 `inherit.<concern>=false` route override는 deploy 시 **Intent only** — DB 미persist | Deploy 후 **Route Edit**에서 per-route bundle 저장 |
| **Governance Workspace Scale** | Route당 4 effective API → 50 routes ≈ 200+ HTTP on load | Stream 선택 후 확인; v1.x에서 lazy load 예정 |
| **Streams Scale (50+)** | Collapsed groups 기준 ~64 HTTP @50 streams (stats/health N calls) | Group collapsed 유지; auto-refresh 간격 조정 |
| **Database Query Source** | Runtime fetch **PostgreSQL only** | PG query source 사용 또는 HTTP/Webhook |
| **`GDC_ROUTE_PROCESSING_ENABLED`** | Default **OFF** — experimental per-route pipeline | Production: stream-scoped path (default) 유지 |
| **Dashboard Schema Drift KPI** | Operational Issues panel에 schema drift count 미연동 | Stream runtime / governance surfaces에서 확인 |
| **Wizard Onboarding** | Connector 생성이 wizard 밖; Destinations → Transform 순서 | [Getting Started](../getting-started/GETTING-STARTED.md) 참조 |

**v1.x backlog:** [`route-processing-persist-roadmap.md`](../architecture/route-processing-persist-roadmap.md)

---

## 업그레이드 참고사항

### RC → GA

- **Database migration:** `alembic upgrade head` (install/upgrade script 사용)
- **API contract:** Breaking change 없음
- **Runtime behavior:** Default path (`GDC_ROUTE_PROCESSING_ENABLED=false`) unchanged
- **Frontend:** `VITE_OSS_RELEASE_MODE=true` production build 유지

### Fresh install

```bash
./scripts/release/install.sh
# or
docker compose -f docker-compose.platform.yml up -d
```

### Upgrade from v1.0.0 / v1.0.1 / v1.0.2

```bash
./scripts/release/upgrade.sh
```

- Operator-created connectors, streams, routes, mappings **preserved**
- Review [production checklist](./production-checklist.md) before production traffic

### Configuration reminders

| Variable | GA recommendation |
|----------|-------------------|
| `GDC_ROUTE_PROCESSING_ENABLED` | `false` (default) |
| `ENABLE_DEV_VALIDATION_LAB` | `false` in production |
| `REQUIRE_AUTH` | `true` |
| `SMTP_ENABLED` | Configure before relying on email notifications |

---

## 검증 게이트

| Gate | Command |
|------|---------|
| Backend full suite | `./scripts/test/run-backend-full.sh` |
| Frontend tests | `cd frontend && npm test` |
| Frontend build | `cd frontend && npm run build` |
| Docker build | `docker compose -f docker-compose.platform.yml build frontend api` |
| GA checklist | [`OSS-v1.0-GA-CHECKLIST.md`](./OSS-v1.0-GA-CHECKLIST.md) |

---

## Documentation

| Document | Purpose |
|----------|---------|
| [Getting Started](../getting-started/GETTING-STARTED.md) | First stream walkthrough |
| [Architecture Overview](../architecture/OSS-v1-ARCHITECTURE.md) | Mental model and runtime |
| [Known Limitations](./KNOWN-LIMITATIONS.md) | Gap reference for operators |
| [Production Checklist](./production-checklist.md) | Go-live security and ops |
| [Documentation Index](../README.md) | Full docs hub |

---

## License

Apache License 2.0 — see [LICENSE](../../LICENSE).

---

*Data Relay OSS v1.0 GA — General Availability release notes.*
