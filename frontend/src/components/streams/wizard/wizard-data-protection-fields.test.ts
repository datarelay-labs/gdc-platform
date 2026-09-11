import { describe, expect, it } from 'vitest'
import {
  collectWizardDetectedFieldCandidates,
  inferWizardSensitivityClass,
  suggestLikelySensitiveFieldsFromState,
} from './wizard-data-protection-fields'
import { buildInitialState } from './wizard-state'
import { buildUnionSchema } from '../../../utils/unionSchema'
import { attachSensitiveSuggestions } from '../../../utils/unionSchemaSensitiveSuggestions'

describe('wizard-data-protection-fields', () => {
  it('infers sensitivity class from backend union schema suggestions', () => {
    const schema = attachSensitiveSuggestions(buildUnionSchema([{ password: 'x', email: 'a@b.c' }]), [
      {
        field_path: '$.password',
        suggested_sensitive_type: 'Likely Password',
        sensitivity_class: 'secret',
        detection_method: 'field_name',
        detection_source: 'sensitive_detection_engine',
      },
      {
        field_path: '$.email',
        suggested_sensitive_type: 'Likely Email',
        sensitivity_class: 'pii',
        detection_method: 'field_name',
        detection_source: 'sensitive_detection_engine',
      },
    ])
    expect(inferWizardSensitivityClass('$.password', schema)).toBe('secret')
    expect(inferWizardSensitivityClass('$.api_key', schema)).toBe('pii')
    expect(inferWizardSensitivityClass('$.email', schema)).toBe('pii')
  })

  it('does not relabel backend non-sensitive fields as pii', () => {
    const schema = attachSensitiveSuggestions(buildUnionSchema([{ status: 'ok', email: 'a@b.c' }]), [
      {
        field_path: '$.email',
        suggested_sensitive_type: 'Likely Email',
        sensitivity_class: 'pii',
        detection_method: 'field_name',
        detection_source: 'sensitive_detection_engine',
      },
    ])
    expect(inferWizardSensitivityClass('$.status', schema)).toBeNull()
    expect(inferWizardSensitivityClass('$.email', schema)).toBe('pii')
  })

  it('uses legacy pii fallback only when backend has not evaluated the path', () => {
    expect(inferWizardSensitivityClass('$.email')).toBe('pii')
    const schema = buildUnionSchema([{ email: 'a@b.c' }])
    expect(schema.sensitive_suggestions_applied).toBeUndefined()
    expect(inferWizardSensitivityClass('$.email', schema)).toBe('pii')
  })

  it('collects candidates from mapped runtime event paths', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ email: 'a@b.c', token: 'x', id: '1' }]
    state.mapping = [{ id: 'm1', outputField: 'event_id', sourceJsonPath: '$.id' }]
    const candidates = collectWizardDetectedFieldCandidates(state)
    expect(candidates).toContain('$.email')
    expect(candidates).toContain('$.token')
    expect(candidates).toContain('$.event_id')
  })

  it('collects mapping rename output path after flatten', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' } }]
    state.mapping = [{ id: 'm1', outputField: 'email', sourceJsonPath: '$.user.email' }]
    const candidates = collectWizardDetectedFieldCandidates(state)
    expect(candidates).toContain('$.email')
    expect(candidates).not.toContain('$.user.email')
  })

  it('suggests likely sensitive fields only from backend union schema suggestions', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ email: 'a@b.c', id: '1', status: 'ok' }]
    state.apiTest.unionSchema = attachSensitiveSuggestions(
      buildUnionSchema([{ email: 'a@b.c', id: '1', status: 'ok' }]),
      [
        {
          field_path: '$.email',
          suggested_sensitive_type: 'Likely Email',
          sensitivity_class: 'pii',
          detection_method: 'field_name',
          detection_source: 'sensitive_detection_engine',
        },
      ],
    )
    const likely = suggestLikelySensitiveFieldsFromState(state)
    expect(likely).toContain('$.email')
    expect(likely).not.toContain('$.id')
    expect(likely).not.toContain('$.status')
  })

  it('does not suggest sensitive fields without backend suggestions', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ email: 'a@b.c', contact: 'user@example.com' }]
    state.apiTest.unionSchema = buildUnionSchema([{ email: 'a@b.c', contact: 'user@example.com' }])
    expect(suggestLikelySensitiveFieldsFromState(state)).toEqual([])
  })
})
