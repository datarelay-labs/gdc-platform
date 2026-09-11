import { evaluateUnionFieldSuggestion } from './evaluateUnionFieldSuggestion'
import type { UnionSchemaField } from './unionSchema'

export function isUnionFieldSensitive(field: UnionSchemaField | null | undefined): boolean {
  return evaluateUnionFieldSuggestion(field).sensitive
}
