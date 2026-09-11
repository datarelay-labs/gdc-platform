import { describe, expect, it } from 'vitest'
import { buildUnionSchema, unionSchemaFromExtractedEvents } from '../../../utils/unionSchema'
import {
  analysisFromParsedRecordArray,
  buildApiTestSuccessPatch,
  canGenerateWizardUnionSchema,
  parsedRecordEvents,
} from '../../../utils/wizardUnionSchema'
import { buildInitialState, buildStreamConfigPayload } from './wizard-state'

const SYNTHETIC_S3_PREVIEW = {
  id: 's3-wizard-preview',
  message: 'Use a field path from your NDJSON or JSON objects (e.g. $.id, $.message).',
  severity: '1',
}

const ACTUAL_S3_EVENTS = [
  { user: 'alice', email: 'alice@example.com', source_ip: '10.1.1.1', s3_key: 'events/alice.ndjson' },
  { user: 'bob', email: 'bob@example.com', source_ip: '10.1.1.2', s3_key: 'events/bob.ndjson' },
]

describe('P2-1 non-HTTP source sample / union schema parity', () => {
  it('buildStreamConfigPayload for S3 sends max_objects_per_run only', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    state.stream.maxObjectsPerRun = 8
    state.stream.endpoint = '/should-not-be-used'
    expect(buildStreamConfigPayload(state)).toEqual({ max_objects_per_run: 8 })
  })

  it('parses actual S3 record arrays without fabricating preview objects', () => {
    const records = parsedRecordEvents(ACTUAL_S3_EVENTS)
    expect(records).toHaveLength(2)
    const analysis = analysisFromParsedRecordArray(ACTUAL_S3_EVENTS)
    expect(analysis?.sampleEvent).toMatchObject({ user: 'alice', email: 'alice@example.com' })
    expect(analysis?.selectedEventArrayDefault).toBe('$')
    expect(JSON.stringify(analysis)).not.toContain('s3-wizard-preview')
  })

  it('builds union schema from actual S3 events, not synthetic preview fields', () => {
    const schema = buildUnionSchema(ACTUAL_S3_EVENTS)
    const paths = schema.fields.map((f) => f.field_path)
    expect(paths).toEqual(expect.arrayContaining(['$.user', '$.email', '$.source_ip', '$.s3_key']))
    expect(paths).not.toContain('$.message')
    expect(paths).not.toContain('$.severity')
    expect(schema.fields.find((f) => f.field_path === '$.email')?.sample_values).toContain('alice@example.com')
    expect(JSON.stringify(schema)).not.toContain('s3-wizard-preview')
  })

  it('does not generate union schema from empty samples', () => {
    expect(unionSchemaFromExtractedEvents([])).toBeNull()
    const emptyPatch = buildApiTestSuccessPatch([], analysisFromParsedRecordArray([]))
    expect(emptyPatch.unionSchema).toBeNull()
    expect(emptyPatch.extractedEvents).toEqual([])
    expect(emptyPatch.eventCount).toBe(0)
    expect(JSON.stringify(SYNTHETIC_S3_PREVIEW)).toContain('s3-wizard-preview')
  })

  it('defers union schema until record/event confirmation even with actual S3 events', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.finishedAt = Date.now()
    expect(canGenerateWizardUnionSchema(state)).toBe(false)
    state.stream.eventArrayPath = '$'
    state.stream.recordPathConfirmedForApiTestAt = state.apiTest.finishedAt
    state.stream.eventRootConfirmedForApiTestAt = state.apiTest.finishedAt
    expect(canGenerateWizardUnionSchema(state)).toBe(true)
  })

  it('blocks union schema when connection succeeded but sample ok is false (no records)', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    state.apiTest.status = 'success'
    state.apiTest.ok = false
    state.apiTest.s3ConnectivityPassed = true
    state.apiTest.eventCount = 0
    state.apiTest.parsedJson = []
    state.apiTest.finishedAt = Date.now()
    state.stream.eventArrayPath = '$'
    state.stream.recordPathConfirmedForApiTestAt = state.apiTest.finishedAt
    state.stream.eventRootConfirmedForApiTestAt = state.apiTest.finishedAt
    expect(canGenerateWizardUnionSchema(state)).toBe(false)
  })

  it('buildStreamConfigPayload for DATABASE_QUERY sends query only', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.sqlQuery = 'SELECT id, email, created_at FROM users'
    state.stream.timeoutSec = 12
    state.stream.endpoint = '/should-not-be-used'
    expect(buildStreamConfigPayload(state)).toEqual({
      query: 'SELECT id, email, created_at FROM users',
      query_timeout_seconds: 12,
    })
  })

  it('builds union schema from actual database rows, not synthetic preview fields', () => {
    const rows = [
      { id: 1, email: 'a@example.com', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, email: 'b@example.com', created_at: '2026-01-02T00:00:00Z' },
    ]
    const records = parsedRecordEvents(rows)
    expect(records).toHaveLength(2)
    const analysis = analysisFromParsedRecordArray(rows)
    expect(analysis?.sampleEvent).toMatchObject({ id: 1, email: 'a@example.com' })
    const schema = buildUnionSchema(rows)
    const paths = schema.fields.map((f) => f.field_path)
    expect(paths).toEqual(expect.arrayContaining(['$.id', '$.email', '$.created_at']))
    expect(schema.fields.find((f) => f.field_path === '$.email')?.sample_values).toContain('a@example.com')
  })

  it('blocks union schema when database query returned no rows', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    state.apiTest.status = 'success'
    state.apiTest.ok = false
    state.apiTest.dbConnectivityPassed = true
    state.apiTest.eventCount = 0
    state.apiTest.parsedJson = []
    state.apiTest.finishedAt = Date.now()
    state.stream.eventArrayPath = '$'
    state.stream.recordPathConfirmedForApiTestAt = state.apiTest.finishedAt
    state.stream.eventRootConfirmedForApiTestAt = state.apiTest.finishedAt
    expect(canGenerateWizardUnionSchema(state)).toBe(false)
    expect(unionSchemaFromExtractedEvents([])).toBeNull()
  })
})
