import type {
  OperationalDestinationSnapshot,
  OperationalHealthStatus,
  OperationalProblem,
  OperationalProblemScope,
  OperationalRouteSnapshot,
  OperationalSnapshotResponse,
  OperationalStreamSnapshot,
} from '../api/operationalSnapshot'
import type { StreamRuntimeStatus } from '../api/streamRows'
import type { StatusTone } from '../components/shell/status-badge'
import { isCheckpointStaleLagMessage } from './stream-console-issue-causes'
import { formatOperationalPercent, formatThroughputEps } from './observability-format'
import { formatTimestampWithResolvedTimezone } from './platform-timestamps'

export type OperationalUiHealthLabel = 'Healthy' | 'Warning' | 'Error' | 'Idle' | 'Disabled' | 'Critical'

export type OperationalHealthPresentation = {
  raw: OperationalHealthStatus | null
  label: OperationalUiHealthLabel
  tone: StatusTone
}

export type OperationalRatePresentation = {
  successRatePct: number | null
  failureRatePct: number | null
  successLabel: string
  failureLabel: string
}

export type OperationalActivityPresentation = {
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
  lastActivityAt: string | null
}

export type GlobalOperationalKpi = {
  health: OperationalHealthPresentation
  totalStreams: number
  enabledStreams: number
  runningStreams: number
  errorStreams: number
  totalRoutes: number
  enabledRoutes: number
  totalDestinations: number
  enabledDestinations: number
  eps1m: number | null
  eps5m: number | null
  avgLatencyMs: number | null
  lastActivityAt: string | null
}

export type StreamOperationalKpi = OperationalRatePresentation &
  OperationalActivityPresentation & {
    health: OperationalHealthPresentation
    enabled: boolean
    eps1m: number | null
    eps5m: number | null
    routeCount: number
    healthyRouteCount: number
    failedRouteCount: number
    issues: string[]
    runtimeStatus: StreamRuntimeStatus
  }

export type RouteOperationalKpi = OperationalRatePresentation &
  OperationalActivityPresentation & {
    health: OperationalHealthPresentation
    enabled: boolean
    deliveredEps1m: number | null
    failedEps1m: number | null
    retryRate5m: number | null
    avgLatencyMs: number | null
    issues: string[]
  }

export type DestinationOperationalKpi = OperationalRatePresentation &
  OperationalActivityPresentation & {
    health: OperationalHealthPresentation
    enabled: boolean
    inboundEps1m: number | null
    failedEps1m: number | null
    avgLatencyMs: number | null
    routeCount: number
    issues: string[]
  }

export type SnapshotHealthCounts = {
  healthy: number
  warning: number
  critical: number
  idle: number
  disabled: number
}

function safeFinite(n: unknown): number | null {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x)) return null
  return x
}

function safeNonNeg(n: unknown): number {
  const x = safeFinite(n)
  if (x == null || x < 0) return 0
  return x
}

export function formatOperationalEps(eps: number | null | undefined, suffix = '/s'): string {
  if (eps == null || !Number.isFinite(eps)) return '—'
  return `${formatThroughputEps(eps)}${suffix ? ` ${suffix}` : ''}`.trim()
}

export function formatOperationalSuccessRate(pct: number | null | undefined): string {
  return formatOperationalPercent(pct)
}

export function formatOperationalFailureRate(pct: number | null | undefined): string {
  return formatOperationalSuccessRate(pct)
}

export function operationalStreamSuccessRatePct(stream: {
  eps_1m: number
  eps_5m: number
  success_rate_5m: number
}): number | null {
  const eps1 = safeNonNeg(stream.eps_1m)
  const eps5 = safeNonNeg(stream.eps_5m)
  if (eps1 <= 0 && eps5 <= 0) return null
  return Number.isFinite(stream.success_rate_5m) ? stream.success_rate_5m : null
}

export function computeSuccessRateFromEps(delivered: number, failed: number): number | null {
  const d = safeNonNeg(delivered)
  const f = safeNonNeg(failed)
  const total = d + f
  if (total <= 0) return null
  return Math.round((100 * d) / total * 100) / 100
}

export function formatOperationalHealth(
  status: OperationalHealthStatus | null | undefined,
  enabled = true,
): OperationalHealthPresentation {
  if (!enabled) {
    return { raw: status ?? null, label: 'Disabled', tone: 'neutral' }
  }
  switch (status) {
    case 'HEALTHY':
      return { raw: 'HEALTHY', label: 'Healthy', tone: 'success' }
    case 'DEGRADED':
      return { raw: 'DEGRADED', label: 'Warning', tone: 'warning' }
    case 'ERROR':
      return { raw: 'ERROR', label: 'Error', tone: 'error' }
    case 'IDLE':
    default:
      return { raw: status ?? 'IDLE', label: 'Idle', tone: 'neutral' }
  }
}

