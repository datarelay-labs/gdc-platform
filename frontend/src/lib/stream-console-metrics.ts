import type { StreamConsoleRow, StreamRuntimeStatus } from '../api/streamRows'
import type { StreamsMetricsWindow } from '../constants/streamConsoleFilters'
import { resolveSourceTypePresentation } from '../utils/sourceTypePresentation'
import {
  aggregateGroupIssueCauses,
  sortIssueCausesByPriority,
  streamOperationalHealthLabel,
} from './stream-console-issue-causes'
import {
  effectiveStreamSeverity,
  normalizeSeverityInput,
  severityToRuntimeStatus,
  worstOperationalSeverity,
  type StreamOperationalSeverity,
} from './stream-operational-status'
import { formatOperationalPercentKnown, formatThroughputEps } from './observability-format'
import { parseApiTimestampMs, formatPlatformRelative as formatRelativeShort } from './platform-timestamps'

export { parseApiTimestampMs, formatRelativeShort } from './platform-timestamps'

/** Align with backend checkpoint lag warning threshold (1 hour). */
export const CHECKPOINT_FRESH_MS = 3_600_000

export type GroupHealthLabel = 'Healthy' | 'Warning' | 'Critical' | 'Stopped'

export function groupHealthLabel(status: StreamRuntimeStatus): GroupHealthLabel {
  switch (status) {
    case 'ERROR':
      return 'Critical'
    case 'DEGRADED':
      return 'Warning'
    case 'STOPPED':
      return 'Stopped'
    case 'RUNNING':
    case 'UNKNOWN':
    default:
      return 'Healthy'
  }
}

export function groupHealthLabelFromSeverity(severity: StreamOperationalSeverity): GroupHealthLabel {
  return streamOperationalHealthLabel(severity)
}

export function groupHealthToneFromSeverity(severity: StreamOperationalSeverity): 'success' | 'warning' | 'error' | 'neutral' {
  switch (severity) {
    case 'critical':
      return 'error'
    case 'warning':
      return 'warning'
    case 'stopped':
      return 'neutral'
    default:
      return 'success'
  }
}

export function groupHealthTone(status: StreamRuntimeStatus): 'success' | 'warning' | 'error' | 'neutral' {
  switch (status) {
    case 'ERROR':
      return 'error'
    case 'DEGRADED':
      return 'warning'
    case 'STOPPED':
      return 'neutral'
    case 'RUNNING':
    case 'UNKNOWN':
    default:
      return 'success'
  }
}

/** Approximate events/sec from a 1h event count. */
export function eventsPerSecFromHourly(events1h: number): number {
  return eventsPerSecFromWindow(events1h, 3600)
}

/** Events/sec for an arbitrary rolling window length. */
export function eventsPerSecFromWindow(events: number, windowSeconds: number): number {
  if (!Number.isFinite(events) || events <= 0) return 0
  const win = Math.max(1, windowSeconds)
  return events / win
}

export function formatEventsPerSecRate(events1h: number, windowSeconds = 3600): string {
  const eps = eventsPerSecFromWindow(events1h, windowSeconds)
  if (eps >= 1000) return `${(eps / 1000).toFixed(1)}K /s`
  if (eps >= 1) return `${formatThroughputEps(eps)} /s`
  if (eps > 0) return `${formatThroughputEps(eps)} /s`
  return '0 /s'
}

/** Group header summary — mockup uses "12.4K events/sec" instead of "/s". */
export function formatGroupEventsPerSecRate(events1h: number): string {
  const eps = eventsPerSecFromHourly(events1h)
  if (eps >= 1000) return `${(eps / 1000).toFixed(1)}K events/sec`
  if (eps >= 1) return `${formatThroughputEps(eps)} events/sec`
  if (eps > 0) return `${formatThroughputEps(eps)} events/sec`
  return '0 events/sec'
}

