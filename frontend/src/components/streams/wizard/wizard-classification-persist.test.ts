import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRouteClassificationOverrideFromGlobal,
  buildRouteClassificationWantedRules,
  loadWizardRouteClassification,
  persistWizardRouteClassification,
  routeClassificationOverrideRulesReady,
} from './wizard-classification-persist'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'
import { projectRouteProcessingStatusFromDeployIntent } from './wizard-deploy-projection'
import { buildUnionSchema } from '../../../utils/unionSchema'
import { attachSensitiveSuggestions } from '../../../utils/unionSchemaSensitiveSuggestions'

vi.mock('../../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationRules: vi.fn(async () => ({
    route_id: 1,
    stream_id: 1,
    rules: [],
    rule_count: 0,
  })),
  createRouteClassificationRule: vi.fn(async () => ({
    rule: {
      id: 21,
      route_id: 102,
      stream_id: 1,
      name: 'Wizard: personal data classification',
      enabled: true,
      condition_json: { sensitivity_class: 'pii' },
      classification_level: 'CONFIDENTIAL',
      created_at: '',
      updated_at: '',
    },
  })),
  patchRouteClassificationRule: vi.fn(async () => ({ rule: { id: 21 } })),
  deleteRouteClassificationRule: vi.fn(async () => undefined),
}))

import {
  createRouteClassificationRule,
  deleteRouteClassificationRule,
  fetchRouteClassificationRules,
} from '../../../api/gdcRouteClassification'

describe('wizard route classification source of truth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds wanted route classification rules from override drafts', () => {
    const wanted = buildRouteClassificationWantedRules({
      rules: [
        {
          key: 'r1',
          name: 'Wizard: personal data classification',
          sensitivityClass: 'pii',
          classificationLevel: 'RESTRICTED',
          enabled: true,
        },
        {
          key: 'r2',
          name: 'ignored',
          sensitivityClass: 'pii',
          classificationLevel: 'INTERNAL',
          enabled: true,
        },
      ],
    })
    expect(wanted).toEqual([
      {
        name: 'Wizard: personal data classification',
        sensitivityClass: 'pii',
        classificationLevel: 'RESTRICTED',
      },
    ])
  })

  it('does not seed classification rules from backend non-sensitive fields', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.status',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
      },
    ]
    const schema = attachSensitiveSuggestions(buildUnionSchema([{ status: 'ok' }]), [])
    const override = buildRouteClassificationOverrideFromGlobal(state.dataProtection, schema)
    expect(override.rules).toEqual([])
  })

  it('seeds route rules from shared data-protection intents', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.email',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
      },
    ]
    const override = buildRouteClassificationOverrideFromGlobal(state.dataProtection)
    expect(override.rules).toEqual([
      expect.objectContaining({
        sensitivityClass: 'pii',
        classificationLevel: 'CONFIDENTIAL',
        enabled: true,
      }),
    ])
  })

  it('persists Override routes to classification-rules API and clears Inherit', async () => {
    const state = buildInitialState()
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
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: false, policy: true },
        overrides: {
          classification: {
            rules: [
              {
                key: 'r1',
                name: 'Wizard: personal data classification',
                sensitivityClass: 'pii',
                classificationLevel: 'RESTRICTED',
                enabled: true,
              },
            ],
          },
        },
      },
    ]

    const result = await persistWizardRouteClassification(state, [101, 102])

    expect(result.saved).toBe(true)
    expect(result.routesUpdated).toBe(2)
    expect(createRouteClassificationRule).toHaveBeenCalledWith(
      102,
      expect.objectContaining({
        name: 'Wizard: personal data classification',
        condition_json: { sensitivity_class: 'pii' },
        classification_level: 'RESTRICTED',
      }),
    )
    expect(createRouteClassificationRule).not.toHaveBeenCalledWith(101, expect.anything())
  })

  it('deletes route classification rules when switching back to Inherit', async () => {
    vi.mocked(fetchRouteClassificationRules).mockResolvedValueOnce({
      route_id: 101,
      stream_id: 1,
      rule_count: 1,
      rules: [
        {
          id: 9,
          route_id: 101,
          stream_id: 1,
          name: 'Wizard: personal data classification',
          enabled: true,
          condition_json: { sensitivity_class: 'pii' },
          classification_level: 'RESTRICTED',
          created_at: '',
          updated_at: '',
        },
      ],
    })
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'route-101',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
    ]

    await persistWizardRouteClassification(state, [101])
    expect(deleteRouteClassificationRule).toHaveBeenCalledWith(101, 9)
  })

  it('restores classification rule bundle on edit hydrate', async () => {
    vi.mocked(fetchRouteClassificationRules).mockResolvedValueOnce({
      route_id: 42,
      stream_id: 1,
      rule_count: 1,
      rules: [
        {
          id: 3,
          route_id: 42,
          stream_id: 1,
          name: 'Wizard: personal data classification',
          enabled: true,
          condition_json: { sensitivity_class: 'pii' },
          classification_level: 'RESTRICTED',
          created_at: '',
          updated_at: '',
        },
      ],
    })
    const drafts = await loadWizardRouteClassification([
      {
        key: 'route-42',
        destinationId: 7,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
    ])
    expect(drafts[0]?.inherit.classification).toBe(false)
    expect(drafts[0]?.overrides?.classification?.rules).toEqual([
      expect.objectContaining({
        sensitivityClass: 'pii',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      }),
    ])
  })

  it('projects classification rule override as route_classification, not intent_only', () => {
    const state = buildInitialState()
    const draft = {
      key: 'route-b',
      destinationId: 20,
      enabled: true,
      failurePolicy: 'LOG_AND_CONTINUE' as const,
      rateLimitJson: {},
      inherit: { transform: true, protection: true, classification: false, policy: true },
      overrides: {
        classification: {
          rules: [
            {
              key: 'r1',
              name: 'Wizard: personal data classification',
              sensitivityClass: 'pii' as const,
              classificationLevel: 'RESTRICTED' as const,
              enabled: true,
            },
          ],
        },
      },
    }
    expect(routeClassificationOverrideRulesReady(draft)).toBe(true)
    const projection = projectRouteProcessingStatusFromDeployIntent(draft, state.dataProtection)
    expect(projection.concerns.classification.persistKind).toBe('route_classification')
    expect(projection.concerns.classification.persistKind).not.toBe('intent_only')
  })
})
