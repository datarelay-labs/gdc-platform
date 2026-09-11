/**
 * Union Schema — aggregate field inventory across all extracted sample events.
 * Used by Record Selection → Transform as the source-of-truth field tree.
 */

export type UnionSchemaField = {
  field_path: string
  field_type: string
  occurrence_count: number
  sample_values: unknown[]
  suggested_sensitive_type?: string | null
  sensitivity_class?: string | null
  detection_source?: string | null
  detection_method?: string | null
}

export type UnionSchema = {
  total_events: number
  fields: UnionSchemaField[]
  sensitive_suggestions_applied?: boolean
}

const MAX_SAMPLE_VALUES = 5
const MAX_PATHS = 500
const MAX_DEPTH = 12

function inferValueType(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'string') return 'string'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return 'string'
}

function mergeInferredTypes(existing: string, next: string): string {
  if (!existing || existing === next) return next
  if (existing === 'mixed' || next === 'mixed') return 'mixed'
  const numeric = new Set(['integer', 'number'])
  if (numeric.has(existing) && numeric.has(next)) return 'number'
  if (existing === 'null' || next === 'null') return existing === 'null' ? next : existing
  return 'mixed'
}

function isPrimitiveSample(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function pushSample(samples: unknown[], value: unknown): void {
  if (!isPrimitiveSample(value) || samples.length >= MAX_SAMPLE_VALUES) return
  const key = JSON.stringify(value)
  if (samples.some((s) => JSON.stringify(s) === key)) return
  samples.push(value)
}

function walkEventFields(
  value: unknown,
  path: string,
  depth: number,
  out: Map<string, { type: string; samples: unknown[] }>,
): void {
  if (out.size >= MAX_PATHS || depth > MAX_DEPTH) return

  const valueType = inferValueType(value)
  const entry = out.get(path) ?? { type: valueType, samples: [] }
  entry.type = mergeInferredTypes(entry.type, valueType)
  if (isPrimitiveSample(value)) pushSample(entry.samples, value)
  out.set(path, entry)

  if (valueType === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === '$' ? `$.${key}` : `${path}.${key}`
      walkEventFields(child, childPath, depth + 1, out)
      if (out.size >= MAX_PATHS) return
    }
    return
  }

  if (valueType === 'array' && Array.isArray(value)) {
    const arrayPath = `${path}[]`
    const arrayEntry = out.get(arrayPath) ?? { type: 'array', samples: [] }
    arrayEntry.type = mergeInferredTypes(arrayEntry.type, 'array')
    out.set(arrayPath, arrayEntry)
    for (const item of value.slice(0, 3)) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
          walkEventFields(child, `${arrayPath}.${key}`, depth + 1, out)
          if (out.size >= MAX_PATHS) return
        }
      } else {
        walkEventFields(item, `${arrayPath}[]`, depth + 1, out)
        if (out.size >= MAX_PATHS) return
      }
    }
  }
}

function collectPathsFromEvent(event: Record<string, unknown>): Map<string, { type: string; samples: unknown[] }> {
  const out = new Map<string, { type: string; samples: unknown[] }>()
  for (const [key, value] of Object.entries(event)) {
    walkEventFields(value, `$.${key}`, 0, out)
    if (out.size >= MAX_PATHS) break
  }
  return out
}

/** Build union schema from all extracted events (Record Selection sample set). */
export function buildUnionSchema(events: ReadonlyArray<Record<string, unknown>>): UnionSchema {
  const total_events = events.length
  const aggregate = new Map<
    string,
    { field_type: string; occurrence_count: number; sample_values: unknown[] }
  >()

  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const pathsInEvent = collectPathsFromEvent(event)
    for (const [field_path, meta] of pathsInEvent) {
      const existing = aggregate.get(field_path)
      if (!existing) {
        aggregate.set(field_path, {
          field_type: meta.type,
          occurrence_count: 1,
          sample_values: [...meta.samples],
        })
        continue
      }
      existing.occurrence_count += 1
      existing.field_type = mergeInferredTypes(existing.field_type, meta.type)
      for (const sample of meta.samples) {
        if (existing.sample_values.length >= MAX_SAMPLE_VALUES) break
        pushSample(existing.sample_values, sample)
      }
    }
  }

  const fields: UnionSchemaField[] = [...aggregate.entries()]
    .map(([field_path, meta]) => ({
      field_path,
      field_type: meta.field_type,
      occurrence_count: meta.occurrence_count,
      sample_values: meta.sample_values,
    }))
    .sort((a, b) => a.field_path.localeCompare(b.field_path))

  return { total_events, fields }
}