export function groupHealthAccentClass(status: StreamRuntimeStatus): string {
  switch (status) {
    case 'ERROR':
      return 'border-l-red-500'
    case 'DEGRADED':
      return 'border-l-amber-500'
    case 'STOPPED':
      return 'border-l-slate-500 dark:border-l-slate-600'
    case 'RUNNING':
    case 'UNKNOWN':
    default:
      return 'border-l-emerald-500'
  }
}

export function formatSuccessRate(pct: number, known: boolean): string {
  return formatOperationalPercentKnown(pct, known)
}

export type StreamRateRow = {
  events1h: number
  ingestEps: number
  eps1m?: number | null
  eps5m?: number | null
  successRate5m?: number | null
  deliveryPct: number
  deliveryPctKnown: boolean
  hasRuntimeApiSnapshot: boolean
  eventsTrend?: readonly number[]
}

function resolveIngestEps(row: StreamRateRow): number {
  if (row.ingestEps > 0) return row.ingestEps
  if (row.eps1m != null && row.eps1m > 0) return row.eps1m
  if (row.eps5m != null && row.eps5m > 0) return row.eps5m
  return 0
}

/** True when the stream has measurable delivery/ingest throughput in the metrics window. */
export function hasRecentDeliveryOutcomes(row: StreamRateRow): boolean {
  return resolveIngestEps(row) > 0
}

export function streamUsesCheckpointObservability(
  row: Pick<StreamConsoleRow, 'streamTypeKey'>,
): boolean {
  return resolveSourceTypePresentation(row.streamTypeKey).runtime.showCheckpointObservability
}

function resolveSuccessPct(row: StreamRateRow): number | null {
  if (!hasRecentDeliveryOutcomes(row)) return null
  if (row.successRate5m != null && Number.isFinite(row.successRate5m)) return row.successRate5m
  if (row.deliveryPctKnown) return row.deliveryPct
  return null
}

/** When throughput-weighted success is unavailable, inherit from any child with a known rate. */
export function aggregateKnownSuccessPctFallback(rows: readonly StreamRateRow[]): number | null {
  let weightedSum = 0
  let weightTotal = 0
  let simpleSum = 0
  let simpleCount = 0

  for (const row of rows) {
    if (!row.hasRuntimeApiSnapshot) continue
    const pct = resolveSuccessPct(row)
    if (pct == null) continue
    simpleSum += pct
    simpleCount += 1
    const ingest = resolveIngestEps(row)
    const weight = ingest > 0 ? ingest : row.events1h > 0 ? row.events1h : 0
    if (weight > 0) {
      weightedSum += pct * weight
      weightTotal += weight
    }
  }

  if (simpleCount === 0) return null
  if (weightTotal > 0) return weightedSum / weightTotal
  return simpleSum / simpleCount
}

export function formatIngestEpsLabel(eps: number): string {
  if (!Number.isFinite(eps) || eps <= 0) return '0 events/sec'
  if (eps >= 1000) return `${(eps / 1000).toFixed(1)}K events/sec`
  return `${formatThroughputEps(eps)} events/sec`
}

export function sparklineHasTrend(values: readonly number[]): boolean {
  if (values.length < 2) return false
  const first = values[0] ?? 0
  return values.some((v) => v !== first)
}

export function ingestRateLabel(row: StreamRateRow): string {
  if (!row.hasRuntimeApiSnapshot) return '—'
  return formatIngestEpsLabel(resolveIngestEps(row))
}

export function deliveryRateLabel(row: StreamRateRow): string {
  if (!row.hasRuntimeApiSnapshot) return '—'
  const ingest = resolveIngestEps(row)
  const successPct = resolveSuccessPct(row)
  if (ingest <= 0) return '0 events/sec'
  if (successPct == null) return '—'
  return formatIngestEpsLabel((ingest * successPct) / 100)
}

export function streamSuccessRateDisplay(row: StreamRateRow): { pct: number | null; known: boolean } {
  if (!hasRecentDeliveryOutcomes(row)) {
    return { pct: null, known: false }
  }
  if (row.successRate5m != null && Number.isFinite(row.successRate5m)) {
    return { pct: row.successRate5m, known: true }
  }
  return { pct: row.deliveryPct, known: row.deliveryPctKnown }
}

