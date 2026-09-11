# Spec Index

**Product Source of Truth (read first):** [`docs/architecture/source-of-truth-index.md`](../docs/architecture/source-of-truth-index.md) · [`PRODUCT-CHARTER v1.2.1`](../docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt)

Route Processing implementation authority: `specs/091`–`specs/097`.

## 001 Core Architecture
Path: `specs/001-core-architecture/spec.md`

Defines:
- Connector / Source / Stream / Destination / Route separation
- Core platform boundaries
- MVP architecture constraints
- Per-Stream runtime reliability modes and lightweight-by-default policy

## 002 Runtime Pipeline
Path: `specs/002-runtime-pipeline/spec.md`

Defines:
- Stream runtime execution
- Polling pipeline
- Mapping / Enrichment / Fan-out / Checkpoint order
- Failure behavior
- Current vs future optional Delivery Worker pipeline
- Reliability mode policy and future queue observability requirements

## 003 DB Model
Path: `specs/003-db-model/spec.md`

Defines:
- Connector, Source, Stream, Mapping, Enrichment, Destination, Route, Checkpoint, Log models
- DB relationship rules

## 004 Delivery Routing
Path: `specs/004-delivery-routing/spec.md`

Defines:
- Multi destination routing
- Syslog/Webhook delivery
- Route failure policy
- Destination rate limit
- Future optional route-level delivery queue, dead-letter, and replay concepts

## 048 Runtime reliability architecture (policy)
Path: `specs/048-runtime-reliability/spec.md`

Defines:
- Per-Stream reliability modes: `DIRECT`, `MEMORY_BUFFER`, `PERSISTENT_QUEUE`, `EXTERNAL_BUFFER`
- Lightweight-by-default and selectable durability principles
- Current StreamRunner pipeline vs future optional Delivery Worker architecture
- Route-level delivery reliability terminology and observability requirements
- Implementation constraints and competitive architecture references (spec/constitution only; no runtime code)

## 005 WireMock integration tests
Path: `specs/005-wiremock-integration/spec.md`

Defines:
- Docker Compose profile `test` WireMock for connector/stream HTTP integration tests
- Stub validation rules for SER-style `_search` without unsafe pagination query params

## 006 Message prefix (delivery)
Path: `specs/006-message-prefix-delivery/spec.md`

Defines:
- Optional route-level prefix before wire send (`prefix + space + compact JSON`)
- Defaults by destination type (Syslog on, Webhook off) and default template string

## 007 Message prefix variables
Path: `specs/007-message-prefix-variables/spec.md`

Defines:
- Message prefix template variables for delivery previews

## 008 Webhook payload mode
Path: `specs/008-webhook-payload-mode/spec.md`

Defines:
- `payload_mode` on WEBHOOK_POST destination config (`SINGLE_EVENT_OBJECT` vs `BATCH_JSON_ARRAY`)
- Default single-object delivery for SIEM/XDR-friendly JSON

## 009 Session login HTTP
Path: `specs/009-session-login-http/spec.md`

Defines:
- Session login body modes (JSON / form_urlencoded / raw)
- Login redirect and URL failure validation
- Probe-based auth success criteria for HTTP session connectors

## 010 Checkpoint trace
Path: `specs/010-checkpoint-trace/spec.md`

Defines:
- Structured checkpoint tracing in delivery_logs
- Checkpoint trace read APIs
- Correlation with route failures and run_id

## 011 Runtime analytics
Path: `specs/011-runtime-analytics/spec.md`

Defines:
- Read-only route failure and retry analytics over delivery_logs
- Default 24h window and optional filters

## 012 Runtime health scoring
Path: `specs/012-runtime-health-scoring/spec.md`

Defines:
- Deterministic operational health scoring for streams, routes, destinations
- 0-100 score with HEALTHY/DEGRADED/UNHEALTHY/CRITICAL levels
- Read-only health endpoints reusing delivery_logs aggregates
- UI extension for the existing Runtime Analytics page

## 013 Template connector system (Phase 1)
Path: `specs/013-template-connector-system/spec.md`

Defines:
- Filesystem-backed template registry (not runtime entities)
- Template list/detail/instantiate APIs
- Instantiation creates Connector/Source/Stream/Mapping/Enrichment/Checkpoint/optional Route only

