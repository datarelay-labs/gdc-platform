import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamRuntimeDetailPage } from './stream-runtime-detail-page'
import { getUrl, jsonResponse } from '../../test/fetchMock'
import * as gdcRuntime from '../../api/gdcRuntime'
import * as gdcBackfill from '../../api/gdcBackfill'
import * as streamGovernanceSnapshot from '../../lib/stream-governance-snapshot'
import {
  persistRuntimeRefreshEvery,
  persistStreamRuntimeMetricsAutoRefresh,
} from '../../localPreferences'
import {
  notifyStreamGovernanceChanged,
  STREAM_GOVERNANCE_CHANGED_EVENT,
} from '../../lib/stream-governance-events'

const { mockFetchStreamById } = vi.hoisted(() => ({
  mockFetchStreamById: vi.fn(async (id: number) => ({
    id,
    name: `Stream ${id}`,
    stream_type: 'HTTP_API_POLLING',
    connector_id: 1,
  })),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: mockFetchStreamById,
}))

vi.mock('../../api/gdcSchemaDrift', () => ({
  fetchStreamSchemaFieldDrifts: vi.fn(async () => ({
    stream_id: 42,
    drift_detection_enabled: true,
    baseline_established: true,
    baseline_established_at: '2026-01-01T00:00:00Z',
    baseline_path_count: 3,
    baseline_version: 1,
    baseline_reset_at: null,
    status_filter: 'open',
    findings: [
      {
        id: 9,
        field_path: '$.email',
        category: 'field_added',
        status: 'open',
        first_detected_at: '2026-01-01T00:00:00Z',
        last_confirmed_at: '2026-01-01T00:05:00Z',
      },
    ],
    finding_count: 1,
  })),
  fetchStreamSchemaFieldDriftsSummary: vi.fn(async () => ({
    stream_id: 42,
    open_count: 1,
    acknowledged_count: 0,
    resolved_count: 0,
    by_category: { field_added: 1, field_removed: 0, field_type_changed: 0 },
    baseline_version: 1,
    baseline_established_at: '2026-01-01T00:00:00Z',
    baseline_reset_at: null,
    drift_detection_enabled: true,
  })),
  acknowledgeSchemaFieldDrift: vi.fn(),
  resetStreamSchemaBaseline: vi.fn(),
}))

vi.mock('../../api/gdcBackfill', () => ({
  replayStreamBackfill: vi.fn(),
}))

vi.mock('../../api/gdcRuntimePipelineDebug', () => ({
  runStreamPipelineDebug: vi.fn(async () => ({
    stream_id: 42,
    raw_event: null,
    mapped_event: null,
    enriched_event: null,
    formatted_payload: null,
    routes: [],
    warnings: [],
    errors: [],
  })),
}))

vi.mock('../../utils/mappingSourceSample', () => ({
  fetchMappingSourceSample: vi.fn(async () => ({
    ok: false,
    sourceType: 'HTTP_API_POLLING',
    rawPayload: null,
    treeDocument: {},
    unionSchema: null,
    extractedEvents: [],
    eventArrayPath: '',
    eventRootPath: '',
    sampleEventIndex: 0,
    message: 'No sample',
    recordsLabel: '—',
    fetchedAt: '',
  })),
}))

const emptyMetrics = {
  stream: {
    id: 42,
    name: 'Stream 42',
    status: 'RUNNING',
    last_run_at: null,
    last_success_at: null,
    last_error_at: null,
    last_checkpoint: null,
  },
  kpis: {
    events_last_hour: 0,
    delivered_last_hour: 0,
    failed_last_hour: 0,
    delivery_success_rate: 100,
    avg_latency_ms: 0,
    max_latency_ms: 0,
    error_rate: 0,
  },
  events_over_time: [] as [],
  route_health: [] as [],
  checkpoint_history: [] as [],
  recent_runs: [] as [],
  route_runtime: [] as [],
  recent_route_errors: [] as [],
}

