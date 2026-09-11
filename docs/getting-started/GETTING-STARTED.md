# Getting Started with Data Relay OSS v1.0

**Audience:** First-time operators setting up their first data pipeline  
**Prerequisite:** Data Relay installed and reachable ([Quick Start](../../README.md#quick-start))  
**Time:** ~30–45 minutes for a simple HTTP → Webhook pipeline

---

## Overview

Data Relay connects **sources** to **destinations** through **streams** and **routes**. The recommended first-time path:

```
Connector  →  Stream Wizard  →  Deploy  →  Monitoring
```

> **Note:** Connector creation is a **separate step** before the Stream Wizard. The wizard **selects** an existing connector — it does not create one inline.

---

## Step 1 — Connector 생성

A **Connector** defines how Data Relay reaches your source product (credentials, base URL, product group).

### Actions

1. Open **Connectors** in the sidebar.
2. Click **New Connector** (or navigate to `/connectors/new`).
3. Choose a source type (e.g. **HTTP API Polling**).
4. Enter connection details:
   - Name (e.g. `My API Connector`)
   - Product group (used for Stream Group display on Dashboard/Streams)
   - Base URL, authentication, timeout
5. Save the connector.

### Sample configuration

See [`samples/http/example-api.json`](../../samples/http/example-api.json) for a reference payload.

### Screenshot placeholder

```
docs/getting-started/images/01-connectors-new.png
(Capture: Connectors overview → New Connector form)
```

### Tips

- Product group names appear as **Stream Groups** on the Dashboard and Streams console.
- Store credentials in the platform — they are encrypted at rest.

---

## Step 2 — Stream 생성 (Wizard: Connect)

1. Open **Streams** → **New Stream** (`/streams/new`).
2. **Connect** step:
   - Select the connector created in Step 1.
   - Configure the HTTP source: method, endpoint path, polling interval.
   - Complete authentication if required.

### Screenshot placeholder

```
docs/getting-started/images/02-wizard-connect.png
(Capture: Stream Wizard — Connect step with connector selected)
```

### Tips

- You can advance to the next step only after basic connection fields are filled.
- If no connector exists, the UI links to **Connectors → New**.

---

## Step 3 — Sample Test (Wizard: Sample & Record Selection)

Validate that Data Relay can reach your source and identify event records.

### Actions

1. **Run Test** — execute a sample API call against the source.
2. Confirm a successful response.
3. Set **Record path** / **Event root** so the platform knows where events live in the payload.
4. Confirm **Checkpoint** preview (where ingestion will resume).

### Screenshot placeholder

```
docs/getting-started/images/03-wizard-sample-test.png
(Capture: Sample step — successful API test + record path)
```

### Tips

- This step has the strictest gates — complete API test and record selection before advancing.
- Use the response preview to pick JSONPath for record selection.

---

## Step 4 — Destination (Wizard: Destinations)

Choose where events will be delivered. Each destination becomes a **route** on the stream.

### Actions

1. Select one or more **Destinations** (create under **Delivery → Destinations** first if needed).
2. Configure per-route delivery settings (enabled, failure policy, formatter).
3. Review route drafts in the list.

### Screenshot placeholder

```
docs/getting-started/images/04-wizard-destinations.png
(Capture: Destinations step — destination selected, route draft visible)
```

### Sample destinations

- Webhook: [`samples/destinations/`](../../samples/destinations/)
- Syslog: see deployment docs

### Tips

- **Destination-first** is intentional: pick targets before configuring transform/protection.
- Reusable destinations can serve multiple streams.

---

## Step 5 — Route Processing (Wizard: Route Processing)

Configure **Shared Processing** (applies to all routes unless overridden) and optional per-route overrides.

Route Processing concerns:

```text
Transform → Protection → Classification → Policy → Delivery
```

### Actions

1. **Shared Transform** — map source fields to a canonical shape (JSONPath / JSONata).
2. **Shared Enrichment** (optional) — add derived fields.
3. **Data Protection** (optional) — protection, classification, policy intents.
4. Per-route cards — set **Inherit Global** or **Override** per concern (Transform, Protection, Classification, Policy).

> **Note:** Complete Transform / Protection / Policy overrides persist at deploy. Incomplete classification or protection overrides may still show **Intent only**. See [Known Limitations](../release/KNOWN-LIMITATIONS.md#route-bundle-persist).

### Screenshot placeholder

```
docs/getting-started/images/05-wizard-route-processing.png
(Capture: Route Processing — shared mapping + route list)
```

### Sample mapping

[`samples/mappings/example-mapping.json`](../../samples/mappings/example-mapping.json)

---

## Step 6 — Deploy (Wizard: Deploy)

Review the **Deployment Decision Center** and create the stream.

### Actions

1. Review deploy summary — routes, processing status projections, readiness checks.
2. Click **Create Stream** (and optionally **Start**).
3. Note any warnings (e.g. Intent only overrides).

### Screenshot placeholder

```
docs/getting-started/images/06-wizard-deploy.png
(Capture: Deploy step — readiness green, create button)
```

### After deploy

- Stream appears on **Streams** console under its product group.
- Routes are visible from the stream detail / Destinations context (Routes is not a primary sidebar item).

---

## Step 7 — Monitoring

Confirm the pipeline is healthy and events are flowing.

### Dashboard (daily check)

1. Open **Dashboard** (`/monitoring`) — default landing page.
2. Review **Overall Health**, **Group KPI**, **Operational Issues**.
3. Drill down: click a group → **Streams** opens with `expand_group` query.

### Screenshot placeholder

```
docs/getting-started/images/07-dashboard-overview.png
(Capture: Dashboard — health hero + group KPI strip)
```

### Streams console

1. Open **Streams** — streams grouped by product.
2. Expand a group to see per-stream status, rates, issues.
3. Click a stream row → **Stream Runtime** detail.

### Screenshot placeholder

```
docs/getting-started/images/08-streams-console.png
(Capture: Streams — expanded group with RUNNING status)
```

### Stream runtime

- Start / Stop / Run Once controls
- Metrics, health, routes, delivery logs, checkpoint
- Backfill (where supported)

### Screenshot placeholder

```
docs/getting-started/images/09-stream-runtime.png
(Capture: Stream runtime — overview tab with metrics)
```

---

## Optional — Governance

If your role includes `governance_read`:

| Surface | When to use |
|---------|-------------|
| **Governance → Violations** | Policy violations triage |
| **Governance → Quarantine** | Held events review and release |
| **Governance → Replay** | Re-deliver recorded events |
| **Governance → Notifications** | Email/webhook alert channels |

Governance is **optional** — core delivery works without configuring governance rules.

---

## Troubleshooting quick reference

| Symptom | First check |
|---------|-------------|
| No data on Dashboard | Stream status STOPPED? Source reachable? |
| Deploy blocked | Sample test incomplete? Destination missing? |
| Route override not applied after deploy | Intent only? → Route Edit to persist bundle |
| Slow Streams page (50+ streams) | Expected — see [Known Limitations](../release/KNOWN-LIMITATIONS.md#streams-scale-50) |

---

## Next steps

| Document | Purpose |
|----------|---------|
| [Architecture Overview](../architecture/OSS-v1-ARCHITECTURE.md) | Mental model deep dive |
| [Operator Runbook](../operator-runbook.md) | Day-2 operations |
| [Production Checklist](../release/production-checklist.md) | Go-live checklist |
| [Known Limitations](../release/KNOWN-LIMITATIONS.md) | Full gap reference |

---

*Data Relay OSS v1.0 — Getting Started guide.*
