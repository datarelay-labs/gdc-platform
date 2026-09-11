import type { MappingUIConfigResponse, StreamRead } from '../api/types/gdcApi'
import { firstNonEmptySourceType, normalizeGdcStreamSourceType } from './sourceTypePresentation'

export function resolveStreamEndpointPath(
  configJson: Record<string, unknown> | null | undefined,
  sourceConfig?: Record<string, unknown> | null,
): string {
  const cfg = configJson ?? {}
  const sc = sourceConfig ?? {}
  const direct = String(cfg.endpoint ?? cfg.endpoint_path ?? sc.endpoint_path ?? sc.endpoint ?? cfg.path ?? '').trim()
  if (direct) return direct
  const baseUrl = String(cfg.base_url ?? sc.base_url ?? '').trim()
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    try {
      const path = new URL(baseUrl).pathname
      if (path && path !== '/') return path
    } catch {
      /* ignore malformed URL */
    }
  }
  return ''
}

/**
 * Build `stream_config` for `POST /runtime/api-test/http` from persisted stream + mapping-ui rows.
 * Shared by Wizard sample, Mapping source sample, and standalone Stream Test so the same
 * saved stream + source type produces the same runtime preview contract.
 */
export function buildStreamHttpConfigFromStreamRead(
  stream: StreamRead,
  cfg: MappingUIConfigResponse,
): Record<string, unknown> {
  const sc = cfg.source_config ?? {}
  const cfgj = (stream.config_json ?? {}) as Record<string, unknown>
  const sourceType = normalizeGdcStreamSourceType(
    firstNonEmptySourceType(cfg.source_type, stream.source_type, stream.stream_type),
  )
  if (sourceType === 'S3_OBJECT_POLLING') {
    const rawMax = cfgj.max_objects_per_run
    const maxObjects =
      typeof rawMax === 'number' && Number.isFinite(rawMax)
        ? rawMax
        : typeof rawMax === 'string' && rawMax.trim()
          ? Number.parseInt(rawMax.trim(), 10) || 20
          : 20
    return { max_objects_per_run: Math.max(1, Math.floor(maxObjects)) }
  }
  if (sourceType === 'REMOTE_FILE_POLLING') {
    return {
      remote_directory: String(cfgj.remote_directory ?? sc.remote_directory ?? '').trim(),
      file_pattern: String(cfgj.file_pattern ?? sc.file_pattern ?? '*').trim() || '*',
      recursive: Boolean(cfgj.recursive ?? sc.recursive ?? false),
      parser_type: cfgj.parser_type ?? sc.parser_type,
      max_files_per_run: cfgj.max_files_per_run ?? sc.max_files_per_run ?? 10,
      max_file_size_mb: cfgj.max_file_size_mb ?? sc.max_file_size_mb ?? 5,
      encoding: cfgj.encoding ?? sc.encoding ?? 'utf-8',
      csv_delimiter: cfgj.csv_delimiter ?? sc.csv_delimiter,
      line_event_field: cfgj.line_event_field ?? sc.line_event_field,
      include_file_metadata: cfgj.include_file_metadata ?? sc.include_file_metadata,
    }
  }
  if (sourceType === 'DATABASE_QUERY') {
    const query = String(cfgj.query ?? sc.query ?? '').trim()
    const out: Record<string, unknown> = { query }
    const timeout = cfgj.query_timeout_seconds ?? sc.query_timeout_seconds ?? cfgj.timeout_seconds
    if (timeout != null) out.query_timeout_seconds = timeout
    return out
  }
  const ep = resolveStreamEndpointPath(cfgj, sc)
  const m = String(cfgj.method ?? cfgj.http_method ?? (sc as { http_method?: string }).http_method ?? 'GET').toUpperCase()
  const method = m === 'POST' ? 'POST' : 'GET'
  const params = (cfgj.params ?? {}) as Record<string, unknown>
  const hdrRaw = cfgj.headers
  const headers: Record<string, unknown> = {}
  if (hdrRaw && typeof hdrRaw === 'object' && !Array.isArray(hdrRaw)) {
    Object.assign(headers, hdrRaw as Record<string, unknown>)
  }
  const body = cfgj.body ?? cfgj.request_body
  const ts = cfgj.timeout_seconds ?? cfgj.timeout_sec ?? (sc as { timeout_sec?: unknown }).timeout_sec
  const timeoutSeconds =
    typeof ts === 'number' && Number.isFinite(ts)
      ? ts
      : typeof ts === 'string' && ts.trim()
        ? Number.parseInt(ts.trim(), 10) || 30
        : 30

  const streamCfg: Record<string, unknown> = {
    method,
    endpoint: ep,
    timeout_seconds: timeoutSeconds,
    params,
  }
  if (Object.keys(headers).length) streamCfg.headers = headers
  if (body !== undefined) streamCfg.body = body
  return streamCfg
}

export function connectorBaseUrlFromMappingUi(
  stream: StreamRead,
  cfg: MappingUIConfigResponse,
): string {
  const sc = cfg.source_config ?? {}
  const cfgj = (stream.config_json ?? {}) as Record<string, unknown>
  const baseFromSource = String((sc as { base_url?: string }).base_url ?? '').trim()
  const baseFromStream = String(cfgj.base_url ?? '').trim()
  return baseFromStream || baseFromSource
}