function streamRuntimeMetricsFixture(params?: { snapshot_id?: string }) {
  const snapshot_id = params?.snapshot_id?.trim() || '2026-01-02T00:00:00Z'
  return {
    snapshot_id,
    generated_at: snapshot_id,
    stream: {
      id: 42,
      name: 'Stream 42',
      status: 'RUNNING',
      last_run_at: null,
      last_success_at: null,
      last_error_at: null,
      last_checkpoint: null,
    },
    kpis: {
      events_last_hour: 0,
      delivered_last_hour: 0,
      failed_last_hour: 0,
      delivery_success_rate: 100,
      avg_latency_ms: 0,
      max_latency_ms: 0,
      error_rate: 0,
    },
    events_over_time: [],
    route_health: [
      {
        route_id: 101,
        destination_name: 'Stellar Syslog',
        destination_type: 'SYSLOG_UDP',
        enabled: true,
        success_count: 1,
        failed_count: 0,
        last_success_at: null,
        last_failure_at: null,
        avg_latency_ms: 0,
        failure_policy: 'RETRY_AND_BACKOFF',
        last_error_message: null,
      },
    ],
    checkpoint_history: [],
    recent_runs: [],
    route_runtime: [],
    recent_route_errors: [],
  }
}

vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamRuntimeTimeline: vi.fn(async () => null),
  fetchStreamRuntimeStats: vi.fn(async () => null),
  fetchStreamRuntimeHealth: vi.fn(async () => null),
  fetchStreamRuntimeStatsHealth: vi.fn(async () => ({ stats: null, health: null })),
  fetchStreamCheckpointHistory: vi.fn(async () => null),
  fetchStreamWebhookIngestObservability: vi.fn(async () => null),
  metricsWindowSeconds: (window: string) => {
    const seconds: Record<string, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 }
    return seconds[window] ?? 3600
  },
  fetchStreamRuntimeMetrics: vi.fn(async (_id: number, _window: string, params?: { snapshot_id?: string }) =>
    streamRuntimeMetricsFixture(params),
  ),
  saveRuntimeRouteEnabledState: vi.fn(async () => null),
  runStreamOnce: vi.fn(async () => ({
    stream_id: 42,
    outcome: 'completed',
    message: null,
    extracted_event_count: 1,
    mapped_event_count: 1,
    enriched_event_count: 1,
    delivered_batch_event_count: 1,
    checkpoint_updated: true,
    transaction_committed: true,
  })),
  startRuntimeStream: vi.fn(async () => null),
  stopRuntimeStream: vi.fn(async () => null),
}))

function emptyGovernanceSnapshot(
  overrides: Partial<streamGovernanceSnapshot.StreamGovernanceSnapshot> = {},
): streamGovernanceSnapshot.StreamGovernanceSnapshot {
  return {
    schemaDrift: null,
    sensitive: null,
    protection: null,
    policy: null,
    dynamicRouting: null,
    failover: null,
    replay: null,
    quarantine: null,
    ...overrides,
  }
}

