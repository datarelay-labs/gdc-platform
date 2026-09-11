import type { StreamConsoleRow } from '../api/streamRows'
import type { OperationalHealthStatus, OperationalStreamSnapshot } from '../api/operationalSnapshot'
import { resolveSourceProductLabel, type ProductStreamGroup } from './source-product-group'
import {
  effectiveStreamSeverity,
  normalizeSeverityInput,
  type StreamOperationalSeverity,
} from './stream-operational-status'
import type { StreamsMetricsWindow, StreamsOperationalFilter } from '../constants/streamConsoleFilters'
import { deriveStreamIssueCauses } from './stream-console-issue-causes'

export type StreamsQuickFilter = 'all' | 'healthy' | 'warning' | 'critical' | 'issues'

export type { StreamsOperationalFilter }

export type StreamOperationsSummary = {
  healthy: number
  warning: number
  critical: number
  issues: number
}

export type ProblemStreamItem = {
  row: StreamConsoleRow
  productLabel: string
  issueCount: number
  severity: StreamOperationalSeverity
}

const SEVERITY_SORT_RANK: Record<StreamOperationalSeverity, number> = {
  critical: 3,
  warning: 2,
  stopped: 1,
  healthy: 0,
}

const GROUP_OPS_SORT_RANK: Record<StreamOperationalSeverity, number> = {
  critical: 4,
  stopped: 3,
  warning: 2,
  healthy: 0,
}

export function streamProductLabel(row: StreamConsoleRow): string {
  return resolveSourceProductLabel(row.connectorName, { product_group: row.connectorProductGroup })
}

export function streamIssueCount(row: StreamConsoleRow, metricsWindow: StreamsMetricsWindow = '1h'): number {
  return deriveStreamIssueCauses(row, metricsWindow).length
}

export function streamOperationalSeverity(row: StreamConsoleRow): StreamOperationalSeverity {
  return effectiveStreamSeverity(normalizeSeverityInput(row))
}

export function matchesQuickFilter(row: StreamConsoleRow, filter: StreamsQuickFilter): boolean {
  if (filter === 'all') return true
  const severity = streamOperationalSeverity(row)
  if (filter === 'healthy') return severity === 'healthy'
  if (filter === 'warning') return severity === 'warning'
  if (filter === 'critical') return severity === 'critical'
  if (filter === 'issues') return severity === 'warning' || severity === 'critical'
  return true
}

/**
 * Dashboard-aligned operational issue filter using snapshot health_status
 * (IDLE = no-data, DEGRADED = low-volume) — same criteria as dashboard charter metrics.
 */
export function streamIdsMatchingOperationalFilter(
  streams: readonly Pick<
    OperationalStreamSnapshot,
    'stream_id' | 'enabled' | 'health_status' | 'open_schema_field_drift_count'
  >[],
  filter: StreamsOperationalFilter,
): Set<number> {
  const out = new Set<number>()
  for (const s of streams) {
    if (!s.enabled) continue
    const health = String(s.health_status ?? '').toUpperCase() as OperationalHealthStatus | string
    if (filter === 'no-data' && health === 'IDLE') out.add(s.stream_id)
    if (filter === 'low-volume' && health === 'DEGRADED') out.add(s.stream_id)
    if (filter === 'schema-drift' && (s.open_schema_field_drift_count ?? 0) > 0) out.add(s.stream_id)
  }
  return out
}

/** Fallback when operational snapshot is not yet available. */
export function matchesOperationalFilterFallback(
  row: StreamConsoleRow,
  filter: StreamsOperationalFilter,
): boolean {
  if (filter === 'no-data') {
    if (!row.hasRuntimeApiSnapshot) return true
    return row.status === 'STOPPED' && (row.eps1m ?? 0) <= 0 && row.ingestEps <= 0
  }
  if (filter === 'schema-drift') {
    return (row.openSchemaFieldDriftCount ?? 0) > 0
  }
  return row.status === 'DEGRADED'
}

export function streamMatchesSearch(
  row: StreamConsoleRow,
  query: string,
  destinationLabels: readonly string[] = [],
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const productLabel = streamProductLabel(row)
  const fields = [row.name, row.connectorName, productLabel, row.connectorProductGroup ?? '', ...destinationLabels]
  return fields.some((field) => String(field).toLowerCase().includes(q))
}

export function compareStreamsProblemFirst(a: StreamConsoleRow, b: StreamConsoleRow): number {
  const sa = streamOperationalSeverity(a)
  const sb = streamOperationalSeverity(b)
  const rankDelta = SEVERITY_SORT_RANK[sb] - SEVERITY_SORT_RANK[sa]
  if (rankDelta !== 0) return rankDelta
  const issueDelta = streamIssueCount(b) - streamIssueCount(a)
  if (issueDelta !== 0) return issueDelta
  return a.name.localeCompare(b.name)
}

