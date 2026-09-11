import { runConnectorAuthTest, runHttpApiTest, type ConnectorAuthTestResponse, type HttpApiTestResponse } from '../api/gdcRuntimePreview'
import type { MappingUIConfigResponse, StreamRead } from '../api/types/gdcApi'
import { parsedRecordEvents } from './wizardUnionSchema'
import {
  buildStreamHttpConfigFromStreamRead,
  connectorBaseUrlFromMappingUi,
} from './streamHttpConfigFromStreamRead'
import {
  classifyStandaloneStreamSourceType,
  firstNonEmptySourceType,
  type StandaloneStreamSourceKind,
} from './sourceTypePresentation'

export type StandaloneConnectionStatus = 'idle' | 'pass' | 'fail' | 'n_a' | 'unsupported'
export type StandaloneSampleStatus =
  | 'idle'
  | 'available'
  | 'no_records'
  | 'not_available'
  | 'failed'
  | 'unsupported'

export type StandaloneHttpOverrides = {
  method?: string
  endpoint?: string
  baseUrl?: string
  headers?: Record<string, string>
  params?: Record<string, string>
  body?: unknown
  timeoutSeconds?: number
}

export type StandaloneStreamTestResult = {
  sourceKind: StandaloneStreamSourceKind
  connectionStatus: StandaloneConnectionStatus
  sampleStatus: StandaloneSampleStatus
  httpResult: HttpApiTestResponse | null
  probe: ConnectorAuthTestResponse | null
  parsedJson: unknown
  eventCount: number
  message: string | null
  hint: string | null
  usedSyntheticSample: false
}

export function standaloneConnectionStatusLabel(status: StandaloneConnectionStatus): string {
  switch (status) {
    case 'pass':
      return 'Connection Success'
    case 'fail':
      return 'Connection Failed'
    case 'n_a':
      return 'N/A'
    case 'unsupported':
      return 'Unsupported'
    default:
      return '—'
  }
}

export function standaloneSampleStatusLabel(status: StandaloneSampleStatus): string {
  switch (status) {
    case 'available':
      return 'Sample Available'
    case 'no_records':
      return 'No Records'
    case 'not_available':
      return 'Sample Not Available'
    case 'failed':
      return 'Sample Failed'
    case 'unsupported':
      return 'Sample Not Available'
    default:
      return '—'
  }
}

export function resolveStandaloneStreamSourceKind(
  stream: Pick<StreamRead, 'stream_type' | 'source_type'> | null | undefined,
  cfg: Pick<MappingUIConfigResponse, 'source_type'> | null | undefined,
): StandaloneStreamSourceKind {
  return classifyStandaloneStreamSourceType(
    firstNonEmptySourceType(cfg?.source_type, stream?.source_type, stream?.stream_type),
  )
}

export function pickWebhookSamplePayload(sourceConfig: Record<string, unknown> | null | undefined): unknown {
  if (!sourceConfig) return null
  const sp = sourceConfig.sample_payload
  if (sp !== undefined && sp !== null) return sp
  const raw = sourceConfig.raw_sample_payload
  if (raw !== undefined && raw !== null) return raw
  return null
}

function unsupportedResult(sourceKind: StandaloneStreamSourceKind): StandaloneStreamTestResult {
  const isAi = sourceKind === 'AI_PROXY_RECEIVER'
  return {
    sourceKind,
    connectionStatus: isAi ? 'n_a' : 'unsupported',
    sampleStatus: isAi ? 'not_available' : 'unsupported',
    httpResult: null,
    probe: null,
    parsedJson: null,
    eventCount: 0,
    message: 'Sample Not Available',
    hint: isAi
      ? 'AI Proxy receiver streams do not support standalone source test. Live fetch is not available on this page.'
      : 'Standalone source test is not available for this source type. Source type is not treated as HTTP.',
    usedSyntheticSample: false,
  }
}

export function buildWebhookStandaloneSampleResult(
  sourceConfig: Record<string, unknown> | null | undefined,
): StandaloneStreamTestResult {
  const sample = pickWebhookSamplePayload(sourceConfig)
  if (sample === null || sample === undefined) {
    return {
      sourceKind: 'WEBHOOK_RECEIVER',
      connectionStatus: 'n_a',
      sampleStatus: 'not_available',
      httpResult: null,
      probe: null,
      parsedJson: null,
      eventCount: 0,
      message: 'Sample Not Available',
      hint: 'No webhook sample_payload is configured on the source. Live fetch is not possible for webhook receivers.',
      usedSyntheticSample: false,
    }
  }
  const records = Array.isArray(sample) ? parsedRecordEvents(sample) : []
  const eventCount = Array.isArray(sample) ? (records.length > 0 ? records.length : sample.length) : 1
  return {
    sourceKind: 'WEBHOOK_RECEIVER',
    connectionStatus: 'n_a',
    sampleStatus: 'available',
    httpResult: null,
    probe: null,
    parsedJson: sample,
    eventCount,
    message: null,
    hint: null,
    usedSyntheticSample: false,
  }
}

