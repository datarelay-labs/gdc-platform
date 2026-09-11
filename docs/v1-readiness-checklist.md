# GDC Platform — v1 Readiness Checklist

**Status:** SUPERSEDED  
**Superseded By:** [`docs/release/OSS-v1.0-GA-CHECKLIST.md`](release/OSS-v1.0-GA-CHECKLIST.md), [`docs/architecture/source-of-truth-index.md`](architecture/source-of-truth-index.md)

Historical pre-GA GDC checklist. Primary navigation listed here (Mappings / Enrichments / Routes as top-level) is obsolete.

---

This document defines what "v1 complete" means for the Generic Data Connector
(GDC) Platform, what must pass before a v1 release, and what an operator must
manually verify on the running system.

It is **operator-focused** and intentionally scoped. It is not a roadmap, an
architecture change, or a UX redesign. The current entity and runtime model
(Connector / Source / Stream / Mapping / Enrichment / Destination / Route /
Checkpoint) defined in `specs/001-core-architecture/spec.md` through
`specs/004-delivery-routing/spec.md` and `.specify/memory/constitution.md` is
considered final for v1.

---

## 1. v1 Goals

v1 is the first **operationally trustworthy** release of GDC. The goal is not
new features; the goal is that the existing platform works the same way every
time an operator uses it.

A release is v1-ready when:

- A non-developer operator can build a working pipeline end to end
  (Connector → Stream → Mapping → Enrichment → Route → Destination → Logs)
  without reading source code.
- Every documented workflow in section 4 passes manual verification.
- Every automated suite in section 7 passes on the release candidate.
- No item in section 9 (release blockers) is present.

v1 explicitly excludes the items listed in section 8 (known acceptable
limitations).

---

## 2. Release Philosophy

v1 follows these principles. Any proposed change that conflicts with them is
out of scope until after v1.

- **Predictability over feature count.** A small set of workflows must behave
  the same on every run.
- **No major UX redesigns.** Existing screens (Dashboard, Connectors, Sources,
  Streams, Mappings, Enrichments, Destinations, Routes, Runtime, Logs,
  Settings) keep their current layout and navigation order.
- **Stabilize existing workflows.** Fixes, validation, and explanatory error
  messages over new wizards.
- **Explainability over complexity.** Every operator-visible failure must have
  a message that names the failing stage, route, or destination.
- **Operational clarity over visualization.** Plain text status, plain log
  rows, simple filters. No new graph-heavy dashboards for v1.
- **Minimal but understandable UI.** Lists, detail pages, and previews remain
  the primary UX. Drag-and-drop and other advanced UX remain Phase 2 per the
  constitution's Mapping UI rules.
- **Lightweight by default.** Per-Stream reliability stays `DIRECT` unless the
  operator explicitly chooses otherwise (`specs/048-runtime-reliability`).
- **Additive change only.** No destructive migrations, no truncation of
  operator-created entities (see workspace rule
  `preserve-user-entities.mdc`).

---

## 3. Scope Boundaries

In scope for v1:

- HTTP API polling source with auth strategies already shipped (Basic, Bearer,
  API Key, Vendor JWT Exchange, Session login).
- S3 object polling, Database Query, Remote File polling, and Webhook Receiver
  sources at the level currently implemented and tested in
  `tests/test_source_adapter_e2e.py` and `tests/test_external_runtime_e2e.py`.
- Syslog UDP / Syslog TCP / Syslog TLS / Webhook POST destinations.
- Mapping (`event_array_path`, `event_root_path`, field mappings) and
  Enrichment (static field injection).
- Route fan-out with the four failure policies in
  `specs/004-delivery-routing/spec.md`.
- Checkpoint after successful delivery only.
- Runtime visibility (status, logs, checkpoint trace, route failures).
- cURL and Postman import into the New Connector wizard.

Out of scope for v1 (see section 8).

---

## 4. Must-Pass Operator Workflows

Each workflow must succeed manually on the release candidate. The
verification method is what the operator does to confirm it works, not an
automated test.

### 4.1 Create Connector

- Expected outcome: Operator can create a new HTTP connector with auth, save
  it, and re-open it with no field loss.
- Common failure modes: secret stripped on reload; auth type reset; base URL
  lost.
- Verification: Create → Save → reload page → all fields, including masked
  secret indicators, are present.

### 4.2 Create Stream

- Expected outcome: Operator can create a Stream on an existing Connector,
  choose endpoint/method/params, and save.
- Common failure modes: polling interval reset; method coerced; params lost.
- Verification: Save → reload → fields identical → Stream appears in Streams
  list and Connector detail.

### 4.3 API Test

- Expected outcome: API Test returns a real HTTP response with status, headers
  preview, and a parsable JSON body (when applicable).
- Common failure modes: silent 401 with no message; CORS surfaced instead of
  upstream error; cached old response.
