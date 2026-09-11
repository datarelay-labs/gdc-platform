import { describe, expect, it, vi } from 'vitest'
import { buildUnionSchema } from './unionSchema'
import {
  attachSensitiveSuggestions,
  enrichUnionSchemaWithSensitiveSuggestions,
} from './unionSchemaSensitiveSuggestions'

vi.mock('../api/gdcRuntimePreview', () => ({
  runSensitiveDetectionPreview: vi.fn(async () => ({
    suggestions: [
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
    suggestion_count: 3,
    auto_protection_applied: false,
  })),
}))

describe('unionSchemaSensitiveSuggestions', () => {
  it('attaches backend suggestions without creating protection actions', () => {
    const schema = buildUnionSchema([
      { email: 'a@test.com', credit_card: '4111', api_key: 'sk', status: 'ok' },
    ])
    const enriched = attachSensitiveSuggestions(schema, [
      {
        field_path: '$.email',
        suggested_sensitive_type: 'Likely Email',
        sensitivity_class: 'pii',
        detection_method: 'field_name',
        detection_source: 'sensitive_detection_engine',
      },
    ])
    const email = enriched.fields.find((f) => f.field_path === '$.email')
    const status = enriched.fields.find((f) => f.field_path === '$.status')
    expect(email?.suggested_sensitive_type).toBe('Likely Email')
    expect(status?.suggested_sensitive_type).toBeNull()
    expect(enriched.sensitive_suggestions_applied).toBe(true)
    expect(JSON.stringify(enriched)).not.toMatch(/mask|tokenize|drop_field|auto_protect/i)
  })

  it('enriches via backend preview API', async () => {
    const schema = buildUnionSchema([
      { email: 'a@test.com', credit_card: '4111', api_key: 'sk', status: 'ok' },
    ])
    const enriched = await enrichUnionSchemaWithSensitiveSuggestions(schema, schema.fields.length ? [{ email: 'a@test.com' }] : [])
    expect(enriched.fields.find((f) => f.field_path === '$.email')?.suggested_sensitive_type).toBe('Likely Email')
    expect(enriched.fields.find((f) => f.field_path === '$.credit_card')?.suggested_sensitive_type).toBe(
      'Likely Credit Card',
    )
    expect(enriched.fields.find((f) => f.field_path === '$.api_key')?.suggested_sensitive_type).toBe('Likely API Key')
    expect(enriched.fields.find((f) => f.field_path === '$.status')?.suggested_sensitive_type).toBeNull()
  })
})
