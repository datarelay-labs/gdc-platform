import type {
  OperationalDestinationSnapshot,
  OperationalHealthStatus,
  OperationalProblem,
  OperationalProblemSeverity,
  OperationalRouteSnapshot,
  OperationalSnapshotResponse,
  OperationalStreamSnapshot,
} from '../../api/operationalSnapshot'
import { formatOperationalPercent, formatThroughputEps } from '../../lib/observability-format'
import type { StatusTone } from '../shell/status-badge'

export type StreamHealthTab = 'all' | 'healthy' | 'degraded' | 'error' | 'idle' | 'disabled'

export function operationalHealthLabel(status: OperationalHealthStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'Healthy'
    case 'DEGRADED':
      return 'Degraded'
    case 'ERROR':
      return 'Error'
    case 'IDLE':
    default:
      return 'Idle'
  }
}

export function operationalHealthTone(status: OperationalHealthStatus): StatusTone {
  switch (status) {
    case 'HEALTHY':
      return 'success'
    case 'DEGRADED':
      return 'warning'
    case 'ERROR':
      return 'error'
    case 'IDLE':
    default:
      return 'neutral'
  }
}

export function operationalHealthStripClass(status: OperationalHealthStatus): string {
  switch (status) {
    case 'HEALTHY':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100'
    case 'DEGRADED':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100'
    case 'ERROR':
      return 'border-red-500/40 bg-red-500/10 text-red-950 dark:text-red-100'
    case 'IDLE':
    default:
      return 'border-slate-300/60 bg-slate-500/[0.06] text-slate-700 dark:border-gdc-border dark:text-slate-200'
  }
}

import { formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'

export function formatShortTs(iso: string | null | undefined): string {
  return formatTimestampWithResolvedTimezone(iso)
}

export function formatPercent(value: number | null | undefined): string {
  return formatOperationalPercent(value)
}

export function formatLatencyMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)} ms`
}

export function formatEps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${formatThroughputEps(value)} /s`
}

export function streamMatchesTab(stream: OperationalStreamSnapshot, tab: StreamHealthTab): boolean {
  if (tab === 'all') return true
  if (tab === 'disabled') return !stream.enabled
  if (tab === 'healthy') return stream.enabled && stream.health_status === 'HEALTHY'
  if (tab === 'degraded') return stream.enabled && stream.health_status === 'DEGRADED'
  if (tab === 'error') return stream.enabled && stream.health_status === 'ERROR'
  return stream.enabled && stream.health_status === 'IDLE'
}

export function countStreamsByTab(streams: OperationalStreamSnapshot[]): Record<StreamHealthTab, number> {
  const counts: Record<StreamHealthTab, number> = {
    all: streams.length,
    healthy: 0,
    degraded: 0,
    error: 0,
    idle: 0,
    disabled: 0,
  }
  for (const s of streams) {
    if (!s.enabled) {
      counts.disabled += 1
      continue
    }
    switch (s.health_status) {
      case 'HEALTHY':
        counts.healthy += 1
        break
      case 'DEGRADED':
        counts.degraded += 1
        break
      case 'ERROR':
        counts.error += 1
        break
      case 'IDLE':
      default:
        counts.idle += 1
        break
    }
  }
  return counts
}

export function countHealthBuckets<T extends { health_status: OperationalHealthStatus; enabled?: boolean }>(
  rows: T[],
  respectEnabled = true,
): { healthy: number; degraded: number; error: number; idle: number; disabled: number } {
  const out = { healthy: 0, degraded: 0, error: 0, idle: 0, disabled: 0 }
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
        out.degraded += 1
        break
      case 'ERROR':
        out.error += 1
        break
      case 'IDLE':
      default:
        out.idle += 1
        break
    }
  }
  return out
}

export function destinationTypeDistribution(destinations: OperationalDestinationSnapshot[]): { type: string; count: number }[] {
  const map = new Map<string, number>()
  for (const d of destinations) {
    const t = (d.destination_type ?? 'unknown').replace(/_/g, ' ')
    map.set(t, (map.get(t) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

export function retryHeavyRoutes(routes: OperationalRouteSnapshot[], minRetryRate = 10): OperationalRouteSnapshot[] {
  return routes
    .filter((r) => r.enabled && Number.isFinite(r.retry_rate_5m) && r.retry_rate_5m >= minRetryRate)
    .sort((a, b) => b.retry_rate_5m - a.retry_rate_5m)
}

export function failedRoutes(routes: OperationalRouteSnapshot[]): OperationalRouteSnapshot[] {
  return routes.filter((r) => r.enabled && (r.health_status === 'ERROR' || r.health_status === 'DEGRADED'))
}

export function problemSeverityRank(severity: OperationalProblemSeverity): number {
  return severity === 'critical' ? 0 : 1
}

export function sortProblems(problems: OperationalProblem[]): OperationalProblem[] {
  return [...problems].sort((a, b) => {
    const sev = problemSeverityRank(a.severity) - problemSeverityRank(b.severity)
    if (sev !== 0) return sev
    const ta = a.last_seen_at ? Date.parse(a.last_seen_at) : 0
    const tb = b.last_seen_at ? Date.parse(b.last_seen_at) : 0
    return tb - ta
  })
}

export function resolveUrlFiltersFromSnapshot(
  snapshot: OperationalSnapshotResponse,
  params: { streamId?: number; routeId?: number; destinationId?: number },
): {
  effectiveStreamId: number | null
  highlightRouteId: number | null
  highlightDestinationId: number | null
  error: 'route_not_found' | 'stream_mismatch' | 'no_route_for_destination' | null
} {
  const highlightRouteId = params.routeId ?? null
  const highlightDestinationId = params.destinationId ?? null
  let effectiveStreamId: number | null = params.streamId ?? null
  let error: 'route_not_found' | 'stream_mismatch' | 'no_route_for_destination' | null = null

  if (params.routeId != null) {
    const route = snapshot.routes.find((r) => r.route_id === params.routeId)
    if (route?.stream_id == null || !Number.isFinite(route.stream_id)) {
      return { effectiveStreamId: null, highlightRouteId, highlightDestinationId, error: 'route_not_found' }
    }
    if (params.streamId != null && route.stream_id !== params.streamId) {
      return { effectiveStreamId: null, highlightRouteId, highlightDestinationId, error: 'stream_mismatch' }
    }
    effectiveStreamId = route.stream_id
  }

  if (effectiveStreamId == null && params.destinationId != null) {
    const match = snapshot.routes.find((r) => r.destination_id === params.destinationId)
    if (match?.stream_id == null || !Number.isFinite(match.stream_id)) {
      return { effectiveStreamId: null, highlightRouteId, highlightDestinationId, error: 'no_route_for_destination' }
    }
    effectiveStreamId = match.stream_id
  }

  return { effectiveStreamId, highlightRouteId, highlightDestinationId, error }
}

export function streamErrorSummary(stream: OperationalStreamSnapshot): string | null {
  const msg = (stream.last_error_message ?? '').trim()
  if (msg) return msg.length > 80 ? `${msg.slice(0, 77)}…` : msg
  if (stream.health_status === 'ERROR') return 'Stream delivery error'
  if (stream.health_status === 'DEGRADED') return 'Stream delivery degraded'
  return null
}
