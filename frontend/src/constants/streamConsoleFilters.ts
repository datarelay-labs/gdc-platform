/** Streams console filter dropdown options (labels only; rows come from API). */

export const PRODUCT_FILTER_ALL = 'All products' as const

export const CONNECTOR_FILTER_OPTIONS = [PRODUCT_FILTER_ALL, 'Dev validation lab'] as const

/** Parse ?connector= query param (connector id or lowercase name slug). */
export function parseConnectorFilterFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('connector')?.trim()
  return raw || null
}

/** Dashboard operational drill-down filters supported on `/streams?filter=`. */
export const STREAMS_OPERATIONAL_FILTERS = ['no-data', 'low-volume', 'schema-drift'] as const
export type StreamsOperationalFilter = (typeof STREAMS_OPERATIONAL_FILTERS)[number]

/** Parse ?filter=no-data|low-volume|schema-drift (dashboard operational drill-down). */
export function parseStreamsOperationalFilterFromSearch(search: string): StreamsOperationalFilter | null {
  const raw = new URLSearchParams(search).get('filter')?.trim().toLowerCase()
  if (raw === 'no-data' || raw === 'low-volume' || raw === 'schema-drift') return raw
  return null
}

/** Destinations page: `/destinations?filter=warning` → Warning health filter. */
export function parseDestinationsHealthFilterFromSearch(
  search: string,
): 'Warning' | null {
  const raw = new URLSearchParams(search).get('filter')?.trim().toLowerCase()
  return raw === 'warning' ? 'Warning' : null
}

export function connectorFilterIsNumericId(filter: string): boolean {
  return /^\d+$/.test(filter.trim())
}

/** Match stream row against connector filter slug (case-insensitive). */
export function matchesConnectorFilter(connectorName: string | null | undefined, filter: string): boolean {
  const name = String(connectorName ?? '').trim().toLowerCase()
  const slug = filter.trim().toLowerCase()
  return name.length > 0 && slug.length > 0 && name === slug
}

export const STATUS_FILTER_OPTIONS = ['All Status', 'RUNNING', 'DEGRADED', 'ERROR', 'STOPPED', 'UNKNOWN'] as const

export const INGEST_METHOD_FILTER_OPTIONS = [
  'All ingest methods',
  'HTTP API polling',
  'S3 object polling',
  'Database query',
  'Remote file polling',
  'Webhook receiver',
] as const

/** @deprecated M30.1 — use INGEST_METHOD_FILTER_OPTIONS */
export const SOURCE_FILTER_OPTIONS = INGEST_METHOD_FILTER_OPTIONS

export const AUTO_REFRESH_OPTIONS = ['Off', '15s', '30s', '1m', '5m'] as const

/** Streams console metrics window — aligned with runtime API (`15m`–`30d`). */
export const STREAMS_TIME_RANGE_OPTIONS = ['15m', '1h', '24h', '7d', '30d'] as const

export type StreamsMetricsWindow = (typeof STREAMS_TIME_RANGE_OPTIONS)[number]

export function streamsTimeRangeLabel(window: StreamsMetricsWindow): string {
  switch (window) {
    case '15m':
      return 'Last 15m'
    case '1h':
      return 'Last 1h'
    case '24h':
      return 'Last 24h'
    case '7d':
      return 'Last 7d'
    case '30d':
      return 'Last 30d'
    default:
      return window
  }
}
