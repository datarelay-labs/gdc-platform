import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MappingUIConfigResponse, StreamRead } from '../api/types/gdcApi'
import {
  buildWebhookStandaloneSampleResult,
  pickWebhookSamplePayload,
  resolveStandaloneStreamSourceKind,
  runStandaloneStreamSourceTest,
  standaloneConnectionStatusLabel,
  standaloneSampleStatusLabel,
} from './standaloneStreamSourceTest'
import { classifyStandaloneStreamSourceType } from './sourceTypePresentation'

const runConnectorAuthTest = vi.fn()
const runHttpApiTest = vi.fn()

vi.mock('../api/gdcRuntimePreview', () => ({
  runConnectorAuthTest: (...args: unknown[]) => runConnectorAuthTest(...args),
  runHttpApiTest: (...args: unknown[]) => runHttpApiTest(...args),
}))

function mappingCfg(sourceType: string, sourceConfig: Record<string, unknown> = {}): MappingUIConfigResponse {
  return {
    stream_id: 1,
    stream_name: 's',
    stream_enabled: true,
    stream_status: 'STOPPED',
    source_id: 2,
    source_type: sourceType,
    source_config: sourceConfig,
    mapping: {
      exists: true,
      event_array_path: '',
      event_root_path: '',
      field_mappings: {},
      raw_payload_mode: null,
    },
    enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
    routes: [],
    message: '',
  }
}

function stream(partial: Partial<StreamRead> & Pick<StreamRead, 'stream_type'>): StreamRead {
  return {
    id: 1,
    name: 's',
    connector_id: 11,
    source_id: 2,
    status: 'STOPPED',
    config_json: {},
    ...partial,
  }
}

describe('classifyStandaloneStreamSourceType', () => {
  it('does not fall unknown or AI Proxy types back to HTTP', () => {
    expect(classifyStandaloneStreamSourceType('HTTP_API_POLLING')).toBe('HTTP_API_POLLING')
    expect(classifyStandaloneStreamSourceType('S3_OBJECT_POLLING')).toBe('S3_OBJECT_POLLING')
    expect(classifyStandaloneStreamSourceType('DATABASE_QUERY')).toBe('DATABASE_QUERY')
    expect(classifyStandaloneStreamSourceType('REMOTE_FILE_POLLING')).toBe('REMOTE_FILE_POLLING')
    expect(classifyStandaloneStreamSourceType('WEBHOOK_RECEIVER')).toBe('WEBHOOK_RECEIVER')
    expect(classifyStandaloneStreamSourceType('AI_PROXY_RECEIVER')).toBe('AI_PROXY_RECEIVER')
    expect(classifyStandaloneStreamSourceType('KAFKA')).toBe('UNSUPPORTED')
    expect(classifyStandaloneStreamSourceType('')).toBe('UNSUPPORTED')
    expect(classifyStandaloneStreamSourceType(null)).toBe('UNSUPPORTED')
  })

  it('resolves stream + mapping source type without HTTP fallback', () => {
    expect(
      resolveStandaloneStreamSourceKind(stream({ stream_type: 'S3_OBJECT_POLLING' }), mappingCfg('S3_OBJECT_POLLING')),
    ).toBe('S3_OBJECT_POLLING')
    expect(
      resolveStandaloneStreamSourceKind(stream({ stream_type: 'AI_PROXY_RECEIVER' }), mappingCfg('AI_PROXY_RECEIVER')),
    ).toBe('AI_PROXY_RECEIVER')
  })

  it('does not treat empty mapping source_type as HTTP when stream_type is S3', () => {
    expect(
      resolveStandaloneStreamSourceKind(stream({ stream_type: 'S3_OBJECT_POLLING' }), mappingCfg('')),
    ).toBe('S3_OBJECT_POLLING')
    expect(
      resolveStandaloneStreamSourceKind(stream({ stream_type: 'DATABASE_QUERY' }), mappingCfg('   ')),
    ).toBe('DATABASE_QUERY')
  })
})

describe('webhook sample_payload', () => {
  it('uses operator sample_payload and never synthesizes events', () => {
    const payload = { events: [{ id: 1, email: 'a@example.com' }] }
    expect(pickWebhookSamplePayload({ sample_payload: payload })).toEqual(payload)
    const result = buildWebhookStandaloneSampleResult({ sample_payload: payload })
    expect(result.connectionStatus).toBe('n_a')
    expect(result.sampleStatus).toBe('available')
    expect(result.parsedJson).toEqual(payload)
    expect(result.usedSyntheticSample).toBe(false)
    expect(JSON.stringify(result)).not.toContain('synthetic')
  })

  it('returns Sample Not Available when webhook sample_payload is missing', () => {
    const result = buildWebhookStandaloneSampleResult({})
    expect(result.connectionStatus).toBe('n_a')
    expect(result.sampleStatus).toBe('not_available')
    expect(result.parsedJson).toBeNull()
    expect(result.eventCount).toBe(0)
    expect(standaloneSampleStatusLabel(result.sampleStatus)).toBe('Sample Not Available')
    expect(result.usedSyntheticSample).toBe(false)
  })
})

