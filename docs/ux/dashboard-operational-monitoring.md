# Dashboard Operational Monitoring (P0)

Operational dashboard at `/monitoring` is the operator's first screen. This document describes the P0 UX surfaces added to close gaps identified in the Dashboard & Operational Monitoring UX Audit.

## Layout order

1. **Overall Health** — Healthy / Warning / Critical counts (`OverallHealthHero`) plus posture beacon.
2. **Operational Issues (primary)** — No data, low volume, schema drift, destination capacity only.
3. **Traffic KPI strip** — Incoming Events, Outgoing Events, Delivery Success Rate (5m snapshot).
4. **Group KPI + Group summary** — Healthy / Warning / Critical stream groups (source product) with drill-down.
5. **Secondary** — Issue details, top sources, supporting KPIs (active streams / delivery gap / alerts), stream health matrix, events chart, recent alerts, system health bar (includes checkpoint demoted from primary).

## P0 / P1-2 surfaces

### Stream group KPI

- **Source:** `deriveStreamGroupHealth(streams, connectors)` in `dashboard-charter-metrics.ts` (same logic as Streams page grouping).
- **UI:** `DashboardGroupKpiStrip` — three cards: Healthy Groups, Warning Groups, Critical Groups.
- **Drill-down:** each card links to `/streams`.

### Operational issues

- **Source:** `derivePrimaryOperationalIssueStrip` / `deriveOperationalIssuesFromSnapshot` — Runtime Snapshot only; no new backend endpoints.
- **Schema Drift count:** fleet total of confirmed open `StreamSchemaFieldDrift` rows (`open_schema_field_drift_count` on snapshot streams). Not checkpoint drift and not continuous-validation failing/degraded counts.
- **UI:** primary strip on Dashboard; detailed problem rows demoted to Issue details.
- **Drill-down:** No data / Low volume / Schema drift → `/streams`; Capacity → `/destinations?filter=warning`.

### Alert deep link

- **Recent alerts:** when `RuntimeAlertSummaryItem.stream_id` is a positive number, the alert row links to `/streams/{id}/runtime`.
- **Fallback:** invalid or missing `stream_id` keeps the previous behavior (`/streams`).

### Group summary

- **UI:** `DashboardGroupSummaryPanel` lists critical (`ERROR`) and warning (`DEGRADED`) source-product groups.
- **Drill-down:** group row links to `/streams?expand_group={productLabel}`.
- **Streams console:** reads `expand_group` from the query string and auto-expands the matching group row.

## Operator flow (target)

```
Dashboard → Group summary / Group KPI
         → Streams (group expanded)
         → Stream runtime
         → Action (routes, logs, mapping)
```

## Constraints (P0 / P1-2)

- No runtime engine changes.
- No new API endpoints / health engine / metrics pipeline.
- Stream Group is UX grouping by `connector.product_group` (no new DB entity).
- Dashboard / monitoring UX only; Route Processing untouched.

## Related files

| Area | File |
|------|------|
| Page layout | `frontend/src/components/dashboard/dashboard-overview.tsx` |
| Panels | `frontend/src/components/dashboard/dashboard-visual-panels.tsx` |
| Metrics | `frontend/src/components/dashboard/dashboard-charter-metrics.ts` |
| Paths | `frontend/src/config/nav-paths.ts` (`streamsExpandedGroupPath`) |
| Streams expand | `frontend/src/components/streams/streams-console.tsx` |
| Tests | `dashboard-overview.test.tsx`, `dashboard-charter-metrics.test.ts`, `source-product-group.test.ts`, `streams-console-expand.test.tsx` |