export function checkpointFreshnessLabel(
  iso: string | null | undefined,
  isLagging: boolean,
): 'Healthy' | 'Stale' | null {
  if (isLagging || !iso || iso === '—') return null
  const t = parseApiTimestampMs(iso)
  if (t == null) return null
  const ageMs = Date.now() - t
  if (ageMs < 0) return null
  return ageMs <= CHECKPOINT_FRESH_MS ? 'Healthy' : 'Stale'
}

export type AggregateGroupRates = {
  ingestLabel: string
  deliveryLabel: string
  successLabel: string
  successPct: number | null
  totalEvents: number
  totalDelivered: number
  hasAny: boolean
  hasDelivery: boolean
}

export function aggregateGroupRates(rows: readonly StreamRateRow[]): AggregateGroupRates {
  let totalEvents = 0
  let totalDelivered = 0
  let totalIngestEps = 0
  let totalDeliveredEps = 0
  let hasAny = false
  let hasDelivery = false

  for (const row of rows) {
    if (!row.hasRuntimeApiSnapshot) continue
    hasAny = true
    const ingest = resolveIngestEps(row)
    totalIngestEps += ingest
    totalEvents += row.events1h
    const successPct = resolveSuccessPct(row)
    if (successPct != null) {
      hasDelivery = true
      totalDeliveredEps += (ingest * successPct) / 100
      totalDelivered += (row.events1h * successPct) / 100
    }
  }

  const successPct =
    totalIngestEps > 0 && hasDelivery
      ? (100 * totalDeliveredEps) / totalIngestEps
      : totalEvents > 0 && hasDelivery
        ? (100 * totalDelivered) / totalEvents
        : hasDelivery
          ? aggregateKnownSuccessPctFallback(rows)
          : null

  return {
    ingestLabel: hasAny ? formatIngestEpsLabel(totalIngestEps) : '—',
    deliveryLabel: hasDelivery ? formatIngestEpsLabel(totalDeliveredEps) : '—',
    successLabel: successPct != null ? formatSuccessRate(successPct, true) : '—',
    successPct,
    totalEvents,
    totalDelivered,
    hasAny,
    hasDelivery,
  }
}

function sumSeries(series: readonly (readonly number[])[]): number[] {
  if (!series.length) return []
  const len = Math.max(...series.map((s) => s.length))
  const out = new Array(len).fill(0)
  for (const s of series) {
    for (let i = 0; i < len; i += 1) out[i]! += s[i] ?? 0
  }
  return out
}

export function aggregateGroupSparklines(rows: readonly StreamRateRow[]): {
  ingest: number[]
  delivery: number[]
  success: number[]
} {
  const ingestSeries: number[][] = []
  const deliverySeries: number[][] = []
  const successSeries: number[][] = []

  for (const row of rows) {
    if (!row.hasRuntimeApiSnapshot) continue
    const ingestTrend = row.eventsTrend?.length ? [...row.eventsTrend] : []
    if (ingestTrend.length >= 2) {
      ingestSeries.push(ingestTrend)
      const successPct = resolveSuccessPct(row)
      if (successPct != null) {
        deliverySeries.push(ingestTrend.map((v) => (v * successPct) / 100))
        successSeries.push(ingestTrend.map(() => successPct))
      }
      continue
    }
    const ingest = resolveIngestEps(row)
    if (ingest > 0) ingestSeries.push([ingest])
    const successPct = resolveSuccessPct(row)
    if (successPct != null) {
      if (ingest > 0) {
        deliverySeries.push([(ingest * successPct) / 100])
      }
      successSeries.push([successPct])
    }
  }

  return {
    ingest: sumSeries(ingestSeries),
    delivery: sumSeries(deliverySeries),
    success: sumSeries(successSeries),
  }
}

