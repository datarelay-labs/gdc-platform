import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { clearTestSession, persistTestSession } from './lib/governance-rbac'
import { clearWizardCatalogSnapshot } from './components/streams/wizard/wizard-catalog-cache'

vi.mock('./api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
  getOperationalSnapshot: vi.fn(() =>
    Promise.resolve({
      global: {
        health_status: 'HEALTHY',
        total_streams: 4,
        enabled_streams: 3,
        running_streams: 2,
        error_streams: 0,
        total_routes: 2,
        enabled_routes: 2,
        total_destinations: 1,
        enabled_destinations: 1,
        total_eps_1m: 0,
        total_eps_5m: 0,
        avg_latency_ms: null,
        last_activity_at: null,
      },
      streams: [],
      routes: [],
      destinations: [],
      problems: [],
      updated_at: '2026-05-22T12:00:00Z',
    }),
  ),
}))

vi.mock('./api/gdcAdmin', () => ({
  getAdminHttpsSettings: vi.fn(() =>
    Promise.resolve({
      enabled: false,
      certificate_ip_addresses: [],
      certificate_dns_names: [],
      redirect_http_to_https: false,
      certificate_valid_days: 365,
      current_access_url: 'http://127.0.0.1:8000',
      https_active: false,
      certificate_not_after: null,
      restart_required_after_save: false,
      http_listener_active: true,
      https_listener_active: false,
      redirect_http_to_https_effective: false,
      proxy_status: 'not_configured',
      proxy_health_ok: null,
      proxy_last_reload_at: null,
      proxy_last_reload_ok: null,
      proxy_last_reload_detail: null,
      proxy_fallback_to_http_last: false,
      browser_http_url: 'http://127.0.0.1:8000',
      browser_https_url: null,
    }),
  ),
  listAdminUsers: vi.fn(() => Promise.resolve([])),
  putAdminHttpsSettings: vi.fn(() =>
    Promise.resolve({
      ok: true,
      restart_required: true,
      certificate_not_after: null,
      message: 'Saved',
      proxy_reload_applied: true,
      proxy_https_effective: false,
      proxy_fallback_to_http: false,
    }),
  ),
  getAdminNetworkSettings: vi.fn(() =>
    Promise.resolve({
      http_port: 18080,
      https_port: 18443,
      env_example: { GDC_HTTP_PORT: '18080', GDC_HTTPS_PORT: '18443' },
      restart_required: false,
      restart_command: 'docker compose -f docker-compose.platform.yml up -d --force-recreate reverse-proxy',
    }),
  ),
  putAdminNetworkSettings: vi.fn(() =>
    Promise.resolve({
      http_port: 19080,
      https_port: 19443,
      env_example: { GDC_HTTP_PORT: '19080', GDC_HTTPS_PORT: '19443' },
      restart_required: true,
      restart_command: 'docker compose -f docker-compose.platform.yml up -d --force-recreate reverse-proxy',
      message: 'Network settings saved.',
    }),
  ),
  postAdminNetworkSettingsApply: vi.fn(() =>
    Promise.resolve({
      success: true,
      command: 'docker compose -f docker-compose.platform.yml up -d --force-recreate reverse-proxy',
      stdout: '',
      stderr: '',
      exit_code: 0,
      message: 'Reverse proxy recreated.',
    }),
  ),
  createAdminUser: vi.fn(() => Promise.resolve({ id: 1, username: 'u', role: 'VIEWER', status: 'ACTIVE', created_at: '', last_login_at: null })),
  updateAdminUser: vi.fn(() => Promise.resolve({ id: 1, username: 'u', role: 'VIEWER', status: 'ACTIVE', created_at: '', last_login_at: null })),
  deleteAdminUser: vi.fn(() => Promise.resolve(undefined)),
  postAdminPasswordChange: vi.fn(() => Promise.resolve(undefined)),
  getAdminSystemInfo: vi.fn(() =>
    Promise.resolve({
      app_name: 'GDC',
      app_version: '0.1.0',
      app_env: 'test',
      python_version: '3',
      database_reachable: true,
      database_url_masked: 'postgresql://****',
      platform: 'linux',
      server_time_utc: '2026-01-01T00:00:00Z',
      timezone: 'UTC',
      database_version: 'PostgreSQL 15',
      uptime_seconds: 3600,
    }),
  ),
  getAdminRetentionPolicy: vi.fn(() =>
    Promise.resolve({
      logs: { retention_days: 30, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      runtime_metrics: { retention_days: 90, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      preview_cache: { retention_days: 7, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      backup_temp: { retention_days: 14, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      cleanup_scheduler_active: false,
      cleanup_engine_message: 'Scheduled cleanup engine is not active yet.',
    }),
  ),
  getAdminAuditLog: vi.fn(() => Promise.resolve({ total: 0, items: [] })),
  getAdminConfigVersions: vi.fn(() => Promise.resolve({ total: 0, items: [] })),
  getAdminHealthSummary: vi.fn(() =>
    Promise.resolve({
      metrics_window_seconds: 3600,
      metrics: [
        {
          key: 'db_latency_ms',
          label: 'DB latency (avg sample)',
          available: true,
          value: '2 ms',
          status: 'good',
          notes: null,
          link_path: null,
        },
      ],
    }),
  ),
  getAuthWhoAmI: vi.fn(() =>
    Promise.resolve({ username: 'tester', role: 'ADMINISTRATOR', authenticated: true }),
  ),
  getAdminMaintenanceHealth: vi.fn(() =>
    Promise.resolve({
      generated_at: '2026-01-01T00:00:00Z',
      overall: 'OK',
      ok: [],
      warn: [],
      error: [],
      panels: {
        database: { status: 'OK', reachable: true, latency_ms: 2, database_url_masked: 'postgresql://****', version_short: 'PostgreSQL' },
        migrations: { status: 'OK', database_revision: 'r', script_heads: ['r'], in_sync: true },
        scheduler: { status: 'OK', startup_scheduler_active_gate: true, supervisor_uptime_seconds: 1, active_worker_count: 0 },
        retention: { status: 'OK', cleanup_scheduler_enabled: true, cleanup_thread_running: true, cleanup_interval_minutes: 60 },
        storage: { status: 'OK', disk: { path: '/', used_percent: 10, free_bytes: 100, total_bytes: 1000 } },
        destinations: { status: 'OK', window_hours: 1, destinations: [] },
        certificates: { status: 'OK', https_enabled: false, certificate_not_after: null, days_remaining: null },
        recent_failures: { status: 'OK', count_returned: 0, items: [] },
        support_bundle: { status: 'OK', download_method: 'GET', download_path: '/api/v1/admin/support-bundle' },
      },
    }),
  ),
  downloadAdminSupportBundle: vi.fn(() => Promise.resolve()),
  getAdminAlertSettings: vi.fn(() =>
    Promise.resolve({
      rules: [
        { alert_type: 'stream_paused', enabled: true, severity: 'WARNING', last_triggered_at: null },
        { alert_type: 'checkpoint_stalled', enabled: true, severity: 'CRITICAL', last_triggered_at: null },
      ],
      webhook_url: null,
      slack_webhook_url: null,
      email_to: null,
      channel_status: { webhook: 'not_configured', slack: 'not_configured', email: 'not_configured' },
      notification_delivery: 'planned',
    }),
  ),
  putAdminRetentionPolicy: vi.fn(() =>
    Promise.resolve({
      logs: { retention_days: 30, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      runtime_metrics: { retention_days: 90, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      preview_cache: { retention_days: 7, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      backup_temp: { retention_days: 14, enabled: true, last_cleanup_at: null, next_cleanup_at: null },
      cleanup_scheduler_active: false,
      cleanup_engine_message: 'Scheduled cleanup engine is not active yet.',
    }),
  ),
  putAdminAlertSettings: vi.fn(),
}))

const DASHBOARD_SNAPSHOT = '2026-01-01T01:00:00Z'

vi.mock('./api/runtimeSnapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/runtimeSnapshotSync')>()
  return {
    ...actual,
    createRuntimeSnapshotId: () => DASHBOARD_SNAPSHOT,
  }
})

vi.mock('./api/observabilitySummary', () => ({
  fetchObservabilitySummary: vi.fn(async () => ({
    snapshot_id: DASHBOARD_SNAPSHOT,
    generated_at: DASHBOARD_SNAPSHOT,
    window: '1h',
    window_start: '2026-01-01T00:00:00Z',
    window_end: DASHBOARD_SNAPSHOT,
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
      retry_success_events: 0,
      retry_failed_events: 0,
      runtime_telemetry_rows: 120,
      lifecycle_rows: 0,
      processed_events: 1378,
      throughput_eps: 0.38,
      p95_latency_ms: null,
    },
    metric_contract: {},
    metric_meta: {},
  })),
}))

vi.mock('./api/gdcRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/gdcRuntime')>()
  return {
    ...actual,
    fetchRuntimeDashboardSummary: vi.fn(async () => ({
    snapshot_id: DASHBOARD_SNAPSHOT,
    generated_at: DASHBOARD_SNAPSHOT,
    window_start: '2026-01-01T00:00:00Z',
    window_end: DASHBOARD_SNAPSHOT,
    summary: {
      total_streams: 10,
      running_streams: 7,
      paused_streams: 0,
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
      recent_successes: 100,
      recent_failures: 15,
      recent_rate_limited: 0,
      processed_events: 1378,
      delivery_outcome_events: 115,
    },
    recent_problem_routes: [],
    recent_rate_limited_routes: [],
    recent_unhealthy_streams: [],
  })),
  fetchRuntimeDashboardOutcomeTimeseries: vi.fn(async () => ({
    snapshot_id: DASHBOARD_SNAPSHOT,
    generated_at: DASHBOARD_SNAPSHOT,
    metrics_window_seconds: 3600,
    buckets: [
      { bucket_start: '2026-01-01T00:15:00Z', success: 40, failed: 5, rate_limited: 2 },
      { bucket_start: '2026-01-01T00:30:00Z', success: 55, failed: 3, rate_limited: 1 },
    ],
  })),
  fetchRuntimeAlertSummary: vi.fn(async () => ({
    items: [
      {
        stream_id: 1,
        stream_name: 'Payment API Stream',
        connector_name: 'Payment API',
        severity: 'ERROR',
        count: 2,
        latest_occurrence: '2026-01-01T00:30:00Z',
      },
    ],
  })),
  fetchRuntimeLogsPage: vi.fn(async () => ({
    total_returned: 0,
    has_next: false,
    next_cursor_created_at: null,
    next_cursor_id: null,
    items: [],
  })),
  fetchRuntimeLogsTotals: vi.fn(async () => ({
    metrics_window_seconds: 3600,
    window_start: '2026-01-01T00:00:00Z',
    window_end: DASHBOARD_SNAPSHOT,
    total_rows: 0,
    error_rows: 0,
    warning_rows: 0,
    info_rows: 0,
    debug_rows: 0,
  })),
  searchRuntimeDeliveryLogs: vi.fn(async () => ({
    total_returned: 0,
    filters: {},
    logs: [],
  })),
  fetchRuntimeSystemResources: vi.fn(async () => null),
  }
})

vi.mock('./api/gdcRuntimeHealth', () => ({
  fetchDestinationHealthList: vi.fn(async () => ({ rows: [] })),
  fetchRouteHealthList: vi.fn(async () => ({ rows: [] })),
  fetchHealthOverview: vi.fn(async () => ({
    time: {
      window: '1h',
      since: '2026-01-01T00:00:00Z',
      until: DASHBOARD_SNAPSHOT,
      snapshot_id: DASHBOARD_SNAPSHOT,
      generated_at: DASHBOARD_SNAPSHOT,
    },
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
  })),
}))

vi.mock('./api/gdcRuntimeAnalytics', () => ({
  fetchRouteFailuresAnalytics: vi.fn(async () => ({
    time: {
      window: '24h',
      since: '2026-01-01T00:00:00Z',
      until: DASHBOARD_SNAPSHOT,
      snapshot_id: DASHBOARD_SNAPSHOT,
      generated_at: DASHBOARD_SNAPSHOT,
    },
    rows: [],
  })),
  fetchDeliveryOutcomesByDestination: vi.fn(async () => ({
    time: {
      window: '24h',
      since: '2026-01-01T00:00:00Z',
      until: DASHBOARD_SNAPSHOT,
      snapshot_id: DASHBOARD_SNAPSHOT,
      generated_at: DASHBOARD_SNAPSHOT,
    },
    rows: [],
  })),
  fetchRetriesSummary: vi.fn(async () => ({
    time: {
      window: '1h',
      since: '2026-01-01T00:00:00Z',
      until: DASHBOARD_SNAPSHOT,
      snapshot_id: DASHBOARD_SNAPSHOT,
      generated_at: DASHBOARD_SNAPSHOT,
    },
    total_retry_outcome_events: 0,
    retry_success_events: 0,
    retry_failed_events: 0,
    retry_column_sum: 0,
  })),
}))

vi.mock('./api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => [
    { id: 1, name: 'Payment API Stream', connector_id: 10, source_id: 1, status: 'RUNNING', enabled: true },
    { id: 2, name: 'Orders DB', connector_id: 11, source_id: 2, status: 'RUNNING', enabled: true },
  ]),
  fetchStreamsListResult: vi.fn(async () => ({
    ok: true as const,
    status: 200,
    data: [
      { id: 1, name: 'Payment API Stream', connector_id: 10, source_id: 1, status: 'RUNNING', enabled: true },
      { id: 2, name: 'Orders DB', connector_id: 11, source_id: 2, status: 'RUNNING', enabled: true },
    ],
  })),
  fetchStreamById: vi.fn(async (id: number) => ({
    id,
    name: id === 1 ? 'Payment API Stream' : `Stream ${id}`,
    connector_id: 10,
    source_id: 1,
    status: 'RUNNING',
    enabled: true,
    stream_type: 'HTTP_API_POLLING',
  })),
}))

