import { describe, expect, it } from 'vitest'
import { evaluateUnionFieldSuggestion } from './evaluateUnionFieldSuggestion'
import type { UnionSchemaField } from './unionSchema'

function field(partial: Partial<UnionSchemaField> & Pick<UnionSchemaField, 'field_path'>): UnionSchemaField {
  return {
    field_type: 'string',
    occurrence_count: 1,
    sample_values: [],
    ...partial,
  }
}

describe('evaluateUnionFieldSuggestion', () => {
  it('reads backend email suggestion', () => {
    const result = evaluateUnionFieldSuggestion(
      field({
        field_path: '$.email',
        suggested_sensitive_type: 'Likely Email',
        sensitivity_class: 'pii',
        detection_source: 'sensitive_detection_engine',
      }),
    )
    expect(result).toEqual({ sensitive: true, category: 'pii', suggestedType: 'Likely Email' })
  })

  it('reads backend api key suggestion', () => {
    const result = evaluateUnionFieldSuggestion(
      field({
        field_path: '$.api_key',
        suggested_sensitive_type: 'Likely API Key',
        sensitivity_class: 'secret',
      }),
    )
    expect(result).toEqual({ sensitive: true, category: 'secret', suggestedType: 'Likely API Key' })
  })

  it('does not invent sensitivity without backend suggestion', () => {
    expect(evaluateUnionFieldSuggestion(field({ field_path: '$.email', sample_values: ['a@b.c'] }))).toEqual({
      sensitive: false,
      category: null,
      suggestedType: null,
    })
    expect(evaluateUnionFieldSuggestion(field({ field_path: '$.api_key' }))).toEqual({
      sensitive: false,
      category: null,
      suggestedType: null,
    })
    expect(evaluateUnionFieldSuggestion(field({ field_path: '$.credit_card' }))).toEqual({
      sensitive: false,
      category: null,
      suggestedType: null,
    })
    expect(evaluateUnionFieldSuggestion(field({ field_path: '$.status' }))).toEqual({
      sensitive: false,
      category: null,
      suggestedType: null,
    })
  })
})
