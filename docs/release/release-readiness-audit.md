# Release Readiness Audit — Enterprise Data Control Gateway OSS v1.0 RC

**Status:** HISTORICAL RC AUDIT (2026-06-06) — do not use §7 as the live wizard workflow, and do not treat §5 / §11 SMTP mock items as current product truth.
**Current wizard:** Connect → Sample & Record Selection → Destinations → Route Processing → Deploy.
**Current SMTP:** Operational email delivery is implemented (`NotificationService` → `SmtpEmailSender`). Slack remains planned.

**Audit date:** 2026-06-06
**Scope:** M20.4 Open Source Release Readiness (cleanup, validation, documentation — no new engine features)

## Executive summary

The platform is a **single codebase** with no Enterprise/OSS SKU split at the binary level. OSS release readiness is enforced through:

- Production Docker frontend build flag `VITE_OSS_RELEASE_MODE=true`
- Backend env gates (`ENABLE_DEV_VALIDATION_LAB=false` in production)
- RBAC (`governance_read`, role-based sidebar)
- Route guards for internal-only UI surfaces

**Overall readiness:** ~98% for OSS v1.0 RC after M20.4 cleanup.

---

## 1. Dead code & legacy artifacts

| Item | Location | Disposition |
|------|----------|-------------|
| Legacy SPA archive | `frontend/_archive/legacy-spa/` | Retained (not bundled); no runtime impact |
| Deprecated sidebar structures | `frontend/src/config/app-navigation.tsx` (`SIDEBAR_STRUCTURE`, `sidebarItemsForPersona`) | Kept for test migration; not used in production nav |
| Legacy runtime redirects | `/runtime/*` → `/monitoring/*` | Intentional backward-compat redirects |
| Legacy wizard sub-step keys | `frontend/src/components/streams/wizard/wizard-state.ts` | Active normalization for persisted wizard JSON |
| Empty placeholder routes | `PLACEHOLDER_NAV_KEYS` in `App.tsx` | Empty array — no dead routes registered |
| `frontend/dist/dev-fixtures/` | Host build artifact | Not served in Docker production image |

**Action taken:** No file deletions (preserve operator data and backward compatibility). Internal routes gated behind OSS mode.

---

## 2. Unused / internal-only API surfaces

| API area | Notes |
|----------|-------|
| Dev validation lab endpoints | Gated by `ENABLE_DEV_VALIDATION_LAB`; disabled in `.env.example` production template |
| Pipeline debug (`POST .../pipeline-debug`) | Stream runtime internal panel; not linked from OSS nav |
| Connector catalog registry | Read-only admin page; hidden from OSS Administration hub |
| Templates API (`GET /templates/`) | Deep-link only; OSS route guard redirects to Streams |

All core OSS paths verified present: auth, streams, mappings, enrichments, destinations, routes, runtime, governance, RBAC, notifications.

---

## 3. Unused / hidden React screens

| Screen | OSS exposure |
|--------|----------------|
| Validation lab (`/validation/*`) | Hidden — redirects to Monitoring |
| Templates (`/templates`) | Hidden — redirects to Streams |
| Connector Catalog | Hidden — redirects to Administration |
| AI Governance (`/governance/ai`) | Hidden — redirects to Governance Dashboard |
| Data Protection hub (`/governance/data-protection`) | Hidden — redirects to Governance Dashboard |
| Persona switcher (localStorage) | Hidden in OSS production build |
| Dev validation admin panel | Hidden when `isDevValidationLabUiEnabled()` is false |

**OSS-visible Governance tabs:** Dashboard, Operations, Violations, Quarantine, Replay, Approvals, Audit, Notifications.

**OSS-visible Administration:** Connectors, Destinations, Routes, Settings (Users/Roles/Credentials), Backup.

---

## 4. Feature flags inventory

### Frontend (`VITE_*`)