export type GroupOperationalStats = {
  operationalSeverity: StreamOperationalSeverity
  worstStatus: StreamRuntimeStatus
  criticalCount: number
  warningCount: number
  stoppedCount: number
  healthyCount: number
  issueCount: number
  totalEvents: number
}

/**
 * Group status = worst stream operational severity (inheritance, not count/average).
 * Critical > Warning > Stopped > Healthy.
 */
export function computeGroupOperationalStats(rows: readonly StreamConsoleRow[]): GroupOperationalStats {
  let criticalCount = 0
  let warningCount = 0
  let stoppedCount = 0
  let healthyCount = 0
  let totalEvents = 0
  const severities: StreamOperationalSeverity[] = []

  for (const row of rows) {
    const severity = effectiveStreamSeverity(normalizeSeverityInput(row))
    severities.push(severity)
    if (severity === 'critical') criticalCount += 1
    else if (severity === 'warning') warningCount += 1
    else if (severity === 'stopped') stoppedCount += 1
    else healthyCount += 1
    if (row.hasRuntimeApiSnapshot) totalEvents += row.events1h
  }

  const operationalSeverity = rows.length ? worstOperationalSeverity(severities) : 'healthy'

  return {
    operationalSeverity,
    worstStatus: severityToRuntimeStatus(operationalSeverity),
    criticalCount,
    warningCount,
    stoppedCount,
    healthyCount,
    issueCount: criticalCount + warningCount,
    totalEvents,
  }
}

export function formatCompactEventCount(totalEvents: number): string {
  if (totalEvents <= 0) return ''
  if (totalEvents >= 1_000_000) return `${(totalEvents / 1_000_000).toFixed(1)}M Events`
  if (totalEvents >= 1_000) return `${(totalEvents / 1_000).toFixed(1)}K Events`
  return `${totalEvents.toLocaleString()} Events`
}

export function formatGroupHeaderSummary(stats: GroupOperationalStats): string {
  const streamCount = stats.criticalCount + stats.warningCount + stats.stoppedCount + stats.healthyCount
  const parts: string[] = [`${streamCount} Stream${streamCount === 1 ? '' : 's'}`]
  if (stats.criticalCount > 0) parts.push(`${stats.criticalCount} Critical`)
  if (stats.warningCount > 0) parts.push(`${stats.warningCount} Warning`)
  if (stats.stoppedCount > 0) parts.push(`${stats.stoppedCount} Stopped`)
  const eventsLabel = formatCompactEventCount(stats.totalEvents)
  if (eventsLabel) parts.push(eventsLabel)
  return parts.join(' · ')
}

export type GroupIssueBreakdown = {
  total: number
  critical: number
  warning: number
  label: string
  causes: readonly string[]
  hiddenCount: number
}

export function aggregateGroupIssueBreakdown(
  rows: readonly Pick<StreamConsoleRow, 'status' | 'routesError' | 'routesDegraded' | 'deliveryPctKnown' | 'deliveryPct' | 'hasRuntimeApiSnapshot' | 'runtimeStatsAttempted' | 'events1h' | 'recentErrors' | 'checkpointLagLabel'>[],
  metricsWindow: StreamsMetricsWindow = '1h',
): GroupIssueBreakdown {
  const fullRows = rows as StreamConsoleRow[]
  const aggregated = aggregateGroupIssueCauses(fullRows, metricsWindow)
  const stats = computeGroupOperationalStats(fullRows)
  return {
    total: aggregated.streamCount,
    critical: stats.criticalCount,
    warning: stats.warningCount,
    label: aggregated.label,
    causes: sortIssueCausesByPriority(aggregated.causes),
    hiddenCount: aggregated.hiddenCount,
  }
}

export function groupLastEventLabel(
  rows: readonly Pick<StreamConsoleRow, 'lastActivityRelative' | 'hasRuntimeApiSnapshot'>[],
): string {
  let bestTs = -1
  let bestLabel = '—'
  for (const row of rows) {
    if (!row.hasRuntimeApiSnapshot) continue
    const raw = row.lastActivityRelative
    if (!raw || raw === '—') continue
    const t = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'))
    if (Number.isFinite(t) && t > bestTs) {
      bestTs = t
      bestLabel = formatRelativeShort(raw)
    }
  }
  return bestLabel
}

