# Generic Data Connector Platform Constitution

## Source of Truth

Product authority (read first):

- `docs/architecture/source-of-truth-index.md`
- `docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt`

Runtime / implementation authority for pipeline invariants:

- specs/001-core-architecture/spec.md
- specs/002-runtime-pipeline/spec.md
- specs/003-db-model/spec.md
- specs/004-delivery-routing/spec.md
- specs/048-runtime-reliability/spec.md
- this constitution

Route Processing implementation: `specs/091`–`specs/097`.

If a document conflicts with PRODUCT-CHARTER, PRODUCT-CHARTER wins.
If a document conflicts with verified Runtime behavior, record the conflict; do not silently change Runtime.

## Non-Negotiable Architecture Rules

1. Connector and Stream must remain separate.
2. Source and Destination must remain separate.
3. Stream is the runtime execution unit.
4. Stream and Destination are connected only through Route.
5. Multi Destination fan-out must be preserved.
6. Mapping and Enrichment must remain separate stages.
7. Checkpoint must be updated only after successful Destination delivery.
8. Source rate limit and Destination rate limit must both exist.
9. Delivery failure logs must be structured and persisted.
10. MVP focuses on HTTP API polling but must not block future DB Query or Webhook Receiver expansion.

## Runtime Reliability Architecture (policy)

GDC remains a **lightweight** Source-to-Destination platform by default. Optional durability and buffering are **selectable per Stream**, not globally mandatory.

Authoritative detail: `specs/048-runtime-reliability/spec.md`.

### Reliability modes (per Stream)

| Mode | Summary |
|------|---------|
| `DIRECT` | No persistent buffering; immediate process and deliver. Default for polling sources. |
| `MEMORY_BUFFER` | In-memory burst/backpressure; may lose data on restart. |
| `PERSISTENT_QUEUE` | DB/disk-backed delivery queue; retry/recovery after restart. |
| `EXTERNAL_BUFFER` | Durability delegated to Vector, Kafka, Redis Streams, NATS, RabbitMQ, etc. |

### Mandatory reliability principles

1. GDC must remain lightweight by default.
2. Persistent buffering must never be globally mandatory.
3. Reliability behavior must be selectable per Stream.
4. Push-based ingestion (`WEBHOOK_RECEIVER`, future `SYSLOG_RECEIVER`) may recommend buffering modes.
5. Polling-based sources (`HTTP_API_POLLING`, `DATABASE_QUERY`, etc.) may safely use `DIRECT`.
6. Durable delivery requires explicit operational tradeoff acceptance.
7. Backpressure handling must exist independently from Stream fetch lifecycle (future runtime).
8. Destination failure must not automatically imply Source failure.
9. Queue depth and delivery health must be observable when queue/buffer features are enabled.

### Current vs future runtime (optional delivery worker)

**Current (all Streams today):**

~~~text
StreamRunner → Fetch → Mapping → Enrichment → Route Fan-out → Destination Send → Checkpoint
~~~

**Future optional mode (per Stream, not required for lightweight deployments):**

~~~text
StreamRunner → Fetch → Mapping → Enrichment → Delivery Queue Enqueue
DeliveryWorker → Route Delivery → Retry/Backoff → ACK → Checkpoint Update
~~~

Fetch lifecycle and destination retry lifecycle must remain separable in future implementations.

### Competitive references (intent, not product scope)

Informed by Vector, Cribl Stream, Fluent Bit, Benthos/Redpanda Connect, and NiFi queue/backpressure patterns. GDC is **not** a generic distributed stream processing platform; it remains focused on operational data collection, transformation, enrichment, and multi-destination delivery.

## Immutable Bootstrap Admin Credential Contract

The first-install administrator bootstrap is a guarded project invariant:

- Fresh install default username is `admin`.
- Fresh install default password is `admin`.
- Fresh install must persist `must_change_password=true`.
- `GDC_SEED_ADMIN_PASSWORD` is an optional explicit override only.
- Randomly generated administrator passwords are forbidden.
- Install scripts must not generate, print, or persist a random value into `GDC_SEED_ADMIN_PASSWORD`.
- Repeated bootstrap/install must never overwrite an existing `admin` password hash.
- Any password reset or reconciliation for an existing `admin` must be an explicit operator recovery action.

Do not weaken this contract or replace it with random credentials unless a future spec explicitly changes this invariant.

## Required Runtime Pipeline

