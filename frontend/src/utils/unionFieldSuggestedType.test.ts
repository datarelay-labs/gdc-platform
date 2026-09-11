import { describe, expect, it } from 'vitest'
import { suggestUnionFieldTypeLabel } from './unionFieldSuggestedType'
import type { UnionSchemaField } from './unionSchema'

function field(partial: Partial<UnionSchemaField> & Pick<UnionSchemaField, 'field_path'>): UnionSchemaField {
  return {
    field_type: 'string',
    occurrence_count: 1,
    sample_values: [],
    ...partial,
  }
}

describe('suggestUnionFieldTypeLabel', () => {
  it('maps backend email suggestions to Likely Email', () => {
    expect(
      suggestUnionFieldTypeLabel(
        field({ field_path: '$.email', suggested_sensitive_type: 'Likely Email', sensitivity_class: 'pii' }),
      ),
    ).toBe('Likely Email')
  })

  it('maps backend api key suggestions to Likely API Key', () => {
    expect(
      suggestUnionFieldTypeLabel(
        field({ field_path: '$.api_key', suggested_sensitive_type: 'Likely API Key', sensitivity_class: 'secret' }),
      ),
    ).toBe('Likely API Key')
  })

  it('maps backend credit card suggestions to Likely Credit Card', () => {
    expect(
      suggestUnionFieldTypeLabel(
        field({
          field_path: '$.credit_card',
          suggested_sensitive_type: 'Likely Credit Card',
          sensitivity_class: 'pii',
        }),
      ),
    ).toBe('Likely Credit Card')
  })

  it('returns em dash when backend suggestion is absent', () => {
    expect(suggestUnionFieldTypeLabel(field({ field_path: '$.email', sample_values: ['a@b.c'] }))).toBe('—')
    expect(suggestUnionFieldTypeLabel(field({ field_path: '$.status' }))).toBe('—')
    expect(suggestUnionFieldTypeLabel(field({ field_path: '$.id', sample_values: ['12345'] }))).toBe('—')
  })
})
