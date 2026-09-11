import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamsConsole } from './streams-console'

vi.mock('../../api/gdcStreams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcStreams')>()
  return {
    ...actual,
    fetchStreamsListResult: vi.fn(),
  }
})

vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamMappingUiConfig: vi.fn(async () => null),
  fetchStreamRuntimeStatsHealth: vi.fn(async () => null),
  runStreamOnce: vi.fn(),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => [
    { id: 10, name: 'office365-connector', product_group: 'Office365' },
    { id: 11, name: 'aws-connector', product_group: 'Amazon Web Services' },
  ]),
  fetchConnectorById: vi.fn(async (id: number) => ({
    id,
    name: id === 10 ? 'office365-connector' : 'aws-connector',
    product_group: id === 10 ? 'Office365' : 'Amazon Web Services',
  })),
}))

vi.mock('../../api/gdcRoutes', () => ({
  fetchRoutesList: vi.fn(async () => [
    { id: 1, stream_id: 2, destination_id: 99, name: 'Route to Splunk' },
  ]),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [{ id: 99, name: 'Splunk Prod', destination_type: 'WEBHOOK_POST' }]),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
  getOperationalSnapshot: vi.fn(async () => ({
    global: {
      health_status: 'DEGRADED',
      total_streams: 4,
      enabled_streams: 4,
      running_streams: 2,
      error_streams: 1,
      total_routes: 1,
      enabled_routes: 1,
      total_destinations: 1,
      enabled_destinations: 1,
      total_eps_1m: 10,
      total_eps_5m: 10,
      avg_latency_ms: 10,
      last_activity_at: null,
    },
    streams: [
      {
        stream_id: 1,
        stream_name: 'healthy-stream',
        connector_id: 10,
        source_id: 1,
        enabled: true,
        status: 'RUNNING',
        health_status: 'HEALTHY',
        eps_1m: 5,
        eps_5m: 5,
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
        open_schema_field_drift_count: 2,
      },
      {
        stream_id: 2,
        stream_name: 'warning-stream',
        connector_id: 10,
        source_id: 2,
        enabled: true,
        status: 'DEGRADED',
        health_status: 'DEGRADED',
        eps_1m: 3,
        eps_5m: 3,
        success_rate_5m: 88,
        failure_rate_5m: 12,
        avg_latency_ms: 12,
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
        stream_name: 'critical-stream',
        connector_id: 11,
        source_id: 3,
        enabled: true,
        status: 'ERROR',
        health_status: 'ERROR',
        eps_1m: 2,
        eps_5m: 2,
        success_rate_5m: 40,
        failure_rate_5m: 60,
        avg_latency_ms: 40,
        route_count: 1,
        healthy_route_count: 0,
        failed_route_count: 1,
        last_success_at: null,
        last_error_at: '2026-01-01T00:00:00Z',
        last_error_message: 'Destination Error',
        checkpoint_updated_at: null,
        checkpoint_lag_seconds: null,
      },
      {
        stream_id: 4,
        stream_name: 'idle-stream',
        connector_id: 10,
        source_id: 4,
        enabled: true,
        status: 'IDLE',
        health_status: 'IDLE',
        eps_1m: 0,
        eps_5m: 0,
        success_rate_5m: 0,
        failure_rate_5m: 0,
        avg_latency_ms: 0,
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
        severity: 'critical',
        scope: 'stream',
        stream_id: 3,
        route_id: null,
        destination_id: null,
        title: 'Delivery error',
        message: 'Destination Error',
        last_seen_at: null,
      },
    ],
    updated_at: '2026-01-01T00:00:00Z',
  })),
}))

import { fetchStreamsListResult } from '../../api/gdcStreams'

