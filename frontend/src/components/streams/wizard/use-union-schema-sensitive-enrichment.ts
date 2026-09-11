import { useEffect } from 'react'
import type { UnionSchema } from '../../../utils/unionSchema'
import {
  enrichUnionSchemaWithSensitiveSuggestions,
  unionSchemaHasSensitiveSuggestions,
} from '../../../utils/unionSchemaSensitiveSuggestions'

export function useUnionSchemaSensitiveEnrichment(
  unionSchema: UnionSchema | null | undefined,
  extractedEvents: ReadonlyArray<Record<string, unknown>>,
  applySchema: (schema: UnionSchema) => void,
): void {
  useEffect(() => {
    if (!unionSchema?.fields.length || unionSchemaHasSensitiveSuggestions(unionSchema)) return
    let cancelled = false
    void enrichUnionSchemaWithSensitiveSuggestions(unionSchema, extractedEvents).then((enriched) => {
      if (cancelled) return
      applySchema(enriched)
    })
    return () => {
      cancelled = true
    }
  }, [unionSchema, extractedEvents, applySchema])
}
