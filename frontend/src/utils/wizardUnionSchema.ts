import type {
  WizardApiTestState,
  WizardConfigState,
  WizardHttpApiAnalysis,
  WizardState,
} from '../components/streams/wizard/wizard-state'
import {
  detectEventRootCandidates,
  flattenSampleFields,
  recordsFromResolvedValue,
  wizardExtractEvents,
} from '../components/streams/wizard/wizard-json-extract'
import { isRareUnionField, unionSchemaFromExtractedEvents, type UnionSchema } from './unionSchema'
import { isUnionFieldSensitive } from './unionSchemaFieldDisplay'

export function canGenerateWizardUnionSchema(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  const finishedAt = state.apiTest.finishedAt
  if (finishedAt == null || state.apiTest.status !== 'success' || !state.apiTest.ok) return false
  const recordReady =
    (state.stream.useWholeResponseAsEvent || state.stream.eventArrayPath.trim().length > 0) &&
    state.stream.recordPathConfirmedForApiTestAt === finishedAt
  const eventRootReady = state.stream.eventRootConfirmedForApiTestAt === finishedAt
  return recordReady && eventRootReady
}

function countRecordCandidates(value: unknown): number {
  return recordsFromResolvedValue(value).length
}

/** Approximate record count for API Test — no Record Path / Event Root selection required. */
export function estimateApiTestRecordCount(
  parsedJson: unknown,
  analysis: WizardHttpApiAnalysis | null,
): number {
  if (parsedJson == null) return 0

  if (analysis?.detectedArrays?.length) {
    return Math.max(...analysis.detectedArrays.map((entry) => entry.count))
  }

  if (Array.isArray(parsedJson)) {
    return countRecordCandidates(parsedJson)
  }

  if (typeof parsedJson === 'object' && parsedJson !== null) {
    let maxCount = 1
    for (const value of Object.values(parsedJson as Record<string, unknown>)) {
      maxCount = Math.max(maxCount, countRecordCandidates(value))
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          maxCount = Math.max(maxCount, countRecordCandidates(nested))
        }
      }
    }
    return maxCount
  }

  return 0
}

export type ApiTestSamplePatch = Pick<
  WizardApiTestState,
  'extractedEvents' | 'eventCount' | 'unionSchema' | 'analysis'
>

export function buildApiTestSamplePatch(
  parsedJson: unknown,
  analysis: WizardHttpApiAnalysis | null,
  stream: Pick<WizardConfigState, 'eventArrayPath' | 'eventRootPath' | 'useWholeResponseAsEvent'>,
  unionSchemaGate: Pick<WizardState, 'stream' | 'apiTest'>,
): ApiTestSamplePatch {
  const rawObj = parsedJson !== null && typeof parsedJson === 'object' ? parsedJson : null
  const defaultArr = analysis?.selectedEventArrayDefault?.trim() ?? ''
  const pathForExtract = (stream.eventArrayPath.trim() || defaultArr).trim()
  const extractedEvents = rawObj != null ? wizardExtractEvents(rawObj, pathForExtract, stream.eventRootPath) : []
  return buildApiTestExtractedEventsPatch(extractedEvents, analysis, unionSchemaGate)
}

export function buildApiTestExtractedEventsPatch(
  extractedEvents: Array<Record<string, unknown>>,
  analysis: WizardHttpApiAnalysis | null,
  unionSchemaGate?: Pick<WizardState, 'stream' | 'apiTest'>,
): ApiTestSamplePatch {
  const unionSchema =
    unionSchemaGate != null && canGenerateWizardUnionSchema(unionSchemaGate)
      ? unionSchemaFromExtractedEvents(extractedEvents)
      : null
  const flat = flattenSampleFields(extractedEvents[0] ?? null)
  const nextAnalysis =
    analysis != null
      ? {
          ...analysis,
          sampleEvent: (extractedEvents[0] ?? null) as Record<string, unknown> | null,
          flatPreviewFields: flat.length ? flat : analysis.flatPreviewFields,
        }
      : analysis

  return {
    extractedEvents,
    eventCount: extractedEvents.length,
    unionSchema,
    analysis: nextAnalysis,
  }
}

/** Analysis model for already-parsed record arrays (S3 / remote file sample fetch). */
export function analysisFromParsedRecordArray(parsedBody: unknown): WizardHttpApiAnalysis | null {
  if (!Array.isArray(parsedBody)) return null
  const records = parsedBody.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row),
  )
  const first = records[0] ?? null
  return {
    responseSummary: {
      root_type: 'array',
      approx_size_bytes: JSON.stringify(parsedBody).length,
      top_level_keys: [],
      item_count_root: parsedBody.length,
      truncation: null,
    },
    detectedArrays: [],
    detectedCheckpointCandidates: [],
    sampleEvent: first,
    selectedEventArrayDefault: '$',
    flatPreviewFields: first ? flattenSampleFields(first) : [],
    eventRootCandidates: first ? detectEventRootCandidates(first) : [],
    previewError: null,
  }
}

export function parsedRecordEvents(parsedBody: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parsedBody)) return []
  return parsedBody.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row),
  )
}

export function buildApiTestSuccessPatch(
  parsedJson: unknown,
  analysis: WizardHttpApiAnalysis | null,
): Pick<WizardApiTestState, 'extractedEvents' | 'eventCount' | 'unionSchema'> {
  return {
    extractedEvents: [],
    eventCount: estimateApiTestRecordCount(parsedJson, analysis),
    unionSchema: null,
  }
}

export type UnionSchemaStatusSummary = {
  state: 'pending' | 'ready'
  eventCount: number
  fieldCount: number
  rareFieldCount: number
  sensitiveFieldCount: number
}

export function summarizeUnionSchemaStatus(
  unionSchema: UnionSchema | null | undefined,
): UnionSchemaStatusSummary {
  if (!unionSchema?.fields?.length) {
    return {
      state: 'pending',
      eventCount: 0,
      fieldCount: 0,
      rareFieldCount: 0,
      sensitiveFieldCount: 0,
    }
  }

  let rareFieldCount = 0
  let sensitiveFieldCount = 0
  for (const field of unionSchema.fields) {
    if (isRareUnionField(field, unionSchema)) rareFieldCount += 1
    if (isUnionFieldSensitive(field)) {
      sensitiveFieldCount += 1
    }
  }

  return {
    state: 'ready',
    eventCount: unionSchema.total_events,
    fieldCount: unionSchema.fields.length,
    rareFieldCount,
    sensitiveFieldCount,
  }
}

export function unionSchemaFieldPaths(schema: UnionSchema | null | undefined): string[] {
  if (!schema) return []
  return schema.fields.map((f) => f.field_path)
}