vi.mock('./api/gdcConnectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/gdcConnectors')>()
  const connectors = [
    {
      id: 10,
      name: 'Payment API',
      product_group: 'Payment API',
      connector_type: 'generic_http',
      source_type: 'HTTP_API_POLLING',
      description: 'fixture',
      status: 'RUNNING',
      source_id: 10,
      stream_count: 1,
      host: 'http://127.0.0.1',
      base_url: 'http://127.0.0.1',
      verify_ssl: false,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
      created_at: '2026-05-11T12:49:13Z',
      updated_at: '2026-05-11T12:49:13Z',
    },
    {
      id: 11,
      name: 'MySQL Orders DB',
      product_group: 'MySQL Orders DB',
      connector_type: 'relational_database',
      source_type: 'DATABASE_QUERY',
      description: 'fixture',
      status: 'RUNNING',
      source_id: 11,
      stream_count: 1,
      host: 'http://127.0.0.1',
      base_url: 'http://127.0.0.1',
      verify_ssl: false,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
      created_at: '2026-05-11T12:49:13Z',
      updated_at: '2026-05-11T12:49:13Z',
    },
  ]
  return {
    ...actual,
    fetchConnectorsList: vi.fn(async () => connectors),
    fetchConnectorsListResult: vi.fn(async () => ({ ok: true, status: 200, data: connectors })),
  }
})

