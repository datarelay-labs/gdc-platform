# Known Limitations — Data Relay OSS v1.0 GA

**Purpose:** Set accurate expectations for operators and integrators.  
**Release decision:** GO WITH KNOWN GAPS (2026-06-20 stabilization audit)  
**These are not release blockers** unless your deployment specifically depends on the limited capability.

---

## How to read this document

| Severity | Meaning |
|----------|---------|
| **Documented gap** | Known by design for v1.0; workaround or v1.x backlog exists |
| **Operational note** | Performance or UX consideration at scale |
| **Experimental** | Feature exists but not GA-recommended |

---

## Route Bundle Persist

### What it is

The Stream Wizard **Route Processing** step lets operators set **Inherit Global** or **Override** per route for Transform, Protection, Classification, and Policy.

At deploy time, the wizard projects a **Deploy Intent** persist kind:

| Persist kind | Meaning |
|--------------|---------|
| **none** | Shared processing only — inherited |
| **governance** | Field-level or policy override persisted via governance API |
| **route_transform** | Route mapping/enrichment bundle persisted at deploy |
| **route_protection** | Route protection intents persisted at deploy |
| **intent_only** | Shown in Deploy but **not saved** for that concern (incomplete override) |

### What is persisted at deploy

- Shared stream processing (mapping, enrichment, data protection intents)
- Complete Transform override (`inherit.transform = false`) → `route_transform`
- Complete Protection override with ready non-audit intents → `route_protection`
- Policy override and field-level governance (protection action, classification floor, delivery behavior) → `governance`
- Route delivery metadata (enabled, failure policy, formatter)

### Remaining Intent only cases

- Classification override without a floor override row
- Protection override without ready non-audit intents
- Incomplete concern payload

### What you should do

1. Prefer complete override payloads in Wizard Route Processing so persist kind is not Intent only.
2. If Deploy still shows Intent only, open the stream/route editor after deploy and save the bundle.
3. Verify **Effective Status** shows **Overridden** (not Inherited) when an override was intended.

**Reference:** [`route-processing-persist-roadmap.md`](../architecture/route-processing-persist-roadmap.md)

---

## Governance Workspace Fan-out

### What it is

**Governance → Governance Workspace** loads effective processing status for **every route across all streams** on page load.

### API pattern

```
2 list calls (streams + routes)
+ 4 × R route effective calls
= 2 + 4R HTTP total
```

Example: **50 routes ≈ 202 HTTP requests** on initial load.

### What you should do

- Use Workspace for **targeted governance review**, not as a high-frequency dashboard.
- Prefer **Route Edit** or **Stream Runtime** for single-stream investigation.
- Expect v1.x lazy-load optimization (selected stream only).

**Reference:** [`performance-p1-optimization-report.md`](../performance/performance-p1-optimization-report.md) §4

---

## Streams Scale (50+)

### What it is

The **Streams console** enriches each stream with runtime stats and health on load.

| Scenario | Approx. HTTP (after P1) |
|----------|-------------------------|
| 50 streams, 5 connectors, groups collapsed | ~64 |
| Expand one group (5 streams) | ~69 |
| 100 streams, collapsed | ~109 |

Mapping UI config is **lazy-loaded** on group expand (P1) — not fetched for collapsed groups.

### Operational notes

- **Product-group view** is the primary UI — groups collapsed by default keeps DOM light.
- **Per-stream stats/health** still scales O(N) — initial load may take several seconds at 100 streams.
- Auto-refresh interval affects repeated load — use **Off** or longer intervals at scale.
- Virtual scrolling applies to a hidden legacy flat table only — not the visible group table.

### What you should do

- Use **Dashboard** for fleet health; drill into Streams for problem groups only.
- Keep groups collapsed unless investigating.
- Plan for v1.x batch stats/health API if running 100+ streams daily.

---

## Database Query Source (PostgreSQL-centric)

### What it is

**DATABASE_QUERY** source type is supported in the UI and wizard.

### Runtime limitation

Stream runner executes database query fetch against **PostgreSQL only** (`app/sources/database_query/execute.py`).

MySQL/MariaDB adapters may exist for dev validation lab but are **not** production runtime paths.

### What you should do

- Use **PostgreSQL** as the query source database for DATABASE_QUERY streams.
- For other databases, use **HTTP API polling** or an intermediate export to a supported source.

---

## GDC_ROUTE_PROCESSING_ENABLED

### Default

```python
GDC_ROUTE_PROCESSING_ENABLED: bool = True  # app/config.py
```

### When true (product default)

- Per-route pipeline: Transform → Protection → Classification → Policy → Delivery
- Shared StreamRunner delivery primitive (adapter send, failure policy, Failover, Replay recording)
- Stream checkpoint after successful / absorbed delivery
- OSS install / docker-compose inherit this default when the env var is unset

### When false (rollback / compatibility)

- Stream-scoped mapping, enrichment, protection, classification, policy
- Legacy multi-route fan-out using the same `_send_route_events` primitive
- Same Failover engine and Replay recording semantics

### What you should do

- Leave default **true** unless rolling back to the legacy stream-scoped path.
- Set `GDC_ROUTE_PROCESSING_ENABLED=false` only for compatibility investigation.

**Reference:** [`OSS-v1-ARCHITECTURE.md`](../architecture/OSS-v1-ARCHITECTURE.md)

---

## Additional documented limitations

| Limitation | Detail |
|------------|--------|
| **Governance Workspace** | Read-only MVP — no inline edit or approval from Workspace |
| **Regex replace** | Not in Advanced Transform MVP — `regex_extract` only in Expert mode |
| **SMTP default off** | Delivery is implemented (`SmtpEmailSender`); default `SMTP_ENABLED=false` skips send. Slack remains planned. |
| **AI Gateway** | Not Data Relay OSS product scope — operator UI and AI-specific APIs are not mounted |
| **Wizard onboarding** | Connector is created outside the Stream Wizard (wizard selects an existing connector) |
| **Main bundle size** | ~991 KB entry + async chunks — first load on slow networks may be noticeable |

---

## What is NOT limited (GA-ready)

- HTTP API polling and Webhook receiver sources
- Multi-route delivery with failure policies
- Dynamic routing (M9)
- Failover (M10) on default path
- Protection, classification, policy, quarantine, replay (with rules configured)
- RBAC and audit trail
- Dashboard operational monitoring and Streams problem-first UX
- Dashboard / Governance Schema Drift fleet count (confirmed open `StreamSchemaFieldDrift` via Runtime Snapshot)
- Operational SMTP email delivery (existing NotificationService / dispatcher → `SmtpEmailSender`) when `SMTP_ENABLED=true` and `SMTP_HOST` is set; disabled SMTP does not send and does not fail Stream/runtime/approval; SMTP failure records notification FAILED only
- Route Edit full persist for all processing concerns

---

## Reporting issues

If behavior differs from this document, check:

1. [Getting Started](../getting-started/GETTING-STARTED.md) — expected workflow
2. [Architecture Overview](../architecture/OSS-v1-ARCHITECTURE.md) — runtime model
3. [Operator Runbook](../operator-runbook.md) — troubleshooting

---

*Data Relay OSS v1.0 GA — Known limitations reference.*