## 050 Pipeline data workspace (mapping + enrichment evolution)
Path: `specs/050-pipeline-workspace/spec.md`

Defines:
- Transformation-aware mapping rows (structured transform chains)
- Computed enrichment, tenant resolver, vendor profile output wrappers
- Stage-aware preview API (`POST /runtime/preview/pipeline-stages`)
- Additive `field_mappings_json` / `enrichment_json` shapes (no destructive migration)

## 049 Template Registry and Template Builder (Source Packs)
Path: `specs/049-template-registry/spec.md`

Defines:
- Template as versioned **Source Pack** (connector/auth/stream/mapping/enrichment/formatter/route hints, samples, validation, docs)—not UI presets alone
- Template Builder draft workflow from vendor docs, OpenAPI/Swagger, API Test samples, and verified payloads (live samples override stale docs)
- Template metadata, compatibility policy (no silent apply on API version mismatch), and validation rules
- Preferred storage layout `templates/<vendor>/<product>/<use_case>/` with `manifest.yaml` and sidecar artifacts
- Guided apply UI workflow with API Test comparison and operator approval
- Non-goals: marketplace, AI automation, StreamRunner vendor logic, secrets in packs
- Evolves Phase 1 (`specs/013`); spec/design only unless noted in implementation phases

## 014 WireMock template E2E
Path: `specs/014-wiremock-template-e2e/spec.md`

Defines:
- Opt-in pytest coverage for template instantiate + run-once against WireMock stubs
- Extended mappings for generic REST, Stellar Malop, Okta System Log, webhook receivers, and failure/retry scenarios
- Assertions for delivery_logs, checkpoints, analytics, and health without UI automation
- Regression markers, shell scripts under `scripts/test-e2e-*.sh`, and operator notes in `docs/testing/e2e-regression.md`

## 018 Continuous test environment (dev infra)
Path: `specs/018-continuous-test-environment/spec.md`

Defines:
- Isolated `docker-compose.test.yml` stack for pytest/CI (PostgreSQL, WireMock, optional echo/syslog listeners, pytest-runner image)
- `scripts/testing/` entry points, `.test-history/` local artifacts, and GitHub Actions split across focused/smoke/regression workflows
- Operator documentation under `docs/testing/continuous-test-environment.md` and `docs/testing/regression-policy.md`

## 044 External runtime E2E
Path: `specs/044-external-runtime-e2e/spec.md`

Defines:

- Opt-in pytest `e2e_runtime` / `e2e_external` coverage for StreamRunner pipeline against MinIO, fixture PostgreSQL, SFTP, and WireMock
- Shared helpers `tests/e2e_runtime_helpers.py` and runner `scripts/test/run-external-runtime-e2e-tests.sh`
- Operator notes in `docs/testing/external-runtime-e2e.md`

## 036 Source adapter E2E
Path: `specs/036-source-adapter-e2e/spec.md`

Defines:

- Opt-in pytest `source_e2e` coverage for `S3_OBJECT_POLLING`, `DATABASE_QUERY`, and `REMOTE_FILE_POLLING` against MinIO, `postgres-query-test`, and `sftp-test` in `docker-compose.test.yml`
- Seed script `scripts/testing/source-e2e/seed-fixtures.sh` and runner `scripts/test/run-source-e2e-tests.sh`
- Operator notes in `docs/testing/source-adapter-e2e.md`

## 037 Visible dev E2E UI fixtures
Path: `specs/037-visible-dev-e2e-fixtures/spec.md`

Defines:

- Optional idempotent seed for UI-visible `[DEV E2E] ` catalog entities (all supported sources + local destinations)
- Script `scripts/dev-validation/seed-visible-e2e-fixtures.sh` and implementation `app/dev_validation_lab/visible_e2e_seed.py`
- Operator notes in `docs/testing/visible-dev-e2e-fixtures.md`

## 038 Release candidate deployment packaging
Path: `specs/038-release-candidate-deployment/spec.md`

Defines:

- `scripts/release/` install, upgrade, backup, restore, and self-signed TLS helpers
- CI validation workflows (`backend-tests`, `frontend-tests`, `docker-validate`)
- English operator documentation under `docs/deployment/` for RC installs

