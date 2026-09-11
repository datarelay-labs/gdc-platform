import { runSensitiveDetectionPreview, type SensitiveSuggestion } from '../api/gdcRuntimePreview'
import type { UnionSchema, UnionSchemaField } from './unionSchema'

export function unionSchemaHasSensitiveSuggestions(schema: UnionSchema | null | undefined): boolean {
  return schema?.sensitive_suggestions_applied === true
}

export function attachSensitiveSuggestions(
  schema: UnionSchema,
  suggestions: readonly SensitiveSuggestion[],
): UnionSchema {
  const byPath = new Map(suggestions.map((row) => [row.field_path, row]))
  const fields: UnionSchemaField[] = schema.fields.map((field) => {
    const hit = byPath.get(field.field_path)
    if (!hit) {
      return {
        ...field,
        suggested_sensitive_type: null,
        sensitivity_class: null,
        detection_source: null,
        detection_method: null,
      }
    }
    return {
      ...field,
      suggested_sensitive_type: hit.suggested_sensitive_type,
      sensitivity_class: hit.sensitivity_class,
      detection_source: hit.detection_source,
      detection_method: hit.detection_method,
    }
  })
  return {
    ...schema,
    fields,
    sensitive_suggestions_applied: true,
  }
}

export async function enrichUnionSchemaWithSensitiveSuggestions(
  schema: UnionSchema,
  events: ReadonlyArray<Record<string, unknown>>,
): Promise<UnionSchema> {
  if (unionSchemaHasSensitiveSuggestions(schema)) return schema
  try {
    const response = await runSensitiveDetectionPreview({ events: [...events] })
    return attachSensitiveSuggestions(schema, response.suggestions)
  } catch {
    return {
      ...schema,
      sensitive_suggestions_applied: true,
    }
  }
}
