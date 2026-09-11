import { describe, expect, it } from 'vitest'
import { buildInitialState } from '../components/streams/wizard/wizard-state'
import {
  analysisFromParsedRecordArray,
  buildApiTestExtractedEventsPatch,
  buildApiTestSuccessPatch,
  canGenerateWizardUnionSchema,
  estimateApiTestRecordCount,
  parsedRecordEvents,
} from './wizardUnionSchema'

describe('wizardUnionSchema', () => {
  it('estimateApiTestRecordCount prefers detected array counts', () => {
    const payload = { data: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] } }
    const count = estimateApiTestRecordCount(payload, {
      responseSummary: {
        root_type: 'object',
        approx_size_bytes: 64,
        top_level_keys: ['data'],
        item_count_root: null,
        truncation: null,
      },
      detectedArrays: [{ path: '$.data.items', count: 3, confidence: 0.9, reason: 'test' }],
      detectedCheckpointCandidates: [],
      sampleEvent: null,
      selectedEventArrayDefault: '$.data.items',
      flatPreviewFields: [],
      previewError: null,
    })
    expect(count).toBe(3)
  })

  it('buildApiTestSuccessPatch never generates union schema', () => {
    const patch = buildApiTestSuccessPatch([{ id: 1 }], null)
    expect(patch.unionSchema).toBeNull()
    expect(patch.extractedEvents).toEqual([])
    expect(patch.eventCount).toBe(1)
  })

  it('defers union schema until record path and event root are confirmed', () => {
    const state = buildInitialState()
    const finishedAt = Date.now()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.finishedAt = finishedAt
    state.stream.eventArrayPath = '$.Records'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt

    const events = [{ id: '1' }, { id: '2' }]
    const pending = buildApiTestExtractedEventsPatch(events, null, state)
    expect(pending.unionSchema).toBeNull()
    expect(canGenerateWizardUnionSchema(state)).toBe(false)

    state.stream.eventRootConfirmedForApiTestAt = finishedAt
    const ready = buildApiTestExtractedEventsPatch(events, null, state)
    expect(canGenerateWizardUnionSchema(state)).toBe(true)
    expect(ready.unionSchema?.total_events).toBe(2)
  })

  it('analysisFromParsedRecordArray uses actual records and $ event root default', () => {
    const parsed = [{ user: 'alice', email: 'alice@example.com' }]
    expect(parsedRecordEvents(parsed)).toEqual(parsed)
    const analysis = analysisFromParsedRecordArray(parsed)
    expect(analysis?.selectedEventArrayDefault).toBe('$')
    expect(analysis?.sampleEvent).toEqual({ user: 'alice', email: 'alice@example.com' })
    expect(analysisFromParsedRecordArray([])?.sampleEvent).toBeNull()
    expect(analysisFromParsedRecordArray({ not: 'array' })).toBeNull()
  })

  it('estimateApiTestRecordCount detects homogeneous object maps', () => {
    const payload = {
      data: {
        resultIdToElementDataMap: {
          a: { id: 'a' },
          b: { id: 'b' },
          c: { id: 'c' },
        },
      },
    }
    expect(estimateApiTestRecordCount(payload, null)).toBe(3)
  })
})