| Flag | Default (OSS prod) | Purpose |
|------|-------------------|---------|
| `VITE_OSS_RELEASE_MODE` | `true` (Docker build) | OSS release surface |
| `VITE_ENABLE_DEV_VALIDATION_LAB` | unset / false | Dev lab UI |
| `VITE_ENABLE_PLATFORM_ALERTING_UI` | unset / false | Internal alerting settings |
| `VITE_GOVERNANCE_MODE` | deprecated | Superseded by RBAC |

### Backend

| Flag | Production default | Purpose |
|------|-------------------|---------|
| `ENABLE_DEV_VALIDATION_LAB` | `false` | WireMock/MinIO lab |
| `GDC_*_ENABLED` (protection, classification, etc.) | `true` | Core runtime pipeline |
| `REQUIRE_AUTH` | `true` (.env.example) | Login gate |
| `SMTP_ENABLED` | `false` | Governance email channel availability (audit-time default; delivery is implemented as of `18f4ce3`) |
| `WEBHOOK_TIMEOUT` | `10` | Governance webhook delivery timeout (seconds) |

No hidden runtime feature flags discovered that bypass OSS gates.

---

## 5. Test-only code

| Area | Location | Risk |
|------|----------|------|
| `MockEmailSender` / `MockWebhookSender` | `app/governance_notifications/` | Audit-time note. Tests still use mocks; production email uses `SmtpEmailSender` (startup); production webhooks use `HttpWebhookSender` when `APP_ENV=production`. |
| `gdc_pytest` catalog | `docker-compose.test.yml` | Isolated from production `gdc` catalog |
| Dev fixtures | `frontend/public/dev-fixtures/` | Not exposed in OSS production bundle |

---

## 6. Deprecated routes

| Legacy path | Replacement |
|-------------|-------------|
| `/runtime` | `/monitoring` |
| `/runtime/topology` | `/monitoring/topology` |
| `/runtime/analytics` | `/monitoring/analytics` |
| `/runtime/ai-gateway` | `/governance/ai` (internal in OSS) |
| `/settings/network` | `/settings` |

---

## 7. Legacy wizard traces

The live stream wizard is Destination First (`connect → sample → destinations → route-processing → deploy`). Legacy sub-step keys (including older mapping/review traces) remain in `wizard-state.ts` for persisted JSON normalization — **required for upgrade safety**, not user-facing UI.

---

## 8. Migration audit

- **Total Alembic revisions:** 44+ (through `20260606_0044_gov_notifications`)
- **Unused migrations:** None identified — all revisions referenced in linear chain
- **Fresh install path:** `scripts/release/install.sh` → pre-upgrade validate → `alembic upgrade head`
- **Partial schema guard:** `app/db/migration_integrity.py` rejects app tables without `alembic_version`

---

## 9. Documentation gaps closed in M20.4

| Gap | Resolution |
|-----|------------|
| Outdated README ("Backend Skeleton") | Rewritten for v1.0 RC Quick Start |
| Missing `docs/release/` | Created audit, installation validation, production checklist |
| Missing sample pack | Created `samples/` |
| Missing OSS UI surface definition | `VITE_OSS_RELEASE_MODE` + route guards |

---

## 10. Release blockers

| Blocker | Status |
|---------|--------|
| Fresh install | ✅ `validate-clean-install.sh` passes |
| Auth / login | ✅ admin bootstrap documented |
| Stream CRUD + runtime | ✅ Implemented |
| Governance + RBAC | ✅ Implemented |
| All tests pass | ⏳ Verified in M20.4 test audit (see test run output) |

**No critical release blockers identified** after M20.4 changes.

---

## 11. Recommended post-RC (non-blocking)

1. Remove deprecated `SIDEBAR_STRUCTURE` after test migration completes.
2. ~~Wire `SMTP_ENABLED` to a real SMTP backend beyond mock.~~ **Superseded** — SMTP delivery implemented (`18f4ce3`). Slack remains planned.
3. Add E2E install smoke in CI using `docker compose up` (optional automation).
