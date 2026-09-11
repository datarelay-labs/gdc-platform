import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamRouteProcessingOverview } from './stream-route-processing-overview'
import { ROUTE_PROCESSING_COPY } from './route-processing/route-processing-labels'

const fetchRoutesList = vi.fn()
const fetchDestinationsList = vi.fn()
const fetchGovernanceWorkspaceSnapshot = vi.fn()
const fetchRouteTransformEffective = vi.fn()
const fetchRouteProtectionEffective = vi.fn()
const fetchRouteClassificationEffective = vi.fn()
const fetchRoutePolicyEffective = vi.fn()
const fetchRouteMappingUiConfig = vi.fn()
const fetchRouteEnrichmentUiConfig = vi.fn()
const fetchRouteProtectionRules = vi.fn()
const fetchRouteClassificationRules = vi.fn()
const fetchRoutePolicyRules = vi.fn()

vi.mock('../../api/gdcRoutes', () => ({
  fetchRoutesList: (...args: unknown[]) => fetchRoutesList(...args),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))

vi.mock('../../api/gdcGovernanceWorkspaceSnapshot', () => ({
  fetchGovernanceWorkspaceSnapshot: (...args: unknown[]) => fetchGovernanceWorkspaceSnapshot(...args),
}))

vi.mock('../../api/gdcRouteTransform', () => ({
  fetchRouteMappingUiConfig: (...args: unknown[]) => fetchRouteMappingUiConfig(...args),
  fetchRouteEnrichmentUiConfig: (...args: unknown[]) => fetchRouteEnrichmentUiConfig(...args),
  fetchRouteTransformEffective: (...args: unknown[]) => fetchRouteTransformEffective(...args),
  saveRouteMappingUiConfig: vi.fn(),
  saveRouteEnrichmentUiConfig: vi.fn(),
}))

vi.mock('../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionEffective: (...args: unknown[]) => fetchRouteProtectionEffective(...args),
  fetchRouteProtectionRules: (...args: unknown[]) => fetchRouteProtectionRules(...args),
  patchRouteProtectionRule: vi.fn(),
}))

vi.mock('../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationEffective: (...args: unknown[]) => fetchRouteClassificationEffective(...args),
  fetchRouteClassificationRules: (...args: unknown[]) => fetchRouteClassificationRules(...args),
  patchRouteClassificationRule: vi.fn(),
}))

vi.mock('../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyEffective: (...args: unknown[]) => fetchRoutePolicyEffective(...args),
  fetchRoutePolicyRules: (...args: unknown[]) => fetchRoutePolicyRules(...args),
  patchRoutePolicyRule: vi.fn(),
}))

vi.mock('../../api/gdcRuntime', () => ({
  searchRuntimeDeliveryLogs: vi.fn(async () => ({ logs: [] })),
}))

vi.mock('../../utils/mappingSourceSample', () => ({
  loadMappingWorkspaceContext: vi.fn(async () => null),
}))

vi.mock('../mappings/mapping-workspace', () => ({
  MappingWorkspace: () => <div data-testid="mapping-workspace-stub" />,
}))

type ProcessingStatus = 'Inherited' | 'Overridden' | 'Mixed'

function inheritedEffective(routeId: number, extras: Record<string, unknown> = {}) {
  return {
    route_id: routeId,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    processing_status: 'Inherited' as const,
    message: 'ok',
    ...extras,
  }
}

function snapshotRoute(
  routeId: number,
  statuses: {
    transform?: ProcessingStatus
    protection?: ProcessingStatus
    classification?: ProcessingStatus
    policy?: ProcessingStatus
  } = {},
) {
  return {
    route_id: routeId,
    route_name: `Route ${routeId}`,
    transform: inheritedEffective(routeId, {
      mapping_source: 'stream',
      enrichment_source: 'stream',
      mapping_count: 1,
      enrichment_count: 0,
      processing_status: statuses.transform ?? 'Inherited',
    }),
    protection: inheritedEffective(routeId, {
      rule_count: 0,
      processing_status: statuses.protection ?? 'Inherited',
    }),
    classification: inheritedEffective(routeId, {
      persisted_source: statuses.classification === 'Overridden' ? 'route' : 'stream',
      fallback_used: statuses.classification !== 'Overridden',
      rule_count: statuses.classification === 'Overridden' ? 1 : 0,
      processing_status: statuses.classification ?? 'Inherited',
    }),
    policy: inheritedEffective(routeId, {
      persisted_source: statuses.policy === 'Mixed' ? 'mixed' : 'stream',
      rule_count: 0,
      processing_status: statuses.policy ?? 'Inherited',
    }),
  }
}

