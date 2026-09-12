import type { ConnectorRead } from '../api/gdcConnectors'
import type { AuthHealthCheckInterval, ConnectorOperationsRow, ConnectorStreamOpsSummary } from '../api/gdcConnectorsOperations'
import { formatThroughputEps } from './observability-format'

export type ConnectorHealthLabel = 'Healthy' | 'Warning' | 'Critical' | 'Stopped'

export type ConnectorHealthResult = {
  health: ConnectorHealthLabel
  reason: string
}

export type StreamHealthCounts = {
  healthy: number
  warning: number
  critical: number
  stopped: number
  stale: number
  total: number
}

/** Root-cause rank — lower number = higher operator priority. */
const REASON_PRIORITY = {
  authenticationFailed: 1,
  connectionFailed: 2,
  noData: 3,
  sourceError: 4,
  destinationError: 5,
  streamFailed: 6,
  streamWarning: 7,
  authOk: 8,
  none: 99,
} as const

const HEALTH_SORT_RANK: Record<ConnectorHealthLabel, number> = {
  Critical: 4,
  Warning: 3,
  Healthy: 2,
  Stopped: 1,
}

const STALE_EVENT_MS = 3_600_000

export function connectorHealthSortRank(health: ConnectorHealthLabel): number {
  return HEALTH_SORT_RANK[health] ?? 0
}

export function compareConnectorsProblemFirst(
  a: { health: ConnectorHealthLabel; name: string },
  b: { health: ConnectorHealthLabel; name: string },
): number {
  const rankDelta = connectorHealthSortRank(b.health) - connectorHealthSortRank(a.health)
  if (rankDelta !== 0) return rankDelta
  return a.name.localeCompare(b.name)
}

const CONNECTOR_STREAM_HEALTH_RANK: Record<ConnectorStreamOpsSummary['health'], number> = {
  critical: 4,
  warning: 3,
  stopped: 2,
  healthy: 1,
}

/** Sort connected streams: Critical → Warning → Healthy → Stopped. */
export function sortConnectorStreamsProblemFirst(
  streams: readonly ConnectorStreamOpsSummary[],
): ConnectorStreamOpsSummary[] {
  return [...streams].sort((a, b) => {
    const rankDelta =
      (CONNECTOR_STREAM_HEALTH_RANK[b.health] ?? 0) - (CONNECTOR_STREAM_HEALTH_RANK[a.health] ?? 0)
    if (rankDelta !== 0) return rankDelta
    return a.stream_name.localeCompare(b.stream_name)
  })
}

export function formatStreamOpsEps(events1h: number): string {
  const eps = Number.isFinite(events1h) && events1h > 0 ? events1h / 3600 : 0
  if (eps >= 1000) return `${(eps / 1000).toFixed(1)}K`
  return formatThroughputEps(eps)
}

function isConnectorStopped(connector: ConnectorRead): boolean {
  return String(connector.status ?? '').trim().toUpperCase() === 'STOPPED'
}

function authFailed(connector: ConnectorRead): boolean {
  return connector.last_auth_check_status === 'failed'
}

function msSince(iso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const diff = nowMs - t
  return diff >= 0 ? diff : null
}

/** Data freshness thresholds for connector-level warnings. */
export function dataFreshnessReason(lastEventAt: string | null | undefined, nowMs = Date.now()): string | null {
  const ageMs = msSince(lastEventAt, nowMs)
  if (ageMs == null) return 'Never'
  const hours = ageMs / 3_600_000
  if (hours >= 24) return 'No Data (24h)'
  if (hours >= 6) return 'No Data (6h)'
  if (hours >= 1) return 'No Data (1h)'
  return null
}

