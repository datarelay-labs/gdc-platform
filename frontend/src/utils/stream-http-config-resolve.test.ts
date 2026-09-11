import { describe, expect, it } from 'vitest'
import { buildStreamHttpConfigFromStreamRead, resolveStreamEndpointPath } from './streamHttpConfigFromStreamRead'
import type { MappingUIConfigResponse, StreamRead } from '../api/types/gdcApi'

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

describe('resolveStreamEndpointPath', () => {
  it('reads endpoint from stream config_json', () => {
    expect(resolveStreamEndpointPath({ endpoint: '/connect/api/dataexport/anomalies/malop/_search' })).toBe(
      '/connect/api/dataexport/anomalies/malop/_search',
    )
  })

  it('falls back to source_config endpoint_path when stream config is empty', () => {
    expect(
      resolveStreamEndpointPath({}, { endpoint_path: '/connect/api/dataexport/anomalies/malop/_search' }),
    ).toBe('/connect/api/dataexport/anomalies/malop/_search')
  })
})

describe('buildStreamHttpConfigFromStreamRead', () => {
  it('sends S3 max_objects_per_run instead of HTTP endpoint fields', () => {
    const stream = {
      id: 1,
      name: 's3',
      connector_id: 1,
      source_id: 2,
      status: 'STOPPED',
      stream_type: 'S3_OBJECT_POLLING',
      config_json: { max_objects_per_run: 7 },
    } as StreamRead
    expect(buildStreamHttpConfigFromStreamRead(stream, mappingCfg('S3_OBJECT_POLLING'))).toEqual({
      max_objects_per_run: 7,
    })
  })

  it('sends remote_directory for REMOTE_FILE_POLLING', () => {
    const stream = {
      id: 1,
      name: 'rf',
      connector_id: 1,
      source_id: 2,
      status: 'STOPPED',
      stream_type: 'REMOTE_FILE_POLLING',
      config_json: { remote_directory: '/data', file_pattern: '*.ndjson', recursive: true },
    } as StreamRead
    expect(buildStreamHttpConfigFromStreamRead(stream, mappingCfg('REMOTE_FILE_POLLING'))).toMatchObject({
      remote_directory: '/data',
      file_pattern: '*.ndjson',
      recursive: true,
    })
  })

  it('sends query for DATABASE_QUERY', () => {
    const stream = {
      id: 1,
      name: 'db',
      connector_id: 1,
      source_id: 2,
      status: 'STOPPED',
      stream_type: 'DATABASE_QUERY',
      config_json: { query: 'SELECT id, email FROM users', query_timeout_seconds: 15 },
    } as StreamRead
    expect(buildStreamHttpConfigFromStreamRead(stream, mappingCfg('DATABASE_QUERY'))).toEqual({
      query: 'SELECT id, email FROM users',
      query_timeout_seconds: 15,
    })
  })

  it('uses stream.stream_type when mapping source_type is empty (no HTTP endpoint fallback)', () => {
    const stream = {
      id: 1,
      name: 's3',
      connector_id: 1,
      source_id: 2,
      status: 'STOPPED',
      stream_type: 'S3_OBJECT_POLLING',
      config_json: { max_objects_per_run: 5 },
    } as StreamRead
    expect(buildStreamHttpConfigFromStreamRead(stream, mappingCfg(''))).toEqual({
      max_objects_per_run: 5,
    })
    expect(buildStreamHttpConfigFromStreamRead(stream, mappingCfg(''))).not.toHaveProperty('endpoint')
  })
})
