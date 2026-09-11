import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyFailoverRoutesToWizardDrafts,
  persistWizardFailover,
} from './wizard-failover-persist'
import { createFailoverRoute, fetchStreamFailoverRoutes, patchFailoverRoute } from '../../../api/gdcFailoverRouting'
import { DEFAULT_ROUTE_PROCESSING_INHERIT, type WizardRouteDraft } from './wizard-state'
import type { FailoverRoute } from '../../../api/gdcFailoverRouting'

vi.mock('../../../api/gdcFailoverRouting', () => ({
  fetchStreamFailoverRoutes: vi.fn(),
  createFailoverRoute: vi.fn(),
  patchFailoverRoute: vi.fn(),
}))

function draft(over: Partial<WizardRouteDraft> & { key: string; destinationId: number }): WizardRouteDraft {
  return {
    enabled: true,
    failurePolicy: 'LOG_AND_CONTINUE',
    rateLimitJson: {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    ...over,
  }
}

function route(over: Partial<FailoverRoute> & Pick<FailoverRoute, 'id' | 'primary_destination_id' | 'secondary_destination_id'>): FailoverRoute {
  return {
    stream_id: 7,
    primary_destination_name: null,
    secondary_destination_name: null,
    enabled: true,
    policy: 'ACTIVE_STANDBY',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('applyFailoverRoutesToWizardDrafts', () => {
  it('restores enabled failover onto the matching primary destination draft', () => {
    const drafts = [
      draft({ key: 'route-1', destinationId: 10 }),
      draft({ key: 'route-2', destinationId: 20 }),
    ]
    const next = applyFailoverRoutesToWizardDrafts(drafts, [
      route({ id: 88, primary_destination_id: 10, secondary_destination_id: 99, enabled: true }),
    ])
    expect(next[0]?.failover).toEqual({
      id: 88,
      enabled: true,
      secondaryDestinationId: 99,
    })
    expect(next[1]?.failover).toBeUndefined()
  })
})

describe('persistWizardFailover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not call create when failover is unset (disabled compatibility)', async () => {
    vi.mocked(fetchStreamFailoverRoutes).mockResolvedValue({ stream_id: 7, routes: [], route_count: 0 })
    const result = await persistWizardFailover(7, [draft({ key: 'route-1', destinationId: 10 })])
    expect(result).toEqual({ saved: true, routesUpdated: 0, errors: [] })
    expect(createFailoverRoute).not.toHaveBeenCalled()
    expect(patchFailoverRoute).not.toHaveBeenCalled()
  })

  it('creates an enabled Active/Standby binding', async () => {
    vi.mocked(fetchStreamFailoverRoutes).mockResolvedValue({ stream_id: 7, routes: [], route_count: 0 })
    vi.mocked(createFailoverRoute).mockResolvedValue({
      route: route({ id: 5, primary_destination_id: 10, secondary_destination_id: 20 }),
    })
    const result = await persistWizardFailover(7, [
      draft({
        key: 'route-1',
        destinationId: 10,
        failover: { enabled: true, secondaryDestinationId: 20 },
      }),
    ])
    expect(result.saved).toBe(true)
    expect(result.routesUpdated).toBe(1)
    expect(createFailoverRoute).toHaveBeenCalledWith(7, {
      primary_destination_id: 10,
      secondary_destination_id: 20,
      enabled: true,
    })
  })

  it('patches an existing binding when standby or enabled changes', async () => {
    vi.mocked(fetchStreamFailoverRoutes).mockResolvedValue({
      stream_id: 7,
      route_count: 1,
      routes: [route({ id: 5, primary_destination_id: 10, secondary_destination_id: 20, enabled: false })],
    })
    vi.mocked(patchFailoverRoute).mockResolvedValue({
      route: route({ id: 5, primary_destination_id: 10, secondary_destination_id: 30 }),
    })
    const result = await persistWizardFailover(7, [
      draft({
        key: 'route-1',
        destinationId: 10,
        failover: { id: 5, enabled: true, secondaryDestinationId: 30 },
      }),
    ])
    expect(result.saved).toBe(true)
    expect(patchFailoverRoute).toHaveBeenCalledWith(7, 5, {
      primary_destination_id: 10,
      secondary_destination_id: 30,
      enabled: true,
    })
    expect(createFailoverRoute).not.toHaveBeenCalled()
  })

  it('disables an existing binding without creating a new one', async () => {
    vi.mocked(fetchStreamFailoverRoutes).mockResolvedValue({
      stream_id: 7,
      route_count: 1,
      routes: [route({ id: 5, primary_destination_id: 10, secondary_destination_id: 20, enabled: true })],
    })
    vi.mocked(patchFailoverRoute).mockResolvedValue({
      route: route({ id: 5, primary_destination_id: 10, secondary_destination_id: 20, enabled: false }),
    })
    const result = await persistWizardFailover(7, [
      draft({
        key: 'route-1',
        destinationId: 10,
        failover: { id: 5, enabled: false, secondaryDestinationId: 20 },
      }),
    ])
    expect(result.saved).toBe(true)
    expect(patchFailoverRoute).toHaveBeenCalledWith(7, 5, { enabled: false })
    expect(createFailoverRoute).not.toHaveBeenCalled()
  })
})