Source Fetch
→ Event Extraction
→ Mapping
→ Enrichment / Static Field Injection
→ Formatting
→ Route Fan-out
→ Destination Delivery
→ Checkpoint Update
→ Structured Logs / Runtime State

## Forbidden

- Do not collapse Connector, Source, Stream, Destination, and Route into one object.
- Do not make Connector the runtime unit.
- Do not update checkpoint after fetch/parse/mapping only.
- Do not bypass Route for Destination delivery.
- Do not merge Mapping and Enrichment into one unclear function.
- Do not change unrelated files.
- Do not make persistent buffering or `PERSISTENT_QUEUE` globally mandatory for all Streams.
- Do not tightly couple Source fetch lifecycle with destination retry lifecycle.
- Do not introduce Kafka-scale distributed stream processing as the default runtime behavior.
- Do not break lightweight single-node deployments that rely on `DIRECT` mode.
- Do not treat optional future Delivery Worker / durable queue architecture as mandatory for every Stream.

## Database Policy

DB is PostgreSQL only in production and development.
SQLite is not supported.
SQLite must not be used as a fallback, local development database, test shortcut, or compatibility layer.
All database migrations, indexes, queries, and performance validations must target PostgreSQL.

## Runtime Transaction Ownership

StreamRunner is the only transaction owner for runtime DB writes.

Runtime services and repositories must stage DB changes only.
They must not independently commit runtime DB writes.

Failure logs must be persisted for route-level delivery failures.
Exception-level `run_failed` logs are emitted to the application logger only and are not persisted because the active transaction is rolled back.

No commit is allowed after StreamRunner rollback.

---

# Mapping UI Rules (Phase 2 - Drag & Drop)

Drag & Drop은 Phase 2에서 구현한다.

필수 규칙:

- MVP 단계에서 Drag & Drop 구현 금지
- Drag & Drop 방향은 JSON Tree → Mapping Table만 허용
- 드롭 시 JSONPath 자동 생성 필수
- 드롭 시 신규 Mapping row 생성 또는 기존 row 업데이트를 지원한다
- 중복 mapping 발생 시 사용자에게 경고해야 한다
- 클릭 기반 JSONPath 생성 기능은 계속 유지해야 한다
- Mapping 엔진과 저장 구조는 기존 JSONPath 기반 구조를 유지해야 한다

금지사항:

- Drag & Drop 때문에 Mapping 데이터 구조 변경 금지
- 클릭 기반 Mapping 기능 제거 금지
- Mapping 엔진 로직 변경 금지

---

# Mapping UI Rules (Phase 2 - Drag & Drop)

- MVP 단계에서 Drag & Drop 구현 금지
- Drag & Drop 방향은 JSON Tree → Mapping Table만 허용
- 드롭 시 JSONPath 자동 생성 필수
- 중복 mapping 발생 시 사용자에게 경고해야 한다
- 클릭 기반 JSONPath 생성 기능은 계속 유지해야 한다
- Mapping 엔진과 저장 구조는 기존 JSONPath 기반 구조를 유지해야 한다

금지사항:

- Drag & Drop 때문에 Mapping 데이터 구조 변경 금지
- 클릭 기반 Mapping 기능 제거 금지
- Mapping 엔진 로직 변경 금지

# Mapping UI Rules (MVP)

Mapping UI는 비개발자도 사용할 수 있는 Preview-first UX를 따라야 한다.

필수 규칙:

- Raw Payload는 JSON Tree 형태로 렌더링해야 한다
- JSON 노드 클릭 시 JSONPath를 자동 생성해야 한다
- 생성된 JSONPath는 Mapping Table에 연결되어야 한다
- Mapping Table은 output_field, source_json_path, sample_value를 표시해야 한다
- Raw Event Preview, Mapped Event Preview, Enriched Final Event Preview를 모두 제공해야 한다
- Final Preview는 실제 Destination 전송 payload와 동일해야 한다
- Mapping과 Enrichment는 UI와 내부 로직 모두에서 분리해야 한다

금지사항:

- JSONPath 수동 입력 UI만 제공하는 것 금지
- Preview 없는 Mapping UI 금지
- Mapping 단계에서 Enrichment 필드를 섞어서 저장하는 것 금지
- Destination 전송 payload와 다른 Final Preview 표시 금지

---

# UI/UX Philosophy

The platform UI must follow a modern SaaS observability/security operations dashboard style.

Target UX direction:

- Webhook Relay inspired operational UX
- Datadog / Grafana Cloud / Vercel style spacing and layout
- Clean professional SaaS admin portal
- Minimal and operator-focused
- Runtime visibility first
- Dashboard-centric navigation
- Responsive layout
- Component-based frontend architecture

Preferred frontend stack:

- React
- Tailwind CSS
- shadcn/ui
- lucide-react
- recharts

Forbidden UI direction:

- Legacy enterprise UI style
- Dense table-only layouts
- Bootstrap admin templates
- Heavy gradients
- Consumer/mobile-app styling

# Dashboard UX Principles

The dashboard is the operational center of the platform.

The first screen must provide:

- Runtime health overview
- Active/error stream visibility
- Delivery success/failure summary
- Recent runtime activity
- Connector health
- Stream execution visibility
- Route delivery visibility

Operators should understand platform health within 5 seconds.

# Global Navigation Structure

Primary sidebar (DATA-RELAY-UX-CHARTER + current SPA):

- Dashboard
- Data Sources
  - Connectors
  - Streams
- Delivery
  - Destinations
- Administration

Not primary sidebar (contextual / deep-link / RBAC-gated):

- Mappings, Enrichments (inside Stream Wizard Route Processing / Stream Edit)
- Routes console
- Governance surfaces
- Runtime, Logs (stream/runtime drill-down)
- Sources as a top-level leaf (connector-scoped)

Sidebar must:

- remain persistent
- support collapse
- support active highlighting
- use icon-based navigation

# Mapping UI UX Policy Addendum

Mapping UI must prioritize usability for non-developers.

Preferred UX:

- JSON tree explorer
- Click-to-select fields
- Auto JSONPath generation
- Split preview layout
- Live event preview
- Drag-and-drop field mapping only in future phase
- Interactive mapping workflow

Forbidden:

- raw JSONPath-only workflow
- text-heavy configuration screens
- removing click-based JSONPath generation
- making drag-and-drop part of MVP
---

# PLUGIN_ADAPTER_ISOLATION_POLICY

## Purpose

Generic Data Connector Platform must support new Source, Auth, Destination, and Stream capabilities without destabilizing existing working connectors.

The runtime core must remain stable. New integrations must be added through isolated plugin or adapter modules.

## Mandatory Rules

1. Runtime Core must only orchestrate execution.
2. Vendor-specific logic must not be implemented inside StreamRunner.
3. Source-specific logic must not be implemented inside StreamRunner.
4. Auth-specific logic must not be implemented inside StreamRunner.
5. Destination-specific logic must not be implemented inside StreamRunner.
6. New Source/Auth/Destination types must be implemented as new adapter or strategy files.
7. Existing working adapters must not be modified unless the task explicitly requires a bug fix in that adapter.
8. Adding a new type must be additive-first.
9. Registry-based dispatch must be used instead of large if/elif chains.
10. Existing regression tests for Basic, Bearer, Vendor JWT Exchange, Runtime, Route, Delivery, and Checkpoint behavior must continue to pass.

## Forbidden Patterns

The following patterns are forbidden in runtime core code:

~~~text
if auth_type == "..."
if source_type == "..."
if vendor == "..."
if destination_type == "..."
~~~

These decisions must be delegated to registries, adapters, or strategy classes.

## Required Architecture

~~~text
StreamRunner
  -> SourceAdapterRegistry
  -> SourceAdapter.execute()
  -> Mapping Engine
  -> Enrichment Engine
  -> DestinationAdapterRegistry
  -> DestinationAdapter.send()
  -> Checkpoint Service
~~~

Authentication must follow the same rule:

~~~text
AuthStrategyRegistry
  -> selected AuthStrategy.apply()
~~~

## Cursor Enforcement

When Cursor adds a new integration such as S3, Database Query, Webhook Receiver, OAuth2, or a vendor-specific auth flow, it must:

~~~text
- create a new adapter/strategy file
- register it in the proper registry
- add focused tests for the new adapter
- run existing regression tests
- avoid unrelated file changes
- avoid changing existing working connector behavior
~~~

# English-Only Product Language Policy

## Language Policy

All project code, UI screens, labels, menus, buttons, placeholders, validation messages, API responses, logs, comments, documentation strings, seed/mock data, and Skill Spec content MUST be written in English only.

Korean or other non-English text is allowed only in external user communication, temporary Cursor prompts, or archived conversation notes. It MUST NOT be committed into product code, runtime UI, API schema, database seed data, tests, screenshots, or official project specifications.

Any new feature, refactor, UI change, or test must verify that user-facing and developer-facing product text remains English-only.

