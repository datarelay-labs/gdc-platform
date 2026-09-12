/**
 * Right-side Stream Detail Panel for the Streams Console.
 * Opened when a stream row is clicked in the group accordion.
 * Shows Overview / Destinations / Events / Schema / Checkpoint tabs.
 */
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Info,
  Layers,
  Pencil,
  Play,
  ScrollText,
  Workflow,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { logsPath, streamEditPath, streamRuntimePath } from '../../config/nav-paths'
import type { StreamConsoleRow } from '../../api/streamRows'
import type { OperationalProblem, OperationalRouteSnapshot } from '../../api/operationalSnapshot'
import { formatOperationalPercent, formatThroughputEps } from '../../lib/observability-format'
import { formatRelativeShort, streamSuccessRateDisplay } from '../../lib/stream-console-metrics'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DetailTab = 'overview' | 'destinations' | 'events' | 'schema' | 'checkpoint'

export type StreamConsoleDetailPanelProps = {
  stream: StreamConsoleRow
  routes: OperationalRouteSnapshot[]
  problems: OperationalProblem[]
  onClose: () => void
  initialTab?: DetailTab
  topOffset?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function routeStatusLabel(route: OperationalRouteSnapshot): string {
  if (!route.enabled) return 'Disabled'
  switch (route.health_status) {
    case 'HEALTHY':
      return 'Healthy'
    case 'DEGRADED':
      return 'Warning'
    case 'ERROR':
      return 'Critical'
    case 'IDLE':
    default:
      return 'Idle'
  }
}

function routeStatusToneClass(route: OperationalRouteSnapshot): string {
  if (!route.enabled) return 'border-slate-600/40 bg-slate-500/10 text-slate-400'
  switch (route.health_status) {
    case 'HEALTHY':
      return 'border-emerald-600/40 bg-emerald-500/10 text-emerald-400'
    case 'DEGRADED':
      return 'border-amber-600/40 bg-amber-500/10 text-amber-400'
    case 'ERROR':
      return 'border-red-600/40 bg-red-500/10 text-red-400'
    default:
      return 'border-slate-600/40 bg-slate-500/10 text-slate-400'
  }
}

function streamStatusToneClass(row: StreamConsoleRow): string {
  switch (row.status) {
    case 'RUNNING':
      return 'border-emerald-600/50 bg-emerald-950/80 text-emerald-400'
    case 'DEGRADED':
      return 'border-amber-600/50 bg-amber-950/80 text-amber-400'
    case 'ERROR':
      return 'border-red-600/50 bg-red-950/80 text-red-400'
    default:
      return 'border-slate-600/50 bg-slate-900/80 text-slate-400'
  }
}

function streamStatusLabel(row: StreamConsoleRow): string {
  switch (row.status) {
    case 'RUNNING':
      return 'Healthy'
    case 'DEGRADED':
      return 'Warning'
    case 'ERROR':
      return 'Critical'
    case 'STOPPED':
      return 'No Data'
    default:
      return 'Unknown'
  }
}

function formatEps(eps: number | null | undefined): string {
  if (eps == null || !Number.isFinite(eps) || eps <= 0) return '—'
  if (eps >= 1000) return `${(eps / 1000).toFixed(1)}K /s`
  return `${formatThroughputEps(eps)} /s`
}

function formatSuccessPct(pct: number | null | undefined): string {
  return formatOperationalPercent(pct)
}

function truncate(str: string | null | undefined, max = 60): string {
  if (!str) return '—'
  return str.length > max ? `${str.slice(0, max)}…` : str
}

// ─── Shared UI primitives ──────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-gdc-muted">
      {children}
    </h4>
  )
}

function MetricRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1.5">
      <span className="shrink-0 text-[11px] text-slate-500 dark:text-gdc-muted">{label}</span>
      <span className={cn('min-w-0 text-right text-[12px] font-semibold text-slate-800 dark:text-slate-100', mono && 'tabular-nums')}>
        {value}
      </span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <p className="py-4 text-center text-[12px] text-slate-500 dark:text-gdc-muted">{label}</p>
  )
}