- Verification: Run API Test → status visible → body visible → re-run with a
  changed param shows changed body.

### 4.4 JSON Preview

- Expected outcome: JSON tree renders the API Test response. Clicking a node
  produces a JSONPath that resolves to a real value.
- Common failure modes: tree shows raw string; click produces an absolute path
  that does not match the runtime extracted event.
- Verification: Click two distinct nodes → both paths appear in the path
  display → both sample values match the JSON.

### 4.5 Record Selection (Event Source / Event Root)

- Expected outcome: Operator chooses `event_array_path` (Event Source) and
  optional `event_root_path` (Event Root). Runtime Extraction summary shows
  the combined path (e.g. `$.Records[*].event`).
- Common failure modes: Event Root not persisted; runtime ignores Event Root;
  preview uses different envelope than runtime.
- Verification: See section 5.

### 4.6 Mapping save / reload

- Expected outcome: Field mapping rows (output field + JSONPath) persist
  exactly across save and reload. Paths remain relative to the extracted
  event.
- Common failure modes: paths rewritten to absolute envelope path on save;
  rows reordered; sample values lost.
- Verification: Save mapping → reload page → row count, order, paths, and
  sample values are unchanged.

### 4.7 Enrichment preview / runtime consistency

- Expected outcome: Enriched Final Preview equals the actual payload sent to
  the Destination.
- Common failure modes: Enrichment fields shown in preview but missing at
  send; static fields ordered differently; values overridden silently.
- Verification: Trigger Run Now → inspect delivered payload in Logs detail or
  receiver → compare to Final Preview.

### 4.8 Destination create

- Expected outcome: Syslog UDP/TCP/TLS or Webhook POST destination saves and
  reconnects on reload with the same config.
- Common failure modes: TLS material stripped; port coerced to default;
  webhook headers reordered or lost.
- Verification: Create → reload → all fields identical.

### 4.9 Route creation

- Expected outcome: Operator can attach a Route from a Stream to one or more
  Destinations, choose failure policy, and save. Multi-destination fan-out
  works.
- Common failure modes: Route saved but not enabled; fan-out only delivers to
  first destination; failure policy reset.
- Verification: Create Route(s) → Run Now → all enabled destinations receive
  the event.

### 4.10 Run Now

- Expected outcome: Manual Run Now executes the full pipeline, returns a
  run summary, and creates `delivery_logs` entries.
- Common failure modes: returns success but no logs; checkpoint advances on
  failure; UI hangs.
- Verification: Run Now → response visible → Logs page shows new rows for the
  run → Runtime page reflects updated last-run time.

### 4.11 Runtime visibility

- Expected outcome: Runtime page shows current Stream status
  (`RUNNING`/`STOPPED`/`PAUSED`/`ERROR`/rate-limited variants) and the last
  run outcome per route.
- Common failure modes: status frozen; error not surfaced; route success
  shown for a partial failure.
- Verification: Stop a Stream → Runtime status flips → Start → flips back.

### 4.12 Logs visibility

- Expected outcome: Logs page shows stage-level rows
  (`route_send_success`, `route_send_failed`, `route_retry_*`,
  `source_rate_limited`, `destination_rate_limited`, `route_skip`,
  `route_unknown_failure_policy`, `run_complete`). Filtering by Stream and
  by status works.
- Common failure modes: `run_failed` shown in DB (must be logger-only per
  `specs/002-runtime-pipeline`); stage filter returns wrong rows; payload
  sample missing.
- Verification: Force a destination failure → `route_send_failed` row appears
  → filter narrows to it.

### 4.13 Checkpoint progression

- Expected outcome: Checkpoint advances only after all required routes
  succeed. On any required-route failure, checkpoint stays.
- Common failure modes: checkpoint advances after mapping; checkpoint
  advances on partial failure outside `LOG_AND_CONTINUE`; checkpoint trace
  empty.
- Verification: Force destination failure → run → checkpoint unchanged →
  recover destination → run → checkpoint advances.

### 4.14 Stream stop / start

- Expected outcome: Stop pauses scheduling and rejects Run Now. Start
  resumes both.
- Common failure modes: scheduler keeps firing after Stop; UI shows Stopped
  but pipeline still runs.
- Verification: Stop → wait one interval → no new logs → Start → next
  interval produces logs.

### 4.15 cURL import

- Expected outcome: Pasting a `curl` command produces a parsed request
  preview (method, base URL, endpoint, headers masked, query params, body
  mode) and pre-fills the wizard.
- Common failure modes: see section 6.

### 4.16 Postman import

- Expected outcome: Importing a Postman collection lists requests and lets
  the operator pick one to pre-fill the wizard.
- Common failure modes: see section 6.

---

## 5. Record Selection / Mapping Consistency Checklist

