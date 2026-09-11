# QA Automation Architecture Audit (final)

Date finalized: 2026-08-20  
Baseline HEAD (fault rerun + ROUTE_OFF): `3cd21d80995470848150c94fa9fcbe0e50ee03fc`  
Prior audit HEAD (ROUTE_ON normal start): `4437e4e7a6faf1fc2dfb79405e7b53eceae1041e`

| Run | Role |
| --- | --- |
| `xp_parallel_full_20260819_001` | Clean ROUTE_ON baseline (27,366) — normal pool PASS; fault pool re-run after product/harness fixes |
| `xp_parallel_full_20260820_001` | Clean ROUTE_OFF baseline (4,818) — workers=2, fault-workers=1 |
| `xp_parallel_full_20260818_002` | Preserved prior mixed-evidence run (**not** a release baseline) |

This audit maps **existing tests and execution paths**, not test names. New tools are recommended only where they close a real coverage or isolation gap.

**Goal:** automate everything that can be automated; humans keep only the frozen **7 GUI acceptance scenarios**.

---

## 0. Clean Full Matrix baseline (P0-0) — PASS

```text
TOTAL_EXPECTED=32184
TOTAL_EXECUTED=32184
TOTAL_UNIQUE=32184
TOTAL_PASS=32184
TOTAL_FAIL=0
TOTAL_MISSING=0
TOTAL_DUPLICATES=0

ROUTE_ON  EXPECTED=27366 EXECUTED=27366 UNIQUE=27366 PASS=27366 FAIL=0
ROUTE_OFF EXPECTED=4818  EXECUTED=4818  UNIQUE=4818  PASS=4818  FAIL=0

NORMAL_SHARDS_PASS=24 (ON) / 24 (OFF)
FAULT_SHARDS_PASS=8  (ON) / 8  (OFF)

HARNESS_INDUCED_5XX=0
CROSS_WORKER_CONTAMINATION=0
RESOURCE_COLLISIONS=0
FAULT_ISOLATION=PASS
```

Product / harness fixes that unblocked the fault pool (already landed before this finalize):

- `cfe15fa` — prevent checkpoint advance without delivery success
- `a3fb4cb` — block trusted resume reuse for shards with FAIL rows
- `3cd21d8` — demote untrusted completed shards on parallel coordinator resume

ROUTE_ON normal shards retain harness `b5d7779…` from the original generation; fault re-run and all ROUTE_OFF rows use `bd7a29f…` at HEAD. Integrity counts treat both as authoritative PASS evidence; legacy FAIL evidence was **not** deleted and was **not** merged into the release baseline.

---

## 1. Target execution layers

```text
PR / Commit
→ Unit
→ API
→ Schemathesis          (after OpenAPI export works)
→ Fast deterministic tests

Integration
→ Testcontainers        (targeted; only if shared-lab contamination returns)
→ PostgreSQL
→ MinIO
→ SFTP
→ Syslog

Failure / Runtime
→ WireMock
→ Toxiproxy             (TCP reset / half-open; WireMock cannot express)
→ Retry / Failover
→ Checkpoint
→ Dedup / Recovery

Nightly / Release
→ Full 32,184 Matrix
→ Fault Matrix
→ RESTler if justified
→ Real API Canary

Human
→ 7 GUI Acceptance Scenarios only
```

| Layer | Goal | What already runs | Cadence |
| --- | --- | --- | --- |
| **PR / Commit QA** | Fast, deterministic | pytest unit + API (`tests/`), Vitest (`frontend/src/**/*.test.*`), path-filtered GHA | Every PR |
| **Integration QA** | Real protocol / storage | `source_e2e` / `e2e_runtime` vs MinIO, fixture PG, atmoz/sftp, WireMock, in-process syslog TLS; `docker-compose.test.yml` | Path PRs + local |
| **Failure / Runtime QA** | Status, timeout, disconnect, retry, failover, checkpoint, dedup | WireMock faults; `fault-inject.sh`; Full Matrix fault shards; pytest checkpoint fakes + WireMock 401 | Nightly + selected PR |
| **Nightly / Release QA** | Combinatorial + evidence | **Clean 32,184 baseline now PASS**; fault matrix; 7 human wizard acceptance; OSS release-gate unit | Nightly / release — **not** every PR |