export function countStreamsByHealth(streams: readonly ConnectorStreamOpsSummary[], nowMs = Date.now()): StreamHealthCounts {
  let healthy = 0
  let warning = 0
  let critical = 0
  let stopped = 0
  let stale = 0
  for (const s of streams) {
    if (s.health === 'critical') critical += 1
    else if (s.health === 'warning') warning += 1
    else if (s.health === 'stopped') stopped += 1
    else healthy += 1

    const isStale =
      s.primary_issue?.startsWith('No Data') ||
      (s.last_success_at != null && (msSince(s.last_success_at, nowMs) ?? 0) >= STALE_EVENT_MS) ||
      (s.health !== 'stopped' && s.events_1h <= 0 && s.primary_issue != null)
    if (isStale && s.health !== 'stopped') stale += 1
  }
  return { healthy, warning, critical, stopped, stale, total: streams.length }
}

/** Popover/table subtitle e.g. "(4 Healthy / 1 Critical)". */
export function formatStreamsHealthSummary(counts: StreamHealthCounts): string | null {
  if (counts.total <= 0) return null
  const parts: string[] = []
  if (counts.healthy > 0) parts.push(`${counts.healthy} Healthy`)
  if (counts.warning > 0) parts.push(`${counts.warning} Warning`)
  if (counts.critical > 0) parts.push(`${counts.critical} Critical`)
  if (counts.stopped > 0) parts.push(`${counts.stopped} Stopped`)
  if (parts.length <= 1 && counts.total === counts.healthy) return null
  return `(${parts.join(' / ')})`
}

/** Popover header lines e.g. "Healthy: 4". */
export function formatStreamsHealthPopoverSummary(counts: StreamHealthCounts): string[] {
  const lines: string[] = []
  if (counts.healthy > 0) lines.push(`Healthy: ${counts.healthy}`)
  if (counts.warning > 0) lines.push(`Warning: ${counts.warning}`)
  if (counts.critical > 0) lines.push(`Critical: ${counts.critical}`)
  if (counts.stopped > 0) lines.push(`Stopped: ${counts.stopped}`)
  return lines
}

export type EventTrendSeverity = 'none' | 'warning' | 'critical_candidate'

export type EventTrendDisplay = {
  label: string
  severity: EventTrendSeverity
  percent: number | null
}

/** Operational traffic-drop hint — does not affect connector health scoring. */
export function formatEventTrendDisplay(trendPercent: number | null | undefined): EventTrendDisplay | null {
  if (trendPercent == null || !Number.isFinite(trendPercent)) return null
  if (trendPercent >= 0) return null
  const drop = Math.abs(trendPercent)
  if (drop < 50) return null
  const severity: EventTrendSeverity = drop >= 80 ? 'critical_candidate' : 'warning'
  const label = drop >= 80 ? 'Traffic Drop Detected' : `↓ ${Math.round(drop)}%`
  return { label, severity, percent: trendPercent }
}

export function eventTrendBadgeClass(severity: EventTrendSeverity): string {
  switch (severity) {
    case 'critical_candidate':
      return 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-100'
    case 'warning':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-200'
  }
}

/** URL for /streams?connector= — uses connector id (reliable before name enrichment). */
export function connectorStreamsFilterPath(connectorId: number, _name?: string): string {
  return `/streams?connector=${encodeURIComponent(String(connectorId))}`
}

/** @deprecated Prefer connectorStreamsFilterPath with connector id. */
export function connectorStreamsFilterSlug(name: string): string {
  return name.trim().toLowerCase()
}

/** Active-stream last event — excludes stale/critical no-data streams so one fresh stream cannot mask others. */
export function computeActiveLastEventAt(
  streams: readonly ConnectorStreamOpsSummary[],
  nowMs = Date.now(),
): string | null {
  let best: string | null = null
  let bestTs = -1
  for (const s of streams) {
    if (s.health === 'stopped' || s.health === 'critical') continue
    if (s.primary_issue?.startsWith('No Data')) continue
    if (!s.last_success_at) continue
    const age = msSince(s.last_success_at, nowMs)
    if (age == null || age >= STALE_EVENT_MS) continue
    const ts = Date.parse(s.last_success_at)
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts
      best = s.last_success_at
    }
  }
  if (best) return best
  for (const s of streams) {
    if (s.health === 'stopped' || !s.last_success_at) continue
    const ts = Date.parse(s.last_success_at)
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts
      best = s.last_success_at
    }
  }
  return best
}