function countSampleRecords(sourceKind: StandaloneStreamSourceKind, res: HttpApiTestResponse): number {
  if (sourceKind === 'DATABASE_QUERY') {
    if (typeof res.database_query_row_count === 'number') return res.database_query_row_count
    if (Array.isArray(res.database_query_sample_rows)) return res.database_query_sample_rows.length
  }
  if (sourceKind === 'S3_OBJECT_POLLING' && typeof res.s3_event_count === 'number') {
    return res.s3_event_count
  }
  if (sourceKind === 'REMOTE_FILE_POLLING' && typeof res.remote_file_event_count === 'number') {
    return res.remote_file_event_count
  }
  const parsed = res.response?.parsed_json
  if (Array.isArray(parsed)) {
    const records = parsedRecordEvents(parsed)
    return records.length > 0 ? records.length : parsed.length
  }
  if (parsed !== null && parsed !== undefined) return 1
  return 0
}

function parsedJsonFromSample(sourceKind: StandaloneStreamSourceKind, res: HttpApiTestResponse): unknown {
  if (sourceKind === 'DATABASE_QUERY' && res.database_query_sample_rows != null) {
    return res.database_query_sample_rows
  }
  return res.response?.parsed_json ?? null
}

function buildHttpRequestPayload(
  stream: StreamRead,
  cfg: MappingUIConfigResponse,
  connectorId: number | null,
  overrides?: StandaloneHttpOverrides | null,
): Parameters<typeof runHttpApiTest>[0] {
  const saved = buildStreamHttpConfigFromStreamRead(stream, cfg)
  const baseUrl = (overrides?.baseUrl?.trim() || connectorBaseUrlFromMappingUi(stream, cfg)).trim()
  if (!overrides) {
    return {
      connector_id: connectorId ?? undefined,
      source_config: connectorId != null ? {} : { base_url: baseUrl },
      stream_config: saved,
      checkpoint: null,
      fetch_sample: true,
    }
  }
  const method = String(overrides.method ?? saved.method ?? 'GET').toUpperCase()
  const streamCfg: Record<string, unknown> = {
    method: method === 'POST' || method === 'PUT' ? method : 'GET',
    endpoint: String(overrides.endpoint ?? saved.endpoint ?? '').trim(),
    timeout_seconds:
      typeof overrides.timeoutSeconds === 'number' && Number.isFinite(overrides.timeoutSeconds)
        ? overrides.timeoutSeconds
        : saved.timeout_seconds ?? 30,
    params: overrides.params ?? saved.params ?? {},
  }
  const headers = overrides.headers ?? saved.headers
  if (headers && typeof headers === 'object' && Object.keys(headers as object).length) {
    streamCfg.headers = headers
  }
  if (overrides.body !== undefined) streamCfg.body = overrides.body
  else if (saved.body !== undefined) streamCfg.body = saved.body
  return {
    connector_id: connectorId ?? undefined,
    source_config: connectorId != null ? {} : { base_url: baseUrl },
    stream_config: streamCfg,
    checkpoint: null,
    fetch_sample: true,
  }
}

function failureFromCaught(sourceKind: StandaloneStreamSourceKind, err: unknown, probeOk: boolean): StandaloneStreamTestResult {
  const message = err instanceof Error ? err.message : 'Source test failed'
  return {
    sourceKind,
    connectionStatus: probeOk ? 'pass' : 'fail',
    sampleStatus: probeOk ? 'failed' : 'failed',
    httpResult: null,
    probe: null,
    parsedJson: null,
    eventCount: 0,
    message,
    hint: probeOk
      ? 'Connection succeeded. Sample fetch failed. No synthetic sample was generated.'
      : 'Connection Failed. No synthetic sample was generated.',
    usedSyntheticSample: false,
  }
}

