import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DashboardOverview } from './dashboard-overview'
import type {
  DashboardSummaryResponse,
  HealthOverviewResponse,
  ObservabilitySummaryResponse,
  RetrySummaryResponse,
  RuntimeAlertSummaryResponse,
} from '../../api/types/gdcApi'

const sampleDashboard = (): DashboardSummaryResponse => ({
  summary: {
    total_streams: 10,
    running_streams: 7,
    paused_streams: 1,
    error_streams: 0,
    stopped_streams: 2,
    rate_limited_source_streams: 0,
    rate_limited_destination_streams: 1,
    total_routes: 12,
    enabled_routes: 11,
    disabled_routes: 1,
    total_destinations: 4,
    enabled_destinations: 4,
    disabled_destinations: 0,
    recent_logs: 120,
    processed_events: 1378,
    delivery_outcome_events: 1172,
    recent_successes: 100,
    recent_failures: 15,
    recent_rate_limited: 5,
    current_runtime_streams_healthy: 6,
    current_runtime_streams_degraded: 1,
  },
  recent_problem_routes: [],
  recent_rate_limited_routes: [],
  recent_unhealthy_streams: [],
  runtime_engine_status: 'RUNNING',
  active_worker_count: 2,
  metrics_window_seconds: 3600,
  metric_meta: {},
})

const snapshotParam = (params?: { snapshot_id?: string }) => params?.snapshot_id ?? FIXED_SNAPSHOT

const FIXED_SNAPSHOT = '2026-01-01T01:00:00Z'

const sampleObservability = (snapshot_id = FIXED_SNAPSHOT): ObservabilitySummaryResponse => ({
  snapshot_id,
  generated_at: snapshot_id,
  window: '1h',
  window_start: '2026-01-01T00:00:00Z',
  window_end: '2026-01-01T01:00:00Z',
  metric_contract_version: 'v1',
  totals: {
    streams_total: 10,
    streams_running: 7,
    routes_total: 12,
    routes_enabled: 11,
    healthy_routes: 9,
    idle_routes: 1,
    unhealthy_routes: 1,
    delivery_success_events: 100,
    delivery_failed_events: 15,
    retry_success_events: 3,
    retry_failed_events: 1,
    runtime_telemetry_rows: 120,
    lifecycle_rows: 5,
    processed_events: 1378,
    throughput_eps: 0.033,
    p95_latency_ms: null,
  },
  metric_contract: {},
  metric_meta: {},
})

const sampleHealth = (snapshot_id = '2026-01-01T01:00:00Z'): HealthOverviewResponse => ({
  time: { window: '1h', since: '2026-01-01T00:00:00Z', until: '2026-01-01T01:00:00Z', snapshot_id },
  filters: { stream_id: null, route_id: null, destination_id: null },
  scoring_mode: 'current_runtime',
  streams: { healthy: 6, degraded: 1, unhealthy: 0, critical: 0, excluded_no_outcome: 2 },
  routes: { healthy: 9, degraded: 1, unhealthy: 1, critical: 0 },
  destinations: { healthy: 4, degraded: 0, unhealthy: 0, critical: 0 },
  average_stream_score: 82,
  average_route_score: 88,
  average_destination_score: 95,
  worst_routes: [],
  worst_streams: [],
  worst_destinations: [],
})

vi.mock('../../api/runtimeSnapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/runtimeSnapshotSync')>()
  return {
    ...actual,
    createRuntimeSnapshotId: () => '2026-01-01T01:00:00Z',
  }
})

