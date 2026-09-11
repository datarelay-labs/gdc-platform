import { evaluateUnionFieldSuggestion } from './evaluateUnionFieldSuggestion'
import type { UnionSchemaField } from './unionSchema'

/** Union Schema Field Detail Panel — backend suggested type labels. */
export function suggestUnionFieldTypeLabel(field: UnionSchemaField | null | undefined): string {
  return evaluateUnionFieldSuggestion(field).suggestedType ?? '—'
}