export function sortStreamsProblemFirst(rows: readonly StreamConsoleRow[]): StreamConsoleRow[] {
  return [...rows].sort(compareStreamsProblemFirst)
}

export function compareGroupsProblemFirst(
  a: Pick<ProductStreamGroup<StreamConsoleRow>, 'productLabel' | 'operationalSeverity'>,
  b: Pick<ProductStreamGroup<StreamConsoleRow>, 'productLabel' | 'operationalSeverity'>,
): number {
  const rankDelta = GROUP_OPS_SORT_RANK[b.operationalSeverity] - GROUP_OPS_SORT_RANK[a.operationalSeverity]
  if (rankDelta !== 0) return rankDelta
  return a.productLabel.localeCompare(b.productLabel)
}

export function sortGroupsProblemFirst<T extends ProductStreamGroup<StreamConsoleRow>>(groups: readonly T[]): T[] {
  return [...groups].sort(compareGroupsProblemFirst)
}

export function filterStreamRows(input: {
  rows: readonly StreamConsoleRow[]
  searchQuery: string
  quickFilter: StreamsQuickFilter
  groupFilter: string
  connectorFilter: string | null
  destinationLabelsByStreamId: ReadonlyMap<number, string[]>
  /** Dashboard drill-down: ?filter=no-data|low-volume|schema-drift */
  operationalFilter?: StreamsOperationalFilter | null
  /** Prefer snapshot-derived ids when available; else row fallback. */
  operationalFilterStreamIds?: ReadonlySet<number> | null
}): StreamConsoleRow[] {
  const {
    rows,
    searchQuery,
    quickFilter,
    groupFilter,
    connectorFilter,
    destinationLabelsByStreamId,
    operationalFilter = null,
    operationalFilterStreamIds = null,
  } = input
  let out = rows.filter((row) => matchesQuickFilter(row, quickFilter))
  if (operationalFilter) {
    if (operationalFilterStreamIds) {
      out = out.filter((row) => {
        const sid = Number(row.id)
        return Number.isFinite(sid) && operationalFilterStreamIds.has(sid)
      })
    } else {
      out = out.filter((row) => matchesOperationalFilterFallback(row, operationalFilter))
    }
  }
  if (connectorFilter) {
    out = out.filter((row) => streamMatchesConnectorFilter(row, connectorFilter))
  }
  if (groupFilter !== 'all') {
    out = out.filter((row) => streamProductLabel(row) === groupFilter)
  }
  if (searchQuery.trim()) {
    out = out.filter((row) => {
      const sid = Number(row.id)
      const destLabels = Number.isFinite(sid) ? (destinationLabelsByStreamId.get(sid) ?? []) : []
      return streamMatchesSearch(row, searchQuery, destLabels)
    })
  }
  return sortStreamsProblemFirst(out)
}

export function streamMatchesConnectorFilter(row: StreamConsoleRow, filter: string): boolean {
  const slug = filter.trim()
  if (!slug) return true
  if (/^\d+$/.test(slug)) {
    return row.connectorId != null && String(row.connectorId) === slug
  }
  const name = String(row.connectorName ?? '').trim().toLowerCase()
  return name.length > 0 && name === slug.toLowerCase()
}

export function computeStreamOperationsSummary(rows: readonly StreamConsoleRow[]): StreamOperationsSummary {
  let healthy = 0
  let warning = 0
  let critical = 0
  for (const row of rows) {
    const severity = streamOperationalSeverity(row)
    if (severity === 'critical') critical += 1
    else if (severity === 'warning') warning += 1
    else if (severity === 'healthy') healthy += 1
  }
  return { healthy, warning, critical, issues: warning + critical }
}

export function buildProblemStreamItems(rows: readonly StreamConsoleRow[]): ProblemStreamItem[] {
  const items: ProblemStreamItem[] = []
  for (const row of rows) {
    const severity = streamOperationalSeverity(row)
    if (severity !== 'warning' && severity !== 'critical') continue
    items.push({
      row,
      productLabel: streamProductLabel(row),
      issueCount: streamIssueCount(row),
      severity,
    })
  }
  items.sort((a, b) => compareStreamsProblemFirst(a.row, b.row))
  return items
}

export function productGroupOptions(rows: readonly StreamConsoleRow[]): string[] {
  const labels = new Set<string>()
  for (const row of rows) labels.add(streamProductLabel(row))
  return [...labels].sort((a, b) => a.localeCompare(b))
}