vi.mock('./api/gdcConnectorsOperations', () => ({
  fetchConnectorOperationsSummary: vi.fn(async () => ({ window: '1h', generated_at: null, connectors: [] })),
  runConnectorAuthCheck: vi.fn(),
  runConnectorQueryTest: vi.fn(),
}))

vi.mock('./api/gdcRoutes', () => ({
  fetchRoutesList: vi.fn(async () => []),
}))

vi.mock('./api/gdcDestinations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/gdcDestinations')>()
  return {
    ...actual,
    fetchDestinationsList: vi.fn(async () => []),
    fetchDestinationById: vi.fn(async () => null),
  }
})

vi.mock('./api/gdcRetention', () => ({
  fetchRetentionStatus: vi.fn(async () => null),
}))

function renderApp(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>,
  )
}

describe('DataRelay sidebar branding', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('exposes DataRelay home link, wordmark, and sidebar logo asset', () => {
    renderApp()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    const home = within(nav).getByRole('link', { name: /DataRelay — Dashboard home/i })
    expect(home).toHaveAttribute('href', '/monitoring')
    expect(home).toHaveTextContent('Data')
    expect(home).toHaveTextContent('Relay')
    const logo = home.querySelector('img')
    expect(logo).not.toBeNull()
    expect(logo).toHaveAttribute('src', '/logo/datarelay-logo.svg')
  })

  it('honors VITE_DATARELAY_INSTANCE_LABEL for the instance subtitle', () => {
    vi.stubEnv('VITE_DATARELAY_INSTANCE_LABEL', 'prod-use1')
    renderApp()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(nav).toHaveTextContent('prod-use1')
  })

  it('falls back to datarelay-instance when VITE_DATARELAY_INSTANCE_LABEL is whitespace only', () => {
    vi.stubEnv('VITE_DATARELAY_INSTANCE_LABEL', '   ')
    renderApp()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(nav).toHaveTextContent('datarelay-instance')
  })
})