---

## 2. Current asset map (assertions and execution path)

| Area | Current tests (what they actually assert) | Current tool | Coverage | Problem | Verdict | Recommended tool | Priority | Expected benefit | Runtime impact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Backend unit / API | CRUD, RBAC 403, runtime fakes, checkpoint-after-delivery, config-version lock | pytest + TestClient | Strong for in-process product rules | OpenAPI fuzz / invalid body matrix not generated | KEEP | pytest | P0 | Existing PR gate | ~minutes |
| Frontend unit | Wizard persist, snapshot labels, login error, route processing | Vitest | Strong UI contract | Not runtime | KEEP | Vitest | P0 | Existing PR gate | ~minutes |
| HTTP source happy path | WireMock journal + delivery_logs + checkpoint advance | WireMock | Strong | Duplicate mappings vs lab fixtures (two stacks) | KEEP | WireMock | P0 | PR HTTP regression | ~minutes with compose |
| HTTP 401 source | No checkpoint on 401 | WireMock | Strong | — | KEEP | WireMock | P0 | Checkpoint hold | seconds |
| HTTP 403 source | Lab mapping + Full Matrix `http_403`. **No pytest** checkpoint hold | WireMock + matrix | Partial | Matrix recovers on a **new** stream; does not assert hold | EXPAND | WireMock pytest family | P0-4 gap | Close without new deps | seconds on PR |
| HTTP timeout | Lab delay + matrix `http_timeout` | WireMock delay | Partial | Application delay only; no TCP reset | EXPAND then ADD | WireMock first; Toxiproxy for TCP | P0-4 / P0-2 | Timeout vs disconnect | WireMock: seconds; Toxiproxy: +job |
| HTTP malformed | Lab `{not-json` + matrix | WireMock | Partial | Checkpoint-hold gap in pytest | EXPAND | WireMock pytest | P0-4 | Parse-fail contract | seconds |
| HTTP 429/500 | Lab + matrix + template rate-limit | WireMock | Adequate for HTTP status | Not connection-level reset | KEEP | WireMock | P0 | Retry classification | seconds |
| S3 happy path | `source_e2e`, parse/watermark unit | MinIO | Happy + checkpoint skip-old | Auth/AccessDenied not asserted | KEEP + EXPAND | Existing MinIO | P0-4 / P1 | Auth failure contract | minutes |
| S3 unavailable | Matrix `s3_unavailable` docker stop | fault-inject | Process-down only | Not AccessDenied / bad key | KEEP | fault-inject | Nightly | Availability | minutes, serial fault pool |
| DATABASE_QUERY happy | source_e2e + readonly execute | postgres-query-test | Happy path | Query timeout / `pg_sleep` not asserted | KEEP + EXPAND | Existing PG fixture | P0-4 | Timeout vs disconnect | minutes |
| DB disconnect | Matrix `db_disconnect` docker stop | fault-inject | Process-down | Not statement_timeout | KEEP | fault-inject | Nightly | Availability | minutes |
| SFTP happy | source_e2e + atmoz/sftp seed | atmoz/sftp | Happy path | Auth/path/permission not asserted | KEEP + EXPAND | Existing SFTP fixture | P0-4 | Auth/path contract | minutes |
| SFTP unavailable | Matrix `sftp_unavailable` docker stop | fault-inject | Process-down | Not bad password / invalid path | KEEP | fault-inject | Nightly | Availability | minutes |
| Syslog dest UDP/TCP/TLS | source_e2e receivers; Full Matrix collectors | Custom collectors + pytest sockets | Strong for evidence | Real syslog-ng interop not required for evidence | KEEP | Custom collector | P0 | Delivery evidence | in matrix |
| Webhook dest | Collectors + WireMock webhook sink | webhook-collector | Strong after NEXT_ID + `collectorMessageKey` | Shared ring buffer needs worker channels (mitigated) | KEEP | Custom collector | P0 | Correlation | in matrix |
| Checkpoint / dedup | pytest fakes; WireMock 401; matrix partial_route_failure | pytest + matrix | Strong in-process; matrix HTTP faults covered | Source 403/timeout/malformed hold not in pytest | EXPAND | pytest family | P0-4 | “checkpoint = delivery success only” | seconds |
| Retry / failover | stream_runner_e2e, template retry, live wizard | pytest + matrix | Strong for dest retry | TCP reset during send not covered | KEEP + later ADD | Toxiproxy later | P0 / P0-2 | Recovery | — |
| Full combinatorial | 32 shards, 32,184 combos, workers=2 + fault-workers=1 | Playwright + lab | Combinatorial product surface | Shared fixtures → races (mitigated); clean baseline now PASS | KEEP | Existing harness | P0-0 **PASS** | Release evidence | ~hours nightly |
| Live wizard GUI | live-wizard acceptance + 7 human | Playwright + human | Representative operator path | Must stay human for 7 | KEEP | Playwright smoke + human 7 | Human | Operator trust | minutes auto + human |
| GitHub Actions | path-filtered pytest/vitest/build; e2e-smoke; e2e-regression nightly | GHA | PR fast path OK | Full Matrix **not** in GHA (correct) | KEEP | GHA | P0 | Required checks | existing |
| OpenAPI / contract | FastAPI generates schema; lab `GET /openapi.json` was HTTP 500 | none | Weak | Schemathesis blocked until exportable | EXPAND then ADD | FastAPI dump + Schemathesis | P0-3 | Boundary fuzz | +PR/nightly job |
| Network-layer faults | docker stop; WireMock delay; closed port `:1` | fault-inject / WireMock | Availability + HTTP delay | reset / half-open / refused vs delay | ADD | Toxiproxy | P0-2 | Source/dest/checkpoint | dedicated job |
| Isolation | Worker namespaces; fault exclusive lock | parallel harness | Improved; clean baseline contamination=0 | Residual risk if worker count rises | EXPAND only if needed | Testcontainers targeted | P0-1 | Parallel stability | setup cost |

