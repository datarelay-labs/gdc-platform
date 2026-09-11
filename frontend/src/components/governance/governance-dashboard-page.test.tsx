import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceDashboard from '../../api/gdcGovernanceDashboard'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import * as gdcGovernanceViolations from '../../api/gdcGovernanceViolations'
import * as gdcRuntimeHealth from '../../api/gdcRuntimeHealth'
import * as operationalSnapshot from '../../api/operationalSnapshot'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { NAV_PATH } from '../../config/nav-paths'
import { GovernanceDashboardPage } from './governance-dashboard-page'

const sampleSummary: gdcGovernanceDashboard.GovernanceDashboardSummaryResponse = {
  active_policies: 4,
  policies_in_review: 2,
  open_violations: 7,
  quarantined_events: 5,
  failed_replays: 1,
  notification_failures: 2,
  pending_approvals: 2,
  pending_replays: 3,
  risk: { critical: 3, high: 4, medium: 8, low: 12 },
  policy_health: { healthy: 3, warning: 2, critical: 1 },
  compliance_snapshot: { violations_24h: 6, quarantines_24h: 5, replays_24h: 4 },
  recent_activity: [
    {
      event_time: '2026-06-06T10:00:00Z',
      event_type: 'VIOLATION_CREATED',
      event_label: 'Violation created',
      policy_id: 1,
      policy_name: 'Customer Data Protection',
      stream_id: 10,
      stream_name: 'Malop API',
      status: 'OPEN',
    },
  ],
}

describe('GovernanceDashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockResolvedValue(sampleSummary)
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 1,
      violations: [
        {
          id: 'v-1',
          policy_id: 1,
          policy_name: 'PII Detection Policy',
          stream_id: 10,
          stream_name: 'Login Stream',
          event_time: new Date(Date.now() - 120_000).toISOString(),
          severity: 'HIGH',
          reason: 'PII detected',
          status: 'OPEN',
          quarantine_event_id: null,
        },
      ],
    })
    vi.spyOn(gdcGovernancePolicies, 'fetchGovernancePolicies').mockResolvedValue({
      policies: [
        {
          id: 1,
          name: 'PII Detection Policy',
          description: null,
          category: 'DATA_PROTECTION',
          status: 'ACTIVE',
          policy_json: { conditions: [], actions: [] },
          version: 1,
          assigned_stream_count: 5,
          assigned_stream_ids: [1],
          created_at: '2026-06-01T10:30:00Z',
          updated_at: '2026-06-01T14:30:00Z',
        },
      ],
    })
    vi.spyOn(gdcRuntimeHealth, 'fetchHealthOverview').mockResolvedValue(null)
    vi.spyOn(operationalSnapshot, 'getOperationalSnapshot').mockResolvedValue(null)
  })

  it('renders governance overview layout sections', async () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-page')).toBeInTheDocument()
    expect(screen.getByText('Governance Overview')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-kpi-strip')).toBeInTheDocument()
    expect(screen.getByTestId('governance-what-happened')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-recent-activity')).toBeInTheDocument()
    expect(screen.getByTestId('governance-recommended-actions')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-policy-health')).toBeInTheDocument()
    expect(screen.getByTestId('governance-quick-actions')).toBeInTheDocument()
    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
    expect(screen.queryByText('Reject')).not.toBeInTheDocument()
  })

  it('shows KPI values from dashboard summary API', async () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-kpi-violations')).toHaveTextContent('7')
      expect(screen.getByTestId('dashboard-kpi-pending-approvals')).toHaveTextContent('2')
    })
  })

  it('renders page when summary fails but list APIs succeed', async () => {
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockRejectedValue(
      new Error('Request timed out after 15000ms'),
    )

    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-page')).toBeInTheDocument()
    expect(await screen.findByTestId('governance-dashboard-summary-error')).toHaveTextContent(/timed out/i)
    expect(screen.queryByTestId('governance-dashboard-error')).not.toBeInTheDocument()
    expect(await screen.findByTestId('gov-violation-row-v-1')).toBeInTheDocument()
    expect(await screen.findByTestId('gov-policy-row-1')).toBeInTheDocument()
  })

  it('does not block page layout while summary is still loading', async () => {
    let resolveSummary: (value: gdcGovernanceDashboard.GovernanceDashboardSummaryResponse) => void
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSummary = resolve
        }),
    )

    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-page')).toBeInTheDocument()
    expect(await screen.findByTestId('gov-violation-row-v-1')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-dashboard-summary-error')).not.toBeInTheDocument()

    resolveSummary!(sampleSummary)
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-kpi-violations')).toHaveTextContent('7')
    })
  })

  it('shows Schema Drift from operational snapshot open counts and drills to streams filter', async () => {
    const snapshot = {
      global: {
        health_status: 'HEALTHY',
        total_streams: 3,
        enabled_streams: 3,
        running_streams: 3,
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
      streams: [
        { stream_id: 1, stream_name: 'A', connector_id: 1, source_id: 1, enabled: true, status: 'RUNNING', health_status: 'HEALTHY', eps_1m: 1, eps_5m: 1, success_rate_5m: 100, failure_rate_5m: 0, avg_latency_ms: 1, route_count: 1, healthy_route_count: 1, failed_route_count: 0, last_success_at: null, last_error_at: null, last_error_message: null, checkpoint_updated_at: null, checkpoint_lag_seconds: null, open_schema_field_drift_count: 2 },
        { stream_id: 2, stream_name: 'B', connector_id: 2, source_id: 2, enabled: true, status: 'RUNNING', health_status: 'HEALTHY', eps_1m: 1, eps_5m: 1, success_rate_5m: 100, failure_rate_5m: 0, avg_latency_ms: 1, route_count: 1, healthy_route_count: 1, failed_route_count: 0, last_success_at: null, last_error_at: null, last_error_message: null, checkpoint_updated_at: null, checkpoint_lag_seconds: null, open_schema_field_drift_count: 1 },
        { stream_id: 3, stream_name: 'C', connector_id: 3, source_id: 3, enabled: true, status: 'RUNNING', health_status: 'HEALTHY', eps_1m: 1, eps_5m: 1, success_rate_5m: 100, failure_rate_5m: 0, avg_latency_ms: 1, route_count: 1, healthy_route_count: 1, failed_route_count: 0, last_success_at: null, last_error_at: null, last_error_message: null, checkpoint_updated_at: null, checkpoint_lag_seconds: null, open_schema_field_drift_count: 0 },
      ],
      routes: [],
      destinations: [],
      problems: [],
      updated_at: '2026-08-14T00:00:00Z',
    } satisfies OperationalSnapshotResponse
    vi.spyOn(operationalSnapshot, 'getOperationalSnapshot').mockResolvedValue(snapshot)

    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('gov-issue-schema-drift')).toHaveTextContent('3')
    })
    expect(screen.getByTestId('gov-issue-schema-drift').closest('a')).toHaveAttribute(
      'href',
      `${NAV_PATH.streams}?filter=schema-drift`,
    )
    expect(screen.getByTestId('gov-action-schema-drift')).toHaveAttribute(
      'href',
      `${NAV_PATH.streams}?filter=schema-drift`,
    )
    expect(screen.getByTestId('gov-action-schema-drift').getAttribute('href')).not.toContain('/validation')
  })
})