Mapping and Record Selection are the highest-risk surface in v1. The
authoritative behavior is captured in
`docs/testing/e2e-functional-regression-matrix.md` (Record Selection → runtime
delivery contract) and the path normalization contract tests. Manually
verify each item:

- [ ] `event_array_path` persists across save/reload exactly as entered
      (e.g. `$.Records`, `$`, `$.data.items`).
- [ ] `event_root_path` persists across save/reload exactly as entered
      (e.g. `$.event`, empty/none, `$.payload`).
- [ ] Runtime extraction uses the **combined** path
      (e.g. `$.Records` + `$.event` → `$.Records[*].event`).
- [ ] Preview-time extraction and runtime extraction return the same shape
      for the same sample payload (preview/runtime parity).
- [ ] Field mapping paths are validated as **relative to the extracted
      event** (e.g. `$.eventTime`, not `$.Records[0].event.eventTime`).
- [ ] An invalid envelope-relative mapping path surfaces the
      `ENVELOPE_RELATIVE_MAPPING_PATH` validation message.
- [ ] Mapping save → reload → same row count, same order, same paths, same
      output field names.
- [ ] Root array case: `event_array_path = $`, no Event Root, runtime
      extracts `$[*]` and delivers full elements.
- [ ] Nested array case: `event_array_path = $.Records`,
      `event_root_path = $.event`, runtime delivers only the nested `event`
      object (no wrapper fields).
- [ ] Checkpoint click flow: clicking a sample `$[0].creationTime` persists
      as `$.creationTime` and applies at runtime as `$[*].creationTime`
      (covered by `tests/test_extraction_path_contract.py` and the frontend
      `eventExtractionPaths.test.ts`).

---

## 6. cURL / Postman Import QA Checklist

The import surface (frontend `http-import-panel.tsx`,
backend `app/backup/postman_parser.py`,
tests `tests/test_postman_import.py`) must remain stable for v1.

cURL:

- [ ] `GET` request import: method, URL, headers, query params all parsed.
- [ ] `POST` with JSON body: body mode reported as JSON; preview shows
      `has_json_body = true`.
- [ ] Auth header import: `Authorization` header is parsed and surfaced as
      an auth-type hint without leaking the raw token in the visible
      preview.
- [ ] Query parameter import: `?a=1&b=2` parsed into `query_params`.
- [ ] Malformed cURL handling: missing URL, unmatched quotes, or unsupported
      flags fail with a readable error and do not crash the wizard.
- [ ] Import → wizard consistency: pressing "Use this request" pre-fills the
      same values shown in the parsed preview.
- [ ] Secrets masking: bearer tokens, API keys, cookies, and basic-auth
      values are masked in the visible preview (raw value is only retained
      in the draft used to pre-fill the wizard, never echoed back to the
      log or screen).

Postman:

- [ ] Single request collection import lists the request and lets the
      operator open it.
- [ ] Multi-request collection import lists all requests with method and
      name.
- [ ] Auth at collection or request level is surfaced as an auth-type hint.
- [ ] Variables (`{{baseUrl}}` etc.) are resolved against the collection's
      environment when present, or kept as-is with a warning when not.
- [ ] Malformed Postman JSON (truncated, wrong schema version) fails with a
      readable error and does not crash the wizard.
- [ ] Import → wizard consistency: the wizard fields after selection match
      the request shown in the preview.
- [ ] Secrets masking: tokens, headers marked as auth, and password fields
      are masked in the visible preview.

---

## 7. Runtime / Logs Operational Checklist

Operators must be able to answer "what is happening and why" without
shelling into the container. Verify on the release candidate:

- [ ] Stream status transitions are visible:
      `STOPPED → RUNNING → ERROR → RUNNING`, plus
      `RATE_LIMITED_SOURCE`, `RATE_LIMITED_DESTINATION`,
      `PAUSED_SYSLOG_DOWN`.
- [ ] Route failures are visible in Logs as `route_send_failed` with
      destination id, route id, HTTP status (when applicable), and the
      configured failure policy outcome.
- [ ] Retry visibility: `route_retry_success` and `route_retry_failed`
      appear when `RETRY_AND_BACKOFF` is configured.
- [ ] Checkpoint update visibility: checkpoint trace (per
      `specs/010-checkpoint-trace`) shows the run that advanced the
      checkpoint and the run that did not.
- [ ] Runtime error explainability: every operator-visible error names the
      failing stage (`source_fetch`, `mapping`, `enrichment`,
      `route_send`, etc.) and the entity (stream id, route id,
      destination id).
- [ ] Logs drilldown usability: from a failed run row, the operator can
      reach the Stream detail, the Route detail, and the Destination detail
      in at most two clicks.