## 032 Dev validation lab source expansion
Path: `specs/032-dev-validation-lab-source-expansion/spec.md`

Defines:
- Optional `ENABLE_DEV_VALIDATION_*` slices for S3, relational query sources, and remote file polling inside the dev validation lab
- Fixture containers (`minio-test`, `postgres-query-test`, `mysql-query-test`, `mariadb-query-test`, `sftp-test`, `ssh-scp-test`) in `docker-compose.test.yml` (core fixtures also on the `test` profile for `source_e2e`; MySQL/MariaDB remain `dev-validation`-only)
- Seed scripts under `scripts/testing/source-expansion/` and UI/scheduler gates that skip disabled slices

## 016 Continuous validation
Path: `specs/016-continuous-validation/spec.md`

Defines:

- StreamRunner-backed synthetic operational validation
- `continuous_validations` and `validation_runs` persistence
- Independent scheduler and REST control plane
- Operator notes in `docs/testing/continuous-validation.md`

## 017 Validation alerting
Path: `specs/017-validation-alerting/spec.md`

Defines:

- Deduped `validation_alerts` and `validation_recovery_events`
- Async outbound notifications (generic, Slack-compatible, PagerDuty v2)
- Read-only runtime/dashboard integration
- Operator notes in `docs/testing/validation-alerting.md`

## 020 Session/JWT authentication
Path: `specs/020-jwt-session-auth/spec.md`

Defines:

- Real local JWT authentication replacing the temporary `X-GDC-Role` header trust
- Access/refresh token pair, `token_version` invalidation, `Authorization: Bearer`
- `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/whoami` APIs
- Frontend session storage, automatic refresh on 401, login redirect on expiry

## 021 HTTPS reverse proxy runtime
Path: `specs/021-https-reverse-proxy/spec.md`

Defines:

- nginx reverse proxy as single browser entrypoint; API remains HTTP-only internally
- Admin Settings drives TLS material, nginx config render, optional reload, HTTP fallback
- Docker Compose `docker-compose.platform.yml`, optional `deploy/docker-compose.https.yml`, and internal reload hook

## 015 Backup, export, import (Phase 1)
Path: `specs/015-backup-export-import/spec.md`

Defines:

- JSON export/import for connectors, streams, and workspace snapshots (masked secrets)
- Import preview with conflict detection; additive and clone apply modes (no destructive merge)
- Clone connector/stream configuration (new IDs, streams disabled by default)

## 024 Syslog TLS destination
Path: `specs/024-syslog-tls-destination/spec.md`

Defines:

- New `SYSLOG_TLS` destination type for runtime delivery (RFC5425-style TCP+TLS)
- Destination configuration fields for TLS material and verification modes
- Sender/probe behavior with optional SNI and mutual auth, retaining existing route retry/checkpoint semantics
- UI/visibility additions; explicitly does not touch the browser HTTPS reverse proxy

## 025 S3 object polling — UI and validation
Path: `specs/025-s3-object-polling-ui/spec.md`

Defines:

- S3_OBJECT_POLLING connector and stream wizard fields (including `max_objects_per_run`)
- S3 connectivity probe semantics (no secret exposure)
- Alignment with checkpoint-after-delivery and English-only product language

## 027 Maintenance Center (admin health)
Path: `specs/027-maintenance-center/spec.md`

Defines:

- Read-only `GET /api/v1/admin/maintenance/health` (Administrator JWT only)
- Aggregated OK/WARN/ERROR notices plus structured panels (DB, Alembic, schedulers, retention, disk, destinations, TLS, failures, support bundle shortcut)
- No checkpoint or data mutations; masked secrets in failure payloads

## 028 Database query source (roadmap)
Path: `specs/028-database-query-source/spec.md`

Defines:

- `DATABASE_QUERY` source type for PostgreSQL, MySQL, and MariaDB
- Connection and stream field contracts, row-to-event conversion, incremental checkpoint payload fields
- SELECT-only and safety constraints; adapter isolation; test strategy

## 029 Remote file polling source (roadmap)
Path: `specs/029-remote-file-polling-source/spec.md`

Defines:

- `REMOTE_FILE_POLLING` over SFTP and SCP
- Connection and stream fields, parser matrix (NDJSON, JSON array/object, CSV, line-delimited text)
- File checkpoint fields, mutation handling, security, test strategy

## 030 Data backfill (roadmap)
Path: `specs/030-data-backfill/spec.md`

Defines:

- Operator **Data Backfill** workflow separate from runtime polling
- Preview, dry run, execute, progress, audit log; route policy reuse; isolated backfill logs
- Checkpoint protection (no overwrite of runtime checkpoint by default; optional admin-confirmed merge)
- Initial targets: `DATABASE_QUERY`, `REMOTE_FILE_POLLING`, `S3_OBJECT_POLLING`

## 033 Data backfill runtime architecture
Path: `specs/033-data-backfill-runtime/spec.md`

Defines:

- **BackfillRuntimeCoordinator** isolation from **StreamRunner** scheduling semantics
- `backfill_jobs` persistence, checkpoint snapshot + ephemeral state rules (`EXPLICIT_ONLY` merge policy placeholder)
- Backfill modes registry (`CHECKPOINT_REWIND`, `TIME_RANGE_REPLAY`, `OBJECT_REPLAY`, `FILE_REPLAY`, `INITIAL_FILL`) and source-strategy placeholders
- REST foundation: `POST/GET /api/v1/backfill/jobs`
- Phase 2 scope notes (worker, backfill logs, stream lock, cancellation, delivery correlation, checkpoint commit policy)
- Complements the operator workflow roadmap in `specs/030-data-backfill/spec.md`

## 034 Operational data retention (PostgreSQL)
Path: `specs/034-data-retention/spec.md`

Defines:

- Lightweight batched cleanup for `delivery_logs`, validation metrics tables, validation perf snapshots, and backfill job/event tables
- `GET/POST /api/v1/retention/*` preview and execution APIs (operator/administrator roles)
- Optional daily supplement scheduler thread (no Celery/Kafka/Redis)
- `platform_retention_policy.operational_retention_meta` JSONB throttle metadata

## 035 RBAC-lite (JWT roles)
Path: `specs/035-rbac-lite/spec.md`

Defines:

- Centralized `evaluate_http_access` rules for Administrator / Operator / Viewer
- Viewer read-only monitoring plus preview-only runtime POST whitelist
- Administrator-only maintenance, support bundle, user admin, policy writes, import apply, snapshot apply
- Capabilities map on login / whoami for SPA alignment

## 039 Default admin bootstrap
Path: `specs/039-default-admin-bootstrap/spec.md`

Defines:

- Deterministic first-install `admin` / `admin` when `GDC_SEED_ADMIN_PASSWORD` is unset
- `must_change_password` persistence and JWT `mcp` gate until self-service password change
- `POST /api/v1/auth/change-password` for the authenticated user
- Official recovery: `docs/operations/admin-password-reset.md`, `./scripts/admin/reset-admin-password.sh`, `GDC_RECONCILE_ADMIN_PASSWORD=true`

## Database Policy

All database implementations must target PostgreSQL.
SQLite must not be used as a fallback.
All migrations, indexes, and query validation rules are PostgreSQL-based.

## 046 Runtime topology view
Path: `specs/046-runtime-topology-view/spec.md`

Defines:

- Read-only `GET /api/v1/runtime/topology` aggregation
- Frontend `/runtime/topology` pipeline graph (connector → source → stream → mapping/enrichment → routes → destinations)
- Health and enabled/disabled badges; drill-down to runtime, logs, and destinations

## 047 Pipeline debugger (MVP)
Path: `specs/047-pipeline-debugger/spec.md`

Defines:

- `POST /api/v1/runtime/streams/{stream_id}/pipeline-debug` read-only sample pipeline inspection
- Reuses mapping, enrichment, and route delivery preview formatters without StreamRunner, checkpoint, or delivery_logs writes
- Stream Runtime Detail UI panel with per-stage cards and route previews

## 065 Protection Engine (M6 MVP)
Path: `specs/065-protection-engine/spec.md`

Defines:

- Milestone M6 masking-only protection after M5 Sensitive Detection, before route fan-out
- `stream_protection_rules` table; modes `full_mask`, `partial_mask`, `hash` (no tokenization)
- Protection REST APIs and sensitive finding resolve (`false_positive`, `protection_applied`)
- Outbound copy masking with enriched checkpoint preservation; `GDC_PROTECTION_ENABLED` feature flag
- Runtime Detail Protection Summary/Rule Table; Sensitive panel Apply protection workflow

## 070 AI Gateway MVP
Path: `specs/070-ai-gateway-mvp/spec.md`

Defines:
- Platform-scoped `ai_gateway_policies` and `ai_gateway_requests`
- Prompt inspection via existing Sensitive Detection, Classification, Protection (read-only)
- Gateway policy actions: allow, audit, block, quarantine
- Mock provider; APIs under `/api/v1/ai-gateway`

## 066 Classification Engine (M13 MVP)
Path: `specs/066-classification-engine/spec.md`

Defines:

- Rule-based `PUBLIC` / `INTERNAL` / `CONFIDENTIAL` / `RESTRICTED` levels after Sensitive Detection, before Protection
- `stream_classification_rules` table and runtime/preview classification stamping
- Policy / Dynamic Routing `condition_json.classification_level` (additive); `classification_complete` observability
- Runtime Detail read-only Classification panel

## 045 PostgreSQL partitioning, retention, and archival
Path: `specs/045-postgresql-partitioning-retention/spec.md`

Defines:

- Monthly `RANGE (created_at)` partitioning for `delivery_logs`
- Partition maintenance scheduler, archival detach/export hooks, and retention env overrides
- `GET /api/v1/retention/partitions` and Maintenance Center partition observability
- Operator docs in `docs/runtime/postgresql-partitioning.md`

## 043 Observability Scale Foundation
Path: `specs/043-observability-scale-foundation/spec.md`

Defines:

- PostgreSQL monthly RANGE partitioning for `delivery_logs`
- Runtime aggregate snapshot materialization
- Frontend refresh-cycle snapshot synchronization
- Opt-in retention guardrails for delivery log partition planning and runtime aggregate snapshot cleanup

---

## Mapping UI UX Policy

MVP Mapping UI must provide a preview-first, non-developer-friendly workflow inspired by WebhookRelay-style payload preview UX.

MVP includes:

- JSON Tree Raw Payload Preview
- click-based JSONPath generation
- Mapping Table
- Raw / Mapped / Enriched Final Preview
- Final Preview matching actual destination payload

Phase 2 includes:

- JSON Tree to Mapping Table Drag & Drop
- duplicate mapping warning
- overwrite / append behavior

Drag & Drop is explicitly not part of MVP.

---

---

## UI/UX Philosophy

The platform UI must follow a modern SaaS observability/security operations dashboard style.

Required UX direction:

- Webhook Relay inspired operational UX
- Datadog / Grafana Cloud / Vercel style spacing and layout
- clean professional SaaS admin portal
- runtime visibility first
- dashboard-centric navigation
- responsive component-based frontend

Preferred frontend stack:

- React
- Tailwind CSS
- shadcn/ui
- lucide-react
- recharts

## Dashboard UX Principles

Dashboard is the operational center of the platform.

The first screen must show:

- runtime health overview
- active/error stream visibility
- delivery success/failure summary
- recent runtime activity
- connector health
- stream execution visibility
- route delivery visibility

Operators should understand platform health within 5 seconds.

## Global Navigation Structure

Primary sidebar (DATA-RELAY-UX-CHARTER + current SPA):

1. Dashboard
2. Data Sources — Connectors, Streams
3. Delivery — Destinations
4. Administration

Not primary sidebar: Mappings, Enrichments, Routes console, Governance, Runtime, Logs (contextual / RBAC deep-links; Route Processing lives inside Stream Wizard / Stream Edit).

Sidebar must remain persistent, collapsible, icon-based, and active-highlighted.

# English-Only Product Language Policy

## Language Policy

All project code, UI screens, labels, menus, buttons, placeholders, validation messages, API responses, logs, comments, documentation strings, seed/mock data, and Skill Spec content MUST be written in English only.

Korean or other non-English text is allowed only in external user communication, temporary Cursor prompts, or archived conversation notes. It MUST NOT be committed into product code, runtime UI, API schema, database seed data, tests, screenshots, or official project specifications.

