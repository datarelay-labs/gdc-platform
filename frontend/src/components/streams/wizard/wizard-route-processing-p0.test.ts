import { describe, expect, it } from 'vitest'
import {
  buildRouteDraftKeyToIdMap,
  buildStreamGovernancePayload,
} from './wizard-governance-persist'
import { parseWizardDraftV2, saveWizardDraft, WIZARD_DRAFT_KEY_V2 } from './wizard-draft-migration'
import {
  buildInitialState,
  computeWizardRouteProcessingStatuses,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  normalizeWizardDestinations,
} from './wizard-state'

function threeRouteState() {
  const state = buildInitialState()
  state.dataPolicy.defaultClassification = 'INTERNAL'
  state.dataPolicy.restrictedResponse = 'quarantine'
  state.dataPolicy.confidentialResponse = 'continue'
  state.destinations.routeDrafts = [
    {
      key: 'route-a',
      destinationId: 10,
      enabled: true,
      failurePolicy: 'LOG_AND_CONTINUE',
      rateLimitJson: {},
      inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    },
    {
      key: 'route-b',
      destinationId: 20,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: { per_second: 8 },
      inherit: { transform: true, protection: false, classification: true, policy: true },
    },
    {
      key: 'route-c',
      destinationId: 30,
      enabled: true,
      failurePolicy: 'LOG_AND_CONTINUE',
      rateLimitJson: {},
      inherit: { transform: true, protection: true, classification: false, policy: false },
      overrides: { policy: { deliveryBehavior: 'quarantine' } },
    },
  ]
  state.dataProtection.routeClassificationOverrides = [
    {
      key: 'c1',
      routeDraftKey: 'route-c',
      classificationLevel: 'RESTRICTED',
      enabled: true,
    },
  ]
  return state
}

describe('P0-1 route processing inherit / override / reload', () => {
  it('computes Inherited, Overridden, and Mixed statuses for 3 routes on one stream', () => {
    const state = threeRouteState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'route-b',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]

    const routeA = computeWizardRouteProcessingStatuses(state.destinations.routeDrafts[0]!, state.dataProtection)
    const routeB = computeWizardRouteProcessingStatuses(state.destinations.routeDrafts[1]!, state.dataProtection)
    const routeC = computeWizardRouteProcessingStatuses(state.destinations.routeDrafts[2]!, state.dataProtection)

    expect(routeA).toEqual({
      transform: 'Inherited',
      protection: 'Inherited',
      classification: 'Inherited',
      policy: 'Inherited',
    })
    expect(routeB).toEqual({
      transform: 'Inherited',
      protection: 'Mixed',
      classification: 'Inherited',
      policy: 'Inherited',
    })
    expect(routeC).toEqual({
      transform: 'Inherited',
      protection: 'Inherited',
      classification: 'Mixed',
      policy: 'Overridden',
    })
  })

  it('preserves inherit, classification floor, and policy override after save/reload', () => {
    const state = threeRouteState()
    saveWizardDraft(state, 'route_processing')
    const loaded = parseWizardDraftV2(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '')
    expect(loaded?.state.destinations.routeDrafts).toHaveLength(3)
    expect(loaded?.state.destinations.routeDrafts.map((d) => d.key)).toEqual(['route-a', 'route-b', 'route-c'])
    expect(loaded?.state.destinations.routeDrafts[0]?.inherit).toEqual(DEFAULT_ROUTE_PROCESSING_INHERIT)
    expect(loaded?.state.destinations.routeDrafts[1]?.inherit.protection).toBe(false)
    expect(loaded?.state.destinations.routeDrafts[2]?.inherit).toMatchObject({
      classification: false,
      policy: false,
    })
    expect(loaded?.state.destinations.routeDrafts[2]?.overrides?.policy?.deliveryBehavior).toBe('quarantine')
    expect(loaded?.state.dataProtection.routeClassificationOverrides).toEqual([
      expect.objectContaining({
        routeDraftKey: 'route-c',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      }),
    ])
    expect(loaded?.state.dataPolicy.restrictedResponse).toBe('quarantine')
    expect(loaded?.state.dataPolicy.defaultClassification).toBe('INTERNAL')
  })

  it('normalizes destinations without duplicating streams or dropping routes', () => {
    const state = threeRouteState()
    const normalized = normalizeWizardDestinations(state.destinations)
    expect(normalized.routeDrafts).toHaveLength(3)
    expect(new Set(normalized.routeDrafts.map((d) => d.destinationId)).size).toBe(3)
  })

  it('persists classification and policy-only overrides as separate governance records', () => {
    const state = threeRouteState()
    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, [101, 102, 103]),
      state.destinations.routeDrafts,
    )
    expect(payload.route_overrides).toEqual([
      {
        route_id: 103,
        classification_level: 'RESTRICTED',
        enabled: true,
      },
      {
        route_id: 103,
        delivery_behavior: 'quarantine',
        enabled: true,
      },
    ])
  })
})