describe('runStandaloneStreamSourceTest', () => {
  beforeEach(() => {
    runConnectorAuthTest.mockReset()
    runHttpApiTest.mockReset()
  })

  it('HTTP existing stream uses actual sample and does not synthesize', async () => {
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'GET', url: 'https://api.example/v1/events', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 12,
        headers: {},
        raw_body: '{"id":1}',
        parsed_json: { id: 1, email: 'a@example.com' },
        content_type: 'application/json',
      },
    })
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'HTTP_API_POLLING',
      stream: stream({
        stream_type: 'HTTP_API_POLLING',
        config_json: { method: 'GET', endpoint: '/v1/events', timeout_seconds: 30 },
      }),
      cfg: mappingCfg('HTTP_API_POLLING', { base_url: 'https://api.example' }),
      connectorId: 11,
    })
    expect(runHttpApiTest).toHaveBeenCalled()
    const payload = runHttpApiTest.mock.calls[0]?.[0] as { stream_config: Record<string, unknown> }
    expect(payload.stream_config).toMatchObject({ method: 'GET', endpoint: '/v1/events' })
    expect(result.connectionStatus).toBe('pass')
    expect(result.sampleStatus).toBe('available')
    expect(result.parsedJson).toMatchObject({ email: 'a@example.com' })
    expect(result.usedSyntheticSample).toBe(false)
  })

  it('S3 existing stream probes then fetches actual object events', async () => {
    runConnectorAuthTest.mockResolvedValue({
      ok: true,
      auth_type: 'S3_OBJECT_POLLING',
      s3_bucket_exists: true,
      s3_auth_ok: true,
    })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'S3_OBJECT_POLLING', url: 's3://lab/events', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 9,
        headers: {},
        raw_body: '[{"user":"alice"}]',
        parsed_json: [{ user: 'alice', email: 'alice@example.com', s3_key: 'events/alice.ndjson' }],
        content_type: 'application/json',
      },
      s3_event_count: 1,
      s3_sample_keys: ['events/alice.ndjson'],
    })
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'S3_OBJECT_POLLING',
      stream: stream({ stream_type: 'S3_OBJECT_POLLING', config_json: { max_objects_per_run: 7 } }),
      cfg: mappingCfg('S3_OBJECT_POLLING', { bucket: 'lab', prefix: 'events/' }),
      connectorId: 11,
    })
    expect(runConnectorAuthTest).toHaveBeenCalled()
    expect(runHttpApiTest).toHaveBeenCalled()
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toEqual({ max_objects_per_run: 7 })
    expect(streamConfig).not.toHaveProperty('endpoint')
    expect(result.connectionStatus).toBe('pass')
    expect(result.sampleStatus).toBe('available')
    expect(result.parsedJson).toEqual([{ user: 'alice', email: 'alice@example.com', s3_key: 'events/alice.ndjson' }])
    expect(result.usedSyntheticSample).toBe(false)
    expect(JSON.stringify(result.parsedJson)).not.toContain('s3-wizard-preview')
  })

  it('S3 empty bucket keeps connection success and reports no records', async () => {
    runConnectorAuthTest.mockResolvedValue({
      ok: true,
      auth_type: 'S3_OBJECT_POLLING',
      s3_bucket_exists: true,
      s3_object_count_preview: 0,
    })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'S3_OBJECT_POLLING', url: 's3://lab', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 4,
        headers: {},
        raw_body: '[]',
        parsed_json: [],
        content_type: 'application/json',
      },
      s3_event_count: 0,
      s3_sample_keys: [],
    })
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'S3_OBJECT_POLLING',
      stream: stream({ stream_type: 'S3_OBJECT_POLLING', config_json: { max_objects_per_run: 5 } }),
      cfg: mappingCfg('S3_OBJECT_POLLING', { bucket: 'lab' }),
      connectorId: 11,
    })
    expect(result.connectionStatus).toBe('pass')
    expect(result.sampleStatus).toBe('no_records')
    expect(standaloneConnectionStatusLabel(result.connectionStatus)).toBe('Connection Success')
    expect(standaloneSampleStatusLabel(result.sampleStatus)).toBe('No Records')
    expect(result.eventCount).toBe(0)
    expect(result.usedSyntheticSample).toBe(false)
  })

  it('DATABASE existing stream uses saved query and actual rows', async () => {
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'DATABASE_QUERY', db_reachable: true, db_auth_ok: true })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'DATABASE_QUERY', url: 'postgresql://db.internal/app', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 11,
        headers: {},
        raw_body: '[{"id":1}]',
        parsed_json: [{ id: 1, email: 'a@example.com' }],
        content_type: 'application/json',
      },
      database_query_row_count: 1,
      database_query_sample_rows: [{ id: 1, email: 'a@example.com' }],
    })
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'DATABASE_QUERY',
      stream: stream({
        stream_type: 'DATABASE_QUERY',
        config_json: { query: 'SELECT id, email FROM users', query_timeout_seconds: 15 },
      }),
      cfg: mappingCfg('DATABASE_QUERY'),
      connectorId: 11,
    })
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toEqual({ query: 'SELECT id, email FROM users', query_timeout_seconds: 15 })
    expect(streamConfig).not.toHaveProperty('endpoint')
    expect(result.connectionStatus).toBe('pass')
    expect(result.sampleStatus).toBe('available')
    expect(result.parsedJson).toEqual([{ id: 1, email: 'a@example.com' }])
    expect(result.usedSyntheticSample).toBe(false)
  })

  it('DATABASE 0 rows keeps connection success and reports no records', async () => {
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'DATABASE_QUERY', db_reachable: true, db_auth_ok: true })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'DATABASE_QUERY', url: 'postgresql://db.internal/app', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 6,
        headers: {},
        raw_body: '[]',
        parsed_json: [],
        content_type: 'application/json',
      },
      database_query_row_count: 0,
      database_query_sample_rows: [],
    })
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'DATABASE_QUERY',
      stream: stream({ stream_type: 'DATABASE_QUERY', config_json: { query: 'SELECT id FROM empty_table' } }),
      cfg: mappingCfg('DATABASE_QUERY'),
      connectorId: 11,
    })
    expect(result.connectionStatus).toBe('pass')
    expect(result.sampleStatus).toBe('no_records')
    expect(result.eventCount).toBe(0)
    expect(result.usedSyntheticSample).toBe(false)
  })

  it('REMOTE_FILE uses adapter sample path without HTTP endpoint', async () => {
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'REMOTE_FILE_POLLING', ssh_reachable: true })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'REMOTE_FILE_POLLING', url: 'sftp://files.example/data', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 20,
        headers: {},
        raw_body: '[{"line":"a"}]',
        parsed_json: [{ line: 'a', path: '/data/a.ndjson' }],
        content_type: 'application/json',
      },
      remote_file_event_count: 1,
    })
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'REMOTE_FILE_POLLING',
      stream: stream({
        stream_type: 'REMOTE_FILE_POLLING',
        config_json: { remote_directory: '/data', file_pattern: '*.ndjson', recursive: true },
      }),
      cfg: mappingCfg('REMOTE_FILE_POLLING'),
      connectorId: 11,
    })
    expect(runConnectorAuthTest.mock.calls[0]?.[0]).toMatchObject({
      remote_file_stream_config: { remote_directory: '/data', file_pattern: '*.ndjson', recursive: true },
    })
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toMatchObject({ remote_directory: '/data', file_pattern: '*.ndjson' })
    expect(streamConfig).not.toHaveProperty('endpoint')
    expect(result.connectionStatus).toBe('pass')
    expect(result.sampleStatus).toBe('available')
    expect(result.parsedJson).toEqual([{ line: 'a', path: '/data/a.ndjson' }])
    expect(result.usedSyntheticSample).toBe(false)
  })

  it('AI_PROXY stays unsupported and does not call HTTP preview', async () => {
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'AI_PROXY_RECEIVER',
      stream: stream({ stream_type: 'AI_PROXY_RECEIVER' }),
      cfg: mappingCfg('AI_PROXY_RECEIVER'),
      connectorId: 11,
    })
    expect(runHttpApiTest).not.toHaveBeenCalled()
    expect(runConnectorAuthTest).not.toHaveBeenCalled()
    expect(result.connectionStatus).toBe('n_a')
    expect(result.sampleStatus).toBe('not_available')
    expect(result.usedSyntheticSample).toBe(false)
  })

  it('unknown source type is unsupported and does not fall back to HTTP', async () => {
    const result = await runStandaloneStreamSourceTest({
      sourceKind: 'UNSUPPORTED',
      stream: stream({ stream_type: 'KAFKA' }),
      cfg: mappingCfg('KAFKA'),
      connectorId: 11,
    })
    expect(runHttpApiTest).not.toHaveBeenCalled()
    expect(result.connectionStatus).toBe('unsupported')
    expect(result.sampleStatus).toBe('unsupported')
    expect(standaloneSampleStatusLabel(result.sampleStatus)).toBe('Sample Not Available')
    expect(result.usedSyntheticSample).toBe(false)
  })
})