function countIssueTypes(streams: readonly ConnectorStreamOpsSummary[]): {
  noData: number
  sourceError: number
  destinationError: number
  connectionError: number
} {
  let noData = 0
  let sourceError = 0
  let destinationError = 0
  let connectionError = 0
  for (const s of streams) {
    const issue = s.primary_issue ?? ''
    if (issue.startsWith('No Data')) noData += 1
    else if (/connection|timeout|unreachable|refused/i.test(issue)) connectionError += 1
    else if (issue === 'Source Error') sourceError += 1
    else if (issue === 'Destination Error') destinationError += 1
  }
  return { noData, sourceError, destinationError, connectionError }
}

/** Critical stream count → connector health tier (small-connector aware). */
export function connectorTierFromCriticalStreams(total: number, critical: number): ConnectorHealthLabel | null {
  if (critical <= 0 || total <= 0) return null
  if (total === 1) return 'Critical'
  if (total === 2) return critical >= 2 ? 'Critical' : 'Warning'
  return critical >= Math.ceil(total * 0.5) ? 'Critical' : 'Warning'
}

type ReasonPick = { rank: number; reason: string; health: ConnectorHealthLabel }

function pickRootReason(candidates: ReasonPick[]): ReasonPick | null {
  if (!candidates.length) return null
  return [...candidates].sort((a, b) => a.rank - b.rank)[0] ?? null
}

/**
 * Connector health from auth status, stream posture, and data freshness.
 * Returns a single root-cause reason (never mixes auth failure with stream failures).
 */
export function computeConnectorHealth(
  connector: ConnectorRead,
  ops: ConnectorOperationsRow | undefined,
  nowMs = Date.now(),
): ConnectorHealthResult {
  if (isConnectorStopped(connector)) {
    return { health: 'Stopped', reason: 'Disabled' }
  }

  if (authFailed(connector)) {
    return { health: 'Critical', reason: 'Authentication Failed' }
  }

  const streams = ops?.streams ?? []
  const counts = countStreamsByHealth(streams, nowMs)
  const issues = countIssueTypes(streams)
  const total = counts.total
  const activeLastEvent = ops?.last_event_at_active ?? computeActiveLastEventAt(streams, nowMs)
  const freshness = dataFreshnessReason(activeLastEvent, nowMs)

  const candidates: ReasonPick[] = []

  if (total > 0 && issues.connectionError > 0 && issues.connectionError >= Math.ceil(total * 0.5)) {
    candidates.push({ rank: REASON_PRIORITY.connectionFailed, reason: 'Connection Failed', health: 'Critical' })
  }

  if (total > 0 && issues.noData === total) {
    candidates.push({
      rank: REASON_PRIORITY.noData,
      reason: freshness ?? 'No Data (all streams)',
      health: 'Critical',
    })
  } else if (freshness === 'No Data (24h)' || freshness === 'Never') {
    candidates.push({ rank: REASON_PRIORITY.noData, reason: freshness, health: 'Critical' })
  } else if (freshness === 'No Data (6h)' || freshness === 'No Data (1h)') {
    candidates.push({ rank: REASON_PRIORITY.noData, reason: freshness, health: 'Warning' })
  }

  if (total >= 2 && issues.sourceError >= Math.ceil(total * 0.6)) {
    candidates.push({ rank: REASON_PRIORITY.sourceError, reason: 'Source Error', health: 'Warning' })
  } else if (issues.sourceError > 0 && issues.sourceError >= issues.destinationError) {
    candidates.push({ rank: REASON_PRIORITY.sourceError, reason: 'Source Error', health: 'Warning' })
  }

  if (issues.destinationError > 0) {
    const destDominant = issues.destinationError >= Math.ceil(total * 0.5)
    candidates.push({
      rank: REASON_PRIORITY.destinationError,
      reason: 'Destination Error',
      health: destDominant && total >= 3 ? 'Critical' : 'Warning',
    })
  }

  const streamFailTier = connectorTierFromCriticalStreams(total, counts.critical)
  if (streamFailTier && counts.critical > 0) {
    candidates.push({
      rank: REASON_PRIORITY.streamFailed,
      reason: counts.critical === 1 ? '1 Stream Failed' : `${counts.critical} Streams Failed`,
      health: streamFailTier,
    })
  }

  if (counts.warning >= 2) {
    candidates.push({
      rank: 4.5,
      reason: `${counts.warning} Streams Warning`,
      health: 'Warning',
    })
  } else if (counts.warning > 0) {
    candidates.push({
      rank: REASON_PRIORITY.streamWarning,
      reason: counts.warning === 1 ? '1 Stream Warning' : `${counts.warning} Streams Warning`,
      health: 'Warning',
    })
  }

  const root = pickRootReason(candidates)
  if (root) {
    let health = root.health
    let reason = root.reason
    if (streamFailTier && counts.critical > 0) {
      health = streamFailTier
      if (root.rank > REASON_PRIORITY.noData && root.rank < REASON_PRIORITY.streamFailed) {
        reason = counts.critical === 1 ? '1 Stream Failed' : `${counts.critical} Streams Failed`
      }
    }
    return { health, reason }
  }

  if (connector.last_auth_check_status === 'success' || connector.auth_type === 'no_auth') {
    return { health: 'Healthy', reason: 'Auth OK' }
  }

  return { health: 'Healthy', reason: total > 0 ? 'All streams healthy' : 'No streams' }
}