function renderRuntimePage(streamId: string) {
  return render(
    <MemoryRouter initialEntries={[`/streams/${streamId}/runtime`]}>
      <Routes>
        <Route path="/streams/:streamId/runtime" element={<StreamRuntimeDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StreamRuntimeDetailPage routes section', () => {
  it('shows connected destination fields for stream routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = getUrl(input)
        const path = url.split('?')[0]
        const pathname = path.startsWith('http')
          ? (() => {
              try {
                return new URL(path).pathname
              } catch {
                return path
              }
            })()
          : path
        if (pathname === '/api/v1/routes' || pathname === '/api/v1/routes/') {
          return jsonResponse([
            {
              id: 101,
              stream_id: 42,
              destination_id: 201,
              failure_policy: 'RETRY_AND_BACKOFF',
              enabled: true,
            },
          ])
        }
        if (pathname === '/api/v1/destinations' || pathname === '/api/v1/destinations/') {
          return jsonResponse([
            {
              id: 201,
              name: 'Stellar Syslog',
              destination_type: 'SYSLOG_UDP',
              config_json: { host: '192.168.1.10', port: 514, protocol: 'udp' },
              rate_limit_json: {},
              enabled: true,
              streams_using_count: 1,
              routes: [{ route_id: 101, stream_id: 42, stream_name: 'Stream 42' }],
            },
          ])
        }
        return jsonResponse({ items: [] })
      }),
    )

    const user = userEvent.setup()
    renderRuntimePage('42')

    await user.click(await screen.findByTestId('stream-detail-tab-audit'))
    expect(await screen.findByTestId('stream-runtime-health-extension')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: /Delivery paths · Operational/i })).toBeInTheDocument()
    expect(screen.getByText(/Committed delivery records · 1h aggregates/i)).toBeInTheDocument()
    expect(await screen.findByText('Stellar Syslog')).toBeInTheDocument()
    expect(screen.getByText(/SYSLOG_UDP/)).toBeInTheDocument()
    expect(screen.getByText('RETRY_AND_BACKOFF')).toBeInTheDocument()
    expect(screen.getByText('On')).toBeInTheDocument()
  })

  it('shows empty-state text when stream has no routes', async () => {
    vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mockImplementationOnce(
      async (_id, _window, params) => ({
        ...streamRuntimeMetricsFixture(params),
        route_health: [],
        route_runtime: [],
        stream: emptyMetrics.stream,
        kpis: emptyMetrics.kpis,
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = getUrl(input)
        const path = url.split('?')[0]
        const pathname = path.startsWith('http')
          ? (() => {
              try {
                return new URL(path).pathname
              } catch {
                return path
              }
            })()
          : path
        if (pathname === '/api/v1/routes' || pathname === '/api/v1/routes/') return jsonResponse([])
        if (pathname === '/api/v1/destinations' || pathname === '/api/v1/destinations/') return jsonResponse([])
        return jsonResponse({ items: [] })
      }),
    )

    const user = userEvent.setup()
    renderRuntimePage('42')

    await user.click(await screen.findByTestId('stream-detail-tab-audit'))
    expect(await screen.findByText('No routes for this stream')).toBeInTheDocument()
    expect(screen.getByText(/Connect a destination from the stream workflow/i)).toBeInTheDocument()
  })
})

describe('StreamRuntimeDetailPage webhook receiver', () => {
  it('shows push ingest panel without checkpoint wording', async () => {
    mockFetchStreamById.mockResolvedValueOnce({
      id: 42,
      name: 'Webhook Stream',
      connector_id: 1,
      source_id: 1,
      stream_type: 'WEBHOOK_RECEIVER',
      status: 'RUNNING',
      enabled: true,
      polling_interval: 60,
    })
    vi.mocked(gdcRuntime.fetchStreamWebhookIngestObservability).mockResolvedValue({
      stream_id: 42,
      stream_status: 'RUNNING',
      source_enabled: true,
      stream_enabled: true,
      receiver_key: 'rx-42',
      receiver_path: '/api/v1/ingest/webhook/rx-42',
      webhook_auth_mode: 'no_auth',
      window: '1h',
      window_start: '2026-05-21T10:00:00Z',
      window_end: '2026-05-21T11:00:00Z',
      ingest_attempts: 2,
      successful_deliveries: 2,
      failed_deliveries: 0,
      auth_failures: 0,
      malformed_payload_count: 0,
      recent_ingest: { at: null, outcome: 'none', stage: null, message: null, run_id: null },
      recent_logs: [],
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = getUrl(input)
        const path = url.split('?')[0]
        const pathname = path.startsWith('http')
          ? (() => {
              try {
                return new URL(path).pathname
              } catch {
                return path
              }
            })()
          : path
        if (pathname === '/api/v1/routes' || pathname === '/api/v1/routes/') return jsonResponse([])
        if (pathname === '/api/v1/destinations' || pathname === '/api/v1/destinations/') return jsonResponse([])
        return jsonResponse({ items: [] })
      }),
    )

    const user = userEvent.setup()
    renderRuntimePage('42')
    await user.click(await screen.findByTestId('stream-detail-tab-audit'))
    expect(await screen.findByTestId('webhook-receiver-runtime-panel')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('webhook-metric-ingest-attempts')).toHaveTextContent('2')
    })
    expect(screen.queryByRole('heading', { name: /Checkpoint trace/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Last Checkpoint/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Checkpoint$/i })).not.toBeInTheDocument()
  })
})