Any new feature, refactor, UI change, or test must verify that user-facing and developer-facing product text remains English-only.

## 068 Replay Engine (M11)
Path: `specs/068-replay-engine/spec.md`

Defines:
- `stream_replay_events` protected-payload replay store
- Manual replay/discard APIs and Runtime Replay Panel
- Recording on base/failover/dynamic final delivery failures (excludes 429/rate-limit/preview/backfill)

## 091 Route Processing Architecture (M13.1)
Path: `specs/091-route-processing-architecture/spec.md`

Defines:
- Milestone M13.1 Route Processing Foundation — Route as Destination Specific Processing Unit
- `SharedBatchContext`, `RouteRuntimeContext`, and `GDC_ROUTE_PROCESSING_ENABLED` orchestration contract
- Shared vs per-route pipeline split, dual-read config resolution, and backward compatibility policy
- Route Configuration Model (additive tables); stage slots for M13.2–M13.6 without parallel runtime

## 092 Per Route Transform (M13.2)
Path: `specs/092-per-route-transform/spec.md`

Defines:
- Milestone M13.2 Per Route Transform — Mapping + Enrichment execution per route
- `route_mappings` / `route_enrichments` additive storage with stream full-bundle fallback
- `process_route_pipeline()` Transform stage; route loop before governance; per-route fan-out wiring
- Reuses existing Mapping/Enrichment engines; depends on M13.1 foundation

## 093 Per Route Protection (M13.3)
Path: `specs/093-per-route-protection/spec.md`

Defines:
- Milestone M13.3 Per Route Protection — protection execution per route inside `process_route_pipeline()`
- Stream defaults + `route_overrides[]` merge + optional `route_protection_rules` dual-read resolution
- Reuses existing Protection Engine and stream-scoped Sensitive Detection results (no parallel engine)
- Protection actions: Audit Only, Mask Partial/Full, Tokenize, Hash; Remove deferred (engine gap documented)
- Unknown field Auto Protect with route override intent; depends on M13.1 and M13.2

## 094 Per Route Classification (M13.4)
Path: `specs/094-per-route-classification/spec.md`

Defines:
- Milestone M13.4 Per Route Classification — classification execution per route inside `process_route_pipeline()`
- `route_classification_rules` additive storage with stream dual-read fallback; governance `route_overrides[]` classification floor
- Reuses existing Classification Engine and stream-scoped Sensitive Detection results (no parallel engine)
- Stamps `classification_level` / `classification_level_gdc` on route events; depends on M13.1–M13.3

## 095 Per Route Policy (M13.5)
Path: `specs/095-per-route-policy/spec.md`

Defines:
- Milestone M13.5 Per Route Policy — policy evaluation and enforcement per route inside `process_route_pipeline()`
- `route_policy_rules` additive storage with stream dual-read fallback; governance `delivery_behavior` override
- Reuses existing Policy Engine with injected rules (no stream DB lookup on route path); `delivery_allowed` fan-out gate
- Route-aware quarantine (`route_id` on `stream_quarantine_events`); depends on M13.1–M13.4

## 096 Route Runtime Delivery (M13.6)
Path: `specs/096-route-runtime-delivery/spec.md`

Defines:
- Milestone M13.6 Route Runtime Delivery — route-aware delivery execution, disposition, metrics, health, and observability
- `RouteDeliveryResult` and `DeliveryDisposition` (`delivered`, `delivered_review_required`, `blocked`, `quarantined`)
- `route_delivery_stage()` after policy; reuses StreamRunner fan-out, delivery adapters, audit pipeline, and `runtime_route_snapshot`
- `route_delivery_*` metrics; policy-aware route health; Require Review on route path does not deliver (§20); depends on M13.1–M13.5

## 097 Route Processing UX (M13.7)
Path: `specs/097-route-processing-ux/spec.md`

Defines:
- Milestone M13.7 Route Processing UX — cross-surface design authority (Wizard, Stream Edit, Route Edit, Governance Workspace)
- Global Processing + Route List + Route Detail; Inherit Global / Override per concern
- Full UX spec: `docs/ux/DATA-RELAY-ROUTE-PROCESSING-UX-SPEC.md`
- Depends on M13.1–M13.6 (`specs/091`–`specs/096`)

