import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDataProtectionPersistPreview,
  persistWizardDataProtectionIntents,
  protectionActionNeedsFieldRule,
  resolveWizardProtectionIntents,
} from './wizard-data-protection-persist'
import { buildInitialState } from './wizard-state'
import { buildUnionSchema } from '../../../utils/unionSchema'
import { attachSensitiveSuggestions } from '../../../utils/unionSchemaSensitiveSuggestions'

vi.mock('../../../api/gdcPolicy', () => ({
  createPolicyRule: vi.fn(async () => ({ rule: { id: 1 } })),
}))

vi.mock('../../../api/gdcClassification', () => ({
  createClassificationRule: vi.fn(async () => ({ rule: { id: 2 } })),
}))

vi.mock('../../../api/gdcProtection', () => ({
  createProtectionRulesDirect: vi.fn(async () => ({
    stream_id: 42,
    created: 1,
    updated: 0,
    skipped: [],
    rules: [],
  })),
  wizardProtectionActionToMode: (action: string) => {
    if (action === 'mask_partial') return 'partial_mask'
    if (action === 'mask_full') return 'full_mask'
    if (action === 'tokenize') return 'tokenization'
    if (action === 'hash') return 'hash'
    return 'partial_mask'
  },
}))

vi.mock('../../../api/gdcRuntimePreview', () => ({
  runEnrichmentExecPreview: vi.fn(async ({ mapped_event }: { mapped_event: Record<string, unknown> }) => ({
    final_event: mapped_event,
    warnings: [],
    message: 'ok',
  })),
  runTransformPreview: vi.fn(),
}))

import { createPolicyRule } from '../../../api/gdcPolicy'
import { createClassificationRule } from '../../../api/gdcClassification'
import { createProtectionRulesDirect } from '../../../api/gdcProtection'