export function unionSchemaFieldMap(schema: UnionSchema | null | undefined): Map<string, UnionSchemaField> {
  const map = new Map<string, UnionSchemaField>()
  if (!schema) return map
  for (const field of schema.fields) map.set(field.field_path, field)
  return map
}

/** SoT: rare when occurrence_count / total_events is strictly below 30%. */
export const RARE_FIELD_RATIO_THRESHOLD = 0.3

/** True when the field appears in fewer than 30% of sample events. */
export function isRareUnionField(field: UnionSchemaField, schema: UnionSchema): boolean {
  const totalEvents = schema.total_events
  if (totalEvents <= 0) return false
  const occurrenceCount = field.occurrence_count
  if (typeof occurrenceCount !== 'number' || !Number.isFinite(occurrenceCount) || occurrenceCount < 0) {
    return false
  }
  return occurrenceCount / totalEvents < RARE_FIELD_RATIO_THRESHOLD
}

export function formatUnionOccurrence(field: UnionSchemaField, schema: UnionSchema): string {
  return `${field.occurrence_count}/${schema.total_events}`
}

/** Merge union schema sample values into a representative nested object for JSON view. */
export function buildRepresentativeEventFromUnionSchema(schema: UnionSchema): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const field of schema.fields) {
    const path = field.field_path
    if (!path.startsWith('$.')) continue
    const rawSegments = path.slice(2).split('.')
    const segments: string[] = []
    for (const seg of rawSegments) {
      if (!seg) continue
      if (seg.endsWith('[]')) {
        const base = seg.replace(/\[\]$/, '')
        if (base) segments.push(base)
        continue
      }
      segments.push(seg.replace(/\[\d+\]/g, ''))
    }
    if (segments.length === 0) continue
    const sample = field.sample_values[0]
    if (!isPrimitiveSample(sample)) continue
    let cur: Record<string, unknown> = root
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg === '[]') continue
      if (i === segments.length - 1) {
        cur[seg] = sample
      } else {
        const next = cur[seg]
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          cur[seg] = {}
        }
        cur = cur[seg] as Record<string, unknown>
      }
    }
  }
  return root
}

export function unionSchemaFromExtractedEvents(
  events: ReadonlyArray<Record<string, unknown>>,
): UnionSchema | null {
  const dictEvents = events.filter(
    (e): e is Record<string, unknown> => e !== null && typeof e === 'object' && !Array.isArray(e),
  )
  if (dictEvents.length === 0) return null
  return buildUnionSchema(dictEvents)
}

/** Load persisted wizard union schema from ``streams.config_json.union_schema``. */
export function unionSchemaFromStreamConfig(
  configJson: Record<string, unknown> | null | undefined,
): UnionSchema | null {
  const raw = configJson?.union_schema
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const record = raw as Record<string, unknown>
  const fieldsRaw = record.fields
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) return null

  const fields: UnionSchemaField[] = []
  for (const item of fieldsRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const field = item as Record<string, unknown>
    const fieldPath = String(field.field_path ?? '').trim()
    if (!fieldPath) continue
    fields.push({
      field_path: fieldPath,
      field_type: String(field.field_type ?? 'string'),
      occurrence_count: typeof field.occurrence_count === 'number' ? field.occurrence_count : 0,
      sample_values: Array.isArray(field.sample_values) ? field.sample_values.slice(0, MAX_SAMPLE_VALUES) : [],
      suggested_sensitive_type:
        typeof field.suggested_sensitive_type === 'string' && field.suggested_sensitive_type.trim()
          ? field.suggested_sensitive_type.trim()
          : null,
      sensitivity_class:
        typeof field.sensitivity_class === 'string' && field.sensitivity_class.trim()
          ? field.sensitivity_class.trim()
          : null,
      detection_source:
        typeof field.detection_source === 'string' && field.detection_source.trim()
          ? field.detection_source.trim()
          : null,
      detection_method:
        typeof field.detection_method === 'string' && field.detection_method.trim()
          ? field.detection_method.trim()
          : null,
    })
  }
  if (fields.length === 0) return null

  const totalEvents =
    typeof record.total_events === 'number' && record.total_events > 0
      ? record.total_events
      : Math.max(...fields.map((f) => f.occurrence_count), fields.length)

  return {
    total_events: totalEvents,
    fields,
    sensitive_suggestions_applied: record.sensitive_suggestions_applied === true,
  }
}