describe('StreamRuntimeDetailPage backfill modal', () => {
  it('opens modal, runs replay, shows delivery summary', async () => {
    const user = userEvent.setup()
    vi.mocked(gdcBackfill.replayStreamBackfill).mockResolvedValue({
      id: 99,
      stream_id: 42,
      source_type: 'HTTP_API_POLLING',
      status: 'COMPLETED',
      backfill_mode: 'TIME_RANGE_REPLAY',
      requested_by: 'test',
      created_at: '2026-05-12T12:00:00Z',
      started_at: '2026-05-12T12:00:01Z',
      completed_at: '2026-05-12T12:00:02Z',
      failed_at: null,
      source_config_snapshot_json: {},
      checkpoint_snapshot_json: null,
      runtime_options_json: {},
      progress_json: {},
      error_summary: null,
      delivery_summary_json: { status: 'completed', sent: 2, failed: 0, skipped: 0 },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = getUrl(input)
        const path = url.split('?')[0]
        const pathname = path.startsWith('http')
          ? (() => {
              try {
                return new URL(path).pathname
              } catch {
                return path
              }
            })()
          : path
        if (pathname === '/api/v1/streams/42' || pathname.endsWith('/streams/42')) {
          return jsonResponse({
            id: 42,
            name: 'Stream 42',
            connector_id: 1,
            source_id: 1,
            stream_type: 'HTTP_API_POLLING',
            status: 'RUNNING',
            enabled: true,
            polling_interval: 60,
          })
        }
        if (pathname === '/api/v1/routes' || pathname === '/api/v1/routes/') {
          return jsonResponse([
            {
              id: 101,
              stream_id: 42,
              destination_id: 201,
              failure_policy: 'LOG_AND_CONTINUE',
              enabled: true,
            },
          ])
        }
        if (pathname === '/api/v1/destinations' || pathname === '/api/v1/destinations/') {
          return jsonResponse([
            {
              id: 201,
              name: 'Dest',
              destination_type: 'WEBHOOK_POST',
              config_json: { url: 'https://x.example/hook' },
              rate_limit_json: {},
              enabled: true,
              streams_using_count: 1,
              routes: [],
            },
          ])
        }
        return jsonResponse({ items: [] })
      }),
    )

    renderRuntimePage('42')
    await user.click(await screen.findByTestId('stream-detail-tab-audit'))

    await user.click(screen.getByTestId('stream-run-backfill-open'))
    expect(screen.getByTestId('stream-backfill-modal')).toBeInTheDocument()

    await user.click(screen.getByTestId('stream-backfill-submit'))
    expect(gdcBackfill.replayStreamBackfill).toHaveBeenCalled()
    expect(await screen.findByTestId('stream-backfill-result')).toBeInTheDocument()
    expect(screen.getByText('Sent').closest('li')).toHaveTextContent('2')
  })
})

