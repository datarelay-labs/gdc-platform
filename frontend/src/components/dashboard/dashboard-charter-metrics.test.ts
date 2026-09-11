import { describe, expect, it } from 'vitest'
import {
  deriveDashboardKpisFromSnapshot,
  deriveFlowBreakdownFromSnapshot,
  deriveOverallHealthBeacon,
  deriveOverallHealthFromSnapshot,
  derivePrimaryOperationalIssueStrip,
  derivePrimaryTrafficKpisFromSnapshot,
  deriveTrafficOverviewFromSnapshot,
  deriveOperationalIssuesFromSnapshot,
  deriveFleetSchemaDriftFromSnapshot,
  deriveRecentAlertsSummary,
  deriveStreamGroupHealthFromSnapshot,
  SNAPSHOT_KPI_BASIS_LABEL,
} from './dashboard-charter-metrics'
import type { ConnectorRead } from '../../api/gdcConnectors'
import type { DestinationListItem } from '../../api/gdcDestinations'
import type { DashboardSummaryResponse } from '../../api/types/gdcApi'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'

const snapshot = (): OperationalSnapshotResponse => ({
  global: {
    health_status: 'DEGRADED',
    total_streams: 8,
    enabled_streams: 8,
    running_streams: 5,
    error_streams: 1,
    total_routes: 10,
    enabled_routes: 10,
    total_destinations: 2,
    enabled_destinations: 2,
    total_eps_1m: 100,
    total_eps_5m: 95,
    avg_latency_ms: 20,
    last_activity_at: null,
  },
  streams: [
    {
      stream_id: 1,
      stream_name: 'A',
      connector_id: 1,
      source_id: 1,
      enabled: true,
      status: 'RUNNING',
      health_status: 'HEALTHY',
      eps_1m: 50,
      eps_5m: 50,
      success_rate_5m: 100,
      failure_rate_5m: 0,
      avg_latency_ms: 10,
      route_count: 1,
      healthy_route_count: 1,
      failed_route_count: 0,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    },
    {
      stream_id: 2,
      stream_name: 'B',
      connector_id: 2,
      source_id: 2,
      enabled: true,
      status: 'DEGRADED',
      health_status: 'DEGRADED',
      eps_1m: 20,
      eps_5m: 20,
      success_rate_5m: 80,
      failure_rate_5m: 20,
      avg_latency_ms: 30,
      route_count: 1,
      healthy_route_count: 0,
      failed_route_count: 1,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    },
    {
      stream_id: 3,
      stream_name: 'C',
      connector_id: 3,
      source_id: 3,
      enabled: true,
      status: 'IDLE',
      health_status: 'IDLE',
      eps_1m: 0,
      eps_5m: 0,
      success_rate_5m: 0,
      failure_rate_5m: 0,
      avg_latency_ms: null,
      route_count: 0,
      healthy_route_count: 0,
      failed_route_count: 0,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    },
    {
      stream_id: 4,
      stream_name: 'D',
      connector_id: 4,
      source_id: 4,
      enabled: true,
      status: 'ERROR',
      health_status: 'ERROR',
      eps_1m: 10,
      eps_5m: 10,
      success_rate_5m: 50,
      failure_rate_5m: 50,
      avg_latency_ms: 40,
      route_count: 1,
      healthy_route_count: 0,
      failed_route_count: 1,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      checkpoint_updated_at: null,
      checkpoint_lag_seconds: null,
    },
  ],
  routes: [],
  destinations: [],
  problems: [],
  updated_at: '2026-01-01T00:00:00Z',
})