describe('wizard-data-protection-persist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not flag enforcement incomplete for masking intents', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    const preview = buildDataProtectionPersistPreview(state.dataProtection)
    expect(preview.enforcementIncomplete).toBe(false)
    expect(preview.warnings.some((w) => w.includes('runtime detection'))).toBe(false)
  })

  it('does not flag enforcement incomplete for audit-only intents', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.user.email',
        protectionAction: 'audit',
        deliveryBehavior: 'continue',
      },
    ]
    const preview = buildDataProtectionPersistPreview(state.dataProtection)
    expect(preview.enforcementIncomplete).toBe(false)
  })

  it('persists policy, classification, and protection rules', async () => {
    const state = buildInitialState()
    state.mapping = [{ id: 'm1', outputField: 'email', sourceJsonPath: '$.user.email' }]
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' } }]
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'quarantine',
      },
      {
        key: 'b',
        detectedField: '$.token',
        protectionAction: 'mask_full',
        deliveryBehavior: 'block',
      },
    ]
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' }, token: 'secret' }]
    state.apiTest.unionSchema = {
      total_events: 1,
      sensitive_suggestions_applied: true,
      fields: [
        {
          field_path: '$.email',
          field_type: 'string',
          occurrence_count: 1,
          sample_values: ['a@b.c'],
          suggested_sensitive_type: 'Likely Email',
          sensitivity_class: 'pii',
          detection_source: 'sensitive_detection_engine',
          detection_method: 'field_name',
        },
        {
          field_path: '$.token',
          field_type: 'string',
          occurrence_count: 1,
          sample_values: ['secret'],
          suggested_sensitive_type: 'Likely Token',
          sensitivity_class: 'secret',
          detection_source: 'sensitive_detection_engine',
          detection_method: 'field_name',
        },
      ],
    }
    state.mapping = [
      { id: 'm1', outputField: 'email', sourceJsonPath: '$.user.email' },
      { id: 'm2', outputField: 'token', sourceJsonPath: '$.token' },
    ]

    const result = await persistWizardDataProtectionIntents(42, state)
    expect(result.saved).toBe(true)
    expect(result.policyRulesCreated).toBe(2)
    expect(result.classificationRulesCreated).toBe(2)
    expect(result.protectionRulesCreated).toBe(1)
    expect(createPolicyRule).toHaveBeenCalledTimes(2)
    expect(createClassificationRule).toHaveBeenCalledTimes(2)
    expect(createProtectionRulesDirect).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        origin: 'wizard',
        rules: expect.arrayContaining([
          expect.objectContaining({ field_path: '$.email', protection_mode: 'partial_mask' }),
        ]),
      }),
    )
    expect(result.enforcementIncomplete).toBe(false)
  })

  it('resolves mapping rename before persist', async () => {
    const state = buildInitialState()
    state.mapping = [{ id: 'm1', outputField: 'email', sourceJsonPath: '$.user.email' }]
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' } }]
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.user.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    const resolved = await resolveWizardProtectionIntents(state)
    expect(resolved.errors).toEqual([])
    expect(resolved.resolved[0]?.resolvedPath).toBe('$.email')
  })

  it('maps block delivery to quarantine policy action', async () => {
    const state = buildInitialState()
    state.apiTest.unionSchema = {
      total_events: 1,
      sensitive_suggestions_applied: true,
      fields: [
        {
          field_path: '$.secret',
          field_type: 'string',
          occurrence_count: 1,
          sample_values: ['x'],
          suggested_sensitive_type: 'Likely Secret',
          sensitivity_class: 'secret',
          detection_source: 'sensitive_detection_engine',
          detection_method: 'field_name',
        },
      ],
    }
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.secret',
        protectionAction: 'audit',
        deliveryBehavior: 'block',
      },
    ]
    await persistWizardDataProtectionIntents(7, state)
    expect(createPolicyRule).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        action_type: 'quarantine',
        condition_json: { sensitivity_class: 'secret' },
      }),
    )
  })

  it('does not persist class-scoped rules for backend non-sensitive fields', async () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ status: 'ok', email: 'a@b.c' }]
    state.apiTest.unionSchema = attachSensitiveSuggestions(buildUnionSchema(state.apiTest.extractedEvents), [
      {
        field_path: '$.email',
        suggested_sensitive_type: 'Likely Email',
        sensitivity_class: 'pii',
        detection_method: 'field_name',
        detection_source: 'sensitive_detection_engine',
      },
    ])
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.status',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'quarantine',
      },
    ]

    const preview = buildDataProtectionPersistPreview(state.dataProtection, state.apiTest.unionSchema)
    expect(preview.aggregated).toEqual([])
    const result = await persistWizardDataProtectionIntents(9, state)
    expect(result.saved).toBe(true)
    expect(createPolicyRule).not.toHaveBeenCalled()
    expect(createClassificationRule).not.toHaveBeenCalled()
    expect(createProtectionRulesDirect).not.toHaveBeenCalled()
  })

  it('skips persist when no intents configured', async () => {
    const result = await persistWizardDataProtectionIntents(1, buildInitialState())
    expect(result.saved).toBe(true)
    expect(createPolicyRule).not.toHaveBeenCalled()
    expect(createClassificationRule).not.toHaveBeenCalled()
    expect(createProtectionRulesDirect).not.toHaveBeenCalled()
  })

  it('reports path resolution errors', async () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.does_not_exist',
        protectionAction: 'hash',
        deliveryBehavior: 'continue',
      },
    ]
    const result = await persistWizardDataProtectionIntents(5, state)
    expect(result.saved).toBe(false)
    expect(result.errors.some((e) => e.includes('does_not_exist'))).toBe(true)
    expect(createProtectionRulesDirect).not.toHaveBeenCalled()
  })

  it('shows protection skip warnings from direct upsert response', async () => {
    vi.mocked(createProtectionRulesDirect).mockResolvedValueOnce({
      stream_id: 42,
      created: 0,
      updated: 0,
      skipped: [
        {
          field_path: '$.email',
          reason: '$.email already has a runtime protection rule. Wizard rule was skipped.',
          existing_rule_id: 99,
        },
      ],
      rules: [],
    })

    const state = buildInitialState()
    state.mapping = [{ id: 'm1', outputField: 'email', sourceJsonPath: '$.user.email' }]
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' } }]
    state.dataProtection.intents = [
      {
        key: 'a',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]

    const result = await persistWizardDataProtectionIntents(42, state)
    expect(result.saved).toBe(true)
    expect(result.protectionRulesCreated).toBe(0)
    expect(result.warnings).toContain(
      '$.email already has a runtime protection rule. Wizard rule was skipped.',
    )
  })

  it('identifies field-level protection actions', () => {
    expect(protectionActionNeedsFieldRule('audit')).toBe(false)
    expect(protectionActionNeedsFieldRule('mask_partial')).toBe(true)
  })
})