async function runProbeThenSample(args: {
  sourceKind: 'S3_OBJECT_POLLING' | 'DATABASE_QUERY' | 'REMOTE_FILE_POLLING'
  stream: StreamRead
  cfg: MappingUIConfigResponse
  connectorId: number | null
  probePayload: Parameters<typeof runConnectorAuthTest>[0]
  missingConfigMessage?: string | null
  connectionFailHint: string
  noRecordsMessage: string
  noRecordsHint: string
}): Promise<StandaloneStreamTestResult> {
  const { sourceKind, stream, cfg, connectorId } = args
  if (args.missingConfigMessage) {
    return {
      sourceKind,
      connectionStatus: 'fail',
      sampleStatus: 'not_available',
      httpResult: null,
      probe: null,
      parsedJson: null,
      eventCount: 0,
      message: args.missingConfigMessage,
      hint: null,
      usedSyntheticSample: false,
    }
  }
  if (connectorId == null) {
    return {
      sourceKind,
      connectionStatus: 'fail',
      sampleStatus: 'not_available',
      httpResult: null,
      probe: null,
      parsedJson: null,
      eventCount: 0,
      message: 'A connector is required to run this source test.',
      hint: null,
      usedSyntheticSample: false,
    }
  }
  let probe: ConnectorAuthTestResponse
  try {
    probe = await runConnectorAuthTest(args.probePayload)
  } catch (err) {
    return failureFromCaught(sourceKind, err, false)
  }
  if (!probe.ok) {
    return {
      sourceKind,
      connectionStatus: 'fail',
      sampleStatus: 'failed',
      httpResult: null,
      probe,
      parsedJson: null,
      eventCount: 0,
      message: probe.message ?? 'Connection Failed',
      hint: args.connectionFailHint,
      usedSyntheticSample: false,
    }
  }
  let res: HttpApiTestResponse
  try {
    res = await runHttpApiTest({
      connector_id: connectorId,
      source_config: {},
      stream_config: buildStreamHttpConfigFromStreamRead(stream, cfg),
      checkpoint: null,
      fetch_sample: true,
    })
  } catch (err) {
    return { ...failureFromCaught(sourceKind, err, true), probe }
  }
  if (!res.ok) {
    return {
      sourceKind,
      connectionStatus: 'pass',
      sampleStatus: 'failed',
      httpResult: res,
      probe,
      parsedJson: parsedJsonFromSample(sourceKind, res),
      eventCount: 0,
      message: res.message ?? res.error_type ?? 'Sample fetch failed',
      hint: 'Connection succeeded. Sample fetch failed. No synthetic sample was generated.',
      usedSyntheticSample: false,
    }
  }
  const parsedJson = parsedJsonFromSample(sourceKind, res)
  const eventCount = countSampleRecords(sourceKind, res)
  if (eventCount === 0) {
    return {
      sourceKind,
      connectionStatus: 'pass',
      sampleStatus: 'no_records',
      httpResult: res,
      probe,
      parsedJson,
      eventCount: 0,
      message: args.noRecordsMessage,
      hint: args.noRecordsHint,
      usedSyntheticSample: false,
    }
  }
  return {
    sourceKind,
    connectionStatus: 'pass',
    sampleStatus: 'available',
    httpResult: res,
    probe,
    parsedJson,
    eventCount,
    message: null,
    hint: null,
    usedSyntheticSample: false,
  }
}

/**
 * Standalone Stream Test — same runtime preview contract as Wizard.
 * Uses saved stream + source type. Never synthesizes sample events.
 */