describe('StreamRuntimeDetailPage M17.2 layout', () => {
  afterEach(() => {
    localStorage.removeItem('gdc-platform-persona')
  })

  it('hides governance drawer for Connector Operator persona (M17.4)', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    renderRuntimePage('42')
    await screen.findByTestId('stream-monitoring-status-strip')
    expect(screen.queryByTestId('stream-governance-drawer')).not.toBeInTheDocument()
  })

  it('shows status-first layout with governance drawer for Governance Operator', async () => {
    const user = userEvent.setup()
    localStorage.setItem('gdc-platform-persona', 'governance')
    renderRuntimePage('42')
    const statusStrip = await screen.findByTestId('stream-monitoring-status-strip')
    expect(statusStrip).toBeInTheDocument()
    expect(statusStrip).toHaveTextContent('Ingest Rate')
    expect(statusStrip).toHaveTextContent('Delivery Rate')
    expect(statusStrip).toHaveTextContent('Success Rate')
    expect(statusStrip).toHaveTextContent('Last Event')
    expect(screen.getByTestId('stream-flow-timeline')).toBeInTheDocument()
    expect(screen.getByTestId('stream-recent-events-panel')).toBeInTheDocument()
    await user.click(screen.getByTestId('stream-detail-tab-audit'))
    expect(screen.getByTestId('stream-governance-drawer')).toBeInTheDocument()
    expect(screen.queryByTestId('schema-drift-panel')).not.toBeInTheDocument()
  })

  it('renders six-tab stream runtime shell', async () => {
    renderRuntimePage('42')
    expect(await screen.findByTestId('stream-detail-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('stream-detail-tab-overview')).toBeInTheDocument()
    expect(screen.getByTestId('stream-detail-tab-metrics')).toBeInTheDocument()
    expect(screen.getByTestId('stream-detail-tab-events')).toBeInTheDocument()
    expect(screen.getByTestId('stream-detail-tab-schema')).toBeInTheDocument()
    expect(screen.getByTestId('stream-detail-tab-violations')).toBeInTheDocument()
    expect(screen.getByTestId('stream-detail-tab-audit')).toBeInTheDocument()
    expect(screen.getByTestId('stream-recent-issues-panel')).toBeInTheDocument()
    expect(screen.getByTestId('stream-why-panel')).toBeInTheDocument()
    expect(screen.getByTestId('stream-information-panel')).toBeInTheDocument()
  })

  it('shows schema drift field, type, and status on the OSS schema tab', async () => {
    const user = userEvent.setup()
    renderRuntimePage('42')
    await user.click(await screen.findByTestId('stream-detail-tab-schema'))
    expect(await screen.findByTestId('schema-drift-panel')).toBeInTheDocument()
    expect(screen.getByTestId('schema-drift-row-9')).toHaveTextContent('$.email')
    expect(screen.getByTestId('schema-drift-row-9')).toHaveTextContent('Field added')
    expect(screen.getByTestId('schema-drift-row-9')).toHaveTextContent('open')
  })

  it('shows run history inside observability without placeholder tabs', async () => {
    const user = userEvent.setup()
    renderRuntimePage('42')
    await user.click(await screen.findByTestId('stream-detail-tab-audit'))
    expect(await screen.findByText('Run History')).toBeInTheDocument()
    expect(screen.getByTestId('stream-monitoring-observability')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Configuration' })).not.toBeInTheDocument()
    expect(screen.queryByText(/No additional tab-specific data/i)).not.toBeInTheDocument()
  })

  it('shows error state instead of monitoring shell when stream metadata fails to load', async () => {
    mockFetchStreamById.mockResolvedValueOnce(null)
    renderRuntimePage('42')
    expect(await screen.findByTestId('stream-runtime-load-error')).toBeInTheDocument()
    expect(screen.getByText(/Stream #42 was not found/i)).toBeInTheDocument()
    expect(screen.queryByTestId('stream-monitoring-status-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-detail-tabs')).not.toBeInTheDocument()
  })
})

describe('StreamRuntimeDetailPage lifecycle cleanup', () => {
  beforeEach(() => {
    mockFetchStreamById.mockImplementation(async (id: number) => ({
      id,
      name: `Stream ${id}`,
      stream_type: 'HTTP_API_POLLING',
      connector_id: 1,
    }))
    vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mockResolvedValue(null)
    vi.mocked(gdcRuntime.fetchStreamRuntimeStatsHealth).mockResolvedValue({ stats: null, health: null })
    vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mockImplementation(
      async (_id, _window, params) => streamRuntimeMetricsFixture(params),
    )
    vi.spyOn(streamGovernanceSnapshot, 'fetchStreamGovernanceSnapshot').mockResolvedValue({
      schemaDrift: null,
      sensitive: null,
      protection: null,
      policy: null,
      dynamicRouting: null,
      failover: null,
      replay: null,
      quarantine: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    persistStreamRuntimeMetricsAutoRefresh(false)
    persistRuntimeRefreshEvery('off')
  })

  it('runs initial runtime refresh once after stream metadata resolves', async () => {
    vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeStatsHealth).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mockClear()
    vi.mocked(gdcRuntime.fetchStreamCheckpointHistory).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeStats).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeHealth).mockClear()
    const governanceSpy = vi.spyOn(streamGovernanceSnapshot, 'fetchStreamGovernanceSnapshot')

    renderRuntimePage('42')

    await waitFor(() => {
      expect(gdcRuntime.fetchStreamRuntimeTimeline).toHaveBeenCalledTimes(1)
    })
    expect(gdcRuntime.fetchStreamRuntimeStatsHealth).toHaveBeenCalledTimes(1)
    expect(gdcRuntime.fetchStreamRuntimeMetrics).toHaveBeenCalledTimes(1)
    expect(gdcRuntime.fetchStreamCheckpointHistory).not.toHaveBeenCalled()
    expect(gdcRuntime.fetchStreamRuntimeStats).not.toHaveBeenCalled()
    expect(gdcRuntime.fetchStreamRuntimeHealth).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(governanceSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('defers governance snapshot until after primary runtime refresh completes', async () => {
    let resolveTimeline!: (value: null) => void
    vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTimeline = resolve
        }),
    )
    const governanceSpy = vi.spyOn(streamGovernanceSnapshot, 'fetchStreamGovernanceSnapshot').mockClear()

    renderRuntimePage('42')
    await waitFor(() => {
      expect(gdcRuntime.fetchStreamRuntimeTimeline).toHaveBeenCalled()
    })
    expect(governanceSpy).not.toHaveBeenCalled()

    resolveTimeline(null)
    await waitFor(() => {
      expect(governanceSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('loads checkpoint history only when audit tab is selected', async () => {
    const user = userEvent.setup()
    vi.mocked(gdcRuntime.fetchStreamCheckpointHistory).mockClear()

    renderRuntimePage('42')
    await screen.findByTestId('stream-monitoring-status-strip')
    expect(gdcRuntime.fetchStreamCheckpointHistory).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('stream-detail-tab-audit'))
    await waitFor(() => {
      expect(gdcRuntime.fetchStreamCheckpointHistory).toHaveBeenCalledTimes(1)
    })
  })

  it('reuses refresh-cycle snapshot_id for stats-health and metrics', async () => {
    vi.mocked(gdcRuntime.fetchStreamRuntimeStatsHealth).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mockClear()

    renderRuntimePage('42')
    await waitFor(() => {
      expect(gdcRuntime.fetchStreamRuntimeStatsHealth).toHaveBeenCalledTimes(1)
      expect(gdcRuntime.fetchStreamRuntimeMetrics).toHaveBeenCalled()
    })

    const statsHealthSnapshot = vi.mocked(gdcRuntime.fetchStreamRuntimeStatsHealth).mock.calls[0]?.[3]?.snapshot_id
    const metricsSnapshot = vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mock.calls[0]?.[2]?.snapshot_id
    expect(statsHealthSnapshot).toBeTruthy()
    expect(metricsSnapshot).toBe(statsHealthSnapshot)
  })

  it('stops metrics auto-refresh polling after unmount', async () => {
    persistRuntimeRefreshEvery('10s')
    const { unmount } = renderRuntimePage('42')
    await waitFor(() => {
      expect(gdcRuntime.fetchStreamRuntimeMetrics).toHaveBeenCalled()
    })
    await screen.findByTestId('stream-monitoring-status-strip')
    const callsAfterMount = vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mock.calls.length
    expect(callsAfterMount).toBeGreaterThan(0)
    unmount()
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mock.calls.length).toBe(callsAfterMount)
  })

  it('skips stale refreshRuntimeData state updates after unmount', async () => {
    let resolveTimeline!: (value: null) => void
    vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTimeline = resolve
        }),
    )
    vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mockClear()
    const { unmount } = renderRuntimePage('42')
    await waitFor(() => {
      expect(gdcRuntime.fetchStreamRuntimeTimeline).toHaveBeenCalled()
    })
    expect(gdcRuntime.fetchStreamRuntimeMetrics).toHaveBeenCalled()
    unmount()
    resolveTimeline(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(await screen.queryByTestId('stream-monitoring-status-strip')).not.toBeInTheDocument()
  })

  it('does not fetch governance on auto-refresh polls (request-count regression)', async () => {
    persistRuntimeRefreshEvery('10s')
    const pollCallbacks: Array<() => void> = []
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        pollCallbacks.push(handler as () => void)
      }
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)

    vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeStatsHealth).mockClear()
    vi.mocked(gdcRuntime.fetchStreamRuntimeMetrics).mockClear()
    const governanceSpy = vi.spyOn(streamGovernanceSnapshot, 'fetchStreamGovernanceSnapshot').mockClear()

    renderRuntimePage('42')
    await waitFor(() => {
      expect(governanceSpy).toHaveBeenCalledTimes(1)
    })
    expect(gdcRuntime.fetchStreamRuntimeTimeline).toHaveBeenCalledTimes(1)
    expect(gdcRuntime.fetchStreamRuntimeStatsHealth).toHaveBeenCalledTimes(1)
    expect(gdcRuntime.fetchStreamRuntimeMetrics).toHaveBeenCalledTimes(1)
    expect(pollCallbacks.length).toBeGreaterThanOrEqual(1)

    const timelineBeforePoll = vi.mocked(gdcRuntime.fetchStreamRuntimeTimeline).mock.calls.length
    const govBeforePoll = governanceSpy.mock.calls.length

    pollCallbacks[0]!()
    await waitFor(() => {
      expect(gdcRuntime.fetchStreamRuntimeTimeline).toHaveBeenCalledTimes(timelineBeforePoll + 1)
    })
    expect(governanceSpy).toHaveBeenCalledTimes(govBeforePoll)

    for (let i = 0; i < 5; i += 1) {
      pollCallbacks[0]!()
    }
    await waitFor(() => {
      expect(gdcRuntime.fetchStreamRuntimeTimeline).toHaveBeenCalledTimes(timelineBeforePoll + 6)
    })
    expect(gdcRuntime.fetchStreamRuntimeStatsHealth).toHaveBeenCalledTimes(timelineBeforePoll + 6)
    expect(gdcRuntime.fetchStreamRuntimeMetrics).toHaveBeenCalledTimes(timelineBeforePoll + 6)
    expect(governanceSpy).toHaveBeenCalledTimes(govBeforePoll)

    setIntervalSpy.mockRestore()
  })

  it('refetches governance after governance mutation invalidation and renders latest values', async () => {
    const governanceSpy = vi
      .spyOn(streamGovernanceSnapshot, 'fetchStreamGovernanceSnapshot')
      .mockResolvedValueOnce(
        emptyGovernanceSnapshot({
          schemaDrift: {
            stream_id: 42,
            open_count: 0,
            acknowledged_count: 0,
            resolved_count: 0,
            by_category: { field_added: 0, field_removed: 0, field_type_changed: 0 },
            baseline_version: 1,
            baseline_established_at: null,
            baseline_reset_at: null,
            drift_detection_enabled: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        emptyGovernanceSnapshot({
          schemaDrift: {
            stream_id: 42,
            open_count: 3,
            acknowledged_count: 0,
            resolved_count: 0,
            by_category: { field_added: 3, field_removed: 0, field_type_changed: 0 },
            baseline_version: 1,
            baseline_established_at: null,
            baseline_reset_at: null,
            drift_detection_enabled: true,
          },
        }),
      )

    renderRuntimePage('42')
    await waitFor(() => {
      expect(governanceSpy).toHaveBeenCalledTimes(1)
    })
    await screen.findByTestId('stream-recent-issues-panel')
    expect(screen.getByText('No drift detected')).toBeInTheDocument()

    notifyStreamGovernanceChanged(42)

    await waitFor(() => {
      expect(governanceSpy).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText('Schema drift detected')).toBeInTheDocument()
    expect(screen.getAllByText(/3 field added/i).length).toBeGreaterThanOrEqual(1)
  })

  it('ignores stale governance responses after stream switch', async () => {
    let resolveA!: (value: streamGovernanceSnapshot.StreamGovernanceSnapshot) => void
    const governanceA = new Promise<streamGovernanceSnapshot.StreamGovernanceSnapshot>((resolve) => {
      resolveA = resolve
    })
    const governanceSpy = vi.spyOn(streamGovernanceSnapshot, 'fetchStreamGovernanceSnapshot').mockImplementation(async (id) => {
      if (id === 42) return governanceA
      return emptyGovernanceSnapshot({
        schemaDrift: {
          stream_id: 99,
          open_count: 1,
          acknowledged_count: 0,
          resolved_count: 0,
          by_category: { field_added: 1, field_removed: 0, field_type_changed: 0 },
          baseline_version: 1,
          baseline_established_at: null,
          baseline_reset_at: null,
          drift_detection_enabled: true,
        },
      })
    })

    const { unmount } = renderRuntimePage('42')
    await waitFor(() => {
      expect(governanceSpy).toHaveBeenCalledWith(42, expect.anything())
    })
    unmount()

    renderRuntimePage('99')
    await waitFor(() => {
      expect(governanceSpy).toHaveBeenCalledWith(99, expect.anything())
    })
    await screen.findByTestId('stream-recent-issues-panel')
    expect(await screen.findByText('Schema drift detected')).toBeInTheDocument()

    resolveA(
      emptyGovernanceSnapshot({
        schemaDrift: {
          stream_id: 42,
          open_count: 9,
          acknowledged_count: 0,
          resolved_count: 0,
          by_category: { field_added: 9, field_removed: 0, field_type_changed: 0 },
          baseline_version: 1,
          baseline_established_at: null,
          baseline_reset_at: null,
          drift_detection_enabled: true,
        },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText(/9 field added/i)).not.toBeInTheDocument()
    expect(screen.getByText('Schema drift detected')).toBeInTheDocument()
  })

  it('keeps governance drawer host mounted across tab switches (no remount duplication)', async () => {
    const user = userEvent.setup()
    localStorage.setItem('gdc-platform-persona', 'governance')
    renderRuntimePage('42')
    await screen.findByTestId('stream-monitoring-status-strip')
    expect(screen.getByTestId('stream-governance-drawer-host')).toBeInTheDocument()
    const host = screen.getByTestId('stream-governance-drawer-host')
    await user.click(screen.getByTestId('stream-detail-tab-audit'))
    expect(screen.getByTestId('stream-governance-drawer-host')).toBe(host)
    await user.click(screen.getByTestId('stream-detail-tab-overview'))
    expect(screen.getByTestId('stream-governance-drawer-host')).toBe(host)
    localStorage.removeItem('gdc-platform-persona')
  })
})

describe('stream-governance-events', () => {
  it('dispatches stream-scoped governance changed events', () => {
    const handler = vi.fn()
    window.addEventListener(STREAM_GOVERNANCE_CHANGED_EVENT, handler)
    notifyStreamGovernanceChanged(42)
    expect(handler).toHaveBeenCalledTimes(1)
    expect((handler.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ streamId: 42 })
    window.removeEventListener(STREAM_GOVERNANCE_CHANGED_EVENT, handler)
  })
})