vi.mock('../../api/gdcRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcRuntime')>()
  return {
    ...actual,
    fetchRuntimeDashboardSummary: vi.fn(async (_limit: number, _window: string, params?: { snapshot_id?: string }) => ({
    ...sampleDashboard(),
    snapshot_id: snapshotParam(params),
    generated_at: snapshotParam(params),
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-01T01:00:00Z',
  })),
  fetchRuntimeDashboardOutcomeTimeseries: vi.fn(async (params?: { snapshot_id?: string }) => ({
    snapshot_id: snapshotParam(params),
    generated_at: snapshotParam(params),
    metrics_window_seconds: 3600,
    buckets: [
      { bucket_start: '2026-01-01T00:15:00Z', success: 40, failed: 5, rate_limited: 2 },
      { bucket_start: '2026-01-01T00:30:00Z', success: 55, failed: 3, rate_limited: 1 },
      { bucket_start: '2026-01-01T00:45:00Z', success: 48, failed: 7, rate_limited: 0 },
    ],
  })),
  fetchRuntimeAlertSummary: vi.fn(async (): Promise<RuntimeAlertSummaryResponse> => ({
    items: [
      {
        stream_id: 1,
        stream_name: 'Payment API Stream',
        connector_name: 'Payment API',
        severity: 'ERROR',
        count: 4,
        latest_occurrence: '2026-01-01T00:30:00Z',
      },
    ],
  })),
  invalidateDashboardAnalyticsCache: vi.fn(),
  }
})

vi.mock('../../api/gdcRuntimeHealth', () => ({
  fetchHealthOverview: vi.fn(async (params?: { snapshot_id?: string }) => sampleHealth(params?.snapshot_id)),
}))

vi.mock('../../api/gdcRuntimeAnalytics', () => ({
  fetchRetriesSummary: vi.fn(async (params?: { snapshot_id?: string }): Promise<RetrySummaryResponse> => ({
    time: {
      window: '1h',
      since: '2026-01-01T00:00:00Z',
      until: '2026-01-01T01:00:00Z',
      snapshot_id: snapshotParam(params),
      generated_at: snapshotParam(params),
    },
    total_retry_outcome_events: 4,
    retry_success_events: 3,
    retry_failed_events: 1,
    retry_column_sum: 0,
  })),
}))

vi.mock('../../api/observabilitySummary', () => ({
  fetchObservabilitySummary: vi.fn(async (_window: string, params?: { snapshot_id?: string }) =>
    sampleObservability(snapshotParam(params)),
  ),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => [
    { id: 1, name: 'Payment API Stream', connector_id: 10, source_id: 1, status: 'ERROR', enabled: true },
    { id: 2, name: 'Orders DB', connector_id: 11, source_id: 2, status: 'RUNNING', enabled: true },
  ]),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => [
    { id: 10, name: 'Payment API', product_group: 'Payment API', connector_type: 'generic_http', source_type: 'HTTP_API_POLLING' },
    { id: 11, name: 'MySQL Orders DB', product_group: 'MySQL Orders DB', connector_type: 'relational_database', source_type: 'DATABASE_QUERY' },
  ]),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  getOperationalSnapshot: vi.fn(async () => ({
    global: {
      health_status: 'DEGRADED',
      total_streams: 4,
      enabled_streams: 4,
      running_streams: 1,
      error_streams: 1,
      total_routes: 2,
      enabled_routes: 2,
      total_destinations: 2,
      enabled_destinations: 2,
      total_eps_1m: 150,
      total_eps_5m: 140,
      avg_latency_ms: 20,
      last_activity_at: null,
    },
    streams: [
      {
        stream_id: 1,
        stream_name: 'Payment API Stream',
        connector_id: 10,
        source_id: 1,
        enabled: true,
        status: 'ERROR',
        health_status: 'ERROR',
        eps_1m: 100,
        eps_5m: 95,
        success_rate_5m: 50,
        failure_rate_5m: 50,
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
        stream_id: 2,
        stream_name: 'Orders DB',
        connector_id: 11,
        source_id: 2,
        enabled: true,
        status: 'RUNNING',
        health_status: 'HEALTHY',
        eps_1m: 50,
        eps_5m: 45,
        success_rate_5m: 99,
        failure_rate_5m: 1,
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
        stream_id: 3,
        stream_name: 'Idle A',
        connector_id: 10,
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
        stream_name: 'Idle B',
        connector_id: 11,
        source_id: 4,
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
    ],
    routes: [],
    destinations: [],
    problems: [
      {
        severity: 'warning',
        scope: 'destination',
        stream_id: null,
        route_id: null,
        destination_id: 1,
        title: 'Capacity',
        message: 'Destination capacity warning',
        last_seen_at: null,
      },
    ],
    updated_at: '2026-01-01T00:00:00Z',
  })),
}))