function mockDefaultSnapshot() {
  fetchGovernanceWorkspaceSnapshot.mockResolvedValue({
    stream_id: 10,
    route_count: 2,
    routes: [
      snapshotRoute(42, { classification: 'Overridden', policy: 'Mixed' }),
      snapshotRoute(43),
    ],
  })
}

function mockAllInheritedSnapshot() {
  fetchGovernanceWorkspaceSnapshot.mockResolvedValue({
    stream_id: 10,
    route_count: 2,
    routes: [snapshotRoute(42), snapshotRoute(43)],
  })
}

describe('StreamRouteProcessingOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRoutesList.mockResolvedValue([
      { id: 42, name: 'Route A', stream_id: 10, destination_id: 5, enabled: true },
      { id: 43, name: 'Route B', stream_id: 10, destination_id: 6, enabled: true },
      { id: 99, name: 'Other stream', stream_id: 20, destination_id: 5, enabled: true },
    ])
    fetchDestinationsList.mockResolvedValue([
      { id: 5, name: 'Dest A' },
      { id: 6, name: 'Dest B' },
    ])
    mockDefaultSnapshot()
    fetchRouteMappingUiConfig.mockResolvedValue({ inherit_stream_mapping: true, mapping: {} })
    fetchRouteEnrichmentUiConfig.mockResolvedValue({ inherit_stream_enrichment: true, enrichment: {} })
    fetchRouteProtectionRules.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      protection_enabled: true,
      rules: [],
      rule_count: 0,
    })
    fetchRouteClassificationRules.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      rules: [],
      rule_count: 0,
    })
    fetchRoutePolicyRules.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      rules: [],
      rule_count: 0,
    })
    fetchRouteTransformEffective.mockResolvedValue(null)
    fetchRouteProtectionEffective.mockResolvedValue(null)
    fetchRouteClassificationEffective.mockResolvedValue(null)
    fetchRoutePolicyEffective.mockResolvedValue(null)
  })

  it('renders shared processing, routes table, and route detail with override workspace', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('route-processing-overview')).toBeInTheDocument()
    expect(screen.getByTestId('stream-shared-processing-section')).toBeInTheDocument()
    expect(screen.getByTestId('stream-shared-processing-card-transform')).toBeInTheDocument()
    expect(screen.getByTestId('stream-shared-processing-card-data_protection')).toBeInTheDocument()
    expect(screen.getByTestId('stream-shared-processing-card-classification')).toBeInTheDocument()
    expect(screen.getByTestId('stream-shared-processing-card-policy')).toBeInTheDocument()
    expect(screen.queryByText('Global Processing')).not.toBeInTheDocument()
    expect(await screen.findByTestId('route-processing-row-42')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-row-43')).toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-row-99')).not.toBeInTheDocument()
    expect(screen.getByTestId('route-processing-mode-override')).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByTestId('route-processing-transform-section')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-open-route-edit')).toBeInTheDocument()
  })

  it('loads processing status from one workspace snapshot instead of per-route effective APIs', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    expect(fetchRouteTransformEffective).not.toHaveBeenCalled()
    expect(fetchRouteProtectionEffective).not.toHaveBeenCalled()
    expect(fetchRouteClassificationEffective).not.toHaveBeenCalled()
    expect(fetchRoutePolicyEffective).not.toHaveBeenCalled()
    const row42 = await screen.findByTestId('route-processing-row-42')
    expect(within(row42).getByText('Override')).toBeInTheDocument()
    expect(within(row42).getByText('Mixed')).toBeInTheDocument()
    expect(within(row42).getAllByText('Shared').length).toBeGreaterThan(0)
    expect(within(row42).getByText('Selected')).toBeInTheDocument()
    expect(screen.getByTestId('route-header-processing-statuses')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-destination')).toHaveTextContent('Destination: Dest A')
  })

  it('does not fan out effective calls when mounting 10 routes', async () => {
    const tenRoutes = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      name: `Route ${i + 1}`,
      stream_id: 10,
      destination_id: 5,
      enabled: true,
    }))
    fetchRoutesList.mockResolvedValue(tenRoutes)
    fetchGovernanceWorkspaceSnapshot.mockResolvedValue({
      stream_id: 10,
      route_count: 10,
      routes: tenRoutes.map((route) => snapshotRoute(route.id)),
    })
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('route-processing-row-100')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-row-109')).toBeInTheDocument()
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    expect(fetchRouteTransformEffective).toHaveBeenCalledTimes(0)
    expect(fetchRouteProtectionEffective).toHaveBeenCalledTimes(0)
    expect(fetchRouteClassificationEffective).toHaveBeenCalledTimes(0)
    expect(fetchRoutePolicyEffective).toHaveBeenCalledTimes(0)
    expect(fetchRouteMappingUiConfig).toHaveBeenCalledTimes(1)
    expect(fetchRouteMappingUiConfig).toHaveBeenCalledWith(100)
  })

  it('lazy-loads selected route detail and reuses snapshot cache on re-select', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    await screen.findByTestId('route-processing-row-42')
    await waitFor(() => {
      expect(fetchRouteMappingUiConfig).toHaveBeenCalledWith(42)
    })
    const mappingCallsAfterA = fetchRouteMappingUiConfig.mock.calls.length

    fireEvent.click(screen.getByTestId('route-processing-row-43'))
    await waitFor(() => {
      expect(screen.getByTestId('route-processing-mode-shared')).toHaveAttribute('aria-checked', 'true')
    })
    await waitFor(() => {
      expect(fetchRouteMappingUiConfig).toHaveBeenCalledWith(43)
    })
    expect(fetchRouteMappingUiConfig.mock.calls.length).toBeGreaterThan(mappingCallsAfterA)
    expect(fetchRouteTransformEffective).not.toHaveBeenCalled()
    expect(fetchRouteProtectionEffective).not.toHaveBeenCalled()
    expect(fetchRouteClassificationEffective).not.toHaveBeenCalled()
    expect(fetchRoutePolicyEffective).not.toHaveBeenCalled()
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)

    const mappingCallsAfterB = fetchRouteMappingUiConfig.mock.calls.length
    fireEvent.click(screen.getByTestId('route-processing-row-42'))
    await waitFor(() => {
      expect(screen.getByTestId('route-processing-mode-override')).toHaveAttribute('aria-checked', 'true')
    })
    await waitFor(() => {
      expect(fetchRouteMappingUiConfig.mock.calls.length).toBe(mappingCallsAfterB + 1)
    })
    expect(screen.getByTestId('route-detail-destination')).toHaveTextContent('Destination: Dest A')
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    expect(fetchRouteTransformEffective).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('route-processing-row-42'))
    expect(fetchRouteMappingUiConfig.mock.calls.length).toBe(mappingCallsAfterB + 1)
  })

  it('shows shared mode and all five stage tabs when all concerns are inherited', async () => {
    mockAllInheritedSnapshot()
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('route-processing-mode-shared')).toHaveAttribute('aria-checked', 'true')
    })
    expect(screen.getByTestId('stream-route-shared-mode-summary')).toHaveTextContent(ROUTE_PROCESSING_COPY.routeUsesShared)
    expect(screen.getByTestId('stream-route-detail-tab-transform')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-data_protection')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-classification')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-policy')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-delivery')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-transform-section')).toBeInTheDocument()
  })

  it('shows first-class classification and policy tabs when route has overrides', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('route-processing-transform-section')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('stream-route-detail-tab-data_protection'))
    expect(await screen.findByTestId('route-processing-data-protection-section')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-protection-section')).toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-classification-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-policy-section')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('stream-route-detail-tab-classification'))
    expect(await screen.findByTestId('route-processing-classification-section')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-inherit-classification')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('stream-route-detail-tab-policy'))
    expect(await screen.findByTestId('route-processing-policy-section')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-inherit-policy')).toBeInTheDocument()
    expect(fetchRouteClassificationEffective).not.toHaveBeenCalled()
    expect(fetchRoutePolicyEffective).not.toHaveBeenCalled()
    expect(fetchRouteProtectionEffective).not.toHaveBeenCalled()
  })

  it('keeps five stage tabs when selecting an all-inherited route', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTestId('route-processing-row-43'))
    await waitFor(() => {
      expect(screen.getByTestId('route-processing-mode-shared')).toHaveAttribute('aria-checked', 'true')
    })
    expect(screen.getByTestId('stream-route-detail-tab-transform')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-classification')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-policy')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-delivery')).toBeInTheDocument()
  })

  it('shows Unavailable in route list when workspace snapshot is missing', async () => {
    fetchGovernanceWorkspaceSnapshot.mockResolvedValue(null)
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    const row42 = await screen.findByTestId('route-processing-row-42')
    await waitFor(() => {
      expect(within(row42).getAllByText('Unavailable').length).toBeGreaterThan(0)
    })
    const transformCells = within(row42).getAllByTestId('route-processing-status-unavailable')
    expect(transformCells.length).toBeGreaterThanOrEqual(1)
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    const effectiveRouteIds = [
      ...fetchRouteTransformEffective.mock.calls,
      ...fetchRouteProtectionEffective.mock.calls,
      ...fetchRouteClassificationEffective.mock.calls,
      ...fetchRoutePolicyEffective.mock.calls,
    ].map((call) => call[0])
    expect(effectiveRouteIds.every((id) => id === 42)).toBe(true)
    expect(effectiveRouteIds.length).toBeLessThan(8)
  })
})