describe('StreamsConsole operations UX', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  beforeEach(() => {
    vi.mocked(fetchStreamsListResult).mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        {
          id: 1,
          name: 'healthy-stream',
          connector_id: 10,
          stream_type: 'HTTP_API_POLLING',
          status: 'RUNNING',
        },
        {
          id: 2,
          name: 'warning-stream',
          connector_id: 10,
          stream_type: 'HTTP_API_POLLING',
          status: 'RATE_LIMITED_SOURCE',
        },
        {
          id: 3,
          name: 'critical-stream',
          connector_id: 11,
          stream_type: 'HTTP_API_POLLING',
          status: 'ERROR',
        },
        {
          id: 4,
          name: 'idle-stream',
          connector_id: 10,
          stream_type: 'HTTP_API_POLLING',
          status: 'IDLE',
        },
      ],
    })
  })

  it('renders operations summary without the legacy problem streams panel', async () => {
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('streams-operations-summary')).toBeInTheDocument()
    expect(screen.queryByTestId('streams-problem-panel')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('streams-ops-summary-healthy')).toHaveTextContent('1')
      expect(screen.getByTestId('streams-ops-summary-warning')).toHaveTextContent('1')
      expect(screen.getByTestId('streams-ops-summary-critical')).toHaveTextContent('1')
    })
  })

  it('filters streams via search input', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await screen.findByTestId('streams-search-input')
    await user.type(screen.getByTestId('streams-search-input'), 'critical-stream')
    await waitFor(() => {
      expect(screen.getByTestId('stream-group-row-Amazon Web Services')).toBeInTheDocument()
      expect(screen.queryByTestId('stream-group-row-Office365')).not.toBeInTheDocument()
    })
  })

  it('filters streams via issues-only quick filter', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await screen.findByTestId('streams-quick-filter-issues')
    await user.click(screen.getByTestId('streams-quick-filter-issues'))
    await waitFor(() => {
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
      expect(screen.getByTestId('stream-group-row-Amazon Web Services')).toBeInTheDocument()
    })
  })

  it('filters streams by source product group dropdown', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await screen.findByTestId('streams-group-filter')
    await user.selectOptions(screen.getByTestId('streams-group-filter'), 'Office365')
    await waitFor(() => {
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
      expect(screen.queryByTestId('stream-group-row-Amazon Web Services')).not.toBeInTheDocument()
    })
  })

  it('Case 5: filters streams by connector query param (id)', async () => {
    render(
      <MemoryRouter initialEntries={['/streams?connector=10']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('streams-filter-chips')).toBeInTheDocument()
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
      expect(screen.queryByTestId('stream-group-row-Amazon Web Services')).not.toBeInTheDocument()
    })
  })

  it('Case 5b: filters streams by connector name slug', async () => {
    render(
      <MemoryRouter initialEntries={['/streams?connector=office365-connector']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('streams-filter-chips')).toBeInTheDocument()
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
      expect(screen.queryByTestId('stream-group-row-Amazon Web Services')).not.toBeInTheDocument()
    })
  })

  it('shows filter empty state message', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await screen.findByTestId('streams-search-input')
    await user.type(screen.getByTestId('streams-search-input'), 'no-such-stream-xyz')
    await waitFor(() => {
      expect(screen.getByTestId('streams-empty-state')).toHaveTextContent('No streams match your filters.')
    })
  })

  it('highlights and expands group from dashboard expand_group deep link', async () => {
    render(
      <MemoryRouter initialEntries={['/streams?expand_group=Office365']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    const groupRow = await screen.findByTestId('stream-group-row-Office365')
    expect(groupRow.className).toMatch(/ring-violet-500/)
    expect(await screen.findByTestId('stream-group-child-row-1')).toBeInTheDocument()
  })

  it('filters to no-data streams from ?filter=no-data and selects health chip', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams?filter=no-data']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('health-summary-no-data')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('streams-operational-filter-chip-no-data')).toBeInTheDocument()
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
      expect(screen.queryByTestId('stream-group-row-Amazon Web Services')).not.toBeInTheDocument()
    })
    await user.click(screen.getByTestId('stream-group-row-Office365'))
    expect(await screen.findByTestId('stream-group-child-row-4')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-2')).not.toBeInTheDocument()
  })

  it('filters to low-volume streams from ?filter=low-volume', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams?filter=low-volume']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('health-summary-low-volume')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('streams-operational-filter-chip-low-volume')).toBeInTheDocument()
    })
    await user.click(await screen.findByTestId('stream-group-row-Office365'))
    expect(await screen.findByTestId('stream-group-child-row-2')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-3')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-4')).not.toBeInTheDocument()
  })

  it('filters to confirmed schema-drift streams from ?filter=schema-drift', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams?filter=schema-drift']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('health-summary-schema-drift')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('streams-operational-filter-chip-schema-drift')).toBeInTheDocument()
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
      expect(screen.queryByTestId('stream-group-row-Amazon Web Services')).not.toBeInTheDocument()
    })
    await user.click(screen.getByTestId('stream-group-row-Office365'))
    expect(await screen.findByTestId('stream-group-child-row-1')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-4')).not.toBeInTheDocument()
    expect(screen.getByTitle('Open Runtime: healthy-stream')).toHaveAttribute(
      'href',
      '/streams/1/runtime?tab=schema',
    )
  })

  it('keeps expand_group working together with operational filter', async () => {
    render(
      <MemoryRouter initialEntries={['/streams?filter=no-data&expand_group=Office365']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    const groupRow = await screen.findByTestId('stream-group-row-Office365')
    expect(groupRow.className).toMatch(/ring-violet-500/)
    expect(await screen.findByTestId('stream-group-child-row-4')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-group-child-row-1')).not.toBeInTheDocument()
  })

  it('clears operational filter chip and restores full list', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams?filter=low-volume']}>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await screen.findByTestId('streams-clear-operational-filter')
    await user.click(screen.getByTestId('streams-clear-operational-filter'))
    await waitFor(() => {
      expect(screen.queryByTestId('streams-operational-filter-chip-low-volume')).not.toBeInTheDocument()
      expect(screen.getByTestId('stream-group-row-Office365')).toBeInTheDocument()
      expect(screen.getByTestId('stream-group-row-Amazon Web Services')).toBeInTheDocument()
    })
  })

  it('shows issue cause labels when a group is expanded', async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )

    await user.click(await screen.findByTestId('stream-group-row-Amazon Web Services'))
    const issuesCell = await screen.findByTestId('stream-row-issues-3')
    await waitFor(() => {
      expect(issuesCell).toHaveTextContent('Destination Error')
    })
  })

  it('reloads operational snapshot when time range changes', async () => {
    const user = userEvent.setup()
    const operationalSnapshot = await import('../../api/operationalSnapshot')
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )
    await screen.findByTestId('streams-time-range')
    const callsBefore = vi.mocked(operationalSnapshot.getOperationalSnapshot).mock.calls.length
    await user.selectOptions(screen.getByTestId('streams-time-range'), '24h')
    await waitFor(() => {
      expect(vi.mocked(operationalSnapshot.getOperationalSnapshot).mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })

  it('exposes auto refresh control', async () => {
    render(
      <MemoryRouter>
        <StreamsConsole />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('streams-auto-refresh')).toBeInTheDocument()
    expect(screen.getByTestId('streams-auto-refresh')).toHaveDisplayValue('Off')
  })
})