vi.mock('../../api/gdcRetention', () => ({
  fetchRetentionStatus: vi.fn(async () => ({
    retention_enabled: true,
    supplement_next_after_utc: null,
    last_operational_retention_at: '2026-01-01T00:00:00Z',
    last_audit: null,
  })),
}))

function mainRegion() {
  return screen.getByRole('main')
}

describe('DashboardOverview', () => {
  it('shows loading state before data resolves', async () => {
    const rt = await import('../../api/gdcRuntime')
    vi.mocked(rt.fetchRuntimeDashboardSummary).mockImplementationOnce(
      () =>
        new Promise<DashboardSummaryResponse | null>((resolve) => {
          globalThis.setTimeout(() => resolve(sampleDashboard()), 40)
        }),
    )
    render(
      <MemoryRouter>
        <DashboardOverview />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Loading dashboard data/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/Loading dashboard data/i)).not.toBeInTheDocument())
  })

  it('renders Dashboard heading instead of Operations Center', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: 'Operations Center' })).not.toBeInTheDocument()
  })

  it('renders charter dashboard sections', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    expect(await within(mainRegion()).findByTestId('dashboard-running-badge')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-overall-health-hero')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-overall-health-beacon')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-operational-issues')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-system-health-summary')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-kpi-strip')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-group-kpi-strip')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-group-summary')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-operational-problem-details')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-stream-health-matrix')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-events-over-time')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-top-sources')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-recent-alerts')).toBeInTheDocument()
    expect(within(mainRegion()).getByTestId('dashboard-system-health')).toBeInTheDocument()
  })

  it('renders overall health as Healthy / Warning / Critical', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const hero = await within(mainRegion()).findByTestId('dashboard-overall-health-hero')
    await waitFor(() => {
      expect(within(hero).getByTestId('dashboard-overall-posture-label')).toHaveTextContent('Critical')
    })
    expect(within(hero).getByTestId('dashboard-health-healthy')).toBeInTheDocument()
    expect(within(hero).getByTestId('dashboard-health-warning')).toBeInTheDocument()
    expect(within(hero).getByTestId('dashboard-health-critical')).toBeInTheDocument()

    const beacon = within(mainRegion()).getByTestId('dashboard-overall-health-beacon')
    // Snapshot has DEGRADED health_status, warning problem, and critical alert → Critical
    await waitFor(() => {
      expect(within(beacon).getByTestId('dashboard-beacon-label')).toHaveTextContent('Critical')
    })
  })

  it('renders primary operational issues without checkpoint/replay in primary strip', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const strip = await within(mainRegion()).findByTestId('dashboard-system-health-summary')
    expect(within(strip).getByTestId('dashboard-summary-no-data')).toBeInTheDocument()
    expect(within(strip).getByTestId('dashboard-summary-low-volume')).toBeInTheDocument()
    expect(within(strip).getByTestId('dashboard-summary-schema-drift')).toBeInTheDocument()
    expect(within(strip).getByTestId('dashboard-summary-capacity-warning')).toBeInTheDocument()
    expect(within(strip).queryByTestId('dashboard-summary-checkpoint-lag')).not.toBeInTheDocument()
    expect(within(strip).queryByTestId('dashboard-summary-replay-queue')).not.toBeInTheDocument()
  })

  it('drills down from capacity warning to destinations and schema drift to streams', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const strip = await within(mainRegion()).findByTestId('dashboard-system-health-summary')
    expect(within(strip).getByTestId('dashboard-summary-capacity-warning')).toHaveAttribute(
      'href',
      '/destinations?filter=warning',
    )
    expect(within(strip).getByTestId('dashboard-summary-schema-drift')).toHaveAttribute(
      'href',
      '/streams?filter=schema-drift',
    )
    expect(within(strip).getByTestId('dashboard-summary-no-data')).toHaveAttribute('href', '/streams?filter=no-data')
  })

  it('renders issue details panel showing problems from snapshot', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const panel = await within(mainRegion()).findByTestId('dashboard-operational-problem-details')
    await waitFor(() => {
      expect(within(panel).getByText(/Capacity/i)).toBeInTheDocument()
    })
  })

  it('links recent alerts with stream_id to stream runtime', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const link = await within(mainRegion()).findByTestId('dashboard-recent-alert-link-1')
    expect(link).toHaveAttribute('href', '/streams/1/runtime')
  })

  it('links recent alerts without a valid stream_id to streams list', async () => {
    const rt = await import('../../api/gdcRuntime')
    vi.mocked(rt.fetchRuntimeAlertSummary).mockResolvedValueOnce({
      items: [
        {
          stream_id: 0,
          stream_name: 'Orphan alert',
          connector_name: 'Unknown',
          severity: 'WARN',
          count: 1,
          latest_occurrence: '2026-01-01T00:05:00Z',
        },
      ],
    })
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const link = await within(mainRegion()).findByTestId('dashboard-recent-alert-link-0')
    expect(link).toHaveAttribute('href', '/streams')
  })

  it('renders stream health matrix panel', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const matrix = await within(mainRegion()).findByTestId('dashboard-stream-health-matrix')
    expect(matrix).toBeInTheDocument()
  })

  it('does not render removed operations center widgets', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    await within(mainRegion()).findByRole('heading', { level: 1, name: 'Dashboard' })
    expect(screen.queryByTestId('ops-incident-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ops-why-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ops-action-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ops-disclosure-trends')).not.toBeInTheDocument()
    expect(screen.queryByText('Operations Center')).not.toBeInTheDocument()
  })

  it('shows recent alerts with severity emphasis', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const alerts = await within(mainRegion()).findByTestId('dashboard-recent-alerts')
    expect(await within(alerts).findByText(/Critical/i)).toBeInTheDocument()
    expect(await within(alerts).findByText('Payment API Stream')).toBeInTheDocument()
  })

  it('shows top sources by ingest rate', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const panel = await within(mainRegion()).findByTestId('dashboard-top-sources')
    expect(await within(panel).findByText('MySQL Orders DB')).toBeInTheDocument()
    expect(await within(panel).findByText('Payment API')).toBeInTheDocument()
  })

  it('changes analytics window when the window select changes', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    await within(mainRegion()).findByRole('heading', { level: 1, name: 'Dashboard' })
    await user.selectOptions(screen.getByLabelText(/Analytics window/i), '15m')
    expect(within(mainRegion()).getAllByText(/Last 15 min/i).length).toBeGreaterThanOrEqual(1)
  })

  it('shows primary traffic KPIs for Incoming / Outgoing / Delivery Success', async () => {
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const strip = await within(mainRegion()).findByTestId('dashboard-kpi-strip')
    expect(within(strip).getByTestId('dashboard-kpi-incoming-events')).toBeInTheDocument()
    expect(within(strip).getByTestId('dashboard-kpi-outgoing-events')).toBeInTheDocument()
    expect(within(strip).getByTestId('dashboard-kpi-success-rate')).toBeInTheDocument()
    expect(within(strip).queryByTestId('dashboard-kpi-delivery-gap')).not.toBeInTheDocument()
  })

  it('keeps snapshot basis on primary traffic KPIs across window changes', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <main>
          <DashboardOverview />
        </main>
      </MemoryRouter>,
    )
    const strip = await within(mainRegion()).findByTestId('dashboard-kpi-strip')
    const incomingKpi = await within(strip).findByTestId('dashboard-kpi-incoming-events')
    await waitFor(() => {
      expect(within(incomingKpi).getByText('5m snapshot')).toBeInTheDocument()
    })
    const valueEl = incomingKpi.querySelector('.text-\\[1\\.75rem\\]')
    const incomingBefore = valueEl?.textContent ?? ''
    await user.selectOptions(screen.getByLabelText(/Analytics window/i), '24h')
    await waitFor(() => {
      expect(within(incomingKpi).getByText('5m snapshot')).toBeInTheDocument()
      expect(valueEl?.textContent).toBe(incomingBefore)
    })
  })
})