// ─── Tab: Overview ─────────────────────────────────────────────────────────────

function OverviewTab({
  stream,
  streamRoutes,
}: {
  stream: StreamConsoleRow
  streamRoutes: OperationalRouteSnapshot[]
}) {
  const successDisplay = streamSuccessRateDisplay(stream)
  const successLabel = successDisplay.known ? formatOperationalPercent(successDisplay.pct) : '—'
  const epsLabel = formatEps(stream.eps5m != null && stream.eps5m > 0 ? stream.eps5m : stream.ingestEps > 0 ? stream.ingestEps : null)
  const checkpointTime = stream.checkpointUpdatedAt && stream.checkpointUpdatedAt !== '—'
    ? formatRelativeShort(stream.checkpointUpdatedAt)
    : '—'
  const isCheckpointLagging = Boolean(stream.checkpointLagLabel && stream.checkpointLagLabel !== '—')
  const checkpointLagSec = (() => {
    if (!isCheckpointLagging || !stream.checkpointLagLabel) return null
    const m = stream.checkpointLagLabel.match(/(\d+)s/)
    return m ? parseInt(m[1]) : null
  })()
  const checkpointLagLabel = checkpointLagSec != null
    ? (checkpointLagSec < 60 ? `${checkpointLagSec}s` : checkpointLagSec < 3600 ? `${Math.floor(checkpointLagSec / 60)}m` : `${Math.floor(checkpointLagSec / 3600)}h ${Math.floor((checkpointLagSec % 3600) / 60)}m`)
    : null

  const routesHealthy = streamRoutes.filter((r) => r.health_status === 'HEALTHY').length || stream.routesOk
  const routesWarning = streamRoutes.filter((r) => r.health_status === 'DEGRADED').length || stream.routesDegraded
  const routesFailed = streamRoutes.filter((r) => r.health_status === 'ERROR').length || stream.routesError
  const routesTotal = Math.max(stream.routesTotal, streamRoutes.length)

  const issues: Array<{ label: string; severity: 'critical' | 'warning' }> = []
  if (stream.routesError > 0) issues.push({ label: 'High failure rate', severity: 'critical' })
  if (isCheckpointLagging) issues.push({ label: 'Checkpoint lagging', severity: 'warning' })
  if (stream.runtimeIssue && stream.runtimeIssue !== '—') issues.push({ label: stream.runtimeIssue, severity: 'warning' })

  const quickActionCls =
    'flex items-center gap-2 rounded-lg border border-slate-200/60 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200 dark:hover:bg-gdc-rowHover'

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* A. Stream Overview with Runtime link */}
      <div>
        <SectionHeading>Stream Overview</SectionHeading>
        <div className="rounded-lg border border-slate-200/60 bg-slate-50/50 px-3 dark:border-gdc-border dark:bg-gdc-elevated/30">
          <MetricRow label="EPS (5m avg)" value={<span className="tabular-nums">{epsLabel}</span>} mono />
          <MetricRow label="Success Rate" value={<span className="tabular-nums">{successLabel}</span>} mono />
          <MetricRow label="Last Event" value={formatRelativeShort(stream.lastActivityRelative)} />
          <MetricRow
            label="Last Checkpoint"
            value={
              <span className="flex flex-col gap-0.5">
                <span className="tabular-nums">{checkpointTime}</span>
                {checkpointLagLabel && (
                  <span className="text-[10px] text-slate-500 dark:text-gdc-muted">Lag {checkpointLagLabel}</span>
                )}
                {checkpointTime !== '—' ? (
                  isCheckpointLagging ? (
                    <span className="text-[10px] font-semibold text-amber-500">Lagging</span>
                  ) : (
                    <span className="text-[10px] font-semibold text-emerald-500">Healthy</span>
                  )
                ) : null}
              </span>
            }
          />
          <MetricRow
            label="Runtime"
            value={
              <Link
                to={streamRuntimePath(stream.id)}
                className="inline-flex items-center gap-1 font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
              >
                Open Runtime
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
          />
        </div>
      </div>

      {/* B. Destination Summary */}
      <div>
        <SectionHeading>Destination Summary</SectionHeading>
        {streamRoutes.length === 0 && routesTotal === 0 ? (
          <EmptyState label="No delivery routes yet" />
        ) : streamRoutes.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {streamRoutes.map((route) => {
              const destName = route.destination_name ?? `Destination #${route.destination_id}`
              const statusLabel = routeStatusLabel(route)
              const toneCls = routeStatusToneClass(route)
              const eps = route.delivered_eps_1m ?? 0
              const epsLabel = formatEps(eps)
              const successPct = formatOperationalPercent(route.success_rate_5m)
              return (
                <div key={route.route_id} className="rounded-lg border border-slate-200/60 bg-slate-50/50 px-3 py-2 dark:border-gdc-border dark:bg-gdc-elevated/20">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[12px] font-medium text-slate-800 dark:text-slate-100" title={destName}>{destName}</span>
                    <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold', toneCls)}>{statusLabel}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3">
                    <span className="text-[11px] text-slate-500 dark:text-gdc-muted">EPS <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-300">{epsLabel}</span></span>
                    <span className="text-[11px] text-slate-500 dark:text-gdc-muted">Success <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-300">{successPct}</span></span>
                  </div>
                </div>
              )
            })}
            <Link
              to={`${streamEditPath(stream.id)}?tab=route_processing`}
              className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
            >
              View route processing
              <ChevronRight className="h-3 w-3" aria-hidden />
            </Link>
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200/60 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-elevated/20">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />{routesHealthy} Healthy
              </span>
              <span className="flex items-center gap-1 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden />{routesWarning} Warning
              </span>
              <span className="flex items-center gap-1 text-[12px] font-medium text-red-600 dark:text-red-400">
                <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden />{routesFailed} Failed
              </span>
            </div>
            <Link
              to={`${streamEditPath(stream.id)}?tab=route_processing`}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
            >
              View route processing
              <ChevronRight className="h-3 w-3" aria-hidden />
            </Link>
          </div>
        )}
      </div>

      {/* C. Issues */}
      {issues.length > 0 ? (
        <div>
          <SectionHeading>Issues</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {issues.map((issue, i) => (
              <div
                key={`${issue.label}-${i}`}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2',
                  issue.severity === 'critical'
                    ? 'border-red-200/50 bg-red-50/50 dark:border-red-900/30 dark:bg-red-950/20'
                    : 'border-amber-200/50 bg-amber-50/50 dark:border-amber-900/30 dark:bg-amber-950/20',
                )}
              >
                {issue.severity === 'critical' ? (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
                )}
                <span
                  className={cn(
                    'text-[12px] font-medium',
                    issue.severity === 'critical' ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200',
                  )}
                >
                  {issue.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* D. Quick Actions */}
      <div>
        <SectionHeading>Quick Actions</SectionHeading>
        <div className="flex flex-col gap-2">
          <Link to={streamRuntimePath(stream.id)} className={quickActionCls}>
            <Play className="h-3.5 w-3.5 shrink-0 text-violet-500" aria-hidden />
            Open Runtime
            <ExternalLink className="ml-auto h-3.5 w-3.5 text-slate-400" aria-hidden />
          </Link>
          <Link to={streamEditPath(stream.id)} className={quickActionCls}>
            <Pencil className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            Edit Stream
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400" aria-hidden />
          </Link>
          <Link to={logsPath(stream.id)} className={quickActionCls}>
            <ScrollText className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            View Logs
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400" aria-hidden />
          </Link>
          <Link to={`${streamEditPath(stream.id)}?tab=route_processing`} className={quickActionCls}>
            <Workflow className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            Route Processing
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400" aria-hidden />
          </Link>
        </div>
      </div>

      {/* E. Recent Events */}
      <div>
        <SectionHeading>Recent Events</SectionHeading>
        {stream.recentErrors.length === 0 ? (
          stream.hasRuntimeApiSnapshot ? (
            <div className="rounded-lg border border-slate-200/60 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-elevated/20">
              <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-gdc-muted">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
                <span>No recent errors · Last event {formatRelativeShort(stream.lastActivityRelative)}</span>
              </div>
            </div>
          ) : (
            <EmptyState label="No runtime data yet" />
          )
        ) : (
          <div className="flex flex-col gap-1.5">
            {stream.recentErrors.map((e, i) => (
              <div
                key={`${e.relativeAt}-${i}`}
                className="flex items-start gap-2 rounded-lg border border-red-200/50 bg-red-50/50 p-2 dark:border-red-900/30 dark:bg-red-950/20"
              >
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-red-800 dark:text-red-200">{e.message}</p>
                  <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">{e.relativeAt}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab: Destinations ─────────────────────────────────────────────────────────

function DestinationsTab({ streamRoutes }: { streamRoutes: OperationalRouteSnapshot[] }) {
  if (streamRoutes.length === 0) {
    return (
      <div className="p-4">
        <EmptyState label="No destination routes in operational snapshot. Routes appear once a stream runs." />
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="overflow-x-auto rounded-lg border border-slate-200/60 dark:border-gdc-border">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-slate-200/60 dark:border-gdc-border bg-slate-50/80 dark:bg-gdc-elevated/40">
              {['Destination', 'Status', 'EPS', 'Success', 'Retry', 'Last Delivery', 'Last Error'].map((h) => (
                <th key={h} className="px-2 py-2 text-left font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {streamRoutes.map((route) => {
              const destName = route.destination_name ?? (route.destination_id != null ? `Destination #${route.destination_id}` : `Route #${route.route_id}`)
              const retryLabel = route.retry_rate_5m > 0 ? formatOperationalPercent(route.retry_rate_5m) : '—'
              const lastDelivery = route.last_success_at ? formatRelativeShort(route.last_success_at) : '—'
              const lastErr = truncate(route.last_error_message, 28)
              return (
                <tr key={route.route_id} className="border-b border-slate-100/60 last:border-0 dark:border-gdc-border/50 hover:bg-slate-50/50 dark:hover:bg-gdc-elevated/20">
                  <td className="px-2 py-2 font-medium text-slate-800 dark:text-slate-100 max-w-[8rem] truncate">
                    {destName}
                  </td>
                  <td className="px-2 py-2">
                    <span className={cn('inline-flex items-center rounded border px-1.5 py-px text-[10px] font-bold uppercase tracking-wide', routeStatusToneClass(route))}>
                      {routeStatusLabel(route)}
                    </span>
                  </td>
                  <td className="px-2 py-2 tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {formatEps(route.delivered_eps_1m)}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {formatSuccessPct(route.success_rate_5m)}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {retryLabel}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-slate-500 dark:text-gdc-muted whitespace-nowrap">
                    {lastDelivery}
                  </td>
                  <td className="px-2 py-2 max-w-[8rem] truncate" title={route.last_error_message ?? undefined}>
                    <span className={cn('text-[10px]', route.last_error_message ? 'text-red-500 dark:text-red-400' : 'text-slate-400 dark:text-gdc-muted')}>
                      {lastErr}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Tab: Events ───────────────────────────────────────────────────────────────

function EventsTab({ stream }: { stream: StreamConsoleRow }) {
  if (!stream.hasRuntimeApiSnapshot) {
    return (
      <div className="p-4">
        <EmptyState label="No runtime events yet. Start the stream to see events." />
      </div>
    )
  }

  return (
    <div className="p-4">
      {stream.recentErrors.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200/60 dark:border-gdc-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-slate-200/60 dark:border-gdc-border bg-slate-50/80 dark:bg-gdc-elevated/40">
                {['Time', 'Type', 'Message'].map((h) => (
                  <th key={h} className="px-2 py-2 text-left font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stream.recentErrors.map((e, i) => (
                <tr key={`${e.relativeAt}-${i}`} className="border-b border-slate-100/60 last:border-0 dark:border-gdc-border/50">
                  <td className="px-2 py-2 whitespace-nowrap tabular-nums text-slate-500 dark:text-gdc-muted">{e.relativeAt}</td>
                  <td className="px-2 py-2">
                    <span className="inline-flex items-center rounded border border-red-600/40 bg-red-500/10 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-red-400">
                      Error
                    </span>
                  </td>
                  <td className="px-2 py-2 text-slate-700 dark:text-slate-300 max-w-[14rem] truncate" title={e.message}>
                    {e.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200/50 bg-emerald-50/50 p-3 dark:border-emerald-900/30 dark:bg-emerald-950/20">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
            <div>
              <p className="text-[12px] font-medium text-emerald-800 dark:text-emerald-200">No recent errors</p>
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                Last activity: {formatRelativeShort(stream.lastActivityRelative)}
              </p>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
            For full event history, open the stream detail page.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Schema ──────────────────────────────────────────────────────────────

function SchemaTab({ stream }: { stream: StreamConsoleRow }) {
  const sourceTypeDisplay = stream.sourceTypeLabel !== '—'
    ? stream.sourceTypeLabel
    : stream.streamType !== '—'
      ? stream.streamType
      : stream.streamTypeKey.replace(/_/g, ' ')

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <SectionHeading>Source Information</SectionHeading>
        <div className="rounded-lg border border-slate-200/60 bg-slate-50/50 px-3 dark:border-gdc-border dark:bg-gdc-elevated/30">
          <MetricRow label="Stream ID" value={stream.id} mono />
          <MetricRow label="Connector" value={stream.connectorName} />
          <MetricRow label="Source Type" value={sourceTypeDisplay} />
          {stream.authType && stream.authType !== '—' ? (
            <MetricRow label="Auth Type" value={stream.authType} />
          ) : null}
        </div>
      </div>

      <div>
        <SectionHeading>Schema Details</SectionHeading>
        <div className="rounded-lg border border-slate-200/60 bg-amber-50/30 p-3 dark:border-gdc-border dark:bg-amber-950/10">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
            <p className="text-[11px] text-amber-800 dark:text-amber-200">
              Detailed schema information is available on the Stream Detail page. Click "Open Detail" to view fields, union schema, and schema drift settings.
            </p>
          </div>
        </div>
      </div>

      <div>
        <SectionHeading>Actions</SectionHeading>
        <div className="flex flex-col gap-2">
          <Link
            to={streamRuntimePath(stream.id)}
            className="inline-flex items-center justify-between rounded-lg border border-slate-200/60 bg-white px-3 py-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          >
            <span className="flex items-center gap-2">
              <Layers className="h-3.5 w-3.5 text-violet-500" aria-hidden />
              Open Stream Detail
            </span>
            <ExternalLink className="h-3.5 w-3.5 text-slate-400" aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  )
}

// ─── Tab: Checkpoint ──────────────────────────────────────────────────────────

function CheckpointTab({ stream }: { stream: StreamConsoleRow }) {
  const hasCheckpoint = stream.checkpointValue && stream.checkpointValue !== '—'
  const checkpointStatus =
    stream.checkpointLagLabel && stream.checkpointLagLabel !== '—' ? 'Warning' : 'Healthy'

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Policy note */}
      <div className="flex items-start gap-2 rounded-lg border border-sky-200/50 bg-sky-50/50 p-3 dark:border-sky-800/30 dark:bg-sky-950/20">
        <Bookmark className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
        <p className="text-[11px] text-sky-800 dark:text-sky-200">
          Checkpoint is updated after successful delivery.
        </p>
      </div>

      <div>
        <SectionHeading>Checkpoint Status</SectionHeading>
        <div className="rounded-lg border border-slate-200/60 bg-slate-50/50 px-3 dark:border-gdc-border dark:bg-gdc-elevated/30">
          <MetricRow
            label="Status"
            value={
              <span className={cn(
                'inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide',
                checkpointStatus === 'Healthy' ? 'text-emerald-500' : 'text-amber-500',
              )}>
                {checkpointStatus === 'Healthy' ? (
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                ) : (
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                )}
                {checkpointStatus}
              </span>
            }
          />
          <MetricRow
            label="Last Updated"
            value={stream.checkpointUpdatedAt !== '—' ? formatRelativeShort(stream.checkpointUpdatedAt) : '—'}
          />
          <MetricRow
            label="Lag"
            value={stream.checkpointLagLabel !== '—' ? stream.checkpointLagLabel : 'None'}
            mono
          />
          <MetricRow label="Retention" value="7 days" />
        </div>
      </div>

      {hasCheckpoint ? (
        <div>
          <SectionHeading>Current Checkpoint Value</SectionHeading>
          <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200/60 bg-slate-900 p-3 text-[10px] font-mono text-emerald-300 dark:border-gdc-border">
            {stream.checkpointValue}
          </pre>
        </div>
      ) : (
        <div>
          <SectionHeading>Current Checkpoint Value</SectionHeading>
          <EmptyState label={stream.hasRuntimeApiSnapshot ? 'No checkpoint stored yet' : 'No runtime data'} />
        </div>
      )}
    </div>
  )
}

// ─── Main Panel Component ──────────────────────────────────────────────────────

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'destinations', label: 'Destinations' },
  { id: 'events', label: 'Events' },
  { id: 'schema', label: 'Schema' },
  { id: 'checkpoint', label: 'Checkpoint' },
]

export function StreamConsoleDetailPanel({
  stream,
  routes,
  problems: _problems,
  onClose,
  initialTab = 'overview',
  topOffset = 0,
}: StreamConsoleDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>(initialTab)
  const streamRoutes = routes.filter((r) => r.stream_id === Number(stream.id))

  const statusBadgeClass = streamStatusToneClass(stream)
  const statusLabel = streamStatusLabel(stream)

  const connectorFormat = [stream.connectorName !== '—' ? stream.connectorName : null, stream.sourceTypeLabel !== '—' ? stream.sourceTypeLabel : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="sticky top-0 self-start flex w-[400px] min-w-[340px] shrink-0 flex-col overflow-hidden border-l border-slate-200/80 bg-white dark:border-gdc-border dark:bg-gdc-card"
      style={{ marginTop: topOffset > 0 ? topOffset : undefined, maxHeight: '100vh' }}
      data-testid="stream-console-detail-panel"
      aria-label={`Stream detail: ${stream.name}`}
    >
      {/* Header */}
      <div className="flex shrink-0 items-start gap-2 border-b border-slate-200/60 bg-slate-50/50 px-4 py-3 dark:border-gdc-border dark:bg-gdc-elevated/30">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 shrink-0 text-violet-500" aria-hidden />
            <h3 className="truncate text-[14px] font-semibold text-slate-900 dark:text-slate-50">
              {stream.name}
            </h3>
          </div>
          {connectorFormat ? (
            <p className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-gdc-muted">{connectorFormat}</p>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <span className={cn('inline-flex items-center rounded border px-1.5 py-px text-[10px] font-bold uppercase tracking-wide', statusBadgeClass)}>
              {statusLabel}
            </span>
          </div>
          <div className="mt-2">
            <Link
              to={streamRuntimePath(stream.id)}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              Open Runtime
              <ExternalLink className="h-3 w-3 opacity-70" aria-hidden />
            </Link>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-200/60 hover:text-slate-600 dark:hover:bg-gdc-elevated dark:hover:text-slate-200"
          aria-label="Close detail panel"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 border-b border-slate-200/60 dark:border-gdc-border overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'shrink-0 whitespace-nowrap px-3 py-2 text-[12px] font-medium transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-violet-500 text-violet-600 dark:text-violet-400'
                : 'text-slate-600 hover:text-slate-900 dark:text-gdc-muted dark:hover:text-slate-200',
            )}
            aria-selected={activeTab === tab.id}
            role="tab"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === 'overview' && (
          <OverviewTab stream={stream} streamRoutes={streamRoutes} />
        )}
        {activeTab === 'destinations' && (
          <DestinationsTab streamRoutes={streamRoutes} />
        )}
        {activeTab === 'events' && (
          <EventsTab stream={stream} />
        )}
        {activeTab === 'schema' && (
          <SchemaTab stream={stream} />
        )}
        {activeTab === 'checkpoint' && (
          <CheckpointTab stream={stream} />
        )}
      </div>
    </div>
  )
}