---

## 3. Tool verdicts

```text
TESTCONTAINERS=EXPAND (targeted; P0-1 — only if contamination returns)
TOXIPROXY=ADD (P0-2)
SCHEMATHESIS=ADD (P0-3 — after OpenAPI export)
EXISTING_6_AUTOMATION_GAPS=EXPAND with current fixtures (P0-4)
GO_HTTPBIN=NOT_NEEDED
MINIO=KEEP + EXPAND auth/access (P1 only if justified after P0-4)
SFTPGO=NOT_NEEDED
SYSLOG_NG=NOT_NEEDED (optional P1 interop only)
PRISM=NOT_NEEDED
RESTLER=ADD (P2 Nightly only; never PR)
PUBLIC_APIS=ADD (P2 canary; never CI-gating)
```

### Testcontainers — EXPAND targeted (P0-1), not a rewrite

Shared-lab races were mitigated (advisory lock, `NEXT_ID`, `collectorMessageKey`, per-worker namespaces, fault pool after normal). Clean baseline measured:

- `CROSS_WORKER_CONTAMINATION=0`
- `RESOURCE_COLLISIONS=0`

Do **not** recreate 32,184 on Testcontainers. Next isolation bet only if contamination returns: hottest candidates lab PostgreSQL catalog mutations, then destination collectors.

### Toxiproxy — ADD (P0-2)

WireMock / docker-stop cannot express connection reset, half-open, or refused vs HTTP delay. Place in lab only in front of WireMock (HTTP source) and webhook/syslog collectors (destination).

### Schemathesis — ADD (P0-3)

Export OpenAPI from `app.openapi()` (or restore `openapi_url`) before enabling. Do not replace pytest. PR-optional or nightly with a time cap. Lab auth must not treat 401 as product FAIL when `REQUIRE_AUTH=false`.

### Six automation gaps — EXPAND existing tools (P0-4)