describe('App shell (phase: sidebar, header, dashboard)', () => {
  // Lazy route chunks contend under full-suite parallelism; keep generous timeouts.
  vi.setConfig({ testTimeout: 30000 })

  beforeEach(() => {
    clearWizardCatalogSnapshot()
    persistTestSession('CONNECTOR_OPERATOR')
  })

  afterEach(() => {
    cleanup()
    clearTestSession()
    clearWizardCatalogSnapshot()
    localStorage.removeItem('gdc-platform-persona')
    localStorage.removeItem('gdc-platform-governance-mode')
  })

  it('renders core nav for CONNECTOR_OPERATOR (M20 RBAC)', () => {
    persistTestSession('CONNECTOR_OPERATOR')
    renderApp()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    for (const label of ['Connectors', 'Streams', 'Destinations', 'Administration']) {
      expect(within(nav).getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(within(nav).getAllByRole('button', { name: 'Dashboard' }).length).toBeGreaterThanOrEqual(1)
    expect(within(nav).queryByRole('button', { name: 'Routes' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Governance Workspace' })).not.toBeInTheDocument()
    expect(within(nav).queryByText('Governance')).not.toBeInTheDocument()
    for (const removed of [
      'Operations',
      'Operations Center',
      'Monitoring',
      'Logs',
      'Templates',
      'Runtime overview',
      'Analytics',
      'AI Gateway',
      'AI Providers',
      'AI Streams',
      'AI Traffic',
      'Admin Settings',
      'Network Settings',
      'Routes',
      'Governance Workspace',
    ]) {
      expect(within(nav).queryByRole('button', { name: removed })).not.toBeInTheDocument()
    }
    expect(nav).toHaveTextContent('Data Sources')
    expect(nav).toHaveTextContent('Delivery')
  })

  it('hides Governance nav for VIEWER (M20 RBAC)', () => {
    persistTestSession('VIEWER')
    renderApp()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(within(nav).queryByRole('button', { name: 'Governance Workspace' })).not.toBeInTheDocument()
    expect(within(nav).queryByText('Governance')).not.toBeInTheDocument()
    expect(within(nav).getAllByRole('button', { name: 'Dashboard' })).toHaveLength(1)
  })

  it('does not expose Governance as primary nav for GOVERNANCE_OPERATOR (M20 RBAC)', () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    renderApp()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(within(nav).queryByText('Governance')).not.toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Governance Workspace' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Destinations' })).toBeInTheDocument()
  })

  it('logo links to Dashboard home', () => {
    renderApp()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    const home = within(nav).getByRole('link', { name: /DataRelay — Dashboard home/i })
    expect(home).toHaveAttribute('href', '/monitoring')
  })

  it('renders Destinations via Delivery sidebar entry', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Destinations' }))
    expect(
      await screen.findByText(/Monitor delivery capacity and health of all destinations/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: /Destinations/ }).length).toBeGreaterThanOrEqual(1)
  })

  it('redirects / to Dashboard at /monitoring', async () => {
    renderApp('/')
    expect(await screen.findByTestId('dashboard-overall-health-beacon', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1, name: 'Dashboard' }).length).toBeGreaterThanOrEqual(1)
  })

  it('shows operator dashboard hierarchy driven by runtime APIs', async () => {
    renderApp('/monitoring')
    expect(await screen.findByTestId('dashboard-overall-health-beacon', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(await screen.findByTestId('dashboard-kpi-strip')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-stream-health-matrix')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-events-over-time')).toBeInTheDocument()
    expect(await screen.findByTestId('dashboard-recent-alerts')).toBeInTheDocument()
  })

  it('renders dashboard top grid and header search', async () => {
    renderApp('/monitoring')
    await screen.findByTestId('dashboard-overall-health-beacon', {}, { timeout: 15000 })
    expect(screen.getByRole('searchbox', { name: /Search streams/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Runtime status')).toBeInTheDocument()
  })

  it('renders Connectors via Data Sources sidebar entry', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Connectors' }))
    expect(
      await screen.findByText(/Operational dashboard — auth, data freshness/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: /^Connectors$/ }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('link', { name: 'Create Connector' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Connector' })).toBeInTheDocument()
  })


  it('renders Streams operational console when Streams is selected', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Streams' }))
    expect(
      await screen.findByText(/Monitor incoming data streams and their delivery status/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: /^Streams$/ }).length).toBeGreaterThanOrEqual(1)
    expect(await screen.findByRole('region', { name: 'Streams KPI summary' })).toBeInTheDocument()
  })


  it('renders destination detail at /destinations/:destinationId', async () => {
    const gdcDest = await import('./api/gdcDestinations')
    vi.spyOn(gdcDest, 'fetchDestinationById').mockResolvedValue({
      id: 42,
      name: 'Stellar SIEM Syslog UDP',
      destination_type: 'SYSLOG_UDP',
      config_json: { host: '10.10.20.50', port: 514 },
      enabled: true,
      last_connectivity_test_success: true,
      created_at: '2026-01-08T09:14:22Z',
      updated_at: '2026-05-08T12:40:00Z',
    })
    vi.spyOn(gdcDest, 'fetchDestinationsList').mockResolvedValue([])
    renderApp('/destinations/42')
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Stellar SIEM Syslog UDP' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(await screen.findByText(/SYSLOG UDP destination/i, {}, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Destination KPI summary' }, { timeout: 8000 })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Routes using this destination' }, { timeout: 8000 }),
    ).toBeInTheDocument()
  }, 15000)

  it('renders Logs explorer at /logs without sidebar entry', async () => {
    renderApp('/logs')
    expect(await screen.findByRole('heading', { level: 1, name: 'Logs' })).toBeInTheDocument()
    expect(
      await screen.findByText(/Search and analyze logs across the pipeline/i, {}, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Logs' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('searchbox', { name: /Search logs/i })).toBeInTheDocument()
  }, 15000)

  it('renders Dashboard when Dashboard is selected', async () => {
    const user = userEvent.setup()
    renderApp('/streams')
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    const [monitoringDashboard] = within(nav).getAllByRole('button', { name: 'Dashboard' })
    await user.click(monitoringDashboard)
    expect(await screen.findByTestId('dashboard-overall-health-beacon', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(await screen.findByTestId('dashboard-kpi-strip')).toBeInTheDocument()
    expect(await screen.findByTestId('dashboard-recent-alerts')).toBeInTheDocument()
  })

  it('renders Backup & Import workspace at /operations/backup', async () => {
    renderApp('/operations/backup')
    expect(
      await screen.findByText(/Export portable JSON snapshots/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 2, name: 'Backup & Import' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Workspace snapshot export' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Import configuration' })).toBeInTheDocument()
  })

  it('renders Templates library at /templates (deep link)', async () => {
    renderApp('/templates')
    expect(
      await screen.findByText(/Browse static integration templates/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: /Template/ }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('searchbox', { name: 'Search templates' })).toBeInTheDocument()
  })

  it('redirects /runtime to /monitoring Dashboard', async () => {
    renderApp('/runtime')
    expect(await screen.findByTestId('dashboard-overall-health-beacon', {}, { timeout: 15000 })).toBeInTheDocument()
  })

  it('redirects /runtime/ai-gateway to /streams', async () => {
    renderApp('/runtime/ai-gateway')
    expect(await screen.findByRole('heading', { level: 1, name: 'Streams' })).toBeInTheDocument()
  })

  it('does not expose /ai-gateway as a product route', async () => {
    renderApp('/ai-gateway/traffic')
    expect(await screen.findByRole('heading', { level: 1, name: 'Streams' })).toBeInTheDocument()
  })

  it('renders Settings directly at /admin', async () => {
    renderApp('/admin')
    expect(screen.queryByTestId('administration-hub-page')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Admin settings' }, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByText(/Operational dashboard for HTTPS/i, {}, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Maintenance Center' }, { timeout: 8000 })).toBeInTheDocument()
    expect(
      await screen.findByText(/Read-only readiness checks for production operations/i, {}, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'User management' }, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'System & backup' }, { timeout: 8000 })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Network / Reverse Proxy Settings' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Retention / cleanup policy' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Audit log' }, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Config versioning' }, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Health monitoring' }, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByText('Backup & Import', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Alerting' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Dev validation lab status' })).not.toBeInTheDocument()
  }, 20000)

  it('renders new stream wizard at /streams/new', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    renderApp('/streams/new')
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Stream Creation Wizard' })).toBeInTheDocument()
    const stepper = await screen.findByTestId('wizard-stepper', {}, { timeout: 15000 })
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Stream Onboarding Wizard' }, { timeout: 15000 }),
    ).toBeInTheDocument()
    expect(stepper.textContent).toContain('Connect')
    expect(stepper.textContent).toContain('Transform')
    expect(stepper.textContent).toContain('Destinations')
    // Catalog fetch can resolve before paint under CI parallelism; accept loading or settled UI.
    expect(
      await screen.findByText(/Loading connector catalog|No connectors available/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
  }, 25000)

  it('renders enrichment configuration at /streams/:streamId/enrichment', async () => {
    renderApp('/streams/malop-api/enrichment')
    expect(await screen.findByRole('navigation', { name: 'Breadcrumb' }, { timeout: 15000 })).toBeInTheDocument()
    expect(
      await screen.findByText(/Add static fields and computed fields to enrich your events/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: 'Enrichment Configuration' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Static Fields' })).toBeInTheDocument()
    expect(screen.getByText('Override Policy')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Enrichment Summary' })).toBeInTheDocument()
  }, 20000)

  it('renders source test page at /streams/:streamId/api-test with HTTP-aware labels for malop-api', async () => {
    renderApp('/streams/malop-api/api-test')
    expect(
      await screen.findByText(/Runs the saved HTTP request/i, {}, { timeout: 15000 }),
    ).toBeInTheDocument()
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumb).getByText('API Test & Preview')).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: 'API Test & Preview' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('heading', { level: 3, name: 'Request Configuration' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Response Preview' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'JSON Tree' })).toBeInTheDocument()
  })

  it('uses fixture slug for remote probe breadcrumb on api-test', async () => {
    renderApp('/streams/fixture-remote-stream/api-test')
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumb).getByText('Remote Probe & Preview')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Remote Probe & Preview' })).toBeInTheDocument()
  })

  it('uses neutral shell title when stream slug has no source hint', async () => {
    renderApp('/streams/unknown-zzz-stream/api-test')
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumb).getByText('Source Test & Preview')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Source Test & Preview' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 2, name: 'Source Test & Preview' })).toBeInTheDocument()
  })

  it('renders stream monitoring inspector at /streams/:streamId/runtime', async () => {
    const user = userEvent.setup()
    // Prefer a numeric stream id so runtime detail loads full monitoring chrome (slug ids are rejected).
    renderApp('/streams/1/runtime')
    expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' }).length).toBeGreaterThan(0)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Stream monitoring' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Stream monitoring' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(await screen.findByTestId('stream-detail-tabs', {}, { timeout: 15000 })).toBeInTheDocument()
    expect(
      await screen.findByRole('region', { name: 'Stream monitoring status' }, { timeout: 8000 }),
    ).toBeInTheDocument()
    expect(await screen.findByLabelText('Flow status', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Recent events' }, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByTestId('stream-why-panel', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(await screen.findByTestId('stream-information-panel', {}, { timeout: 8000 })).toBeInTheDocument()
    await user.click(screen.getByTestId('stream-detail-tab-metrics'))
    expect(screen.getByTestId('stream-monitoring-observability')).toBeInTheDocument()
  }, 25000)

  it('renders Routes operational console at /routes', async () => {
    renderApp('/routes')
    expect(await screen.findByRole('heading', { level: 1, name: 'Routes' }, { timeout: 8000 })).toBeInTheDocument()
    // LazyRoutesOverviewPage loads asynchronously; wait for page chrome before h2 assertions.
    expect(await screen.findByRole('region', { name: 'Route KPI summary' }, { timeout: 15000 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Routes' })).toBeInTheDocument()
    expect(screen.getByText(/End-to-end delivery flow across streams, routes, and destinations/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create Route' })).toBeInTheDocument()
  }, 20000)

  it('renders advanced health checks workspace at /validation without sidebar entry', async () => {
    renderApp('/validation')
    expect(await screen.findByRole('heading', { level: 1, name: 'Runtime health checks' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Runtime health checks workspace' })).toBeInTheDocument()
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(within(nav).queryByRole('button', { name: 'Continuous validation' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Administration' })).toHaveAttribute('aria-current', 'page')
  })

  it('renders Governance shell with section nav at /governance', async () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    renderApp('/governance')
    expect(await screen.findByTestId('governance-shell')).toBeInTheDocument()
    expect(screen.getByTestId('governance-nav-dashboard')).toBeInTheDocument()
    expect(screen.getByTestId('governance-nav-violations')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-read-only-banner')).not.toBeInTheDocument()
  })

  it('shows read-only banner on Governance pages for CONNECTOR_OPERATOR (M20 RBAC)', async () => {
    persistTestSession('CONNECTOR_OPERATOR')
    renderApp('/governance')
    expect(await screen.findByTestId('governance-read-only-banner')).toBeInTheDocument()
    expect(screen.getByText(/Governance write actions require Governance Operator role/i)).toBeInTheDocument()
  })
})
