import { fetchStreamById, updateStream } from '../../../api/gdcStreams'
import type { UnionSchema } from '../../../utils/unionSchema'
import { enrichUnionSchemaWithSensitiveSuggestions } from '../../../utils/unionSchemaSensitiveSuggestions'

export type UnionSchemaPersistPayload = {
  total_events: number
  fields: UnionSchema['fields']
  snapshot_at: string
  sensitive_suggestions_applied?: boolean
}

export type UnionSchemaPersistResult = {
  saved: boolean
  errors: string[]
}

export function buildUnionSchemaPersistPayload(
  unionSchema: UnionSchema | null | undefined,
): UnionSchemaPersistPayload | null {
  if (!unionSchema?.fields?.length) return null
  return {
    total_events: unionSchema.total_events,
    fields: unionSchema.fields,
    snapshot_at: new Date().toISOString(),
    sensitive_suggestions_applied: unionSchema.sensitive_suggestions_applied === true,
  }
}

export async function persistWizardUnionSchema(
  streamId: number,
  unionSchema: UnionSchema | null | undefined,
  options?: {
    existingConfigJson?: Record<string, unknown> | null
    events?: ReadonlyArray<Record<string, unknown>>
  },
): Promise<UnionSchemaPersistResult> {
  let schema = unionSchema ?? null
  if (schema?.fields.length && options?.events?.length && schema.sensitive_suggestions_applied !== true) {
    schema = await enrichUnionSchemaWithSensitiveSuggestions(schema, options.events)
  }
  const payload = buildUnionSchemaPersistPayload(schema)
  if (payload == null) {
    return { saved: false, errors: [] }
  }

  let existing = options?.existingConfigJson
  if (existing === undefined) {
    const stream = await fetchStreamById(streamId)
    existing =
      stream?.config_json && typeof stream.config_json === 'object' && !Array.isArray(stream.config_json)
        ? (stream.config_json as Record<string, unknown>)
        : {}
  } else {
    existing = existing ?? {}
  }

  try {
    await updateStream(streamId, {
      config_json: {
        ...existing,
        union_schema: payload,
      },
    })
    return { saved: true, errors: [] }
  } catch (err) {
    return {
      saved: false,
      errors: [`union-schema: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}
