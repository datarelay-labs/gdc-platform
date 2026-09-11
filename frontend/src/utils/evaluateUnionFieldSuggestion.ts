import type { UnionSchemaField } from './unionSchema'

export type UnionFieldSuggestionCategory = 'pii' | 'secret' | 'security_metadata'

export type UnionFieldSuggestion = {
  sensitive: boolean
  category: UnionFieldSuggestionCategory | null
  suggestedType: string | null
}

function normalizeCategory(value: string | null | undefined): UnionFieldSuggestionCategory | null {
  if (value === 'pii' || value === 'secret' || value === 'security_metadata') return value
  return null
}

/** Display-only: reads backend Sensitive Detection results attached to a Union Schema field. */
export function evaluateUnionFieldSuggestion(field: UnionSchemaField | null | undefined): UnionFieldSuggestion {
  const suggestedType = field?.suggested_sensitive_type?.trim() || null
  if (!suggestedType) {
    return { sensitive: false, category: null, suggestedType: null }
  }
  return {
    sensitive: true,
    category: normalizeCategory(field?.sensitivity_class),
    suggestedType,
  }
}