- [ ] `run_failed` from the exception path is **not** persisted in
      `delivery_logs` (logger-only per
      `specs/002-runtime-pipeline/spec.md`).

---

## 8. Known Acceptable v1 Limitations

These are deliberately out of scope for v1. They are not bugs. They are not
release blockers.

- No advanced distributed runtime. GDC remains single-node by default; the
  optional Delivery Worker / persistent queue in
  `specs/048-runtime-reliability/spec.md` is not required.
- No complex governance system (no per-field RBAC, no approval workflows
  beyond RBAC-lite in `specs/035-rbac-lite/spec.md`).
- No advanced semantic analysis of payloads (no schema inference, no field
  classification beyond what the operator types).
- No large pipeline visualization. The Runtime Topology view
  (`specs/046-runtime-topology-view/spec.md`) is the only graph view and
  remains read-only.
- No automatic vendor-specific incremental inference. Templates
  (`specs/013-template-connector-system`, `specs/049-template-registry`)
  remain manually authored Source Packs.
- No multi-tenant catalog. Single platform instance, single admin
  hierarchy.
- No drag-and-drop mapping in MVP UI (Phase 2 per constitution).
- No AI / function-style transforms in Mapping or Enrichment.
- No marketplace, no remote template registry.

---

## 9. Release Blockers

The release is **blocked** if any of the following is observed on the
release candidate. There is no soft-blocker tier.

- Save/reload corruption on Connector, Source, Stream, Mapping, Enrichment,
  Destination, or Route (any field silently changes value, type, or is
  dropped).
- Runtime / preview mismatch: the Enriched Final Preview differs from the
  payload actually sent to the Destination for the same sample.
- Mapping path drift: a saved mapping path is rewritten on reload, or the
  runtime extracts using a different envelope than the preview.
- Checkpoint regression: checkpoint advances on a required-route failure,
  or fails to advance on a fully successful run.
- Import corruption: cURL or Postman import pre-fills the wizard with
  values different from the parsed preview.
- Route delivery inconsistency: fan-out delivers to a subset of enabled
  destinations without a corresponding `route_send_failed` or `route_skip`
  log entry explaining why.
- Silent failures: any pipeline error that produces no `delivery_logs` row
  and no application-log line.
- Unexplained operator errors: a UI error message that does not name the
  failing stage or entity (e.g. raw stack trace, opaque 500, "Something
  went wrong" without context).
- Destructive admin or seed behavior that overwrites operator-created
  connectors, streams, routes, or checkpoints (workspace rule
  `preserve-user-entities.mdc`).
- Bootstrap admin contract violation per
  `.specify/memory/constitution.md` (random admin password, overwritten
  existing hash, missing `must_change_password` on first install).

---

## 10. Automated Regression Checklist

These suites must pass on the release candidate. They are the floor, not the
ceiling, of release validation. Each entry maps to an existing entry point;
do not invent new test infrastructure for v1.

- [ ] Focused backend pytest suites used in the functional regression
      script: `./scripts/testing/run-functional-regression.sh` (markers
      include `functional_regression`, `wiremock_integration`).
- [ ] Extraction path contract tests:
      `tests/test_extraction_path_contract.py` and frontend
      `frontend/src/utils/eventExtractionPaths.test.ts`.
- [ ] Event extraction tests (Event Source + Event Root):
      `tests/test_event_extraction_event_root.py`.
- [ ] Mapping draft preview endpoint test:
      `tests/test_runtime_mapping_draft_preview_endpoint.py`.
- [ ] Runtime E2E (WireMock):
      `tests/test_functional_regression_extraction_e2e.py`,
      `tests/test_e2e_regression_matrix.py`, syslog delivery
      `tests/test_e2e_syslog_delivery.py`.
- [ ] Postman import: `tests/test_postman_import.py`.
- [ ] Playwright smoke: `cd frontend && npm run test:playwright-smoke`
      (preflight via `npm run validate:playwright-smoke`). See
      `docs/testing/e2e-functional-regression-matrix.md` for the steady
      vs bootstrap credential rules.
- [ ] Frontend production build: `cd frontend && npm run build` (per the
      workspace rule `frontend-build-after-edit`).
- [ ] Optional source-specific E2E (opt-in markers `source_e2e`,
      `e2e_external`, `e2e_runtime`) when the corresponding source is in
      the release scope:
      `tests/test_source_adapter_e2e.py`,
      `tests/test_external_runtime_e2e.py`,
      `tests/test_webhook_receiver_ingest.py`.

---

## 11. Sign-off

A v1 sign-off requires:

- All section 4 workflows verified by an operator on the release candidate.
- All section 5, 6, 7 checklists verified.
- All section 10 automated suites green.
- No section 9 blocker observed.
- Section 8 limitations explicitly acknowledged in the release notes.

Sign-off is documentation only; no spec or constitution changes are made by
this checklist.