export function connectorHealthTone(health: ConnectorHealthLabel): 'success' | 'warning' | 'error' | 'neutral' {
  switch (health) {
    case 'Critical':
      return 'error'
    case 'Warning':
      return 'warning'
    case 'Stopped':
      return 'neutral'
    default:
      return 'success'
  }
}

export function connectorHealthBadgeClass(health: ConnectorHealthLabel): string {
  switch (health) {
    case 'Critical':
      return 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-100'
    case 'Warning':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100'
    case 'Stopped':
      return 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-200'
    default:
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-100'
  }
}

export function formatAuthCheckResult(connector: ConnectorRead): { label: string; detail: string | null } {
  if (connector.last_auth_check_status === 'success') {
    return { label: 'Success', detail: null }
  }
  if (connector.last_auth_check_status === 'failed') {
    return { label: 'Failed', detail: connector.last_auth_error ?? 'Authentication failed' }
  }
  return { label: '—', detail: null }
}

const AUTH_INTERVAL_LABELS: Record<AuthHealthCheckInterval, string> = {
  disabled: 'Disabled',
  '15m': 'Every 15m',
  '1h': 'Every 1h',
  '6h': 'Every 6h',
  '24h': 'Every 24h',
}

/** Scheduler is not implemented — never imply automatic execution. */
export function formatAuthHealthCheckStatus(interval: AuthHealthCheckInterval | null | undefined): {
  configured: string
  execution: 'Manual Only'
} {
  const key = interval ?? 'disabled'
  return {
    configured: AUTH_INTERVAL_LABELS[key] ?? 'Disabled',
    execution: 'Manual Only',
  }
}

export type ConnectorDashboardRow = ConnectorRead & {
  operations?: ConnectorOperationsRow
  health: ConnectorHealthLabel
  healthReason: string
  streamCounts: StreamHealthCounts
  streamsSummary: string | null
  lastEventActive: string | null
}

export function buildConnectorDashboardRow(
  connector: ConnectorRead,
  opsById: Map<number, ConnectorOperationsRow>,
  nowMs = Date.now(),
): ConnectorDashboardRow {
  const operations = opsById.get(connector.id)
  const streamCounts = countStreamsByHealth(operations?.streams ?? [], nowMs)
  const lastEventActive =
    operations?.last_event_at_active ?? computeActiveLastEventAt(operations?.streams ?? [], nowMs)
  const { health, reason } = computeConnectorHealth(connector, operations, nowMs)
  return {
    ...connector,
    operations,
    stream_count: operations?.stream_count ?? connector.stream_count,
    health,
    healthReason: reason,
    streamCounts,
    streamsSummary: formatStreamsHealthSummary(streamCounts),
    lastEventActive,
  }
}
