import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRouteDraftKeyToIdMap,
  buildStreamGovernancePayload,
  isDuplicateRouteClassificationOverride,
  isDuplicateRouteOverride,
  persistWizardStreamGovernance,
} from './wizard-governance-persist'
import { buildInitialState } from './wizard-state'

vi.mock('../../../api/gdcStreamGovernance', () => ({
  putStreamGovernance: vi.fn(async () => ({
    stream_id: 42,
    enabled: true,
    rules: [],
    route_overrides: [],
  })),
}))

import { putStreamGovernance } from '../../../api/gdcStreamGovernance'

describe('wizard-governance-persist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps routeDraftKey to route_id by draft order', () => {
    const map = buildRouteDraftKeyToIdMap(
      [
        { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
        { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
      ],
      [101, 102],
    )
    expect(map.get('r1')).toBe(101)
    expect(map.get('r2')).toBe(102)
  })

  it('detects duplicate field + route override', () => {
    const overrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize' as const,
        deliveryBehavior: 'continue' as const,
        enabled: true,
      },
    ]
    expect(isDuplicateRouteOverride(overrides, '$.email', 'r1')).toBe(true)
    expect(isDuplicateRouteOverride(overrides, '$.email', 'r2')).toBe(false)
    expect(isDuplicateRouteOverride(overrides, '$.email', 'r1', 'o1')).toBe(false)
  })

  it('builds PUT governance payload from intents and overrides', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
      {
        key: 'o2',
        fieldPath: '$.email',
        routeDraftKey: 'r2',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
      { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, [501, 502]),
    )

    expect(payload.enabled).toBe(true)
    expect(payload.rules).toHaveLength(1)
    expect(payload.rules[0]).toMatchObject({
      field_path: '$.email',
      default_protection_action: 'mask_partial',
      default_delivery_behavior: 'continue',
    })
    expect(payload.route_overrides).toEqual([
      {
        field_path: '$.email',
        route_id: 501,
        protection_action: 'tokenize',
        delivery_behavior: 'continue',
        enabled: true,
      },
      {
        field_path: '$.email',
        route_id: 502,
        protection_action: 'mask_full',
        delivery_behavior: 'continue',
        enabled: true,
      },
    ])
  })

  it('builds classification-only route overrides in governance payload', () => {
    const state = buildInitialState()
    state.dataProtection.routeClassificationOverrides = [
      {
        key: 'c1',
        routeDraftKey: 'r1',
        classificationLevel: 'INTERNAL',
        enabled: true,
      },
      {
        key: 'c2',
        routeDraftKey: 'r2',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
      { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, [701, 702]),
    )

    expect(payload.enabled).toBe(true)
    expect(payload.route_overrides).toEqual([
      { route_id: 701, classification_level: 'INTERNAL', enabled: true },
      { route_id: 702, classification_level: 'RESTRICTED', enabled: true },
    ])
  })

  it('emits policy-only delivery_behavior separately from classification override', () => {
    const state = buildInitialState()
    state.dataProtection.routeClassificationOverrides = [
      {
        key: 'c1',
        routeDraftKey: 'r1',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: false, policy: false },
        overrides: { policy: { deliveryBehavior: 'block' } },
      },
    ]

    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, [801]),
      state.destinations.routeDrafts,
    )

    expect(payload.route_overrides).toEqual([
      {
        route_id: 801,
        classification_level: 'RESTRICTED',
        enabled: true,
      },
      {
        route_id: 801,
        delivery_behavior: 'block',
        enabled: true,
      },
    ])
  })

  it('emits policy-only override without classification or protection', () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'quarantine' } },
      },
    ]

    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, [901]),
      state.destinations.routeDrafts,
    )

    expect(payload.route_overrides).toEqual([
      { route_id: 901, delivery_behavior: 'quarantine', enabled: true },
    ])
  })

  it('detects duplicate route classification override', () => {
    const overrides = [
      {
        key: 'c1',
        routeDraftKey: 'r1',
        classificationLevel: 'INTERNAL' as const,
        enabled: true,
      },
    ]
    expect(isDuplicateRouteClassificationOverride(overrides, 'r1')).toBe(true)
    expect(isDuplicateRouteClassificationOverride(overrides, 'r2')).toBe(false)
    expect(isDuplicateRouteClassificationOverride(overrides, 'r1', 'c1')).toBe(false)
  })

  it('persists governance via PUT after route mapping', async () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    const result = await persistWizardStreamGovernance(42, state, [900])

    expect(result.saved).toBe(true)
    expect(putStreamGovernance).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({ field_path: '$.email', default_protection_action: 'mask_partial' }),
        ]),
      }),
    )
  })

  it('skips PUT when no governance content', async () => {
    const state = buildInitialState()
    const result = await persistWizardStreamGovernance(42, state, [])
    expect(result.saved).toBe(true)
    expect(putStreamGovernance).not.toHaveBeenCalled()
  })
})