export function formatDestinationOperationalHealth(
  status: OperationalHealthStatus | null | undefined,
  enabled = true,
): OperationalHealthPresentation {
  const base = formatOperationalHealth(status, enabled)
  if (base.label === 'Error') return { ...base, label: 'Critical' }
  return base
}

export function operationalHealthToStreamStatus(
  status: OperationalHealthStatus | null | undefined,
  enabled: boolean,
): StreamRuntimeStatus {
  if (!enabled) return 'STOPPED'
  switch (status) {
    case 'HEALTHY':
      return 'RUNNING'
    case 'DEGRADED':
      return 'DEGRADED'
    case 'ERROR':
      return 'ERROR'
    case 'IDLE':
      return 'STOPPED'
    default:
      return 'UNKNOWN'
  }
}

function mapOperationalRuntimeStatus(raw: string | null | undefined): StreamRuntimeStatus {
  if (raw == null || String(raw).trim() === '') return 'UNKNOWN'
  const u = String(raw).trim().toUpperCase()
  if (u === 'RUNNING') return 'RUNNING'
  if (u === 'ERROR') return 'ERROR'
  if (u === 'RATE_LIMITED_SOURCE' || u === 'RATE_LIMITED_DESTINATION') return 'DEGRADED'
  if (u === 'PAUSED' || u === 'STOPPED' || u === 'IDLE') return 'STOPPED'
  if (u === 'UNKNOWN') return 'UNKNOWN'
  return 'UNKNOWN'
}