describe('dashboard-charter-metrics', () => {
  it('derives overall health posture from operational snapshot streams', () => {
    expect(deriveOverallHealthFromSnapshot(snapshot())).toEqual({
      healthy: 1,
      warning: 1,
      critical: 1,
      posture: 'critical',
    })
  })

  it('derives traffic overview from operational snapshot EPS on fixed 5m basis', () => {
    const traffic = deriveTrafficOverviewFromSnapshot(snapshot())
    expect(traffic.incomingEvents).toBe(28500)
    expect(traffic.deliverySuccessRatePct).not.toBeNull()
    expect(traffic.windowLabel).toBe('5m')
  })

  it('derives traffic overview identically regardless of prior window-scaling API', () => {
    const a = deriveTrafficOverviewFromSnapshot(snapshot())
    const b = deriveTrafficOverviewFromSnapshot(snapshot())
    expect(a).toEqual(b)
  })

  it('derives operational issues from snapshot idle/degraded and dashboard validation', () => {
    const dashboard: DashboardSummaryResponse = {
      summary: {
        total_streams: 10,
        running_streams: 7,
        paused_streams: 0,
        error_streams: 0,
        stopped_streams: 0,
        rate_limited_source_streams: 0,
        rate_limited_destination_streams: 0,
        total_routes: 10,
        enabled_routes: 10,
        disabled_routes: 0,
        total_destinations: 2,
        enabled_destinations: 2,
        disabled_destinations: 0,
        recent_logs: 0,
        recent_successes: 0,
        recent_failures: 0,
        recent_rate_limited: 0,
        processed_events: 0,
        delivery_outcome_events: 0,
      },
      recent_problem_routes: [],
      recent_rate_limited_routes: [],
      recent_unhealthy_streams: [],
      validation_operational: {
        failing_validations_count: 1,
        degraded_validations_count: 0,
        open_checkpoint_drift_alerts: 0,
        open_alerts_critical: 0,
        open_alerts_warning: 0,
        open_alerts_info: 0,
        open_auth_failure_alerts: 0,
        open_delivery_failure_alerts: 0,
        latest_open_alerts: [],
        latest_recoveries: [],
        outcome_trend_24h: [],
      },
    }
    expect(deriveOperationalIssuesFromSnapshot(snapshot(), dashboard)).toEqual({
      noDataStreams: 1,
      lowVolumeStreams: 1,
      schemaDriftCount: 0,
      destinationCapacityWarnings: null,
    })
  })

  it('counts confirmed open schema field drifts from snapshot, excluding resolved', () => {
    const snap = snapshot()
    snap.streams = [
      { ...snap.streams[0]!, stream_id: 1, open_schema_field_drift_count: 2 },
      { ...snap.streams[1]!, stream_id: 2, open_schema_field_drift_count: 1 },
      { ...snap.streams[2]!, stream_id: 3, open_schema_field_drift_count: 0 },
    ]
    expect(deriveFleetSchemaDriftFromSnapshot(snap)).toEqual({ openDriftCount: 3, affectedStreamCount: 2 })
    expect(deriveOperationalIssuesFromSnapshot(snap, null).schemaDriftCount).toBe(3)
    expect(derivePrimaryOperationalIssueStrip(snap, null).find((i) => i.id === 'schema-drift')?.count).toBe(3)
  })

  it('treats resolved-only and missing drift counts as zero fleet schema drift', () => {
    const resolvedOnly = snapshot()
    resolvedOnly.streams = [{ ...resolvedOnly.streams[0]!, open_schema_field_drift_count: 0 }]
    expect(deriveFleetSchemaDriftFromSnapshot(resolvedOnly)).toEqual({ openDriftCount: 0, affectedStreamCount: 0 })
    expect(derivePrimaryOperationalIssueStrip(snapshot(), null).find((i) => i.id === 'schema-drift')?.count).toBe(0)
  })

  it('summarizes alert presence without detail', () => {
    expect(
      deriveRecentAlertsSummary([
        { stream_id: 1, stream_name: 'A', connector_name: 'C', severity: 'ERROR', count: 3, latest_occurrence: '2026-01-01T00:00:00Z' },
        { stream_id: 2, stream_name: 'B', connector_name: 'D', severity: 'WARN', count: 1, latest_occurrence: '2026-01-01T00:05:00Z' },
      ]),
    ).toEqual({ total: 2, critical: 1, warning: 1, hasAlerts: true })
  })

  it('derives dashboard KPIs from snapshot only — not dashboard/summary runtime fields', () => {
    const kpis = deriveDashboardKpisFromSnapshot({
      snapshot: snapshot(),
      alertsSummary: { total: 0, critical: 0, warning: 0, hasAlerts: false },
      outcomeTs: null,
      chartWindowLabel: '1h',
    })
    const ingest = kpis.find((k) => k.id === 'ingest-rate')
    expect(ingest?.value).toContain('95')
    expect(ingest?.basisLabel).toBe(SNAPSHOT_KPI_BASIS_LABEL)
    expect(ingest?.sub).not.toMatch(/vs last/)
    const active = kpis.find((k) => k.id === 'active-streams')
    expect(active?.value).toBe('5')
    expect(active?.basisLabel).toBe('Live snapshot')
  })

  it('keeps snapshot KPI values stable when chart window label changes', () => {
    const base = {
      snapshot: snapshot(),
      alertsSummary: { total: 0, critical: 0, warning: 0, hasAlerts: false },
      outcomeTs: null,
    }
    const kpi15 = deriveDashboardKpisFromSnapshot({ ...base, chartWindowLabel: '15m' })
    const kpi24 = deriveDashboardKpisFromSnapshot({ ...base, chartWindowLabel: '24h' })
    for (const id of ['ingest-rate', 'delivery-rate', 'success-rate', 'active-streams'] as const) {
      expect(kpi15.find((k) => k.id === id)?.value).toBe(kpi24.find((k) => k.id === id)?.value)
      expect(kpi15.find((k) => k.id === id)?.basisLabel).toBe(kpi24.find((k) => k.id === id)?.basisLabel)
    }
  })

  it('derives flow breakdown stream count from snapshot, not dashboard summary', () => {
    const connectors: ConnectorRead[] = [
      { id: 1, name: 'DB', product_group: 'DB', connector_type: 'relational_database', source_type: 'DATABASE_QUERY' },
      { id: 2, name: 'API', product_group: 'API', connector_type: 'generic_http', source_type: 'HTTP_API_POLLING' },
    ]
    const destinations: DestinationListItem[] = [
      {
        id: 1,
        name: 'Webhook',
        destination_type: 'WEBHOOK_POST',
        enabled: true,
        config_json: {},
        rate_limit_json: {},
        streams_using_count: 1,
        routes: [],
      },
    ]
    const breakdown = deriveFlowBreakdownFromSnapshot(snapshot(), connectors, destinations)
    expect(breakdown.streams).toBe(8)
    expect(breakdown.sources).toEqual([
      { label: 'Database', count: 1 },
      { label: 'API', count: 1 },
    ])
    expect(breakdown.destinations).toEqual([{ label: 'API', count: 1 }])
  })

  it('maps overall health beacon labels to Healthy / Warning / Critical', () => {
    expect(
      deriveOverallHealthBeacon(snapshot(), { total: 0, critical: 0, warning: 0, hasAlerts: false }).label,
    ).toBe('Warning')
    expect(
      deriveOverallHealthBeacon(snapshot(), { total: 1, critical: 1, warning: 0, hasAlerts: true }).label,
    ).toBe('Critical')
  })

  it('derives primary traffic KPIs as Incoming / Outgoing / Delivery Success', () => {
    const kpis = derivePrimaryTrafficKpisFromSnapshot(snapshot())
    expect(kpis.map((k) => k.id)).toEqual(['incoming-events', 'outgoing-events', 'success-rate'])
    expect(kpis[0]?.label).toBe('Incoming Events')
    expect(kpis[1]?.label).toBe('Outgoing Events')
    expect(kpis[2]?.label).toBe('Delivery Success Rate')
  })

  it('limits primary operational issue strip to charter four items', () => {
    const items = derivePrimaryOperationalIssueStrip(snapshot(), null)
    expect(items.map((i) => i.id)).toEqual(['no-data', 'low-volume', 'schema-drift', 'capacity-warning'])
  })

  it('derives stream group health with Office365 Warning and AWS Healthy', () => {
    const snap = snapshot()
    snap.streams = [
      {
        ...snap.streams[0]!,
        stream_id: 10,
        stream_name: 'Stream A',
        connector_id: 100,
        health_status: 'HEALTHY',
        status: 'RUNNING',
        open_schema_field_drift_count: 2,
      },
      {
        ...snap.streams[1]!,
        stream_id: 11,
        stream_name: 'Stream B',
        connector_id: 100,
        health_status: 'DEGRADED',
        status: 'DEGRADED',
        open_schema_field_drift_count: 1,
      },
      {
        ...snap.streams[0]!,
        stream_id: 12,
        stream_name: 'Stream C',
        connector_id: 200,
        health_status: 'HEALTHY',
        status: 'RUNNING',
        open_schema_field_drift_count: 0,
      },
    ]
    const connectors: ConnectorRead[] = [
      { id: 100, name: 'o365', product_group: 'Office365', connector_type: 'generic_http', source_type: 'HTTP_API_POLLING' },
      { id: 200, name: 'aws', product_group: 'AWS', connector_type: 'generic_http', source_type: 'HTTP_API_POLLING' },
    ]
    const groupHealth = deriveStreamGroupHealthFromSnapshot(snap, connectors)
    const byLabel = Object.fromEntries(groupHealth.groups.map((g) => [g.productLabel, g]))
    expect(byLabel.Office365?.worstStatus).toBe('DEGRADED')
    expect(byLabel.AWS?.worstStatus).toBe('RUNNING')
    expect(groupHealth.warning).toBe(1)
    expect(groupHealth.healthy).toBe(1)
    expect(groupHealth.critical).toBe(0)
    const office365Drift = byLabel.Office365?.rows.reduce((n, r) => n + (r.openSchemaFieldDriftCount ?? 0), 0)
    const awsDrift = byLabel.AWS?.rows.reduce((n, r) => n + (r.openSchemaFieldDriftCount ?? 0), 0)
    expect(office365Drift).toBe(3)
    expect(awsDrift).toBe(0)
  })
})
