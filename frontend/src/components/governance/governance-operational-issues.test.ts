import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import type { DashboardSummaryResponse } from '../../api/types/gdcApi'
import {
  deriveFleetSchemaDriftFromSnapshot,
  deriveOperationalIssuesFromSnapshot,
} from '../dashboard/dashboard-charter-metrics'
import { deriveGovernanceOperationalIssues } from './governance-operational-issues'

function stream(
  overrides: Partial<OperationalSnapshotResponse['streams'][number]> & { stream_id: number },
): OperationalSnapshotResponse['streams'][number] {
  return {
    stream_name: `S${overrides.stream_id}`,
    connector_id: 1,
    source_id: 1,
    enabled: true,
    status: 'RUNNING',
    health_status: 'HEALTHY',
    eps_1m: 1,
    eps_5m: 1,
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
    ...overrides,
  }
}

function snap(streams: OperationalSnapshotResponse['streams']): OperationalSnapshotResponse {
  return {
    global: {
      health_status: 'HEALTHY',
      total_streams: streams.length,
      enabled_streams: streams.length,
      running_streams: streams.length,
      error_streams: 0,
      total_routes: 0,
      enabled_routes: 0,
      total_destinations: 0,
      enabled_destinations: 0,
      total_eps_1m: 0,
      total_eps_5m: 0,
      avg_latency_ms: null,
      last_activity_at: null,
    },
    streams,
    routes: [],
    destinations: [],
    problems: [],
    updated_at: '2026-08-14T00:00:00Z',
  }
}

const noisyDashboard: DashboardSummaryResponse = {
  generated_at: '2026-08-14T00:00:00Z',
  window: '24h',
  summary: {
    active_streams: 3,
    events_ingested: 0,
    events_delivered: 0,
    failed_deliveries: 0,
    avg_latency_ms: 0,
    p95_latency_ms: 0,
    success_rate: 100,
    rate_limited_destination_streams: 0,
  },
  recent_rate_limited_routes: [],
  recent_unhealthy_streams: [],
  validation_operational: {
    failing_validations_count: 9,
    degraded_validations_count: 4,
    open_checkpoint_drift_alerts: 7,
    open_alerts_critical: 0,
    open_alerts_warning: 0,
    open_alerts_info: 0,
    open_auth_failure_alerts: 0,
    open_delivery_failure_alerts: 0,
    latest_open_alerts: [],
    latest_recoveries: [],
    outcome_trend_24h: [],
  },
} as DashboardSummaryResponse

describe('deriveGovernanceOperationalIssues schema drift SoT', () => {
  it('sums confirmed open field drifts across streams (2+1+0 = 3)', () => {
    const snapshot = snap([
      stream({ stream_id: 1, open_schema_field_drift_count: 2 }),
      stream({ stream_id: 2, open_schema_field_drift_count: 1 }),
      stream({ stream_id: 3, open_schema_field_drift_count: 0 }),
    ])
    expect(deriveGovernanceOperationalIssues(null, noisyDashboard, [], snapshot).schemaDriftCount).toBe(3)
  })

  it('returns 0 when snapshot only has resolved/acknowledged (open count 0)', () => {
    const snapshot = snap([
      stream({ stream_id: 1, open_schema_field_drift_count: 0 }),
      stream({ stream_id: 2, open_schema_field_drift_count: 0 }),
    ])
    expect(deriveGovernanceOperationalIssues(null, noisyDashboard, [], snapshot).schemaDriftCount).toBe(0)
  })

  it('returns 0 when snapshot has no open counts (pending observations excluded)', () => {
    const snapshot = snap([stream({ stream_id: 1 }), stream({ stream_id: 2 })])
    expect(deriveGovernanceOperationalIssues(null, noisyDashboard, [], snapshot).schemaDriftCount).toBe(0)
  })

  it('returns null when snapshot is unavailable', () => {
    expect(deriveGovernanceOperationalIssues(null, noisyDashboard, [], null).schemaDriftCount).toBeNull()
  })

  it('matches Main Dashboard fleet count on the same snapshot fixture', () => {
    const snapshot = snap([
      stream({ stream_id: 1, open_schema_field_drift_count: 2 }),
      stream({ stream_id: 2, open_schema_field_drift_count: 1 }),
      stream({ stream_id: 3, open_schema_field_drift_count: 0 }),
    ])
    const main = deriveOperationalIssuesFromSnapshot(snapshot, noisyDashboard).schemaDriftCount
    const governance = deriveGovernanceOperationalIssues(null, noisyDashboard, [], snapshot).schemaDriftCount
    expect(main).toBe(3)
    expect(governance).toBe(main)
    expect(deriveFleetSchemaDriftFromSnapshot(snapshot).openDriftCount).toBe(main)
  })

  it('does not use validation_operational checkpoint aggregates as Schema Drift', () => {
    const snapshot = snap([stream({ stream_id: 1, open_schema_field_drift_count: 0 })])
    expect(deriveGovernanceOperationalIssues(null, noisyDashboard, [], snapshot).schemaDriftCount).toBe(0)
  })
})