export function resolveLastActivityAt(
  lastSuccessAt: string | null | undefined,
  lastErrorAt: string | null | undefined,
): string | null {
  const a = lastSuccessAt ?? null
  const b = lastErrorAt ?? null
  if (!a && !b) return null
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

export function formatProblemSummary(
  lastErrorMessage: string | null | undefined,
  health: OperationalHealthStatus | null | undefined,
  fallbackDegraded = 'Delivery degraded',
  fallbackError = 'Delivery error',
): string | null {
  const msg = (lastErrorMessage ?? '').trim()
  if (msg) return msg
  if (health === 'ERROR') return fallbackError
  if (health === 'DEGRADED') return fallbackDegraded
  return null
}

export function shouldSuppressOperationalDegradedSummary(
  health: OperationalHealthStatus | null | undefined,
  successRatePct: number | null | undefined,
  lastErrorMessage: string | null | undefined,
  routesError = 0,
): boolean {
  if ((lastErrorMessage ?? '').trim()) return false
  if (routesError > 0) return false
  if (health !== 'DEGRADED') return false
  return successRatePct != null && Number.isFinite(successRatePct) && successRatePct >= 95
}

export function problemsForEntity(
  problems: readonly OperationalProblem[],
  scope: OperationalProblemScope,
  entityId: number,
): OperationalProblem[] {
  return problems.filter((p) => {
    if (p.scope !== scope) return false
    if (scope === 'stream') return p.stream_id === entityId
    if (scope === 'route') return p.route_id === entityId
    if (scope === 'destination') return p.destination_id === entityId
    return false
  })
}

export function issueLabelsFromProblems(problems: readonly OperationalProblem[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of problems) {
    const msg = (p.message ?? p.title ?? '').trim()
    if (!msg || seen.has(msg) || isCheckpointStaleLagMessage(msg)) continue
    seen.add(msg)
    out.push(msg)
  }
  return out
}

export function countHealthFromRows<T extends { health_status: OperationalHealthStatus; enabled?: boolean }>(
  rows: readonly T[],
  respectEnabled = true,
): SnapshotHealthCounts {
  const out: SnapshotHealthCounts = { healthy: 0, warning: 0, critical: 0, idle: 0, disabled: 0 }
  for (const row of rows) {
    if (respectEnabled && row.enabled === false) {
      out.disabled += 1
      continue
    }
    switch (row.health_status) {
      case 'HEALTHY':
        out.healthy += 1
        break
      case 'DEGRADED':
        out.warning += 1
        break
      case 'ERROR':
        out.critical += 1
        break
      case 'IDLE':
      default:
        out.idle += 1
        break
    }
  }
  return out
}

export function selectGlobalKpi(snapshot: OperationalSnapshotResponse): GlobalOperationalKpi {
  const g = snapshot.global
  return {
    health: formatOperationalHealth(g.health_status, true),
    totalStreams: safeNonNeg(g.total_streams),
    enabledStreams: safeNonNeg(g.enabled_streams),
    runningStreams: safeNonNeg(g.running_streams),
    errorStreams: safeNonNeg(g.error_streams),
    totalRoutes: safeNonNeg(g.total_routes),
    enabledRoutes: safeNonNeg(g.enabled_routes),
    totalDestinations: safeNonNeg(g.total_destinations),
    enabledDestinations: safeNonNeg(g.enabled_destinations),
    eps1m: safeFinite(g.total_eps_1m),
    eps5m: safeFinite(g.total_eps_5m),
    avgLatencyMs: g.avg_latency_ms ?? null,
    lastActivityAt: g.last_activity_at ?? null,
  }
}

export function selectStreamKpi(
  stream: OperationalStreamSnapshot,
  problems: readonly OperationalProblem[] = [],
): StreamOperationalKpi {
  const entityProblems = problemsForEntity(problems, 'stream', stream.stream_id)
  const issues = issueLabelsFromProblems(entityProblems)
  const successRatePct = operationalStreamSuccessRatePct(stream)
  const summary = shouldSuppressOperationalDegradedSummary(
    stream.health_status,
    successRatePct,
    stream.last_error_message,
    safeNonNeg(stream.failed_route_count),
  )
    ? null
    : formatProblemSummary(stream.last_error_message, stream.health_status, 'Stream delivery degraded', 'Stream delivery error')
  if (summary && !issues.includes(summary)) issues.unshift(summary)

  const failureRatePct = Number.isFinite(stream.failure_rate_5m) ? stream.failure_rate_5m : null

  const runtimeStatusFromSnapshot = mapOperationalRuntimeStatus(stream.status)
  const runtimeStatus =
    runtimeStatusFromSnapshot !== 'UNKNOWN'
      ? runtimeStatusFromSnapshot
      : operationalHealthToStreamStatus(stream.health_status, stream.enabled)

  return {
    health: formatOperationalHealth(stream.health_status, stream.enabled),
    enabled: stream.enabled,
    eps1m: safeFinite(stream.eps_1m),
    eps5m: safeFinite(stream.eps_5m),
    successRatePct,
    failureRatePct,
    successLabel: formatOperationalSuccessRate(successRatePct),
    failureLabel: formatOperationalFailureRate(failureRatePct),
    lastSuccessAt: stream.last_success_at,
    lastErrorAt: stream.last_error_at,
    lastErrorMessage: stream.last_error_message,
    lastActivityAt: resolveLastActivityAt(stream.last_success_at, stream.last_error_at),
    routeCount: safeNonNeg(stream.route_count),
    healthyRouteCount: safeNonNeg(stream.healthy_route_count),
    failedRouteCount: safeNonNeg(stream.failed_route_count),
    issues,
    runtimeStatus,
  }
}

export function selectRouteKpi(
  route: OperationalRouteSnapshot,
  problems: readonly OperationalProblem[] = [],
): RouteOperationalKpi {
  const entityProblems = problemsForEntity(problems, 'route', route.route_id)
  const issues = issueLabelsFromProblems(entityProblems)
  const summary = formatProblemSummary(route.last_error_message, route.health_status, 'Route delivery degraded', 'Route delivery error')
  if (summary && !issues.includes(summary)) issues.unshift(summary)

  const successRatePct = Number.isFinite(route.success_rate_5m) ? route.success_rate_5m : null
  const delivered = safeNonNeg(route.delivered_eps_1m)
  const failed = safeNonNeg(route.failed_eps_1m)
  const failureRatePct = computeSuccessRateFromEps(failed, delivered) != null && delivered + failed > 0
    ? Math.round((100 * failed) / (delivered + failed) * 100) / 100
    : null

  return {
    health: formatOperationalHealth(route.health_status, route.enabled),
    enabled: route.enabled,
    deliveredEps1m: safeFinite(route.delivered_eps_1m),
    failedEps1m: safeFinite(route.failed_eps_1m),
    retryRate5m: safeFinite(route.retry_rate_5m),
    avgLatencyMs: route.avg_latency_ms ?? null,
    successRatePct,
    failureRatePct,
    successLabel: formatOperationalSuccessRate(successRatePct),
    failureLabel: formatOperationalFailureRate(failureRatePct),
    lastSuccessAt: route.last_success_at,
    lastErrorAt: route.last_error_at,
    lastErrorMessage: route.last_error_message,
    lastActivityAt: resolveLastActivityAt(route.last_success_at, route.last_error_at),
    issues,
  }
}

export function selectDestinationKpi(
  destination: OperationalDestinationSnapshot,
  problems: readonly OperationalProblem[] = [],
): DestinationOperationalKpi {
  const entityProblems = problemsForEntity(problems, 'destination', destination.destination_id)
  const issues = issueLabelsFromProblems(entityProblems)
  const summary = formatProblemSummary(
    destination.last_error_message,
    destination.health_status,
    'Destination delivery degraded',
    'Destination delivery error',
  )
  if (summary && !issues.includes(summary)) issues.unshift(summary)

  const inbound = safeNonNeg(destination.inbound_eps_1m)
  const failed = safeNonNeg(destination.failed_eps_1m)
  const successRatePct = computeSuccessRateFromEps(inbound, failed)
  const failureRatePct =
    successRatePct != null && inbound + failed > 0
      ? Math.round((100 * failed) / (inbound + failed) * 100) / 100
      : null

  return {
    health: formatDestinationOperationalHealth(destination.health_status, destination.enabled),
    enabled: destination.enabled,
    inboundEps1m: safeFinite(destination.inbound_eps_1m),
    failedEps1m: safeFinite(destination.failed_eps_1m),
    avgLatencyMs: destination.avg_latency_ms ?? null,
    routeCount: safeNonNeg(destination.route_count),
    successRatePct,
    failureRatePct,
    successLabel: formatOperationalSuccessRate(successRatePct),
    failureLabel: formatOperationalFailureRate(failureRatePct),
    lastSuccessAt: destination.last_success_at,
    lastErrorAt: destination.last_error_at,
    lastErrorMessage: destination.last_error_message,
    lastActivityAt: resolveLastActivityAt(destination.last_success_at, destination.last_error_at),
    issues,
  }
}

export function deriveStreamIssuesFromSnapshot(
  stream: OperationalStreamSnapshot,
  problems: readonly OperationalProblem[] = [],
): string[] {
  return selectStreamKpi(stream, problems).issues
}

export function deriveOverallHealthPostureFromSnapshot(
  snapshot: OperationalSnapshotResponse,
): { healthy: number; warning: number; critical: number; posture: 'healthy' | 'warning' | 'critical' } {
  const counts = countHealthFromRows(snapshot.streams ?? [])
  let posture: 'healthy' | 'warning' | 'critical' = 'healthy'
  if (counts.critical > 0) posture = 'critical'
  else if (counts.warning > 0) posture = 'warning'
  return { healthy: counts.healthy, warning: counts.warning, critical: counts.critical, posture }
}

export function aggregateDeliverySuccessRateFromSnapshot(
  snapshot: OperationalSnapshotResponse,
): number | null {
  let delivered = 0
  let failed = 0
  for (const s of snapshot.streams ?? []) {
    const eps = safeNonNeg(s.eps_1m)
    if (eps <= 0) continue
    const sr = Number.isFinite(s.success_rate_5m) ? s.success_rate_5m / 100 : null
    if (sr == null) continue
    delivered += eps * sr
    failed += eps * (1 - sr)
  }
  if (delivered + failed <= 0) {
    return null
  }
  return Math.round((100 * delivered) / (delivered + failed) * 100) / 100
}

export type StreamsSectionKpiFromSnapshot = {
  total: number
  totalTrend: string
  running: number
  runningPct: string
  degraded: number
  degradedPct: string
  error: number
  errorPct: string
  stopped: number
  stoppedPct: string
  processedEvents: string
  processedEventsTrend: string
}

export function streamsSectionKpiFromOperationalSnapshot(
  snapshot: OperationalSnapshotResponse,
): StreamsSectionKpiFromSnapshot {
  const g = selectGlobalKpi(snapshot)
  const streams = snapshot.streams ?? []
  const total = g.totalStreams > 0 ? g.totalStreams : streams.length
  const running = g.runningStreams > 0 ? g.runningStreams : streams.filter((s) => s.enabled && s.health_status === 'HEALTHY').length
  const error = g.errorStreams > 0 ? g.errorStreams : streams.filter((s) => s.enabled && s.health_status === 'ERROR').length
  const degraded = streams.filter((s) => s.enabled && s.health_status === 'DEGRADED').length
  const stopped = streams.filter((s) => !s.enabled || s.health_status === 'IDLE').length
  const pct = (n: number) => (total > 0 ? `${Math.round((100 * n) / total)}% of total` : '—')
  const epsLabel = g.eps1m != null ? formatOperationalEps(g.eps1m, 'events/sec') : '—'

  return {
    total,
    totalTrend: 'Live · operational snapshot',
    running,
    runningPct: pct(running),
    degraded,
    degradedPct: pct(degraded),
    error,
    errorPct: pct(error),
    stopped,
    stoppedPct: pct(stopped),
    processedEvents: epsLabel,
    processedEventsTrend: `Snapshot · ${snapshot.updated_at ? formatTimestampWithResolvedTimezone(snapshot.updated_at) : '—'}`,
  }
}