export type StreamsPageKpi = {
  totalGroups: number
  totalStreams: number
  healthyGroups: number
  warningGroups: number
  criticalGroups: number
  totalIssues: number
  healthyPct: string
  warningPct: string
  criticalPct: string
  /** Stream-level health breakdown (across all individual streams). */
  healthyStreams: number
  warningStreams: number
  criticalStreams: number
  noDataStreams: number
  healthyStreamsPct: string
  warningStreamsPct: string
  criticalStreamsPct: string
  /** Aggregate ingest EPS label from all streams. */
  totalEpsLabel: string
  /** Running/enabled count for sub-label. */
  runningStreams: number
}

export function computeStreamsPageKpi(
  groups: readonly { operationalSeverity: StreamOperationalSeverity; issueCount: number; rows?: readonly StreamConsoleRow[] }[],
  rowsOrTotal: readonly StreamConsoleRow[] | number,
): StreamsPageKpi {
  const totalGroups = groups.length
  let healthyGroups = 0
  let warningGroups = 0
  let criticalGroups = 0
  let totalIssues = 0
  for (const g of groups) {
    totalIssues += g.issueCount
    const label = groupHealthLabelFromSeverity(g.operationalSeverity)
    if (label === 'Healthy') healthyGroups += 1
    else if (label === 'Warning') warningGroups += 1
    else if (label === 'Critical') criticalGroups += 1
  }

  const rows: readonly StreamConsoleRow[] =
    Array.isArray(rowsOrTotal)
      ? (rowsOrTotal as readonly StreamConsoleRow[])
      : groups.flatMap((g) => (g.rows ?? []) as StreamConsoleRow[])

  const totalStreams = typeof rowsOrTotal === 'number' ? rowsOrTotal : rows.length

  let healthyStreams = 0
  let warningStreams = 0
  let criticalStreams = 0
  let noDataStreams = 0
  let runningStreams = 0
  let totalIngestEps = 0

  for (const row of rows) {
    if (row.hasRuntimeApiSnapshot) {
      totalIngestEps += resolveIngestEps(row)
      runningStreams += 1
    }
    const sev = effectiveStreamSeverity(normalizeSeverityInput(row))
    if (sev === 'critical') criticalStreams += 1
    else if (sev === 'warning') warningStreams += 1
    else if (sev === 'stopped' || !row.hasRuntimeApiSnapshot) noDataStreams += 1
    else healthyStreams += 1
  }

  const sPct = (n: number) => (totalStreams > 0 ? `${((100 * n) / totalStreams).toFixed(1)}%` : '—')
  const gPct = (n: number) => (totalGroups > 0 ? `${((100 * n) / totalGroups).toFixed(1)}%` : '—')

  const totalEpsLabel =
    totalIngestEps >= 1000
      ? `${(totalIngestEps / 1000).toFixed(1)}K /s`
      : totalIngestEps > 0
        ? `${totalIngestEps.toFixed(1)} /s`
        : '—'

  return {
    totalGroups,
    totalStreams,
    healthyGroups,
    warningGroups,
    criticalGroups,
    totalIssues,
    healthyPct: gPct(healthyGroups),
    warningPct: gPct(warningGroups),
    criticalPct: gPct(criticalGroups),
    healthyStreams,
    warningStreams,
    criticalStreams,
    noDataStreams,
    healthyStreamsPct: sPct(healthyStreams),
    warningStreamsPct: sPct(warningStreams),
    criticalStreamsPct: sPct(criticalStreams),
    totalEpsLabel,
    runningStreams,
  }
}

export function successRateTone(pct: number | null): StreamOperationalSeverity {
  if (pct == null) return 'healthy'
  if (pct < 85) return 'critical'
  if (pct < 95) return 'warning'
  return 'healthy'
}