HTTP 403 / timeout / malformed checkpoint hold; S3 auth; DB statement timeout; SFTP auth/path — all against **existing** WireMock / MinIO / PG / atmoz/sftp. No new products.

### go-httpbin / SFTPGo / Prism — NOT_NEEDED

WireMock + atmoz/sftp + pytest already cover the contracts. Prism would duplicate pytest + planned Schemathesis.

### MinIO / syslog-ng — P1 only if justified

MinIO auth/AccessDenied expansion is the only P1 tool change likely to pay off. syslog-ng is optional vendor interop, not an evidence sink replacement.

### RESTler / public-apis — P2 Nightly only

Never PR-gating. External canary must classify `PRODUCT_FAILURE` | `EXTERNAL_FAILURE` | `UNKNOWN`.

---

## 4. Automation gap placement (former manual/GUI leftovers)

| # | Gap | Today | Place | Tool |
| --- | --- | --- | --- | --- |
| 1 | HTTP 403 source path | WireMock + matrix; no pytest checkpoint hold | Failure / Runtime QA (PR) + matrix | WireMock |
| 2 | HTTP timeout | WireMock 60s delay + matrix | Failure QA + later Toxiproxy | WireMock → Toxiproxy |
| 3 | HTTP malformed response | WireMock `{not-json` + matrix | Failure QA pytest family | WireMock |
| 4 | S3 auth/access failure | Only `s3_unavailable` | Integration + Failure QA | MinIO bad key / policy |
| 5 | DATABASE_QUERY timeout | Only `db_disconnect` | Integration + Failure QA | `pg_sleep` / statement_timeout |
| 6 | SFTP auth/path failure | Only `sftp_unavailable` | Integration + Failure QA | Existing atmoz/sftp |

Do **not** leave these as human GUI checks.

---

## 5. Connector family contract (target model)

```text
Connector Family Contract
        ↓
Source Runtime
        ↓
Failure Matrix
        ↓
Checkpoint / Dedup
        ↓
Destination Result
```

| Family | PR contract (pytest) | Integration | Failure | Nightly |
| --- | --- | --- | --- | --- |
| HTTP | WireMock 401/403/429/500/timeout/malformed + checkpoint hold | — | Toxiproxy later | Full Matrix |
| S3 | Parse/watermark unit (exists) | MinIO happy (exists) | AccessDenied + unavailable | Matrix s3_unavailable |
| DATABASE_QUERY | Readonly execute (exists) | Fixture SQL happy (exists) | statement timeout + disconnect | Matrix db_disconnect |
| REMOTE_FILE | — | SFTP happy (exists) | auth/path + unavailable | Matrix sftp_unavailable |
| WEBHOOK | Ingest unit/e2e (exists) | Receiver + dest collector | dest down + dedup | Matrix |

Humans verify **one representative connector** for Test Connection → Sample → Stream Create → Real Delivery (items 2–5 of the 7).

---

## 6. Human QA (frozen at 7)

1. Login → Dashboard  
2. Real Connector → Test Connection → Sample  
3. Create Stream → Union Schema → Destinations → Deploy  
4. One Stream → Three Routes (Inherit / Transform+Protection / Policy Block)  
5. Real destination payload compare  
6. Stream Edit → Reload → Override → Redeploy  
7. Destination Failure → Dashboard/Route → Recovery  

No automated-capable items will be added to this list.

---

## 7. Duplicates to keep vs consolidate

| Pair | Verdict |
| --- | --- |
| `tests/wiremock/mappings` vs `e2e/lab/fixtures/http/mappings` | **KEEP both** — pytest CI vs Full E2E lab |
| `tests/test_e2e_regression_matrix.py` vs Full Matrix | **KEEP both** — PR subset vs 32k combinatorial |
| `frontend/e2e/*` wizard smoke vs live-wizard acceptance | **KEEP both** |
| `gdc-smoke-*` vs `gdc-*` fixture containers | **KEEP both names**; Full Matrix must use prefix `gdc` |
| Fake syslog in pytest vs lab syslog-collector | **KEEP both** |

