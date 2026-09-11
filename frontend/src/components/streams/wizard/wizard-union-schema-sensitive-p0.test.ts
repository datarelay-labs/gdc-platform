import { describe, expect, it } from 'vitest'
import { buildUnionSchema } from '../../../utils/unionSchema'
import { attachSensitiveSuggestions } from '../../../utils/unionSchemaSensitiveSuggestions'
import { suggestLikelySensitiveFieldsFromState } from './wizard-data-protection-fields'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'

describe('P0-4 union schema sensitive source of truth', () => {
  it('shares one backend-suggested union schema across three routes without auto protection', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [
      {
        email: 'ops@example.com',
        credit_card: '4111111111111111',
        api_key: 'sk-test',
        status: 'ok',
      },
    ]
    state.apiTest.unionSchema = attachSensitiveSuggestions(
      buildUnionSchema(state.apiTest.extractedEvents),
      [
        {
          field_path: '$.email',
          suggested_sensitive_type: 'Likely Email',
          sensitivity_class: 'pii',
          detection_method: 'field_name',
          detection_source: 'sensitive_detection_engine',
        },
        {
          field_path: '$.credit_card',
          suggested_sensitive_type: 'Likely Credit Card',
          sensitivity_class: 'pii',
          detection_method: 'field_name',
          detection_source: 'sensitive_detection_engine',
        },
        {
          field_path: '$.api_key',
          suggested_sensitive_type: 'Likely API Key',
          sensitivity_class: 'secret',
          detection_method: 'field_name',
          detection_source: 'sensitive_detection_engine',
        },
      ],
    )
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
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT, protection: false },
        overrides: {
          protection: {
            intents: [
              {
                key: 'p1',
                detectedField: '$.email',
                protectionAction: 'mask_partial',
                deliveryBehavior: 'continue',
              },
            ],
            unknownNormalFieldPolicy: 'pass_through',
            unknownSensitiveFieldPolicy: 'auto_protect',
          },
        },
      },
      {
        key: 'route-c',
        destinationId: 30,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT, protection: false },
        overrides: {
          protection: {
            intents: [
              {
                key: 'p2',
                detectedField: '$.email',
                protectionAction: 'tokenize',
                deliveryBehavior: 'continue',
              },
            ],
            unknownNormalFieldPolicy: 'pass_through',
            unknownSensitiveFieldPolicy: 'auto_protect',
          },
        },
      },
    ]

    const likely = suggestLikelySensitiveFieldsFromState(state)
    expect(likely).toEqual(expect.arrayContaining(['$.email', '$.credit_card', '$.api_key']))
    expect(likely).not.toContain('$.status')
    expect(state.dataProtection.intents).toEqual([])
    expect(state.dataProtection.unknownNormalFieldPolicy).toBe('pass_through')

    const shared = state.apiTest.unionSchema
    expect(shared?.fields.find((f) => f.field_path === '$.email')?.suggested_sensitive_type).toBe('Likely Email')
    expect(state.destinations.routeDrafts).toHaveLength(3)
    expect(state.destinations.routeDrafts[1]?.overrides?.protection?.intents[0]?.protectionAction).toBe('mask_partial')
    expect(state.destinations.routeDrafts[2]?.overrides?.protection?.intents[0]?.protectionAction).toBe('tokenize')
    expect(JSON.stringify(shared)).not.toMatch(/"protectionAction"|mask_partial|tokenize/)
  })
})
