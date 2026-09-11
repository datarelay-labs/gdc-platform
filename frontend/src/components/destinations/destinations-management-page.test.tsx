import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DestinationsManagementPage } from './destinations-management-page'

vi.mock('./use-destinations-overview-data', () => ({
  useDestinationsOverviewData: vi.fn(() => ({
    rows: [
      {
        id: 9,
        name: 'MDS',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.1', port: 514 },
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 1,
        routes: [{ route_id: 1, stream_id: 1, stream_name: 'Stream A', route_enabled: true, route_status: 'ENABLED' }],
        created_at: null,
        updated_at: null,
        runtime: {
          connectedStreams: 1,
          connectedRoutes: 1,
          successRatePct: 99,
          currentEps: 1.2,
          hasDeliveryActivity: true,
          health: 'Healthy',
          recentIssues: [],
          metricsWindowLabel: '1h',
        },
      },
      {
        id: 10,
        name: 'WarnDest',
        destination_type: 'WEBHOOK_POST',
        config_json: { url: 'https://example.test/hook' },
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 1,
        routes: [{ route_id: 2, stream_id: 2, stream_name: 'Stream B', route_enabled: true, route_status: 'ENABLED' }],
        created_at: null,
        updated_at: null,
        runtime: {
          connectedStreams: 1,
          connectedRoutes: 1,
          successRatePct: 91,
          currentEps: 8,
          hasDeliveryActivity: true,
          health: 'Warning',
          recentIssues: ['Near capacity'],
          metricsWindowLabel: '1h',
        },
      },
    ],
    loading: false,
    runtimeLoading: false,
    error: null,
    runtimeError: null,
    refresh: vi.fn(),
  })),
}))

vi.mock('../../api/gdcDestinations', () => ({
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  deleteDestination: vi.fn(),
  previewTestDestination: vi.fn(),
  testDestination: vi.fn(async () => ({
    success: true,
    latency_ms: 3,
    message: 'ok',
    tested_at: '2026-05-09T12:00:00Z',
    detail: null,
  })),
}))

describe('DestinationsManagementPage', () => {
  it('renders Test delivery action for each destination', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    const row = await screen.findByText('MDS')
    const tr = row.closest('tr')
    expect(tr).toBeTruthy()
    const actionButtons = within(tr as HTMLElement).getAllByRole('button')
    await user.click(actionButtons[actionButtons.length - 1])
    expect(await screen.findByRole('button', { name: /test delivery/i })).toBeInTheDocument()
  })

  it('shows runtime KPI columns', async () => {
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Success Rate')).toBeInTheDocument()
    expect(screen.getByText('EPS (Current)')).toBeInTheDocument()
    expect(screen.getAllByText(/Healthy/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('99%').length).toBeGreaterThanOrEqual(1)
  })

  it('applies Warning health filter from ?filter=warning', async () => {
    render(
      <MemoryRouter initialEntries={['/destinations?filter=warning']}>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('destinations-health-filter')).toHaveValue('Warning')
    expect(screen.getByText('WarnDest')).toBeInTheDocument()
    expect(screen.queryByText('MDS')).not.toBeInTheDocument()
  })

  it('clears warning query filter when All Status is selected', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/destinations?filter=warning']}>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    const select = await screen.findByTestId('destinations-health-filter')
    expect(select).toHaveValue('Warning')
    await user.selectOptions(select, 'ALL')
    expect(select).toHaveValue('ALL')
    expect(await screen.findByText('MDS')).toBeInTheDocument()
    expect(screen.getByText('WarnDest')).toBeInTheDocument()
  })
})