export async function runStandaloneStreamSourceTest(args: {
  sourceKind: StandaloneStreamSourceKind
  stream: StreamRead
  cfg: MappingUIConfigResponse
  connectorId: number | null
  httpOverrides?: StandaloneHttpOverrides | null
}): Promise<StandaloneStreamTestResult> {
  const { sourceKind, stream, cfg, connectorId, httpOverrides } = args

  if (sourceKind === 'AI_PROXY_RECEIVER' || sourceKind === 'UNSUPPORTED') {
    return unsupportedResult(sourceKind)
  }

  if (sourceKind === 'WEBHOOK_RECEIVER') {
    return buildWebhookStandaloneSampleResult(cfg.source_config)
  }

  if (sourceKind === 'S3_OBJECT_POLLING') {
    return runProbeThenSample({
      sourceKind,
      stream,
      cfg,
      connectorId,
      probePayload: { connector_id: connectorId ?? undefined, method: 'GET', test_path: '/' },
      connectionFailHint: 'Verify endpoint URL, bucket, credentials, and IAM (s3:ListBucket, s3:GetObject).',
      noRecordsMessage: 'Connection succeeded. Sample data is not available (no records).',
      noRecordsHint: 'Upload at least one JSON/NDJSON object under the configured bucket and prefix, then retry sample fetch.',
    })
  }

  if (sourceKind === 'DATABASE_QUERY') {
    const sc = cfg.source_config ?? {}
    const streamCfg = (stream.config_json ?? {}) as Record<string, unknown>
    const query = String(streamCfg.query ?? sc.query ?? '').trim()
    return runProbeThenSample({
      sourceKind,
      stream,
      cfg,
      connectorId,
      probePayload: { connector_id: connectorId ?? undefined, method: 'GET', test_path: '/' },
      missingConfigMessage: query ? null : 'stream_config.query is required on the stream before fetching a database sample.',
      connectionFailHint: 'Verify host, database name, credentials, and db_type (PostgreSQL).',
      noRecordsMessage: 'Connection succeeded. Query succeeded. Sample data is not available (no records).',
      noRecordsHint: 'The query ran successfully but returned no rows. No synthetic sample was generated.',
    })
  }

  if (sourceKind === 'REMOTE_FILE_POLLING') {
    const sc = cfg.source_config ?? {}
    const streamCfg = (stream.config_json ?? {}) as Record<string, unknown>
    const remoteDirectory = String(streamCfg.remote_directory ?? sc.remote_directory ?? '').trim()
    const filePattern = String(streamCfg.file_pattern ?? sc.file_pattern ?? '*').trim() || '*'
    const recursive = Boolean(streamCfg.recursive ?? sc.recursive ?? false)
    return runProbeThenSample({
      sourceKind,
      stream,
      cfg,
      connectorId,
      probePayload: {
        connector_id: connectorId ?? undefined,
        method: 'GET',
        test_path: '/',
        remote_file_stream_config: {
          remote_directory: remoteDirectory,
          file_pattern: filePattern,
          recursive,
        },
      },
      missingConfigMessage: remoteDirectory
        ? null
        : 'remote_directory is required on the stream before fetching a remote file sample.',
      connectionFailHint: 'Verify SSH host, credentials, known_hosts policy, and remote_directory.',
      noRecordsMessage: 'Connection succeeded. Sample data is not available (no records).',
      noRecordsHint: 'No matching remote files were parsed. No synthetic sample was generated.',
    })
  }

  const payload = buildHttpRequestPayload(stream, cfg, connectorId, httpOverrides)
  const endpoint = String(payload.stream_config.endpoint ?? '').trim()
  if (!endpoint) {
    return {
      sourceKind: 'HTTP_API_POLLING',
      connectionStatus: 'fail',
      sampleStatus: 'failed',
      httpResult: null,
      probe: null,
      parsedJson: null,
      eventCount: 0,
      message: 'Endpoint path is required.',
      hint: null,
      usedSyntheticSample: false,
    }
  }
  if (connectorId == null && !String((payload.source_config as { base_url?: string }).base_url ?? '').trim()) {
    return {
      sourceKind: 'HTTP_API_POLLING',
      connectionStatus: 'fail',
      sampleStatus: 'failed',
      httpResult: null,
      probe: null,
      parsedJson: null,
      eventCount: 0,
      message: 'Base URL is required when no connector is attached.',
      hint: null,
      usedSyntheticSample: false,
    }
  }
  let res: HttpApiTestResponse
  try {
    res = await runHttpApiTest(payload)
  } catch (err) {
    return failureFromCaught('HTTP_API_POLLING', err, false)
  }
  if (!res.ok) {
    return {
      sourceKind: 'HTTP_API_POLLING',
      connectionStatus: 'fail',
      sampleStatus: 'failed',
      httpResult: res,
      probe: null,
      parsedJson: res.response?.parsed_json ?? null,
      eventCount: 0,
      message: res.message ?? res.error_type ?? 'Request failed',
      hint: null,
      usedSyntheticSample: false,
    }
  }
  const parsedJson = res.response?.parsed_json ?? null
  const eventCount = countSampleRecords('HTTP_API_POLLING', res)
  if (parsedJson === null || parsedJson === undefined) {
    return {
      sourceKind: 'HTTP_API_POLLING',
      connectionStatus: 'pass',
      sampleStatus: 'no_records',
      httpResult: res,
      probe: null,
      parsedJson: null,
      eventCount: 0,
      message: 'Connection succeeded. Sample data is not available (no records).',
      hint: null,
      usedSyntheticSample: false,
    }
  }
  if (Array.isArray(parsedJson) && eventCount === 0) {
    return {
      sourceKind: 'HTTP_API_POLLING',
      connectionStatus: 'pass',
      sampleStatus: 'no_records',
      httpResult: res,
      probe: null,
      parsedJson,
      eventCount: 0,
      message: 'Connection succeeded. Sample data is not available (no records).',
      hint: null,
      usedSyntheticSample: false,
    }
  }
  return {
    sourceKind: 'HTTP_API_POLLING',
    connectionStatus: 'pass',
    sampleStatus: 'available',
    httpResult: res,
    probe: null,
    parsedJson,
    eventCount,
    message: null,
    hint: null,
    usedSyntheticSample: false,
  }
}
