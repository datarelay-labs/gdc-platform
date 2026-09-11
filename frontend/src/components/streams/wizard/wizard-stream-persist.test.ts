import { beforeEach, describe, expect, it, vi } from 'vitest'
import { persistWizardStreamEdits } from './wizard-stream-persist'
import { persistWizardRouteProtection } from './wizard-route-protection-persist'
import { persistWizardRouteClassification } from './wizard-classification-persist'
import { persistWizardFailover } from './wizard-failover-persist'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'

vi.mock('../../../api/gdcRoutes', () => ({
  createRoute: vi.fn(),
  deleteRoute: vi.fn(),
  updateRoute: vi.fn(async () => ({ id: 101 })),
}))

vi.mock('../../../api/gdcRuntimeUi', () => ({
  saveStreamMappingUiConfigStrict: vi.fn(async () => undefined),
}))

vi.mock('../../../api/gdcStreams', () => ({
  fetchStreamById: vi.fn(async () => ({ id: 7, name: 'Edit', status: 'STOPPED', config_json: {} })),
  updateStream: vi.fn(async () => ({ id: 7, name: 'Edit', status: 'STOPPED' })),
}))

vi.mock('./wizard-data-protection-persist', () => ({
  persistWizardDataProtectionIntents: vi.fn(async () => ({
    saved: true,
    errors: [],
    warnings: [],
    enforcementIncomplete: false,
    policyRulesCreated: 0,
    classificationRulesCreated: 0,
    protectionRulesCreated: 0,
  })),
}))

vi.mock('./wizard-policy-persist', () => ({
  persistWizardSharedAndRoutePolicy: vi.fn(async () => ({
    saved: true,
    streamRulesUpserted: 0,
    routeRulesUpserted: 0,
    errors: [],
  })),
}))

vi.mock('./wizard-schema-drift-policy-persist', () => ({
  persistWizardSchemaDriftPolicy: vi.fn(async () => ({ saved: true, errors: [] })),
}))

vi.mock('./wizard-governance-persist', () => ({
  persistWizardStreamGovernance: vi.fn(async () => ({ saved: true, errors: [], warnings: [] })),
}))

vi.mock('./wizard-transform-persist', () => ({
  persistWizardRouteTransforms: vi.fn(async () => ({ saved: true, routesUpdated: 0, errors: [] })),
}))

vi.mock('./wizard-route-protection-persist', () => ({
  persistWizardRouteProtection: vi.fn(async () => ({ saved: true, routesUpdated: 2, errors: [] })),
}))

vi.mock('./wizard-classification-persist', () => ({
  persistWizardRouteClassification: vi.fn(async () => ({ saved: true, routesUpdated: 2, errors: [] })),
}))

vi.mock('./wizard-failover-persist', () => ({
  persistWizardFailover: vi.fn(async () => ({ saved: true, routesUpdated: 0, errors: [] })),
}))

describe('persistWizardStreamEdits route protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps Edit persist on persistWizardRouteProtection with resolved route IDs', async () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Edit Stream'
    state.destinations.routeDrafts = [
      {
        key: 'route-101',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
      {
        key: 'route-102',
        destinationId: 20,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: false, classification: true, policy: true },
        overrides: {
          protection: {
            intents: [
              {
                key: 'i1',
                detectedField: '$.email',
                protectionAction: 'mask_full',
                deliveryBehavior: 'continue',
              },
            ],
            unknownNormalFieldPolicy: 'pass_through',
            unknownSensitiveFieldPolicy: 'auto_protect',
          },
        },
      },
    ]

    const result = await persistWizardStreamEdits(7, state)

    expect(result.ok).toBe(true)
    expect(persistWizardRouteProtection).toHaveBeenCalledWith(state, [101, 102])
    expect(persistWizardRouteClassification).toHaveBeenCalledWith(state, [101, 102])
    expect(persistWizardFailover).toHaveBeenCalledWith(7, state.destinations.routeDrafts)
  })
})