No REMOVE_DUPLICATE this cycle except: do not add Prism, go-httpbin, or SFTPGo on top of working fixtures.

---

## 8. Implementation order (next)

```text
P0-0  Clean 32,184 Full Matrix baseline          PASS (this campaign)
P0-1  Testcontainers / test isolation (targeted) after contamination metrics (currently 0)
P0-2  Toxiproxy                                  network faults WireMock cannot do
P0-3  Schemathesis                               after OpenAPI export works
P0-4  Existing 6 automation gaps                 WireMock/MinIO/PG/SFTP — no new products

P1    go-httpbin / MinIO expand / SFTPGo / syslog-ng
      → only MinIO auth expansion is justified; others NOT_NEEDED unless P0-4 proves fixture limits

P2    RESTler Nightly / public API Canary / Prism only if justified
      → Prism remains NOT_NEEDED; other two Nightly-only
```

Do not install P1/P2 tools until P0-1…P0-4 need them.

---

## 9. Parallelization performance (Full Matrix, not tiny subset)

Stable settings: `workers=2`, `fault-workers=1`.

| Metric | Value |
| --- | --- |
| ROUTE_ON wall clock | ~39.04 h (140,553 s) — 2026-08-18T15:30:55Z → 2026-08-20T06:33:28Z |
| ROUTE_ON normal pool | ~20.89 h (workers=2) then fault pool serial |
| ROUTE_ON fault re-run | ~14.35 h (51,663 s coordinator elapsed; fault-workers=1) |
| ROUTE_OFF wall clock | ~10.45 h (37,635 s coordinator elapsed) — 2026-08-20T06:42:10Z → 2026-08-20T17:09:25Z |
| TOTAL wall clock | ~49.5 h (178,188 s) |
| TOTAL scenarios/sec | ~0.181 |
| ROUTE_OFF scenarios/sec | 0.128 |
| SPEEDUP vs previous serial (est.) | ~1.5× (normal pool ~2×; fault pool remains serial) |

Bottlenecks (no further optimization in this campaign):

1. **GLOBAL_FAULT pool is strictly serial** (`fault-workers=1`) — dominates ROUTE_ON fault re-run and most of ROUTE_OFF tail.
2. Largest ROUTE_OFF normal shards by scenario count: `xp-normal-021` (183), `011` (175), `001` (172), `023` (168), `009` (166).
3. Shared lab fixtures force fault isolation after the normal pool; raising fault concurrency is not safe without stronger isolation (P0-1).

---

## 10. Coverage snapshot

```text
CURRENT_AUTOMATED_COVERAGE=HTTP happy+401+status faults, S3/DB/SFTP happy, dest retry/failover pytest, Full Matrix combinatorial (clean 32184 PASS), docker-stop availability
TARGET_AUTOMATED_COVERAGE=above + source 403/timeout/malformed checkpoint hold + S3 auth + DB query timeout + SFTP auth/path + TCP toxics + OpenAPI boundary fuzz
MANUAL_ACCEPTANCE_SCENARIOS=7
CLEAN_FULL_MATRIX_BASELINE=YES
PARALLELIZATION_WORK_COMPLETE=YES
QA_AUTOMATION_FOUNDATION_READY=YES
```

Estimated: **~80%** of intended automated runtime/failure coverage today; **~95%** after P0-1…P0-4. Remaining ~5% is the frozen human 7 plus optional P2 canary/fuzz.

---

## 11. Clean baseline operational notes

- Prior run `xp_parallel_full_20260818_002` mixed old collector id-reuse evidence; **preserved, not overwritten**.
- Collectors rebuilt with monotonic `NEXT_ID`. Production API/scheduler/postgres **not** recreated for this baseline.
- Lab API `:18000` on HEAD with advisory lock `gdc:platform_config_versions.version`. Production `:8000` left running.
- Fixtures: WireMock lab mappings; MinIO `s3://gdc-full-e2e/full-e2e/`; SFTP `/upload/full-e2e/`; PG fixture seeded.
- FAIL shards are never trusted/reused; untrusted completed shards are demoted on coordinator resume.
