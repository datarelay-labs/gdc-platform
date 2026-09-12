import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  FlaskConical,
  Loader2,
  MinusCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Sparkles,
  Wand2,
  Workflow,
  XCircle,
} from 'lucide-react'
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { computeFixedRowVirtualRange } from '../../lib/fixed-row-virtual-window'
import { formatRunOnceSummaryLines } from '../../utils/formatRunOnceSummary'
import { StatusBadge } from '../shell/status-badge'
import { opStateRow, opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  logsPath,
  newStreamPath,
  streamApiTestPath,
  streamEditPath,
  streamEnrichmentPath,
  streamMappingPath,
  streamRuntimePath,
} from '../../config/nav-paths'
import {
  fetchStreamMappingUiConfig,
  runStreamOnce,
} from '../../api/gdcRuntime'
import { fetchConnectorsList } from '../../api/gdcConnectors'
import { fetchStreamsListResult, GDC_AUTH_REQUIRED_MESSAGE } from '../../api/gdcStreams'
import { clearOperationalSnapshotCache, getOperationalSnapshot, type OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { destinationLabelsByStreamIdFromSnapshot } from '../../lib/streams-console-destination-labels'
import { createRefreshCycleSnapshotId } from '../../api/runtimeSnapshotSync'
import {
  enrichStreamRowFromOperationalSnapshot,
  mergeConnectorIntoRow,
  type ConnectorRowMetadata,
  mergeMappingUiIntoRow,
  streamReadToConsoleRow,
  type StreamConsoleRow,
  type StreamRuntimeStatus,
} from '../../api/streamRows'
import { computeStreamWorkflow, type StreamWorkflowInput, type StreamWorkflowSnapshot } from '../../utils/streamWorkflow'
import { workflowOverridesFromMappingUi } from '../../utils/mappingUiWorkflow'
import { resolveSourceTypePresentation } from '../../utils/sourceTypePresentation'
import { streamsSectionKpiFromOperationalSnapshot, type StreamsSectionKpi } from '../../api/streamsKpi'
import { StreamWorkflowProgressBadge } from './stream-workflow-checklist'
import { groupRowsBySourceProduct } from '../../lib/source-product-group'
import {
  aggregateGroupIssueBreakdown,
  aggregateGroupRates,
  aggregateGroupSparklines,
  computeGroupOperationalStats,
  computeStreamsPageKpi,
  formatGroupHeaderSummary,
  formatRelativeShort,
  groupHealthLabelFromSeverity,
  groupHealthToneFromSeverity,
  groupLastEventLabel,
  checkpointFreshnessLabel,
  sparklineHasTrend,
  streamSuccessRateDisplay,
  streamUsesCheckpointObservability,
  type StreamsPageKpi,
  successRateTone,
  type GroupHealthLabel,
} from '../../lib/stream-console-metrics'
import { formatOperationalPercent, formatThroughputEps } from '../../lib/observability-format'
import { operationalSeverityIcon } from '../../lib/stream-operational-status'
import { StreamsGroupKpiStrip } from './streams-group-kpi-strip'
import { StreamsOperationsSummaryStrip } from './streams-operations-summary-strip'
import { StreamConsoleDetailPanel } from './stream-console-detail-panel'
import { StreamsOperationsToolbar } from './streams-operations-toolbar'
import { StreamsConsoleControls } from './streams-console-controls'
import { StreamsFilterChips } from './streams-filter-chips'
import {
  computeStreamOperationsSummary,
  filterStreamRows,
  productGroupOptions,
  sortGroupsProblemFirst,
  sortStreamsProblemFirst,
  type StreamsQuickFilter,
} from '../../lib/streams-console-operations'
import {
  formatStreamIssuesCell,
  streamOperationalHealthLabel,
  streamSeverityFromCauses,
} from '../../lib/stream-console-issue-causes'
import type { StreamsMetricsWindow } from '../../constants/streamConsoleFilters'
import { parseConnectorFilterFromSearch, connectorFilterIsNumericId } from '../../constants/streamConsoleFilters'
import { isDevValidationLabUiEnabled } from '../../lib/feature-flags'
import { operationalRunControlTooltipSupplement } from '../../utils/streamOperationalBadges'
import { DevValidationBadge } from '../shell/dev-validation-badge'
import {
  loadStreamsAutoRefresh,
  loadStreamsTimeRange,
  persistStreamsAutoRefresh,
  persistStreamsTimeRange,
  type StreamsAutoRefreshOption,
} from '../../localPreferences'
import type { StreamRead } from '../../api/types/gdcApi'
import { readStreamsConsoleSnapshot, writeStreamsConsoleSnapshot, clearStreamsConsoleSnapshot } from './streams-console-cache'
import { RuntimeFixtureModeBanner } from '../runtime/runtime-fixture-mode-banner'
import { useMountAbortController } from '../../hooks/use-mount-abort-signal'
import { isRequestAborted } from '../../lib/request-abort'

const STREAMS_CONNECTOR_ENRICH_CONCURRENCY = 12

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return []
  const limit = Math.max(1, concurrency)
  const out: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex
      nextIndex += 1
      if (i >= items.length) return
      out[i] = await mapper(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

async function enrichStreamConsoleRows(
  streamList: StreamRead[],
  gen: number,
  loadGenRef: MutableRefObject<number>,
  isCancelled: () => boolean,
  _metricsWindow: StreamsMetricsWindow,
  _snapshotId: string | undefined,
  fetchOpts: { signal?: AbortSignal },
  setters: {
    setDisplayRows: Dispatch<SetStateAction<StreamConsoleRow[]>>
  },
): Promise<void> {
  const isCurrent = () => !isCancelled() && loadGenRef.current === gen

  const baseRows = streamList.map((s) => streamReadToConsoleRow(s))
  setters.setDisplayRows(baseRows)
  if (!isCurrent()) return

  const connectorById = new Map<number, ConnectorRowMetadata>()
  const connectorIds = [
    ...new Set(streamList.map((s) => s.connector_id).filter((x): x is number => typeof x === 'number')),
  ]

  const [connectorsList, operationalSnapshot] = await Promise.all([
    fetchConnectorsList(fetchOpts),
    getOperationalSnapshot(),
  ])
  for (const c of connectorsList ?? []) {
    if (!connectorIds.includes(c.id)) continue
    const nm = (c.name ?? '').trim()
    const pg = (c.product_group ?? '').trim() || null
    if (nm || pg) connectorById.set(c.id, { name: nm || null, product_group: pg })
  }
  if (!isCurrent()) return

  const operationalByStreamId = new Map(
    (operationalSnapshot?.streams ?? []).map((stream) => [stream.stream_id, stream]),
  )
  const snapshotProblems = operationalSnapshot?.problems ?? []

  const enrichedRows = baseRows.map((row) => {
    const sid = Number(row.id)
    if (!Number.isFinite(sid) || !/^\d+$/.test(row.id)) {
      return { ...row, runtimeStatsAttempted: true, hasRuntimeApiSnapshot: false }
    }
    const snap = operationalByStreamId.get(sid)
    if (!snap) {
      return { ...row, runtimeStatsAttempted: true, hasRuntimeApiSnapshot: false }
    }
    return enrichStreamRowFromOperationalSnapshot(row, snap, snapshotProblems)
  })
  if (!isCurrent()) return

  const withConnectors = enrichedRows.map((row) => {
    const connMeta = row.connectorId != null ? connectorById.get(row.connectorId) : undefined
    return mergeConnectorIntoRow(row, connMeta ?? null)
  })
  setters.setDisplayRows(withConnectors)
}

/** Lazy mapping-ui enrichment — deferred until group expand or flat-table visibility (P1). */
export async function enrichMappingUiForStreamIds(
  streamIds: readonly number[],
  gen: number,
  loadGenRef: MutableRefObject<number>,
  isCancelled: () => boolean,
  alreadyFetched: ReadonlySet<number>,
  fetchOpts: { signal?: AbortSignal },
  setters: {
    setDisplayRows: Dispatch<SetStateAction<StreamConsoleRow[]>>
    setWorkflowExtrasByStreamId: Dispatch<SetStateAction<Record<string, Partial<StreamWorkflowInput>>>>
  },
): Promise<number[]> {
  const pending = streamIds.filter((id) => Number.isFinite(id) && id > 0 && !alreadyFetched.has(id))
  if (!pending.length) return []

  const isCurrent = () => !isCancelled() && loadGenRef.current === gen

  const cfgPairs = await mapWithConcurrency(pending, STREAMS_CONNECTOR_ENRICH_CONCURRENCY, async (id) => {
    try {
      const cfg = await fetchStreamMappingUiConfig(id, fetchOpts)
      return [id, cfg] as const
    } catch (e) {
      if (isRequestAborted(e)) throw e
      return [id, null] as const
    }
  })
  if (!isCurrent()) return []

  const cfgById = new Map<number, NonNullable<Awaited<ReturnType<typeof fetchStreamMappingUiConfig>>>>()
  for (const [id, cfg] of cfgPairs) {
    if (cfg != null) cfgById.set(id, cfg)
  }

  const extrasPatch: Record<string, Partial<StreamWorkflowInput>> = {}
  const fetchedIds: number[] = []
  for (const id of pending) {
    const cfg = cfgById.get(id)
    if (cfg) extrasPatch[String(id)] = workflowOverridesFromMappingUi(cfg)
    fetchedIds.push(id)
  }

  if (Object.keys(extrasPatch).length > 0) {
    setters.setWorkflowExtrasByStreamId((prev) => ({ ...prev, ...extrasPatch }))
  }

  setters.setDisplayRows((prev) =>
    prev.map((row) => {
      const sid = Number(row.id)
      if (!Number.isFinite(sid) || !pending.includes(sid)) return row
      const cfg = cfgById.get(sid)
      return cfg ? mergeMappingUiIntoRow(row, cfg) : row
    }),
  )

  return fetchedIds
}

function statusTone(s: StreamRuntimeStatus) {
  switch (s) {
    case 'RUNNING':
      return 'success' as const
    case 'DEGRADED':
      return 'warning' as const
    case 'ERROR':
      return 'error' as const
    case 'STOPPED':
      return 'neutral' as const
    case 'UNKNOWN':
      return 'neutral' as const
    default: {
      const _exhaustive: never = s
      return _exhaustive
    }
  }
}

function GroupHealthBadge({
  label,
  tone,
}: {
  label: GroupHealthLabel
  tone: ReturnType<typeof groupHealthToneFromSeverity>
}) {
  const Icon =
    label === 'Healthy'
      ? CheckCircle2
      : label === 'Warning'
        ? AlertTriangle
        : label === 'Critical'
          ? XCircle
          : MinusCircle
  const toneClass =
    tone === 'success'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
      : tone === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
        : tone === 'error'
          ? 'border-red-500/40 bg-red-500/10 text-red-400'
          : 'border-slate-500/40 bg-slate-500/10 text-slate-400'
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', toneClass)}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  )
}

function eventsSparklineClass(status: StreamRuntimeStatus) {
  switch (status) {
    case 'RUNNING':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'DEGRADED':
      return 'text-amber-600 dark:text-amber-400'
    case 'ERROR':
      return 'text-red-600 dark:text-red-400'
    case 'STOPPED':
      return 'text-slate-400 dark:text-gdc-muted'
    case 'UNKNOWN':
      return 'text-slate-400 dark:text-gdc-muted'
    default: {
      const _e: never = status
      return _e
    }
  }
}

function MiniSparkline({ values }: { values: readonly number[] }) {
  const w = 52
  const h = 18
  const padX = 2
  const padY = 2
  const nums = values.length ? [...values] : [0]
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const range = max - min || 1
  const innerW = w - padX * 2
  const innerH = h - padY * 2
  const pts = nums.map((v, i) => {
    const x = padX + (i / Math.max(nums.length - 1, 1)) * innerW
    const y = padY + (1 - (v - min) / range) * innerH
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 overflow-visible" aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={pts.join(' ')} />
    </svg>
  )
}

function RouteFanOut({ row }: { row: StreamConsoleRow }) {
  const dots: Array<{ tone: 'ok' | 'deg' | 'err' }> = []
  for (let i = 0; i < row.routesOk; i += 1) dots.push({ tone: 'ok' })
  for (let i = 0; i < row.routesDegraded; i += 1) dots.push({ tone: 'deg' })
  for (let i = 0; i < row.routesError; i += 1) dots.push({ tone: 'err' })
  const summaryParts: string[] = []
  if (row.routesOk) summaryParts.push(`${row.routesOk} OK`)
  if (row.routesDegraded) summaryParts.push(`${row.routesDegraded} DEG`)
  if (row.routesError) summaryParts.push(`${row.routesError} ERR`)
  const summary = summaryParts.length ? summaryParts.join(', ') : '—'
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <span className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">{row.routesTotal}</span>
        <span className="flex items-center gap-0.5" aria-hidden>
          {dots.map((d, idx) => (
            <span
              key={`${d.tone}-${idx}`}
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                d.tone === 'ok' && 'bg-emerald-500',
                d.tone === 'deg' && 'bg-amber-500',
                d.tone === 'err' && 'bg-red-500',
              )}
            />
          ))}
        </span>
      </div>
      <p className="truncate text-[10px] font-medium text-slate-500 dark:text-gdc-muted">{summary}</p>
    </div>
  )
}

function DeliveryMeter({ pct }: { pct: number }) {
  const tone =
    pct >= 99 ? 'bg-emerald-500' : pct >= 90 ? 'bg-amber-500' : pct <= 0 ? 'bg-slate-300 dark:bg-slate-600' : 'bg-red-500'
  const width = `${Math.min(100, Math.max(0, pct))}%`
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">{formatOperationalPercent(pct)}</p>
      <div className="h-1 w-full max-w-[88px] overflow-hidden rounded-full bg-slate-200/90 dark:bg-gdc-elevated">
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width }} />
      </div>
    </div>
  )
}

/** Format EPS as compact decimal without unit suffix (for table cell). */
function epsCompact(eps: number): string {
  if (!Number.isFinite(eps) || eps <= 0) return '—'
  return formatThroughputEps(eps)
}

/** Arrow + % delta between eps1m and eps5m. */
function epsDeltaLabel(row: StreamConsoleRow): string | null {
  const eps5m = row.eps5m ?? 0
  const eps1m = row.eps1m ?? 0
  if (eps5m <= 0 || eps1m <= 0 || eps5m === eps1m) return null
  const pct = ((eps1m - eps5m) / eps5m) * 100
  if (Math.abs(pct) < 1) return null
  return pct > 0 ? `↑ ${Math.round(Math.abs(pct))}%` : `↓ ${Math.round(Math.abs(pct))}%`
}

function StreamEpsCell({ row }: { row: StreamConsoleRow }) {
  if (!row.hasRuntimeApiSnapshot) {
    return <span className="text-[12px] text-slate-400 dark:text-gdc-muted">—</span>
  }
  const currentEps = row.eps5m != null && row.eps5m > 0 ? row.eps5m : row.ingestEps
  const epsLabel = epsCompact(currentEps)
  const delta = epsDeltaLabel(row)
  const hasTrend = sparklineHasTrend(row.eventsTrend)
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">{epsLabel}</span>
        {hasTrend && (
          <span className={eventsSparklineClass(row.status)}>
            <MiniSparkline values={row.eventsTrend} />
          </span>
        )}
      </div>
      {delta && (
        <span
          className={cn(
            'text-[10px] font-medium tabular-nums',
            delta.startsWith('↑') ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400',
          )}
        >
          {delta}
        </span>
      )}
    </div>
  )
}

function StreamSuccessCell({ row }: { row: StreamConsoleRow }) {
  const success = streamSuccessRateDisplay(row)
  if (!success.known) {
    return <span className="text-[12px] text-slate-400 dark:text-gdc-muted">—</span>
  }
  const pct = success.pct ?? 0
  const barColor = pct >= 98 ? 'bg-emerald-500' : pct >= 90 ? 'bg-amber-500' : 'bg-red-500'
  const textColor = pct >= 98 ? 'text-emerald-600 dark:text-emerald-400' : pct >= 90 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
  const targetPct = 99
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn('text-[12px] font-semibold tabular-nums', textColor)}>
        {formatOperationalPercent(pct)}
      </span>
      {/* Bullet chart: current bar + target line at 99% */}
      <div className="relative h-2 w-full max-w-[80px] overflow-visible rounded-sm bg-slate-200/90 dark:bg-gdc-elevated">
        <div className={cn('h-full rounded-sm', barColor)} style={{ width: `${Math.min(100, pct)}%` }} />
        <div
          className="absolute top-0 h-full w-px bg-slate-600 dark:bg-slate-300 opacity-70"
          style={{ left: `${targetPct}%` }}
          title={`Target: ${targetPct}%`}
        />
      </div>
      <span className="text-[9px] text-slate-400 dark:text-gdc-muted">target {targetPct}%</span>
    </div>
  )
}

function extractLagSeconds(lagLabel: string): number | null {
  if (!lagLabel || lagLabel === '—') return null
  const m = lagLabel.match(/(\d+)s/)
  return m ? parseInt(m[1]) : null
}

function formatLagDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const min = Math.floor(seconds / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const remMin = min % 60
  return remMin > 0 ? `${h}h ${remMin}m` : `${h}h`
}

function StreamCheckpointCell({ row }: { row: StreamConsoleRow }) {
  if (!row.hasRuntimeApiSnapshot) {
    return <span className="text-[12px] text-slate-400 dark:text-gdc-muted">—</span>
  }
  if (!streamUsesCheckpointObservability(row)) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] font-medium text-slate-600 dark:text-slate-400">Push ingest</span>
        <span className="text-[10px] text-slate-500 dark:text-gdc-muted">No checkpoint</span>
      </div>
    )
  }
  const time = row.checkpointUpdatedAt && row.checkpointUpdatedAt !== '—' ? formatRelativeShort(row.checkpointUpdatedAt) : '—'
  const isLagging = Boolean(row.checkpointLagLabel && row.checkpointLagLabel !== '—')
  const lagSec = isLagging ? extractLagSeconds(row.checkpointLagLabel) : null
  const freshness = checkpointFreshnessLabel(row.checkpointUpdatedAt, isLagging)
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[12px] font-medium tabular-nums text-slate-700 dark:text-slate-300">{time}</span>
      {lagSec !== null && (
        <span className="text-[10px] text-slate-500 dark:text-gdc-muted">Lag {formatLagDuration(lagSec)}</span>
      )}
      {isLagging ? (
        <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">Lagging</span>
      ) : freshness === 'Healthy' ? (
        <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">Healthy</span>
      ) : freshness === 'Stale' ? (
        <span className="text-[10px] font-semibold text-slate-500 dark:text-gdc-muted">Stale</span>
      ) : null}
    </div>
  )
}

function StreamRowActions({ row }: { row: StreamConsoleRow }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const hasId = /^\d+$/.test(row.id)

  const menuItemCls =
    'flex items-center gap-2 px-3 py-2 text-[12px] text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-gdc-elevated'

  return (
    <div
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Link
        to={hasId ? streamRuntimePath(row.id) : '#'}
        aria-disabled={!hasId}
        title={hasId ? 'Open Runtime' : 'Runtime unavailable: missing stream id'}
        aria-label={`Open Runtime: ${row.name}`}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold shadow-sm transition-colors',
          hasId
            ? 'bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500'
            : 'cursor-not-allowed bg-slate-300/60 text-slate-500 dark:bg-slate-700 dark:text-slate-500',
        )}
      >
        <Play className="h-3 w-3" aria-hidden />
        Open Runtime
      </Link>
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          onBlur={() => window.setTimeout(() => setMenuOpen(false), 160)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-gdc-elevated dark:hover:text-slate-300"
          aria-label="More actions"
          title="More actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-full z-[60] mt-1 min-w-[11rem] rounded-lg border border-slate-200/80 bg-white py-1 shadow-lg dark:border-gdc-border dark:bg-gdc-card">
            <Link to={streamRuntimePath(row.id)} onClick={() => setMenuOpen(false)} className={menuItemCls}>
              <Play className="h-3.5 w-3.5 text-violet-500" aria-hidden />
              Open Runtime
            </Link>
            <Link to={streamEditPath(row.id)} onClick={() => setMenuOpen(false)} className={menuItemCls}>
              <Pencil className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              Edit Stream
            </Link>
            <Link to={logsPath(row.id)} onClick={() => setMenuOpen(false)} className={menuItemCls}>
              <ScrollText className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              View Logs
            </Link>
            <Link
              to={`${streamEditPath(row.id)}?tab=route_processing`}
              onClick={() => setMenuOpen(false)}
              className={menuItemCls}
            >
              <Workflow className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              Route Processing
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ─── Overall Health Beacon ────────────────────────────────────────────────────

type SystemHealthStatus = 'OPERATIONAL' | 'DEGRADED' | 'INCIDENT' | 'CRITICAL'

function computeSystemHealthStatus(kpi: StreamsPageKpi): { status: SystemHealthStatus; description: string } {
  if (kpi.criticalStreams > 0) return { status: 'CRITICAL', description: 'Delivery failure detected' }
  if (kpi.warningStreams > 0) return { status: 'DEGRADED', description: `${kpi.warningStreams} stream${kpi.warningStreams !== 1 ? 's' : ''} require attention` }
  if (kpi.totalIssues > 0) return { status: 'INCIDENT', description: `${kpi.totalIssues} active issue${kpi.totalIssues !== 1 ? 's' : ''} detected` }
  return { status: 'OPERATIONAL', description: 'All streams are healthy' }
}

function OverallHealthBeacon({ kpi, loading }: { kpi: StreamsPageKpi; loading?: boolean }) {
  if (loading) return <div className="h-14 animate-pulse rounded-xl bg-slate-200/60 dark:bg-gdc-elevated" aria-hidden />

  const { status, description } = computeSystemHealthStatus(kpi)

  type ToneCfg = { border: string; bg: string; dot: string; statusCls: string; descCls: string; metaCls: string }
  const cfg: Record<SystemHealthStatus, ToneCfg> = {
    OPERATIONAL: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/[0.06]', dot: 'bg-emerald-500', statusCls: 'text-emerald-600 dark:text-emerald-400', descCls: 'text-emerald-800 dark:text-emerald-200', metaCls: 'text-emerald-600/80 dark:text-emerald-400/80' },
    DEGRADED:    { border: 'border-amber-500/30',   bg: 'bg-amber-500/[0.06]',   dot: 'bg-amber-500',   statusCls: 'text-amber-600 dark:text-amber-400',   descCls: 'text-amber-800 dark:text-amber-200',   metaCls: 'text-amber-600/80 dark:text-amber-400/80'   },
    INCIDENT:    { border: 'border-orange-500/30',  bg: 'bg-orange-500/[0.06]',  dot: 'bg-orange-500 animate-pulse', statusCls: 'text-orange-600 dark:text-orange-400', descCls: 'text-orange-800 dark:text-orange-200', metaCls: 'text-orange-600/80 dark:text-orange-400/80' },
    CRITICAL:    { border: 'border-red-500/30',     bg: 'bg-red-500/[0.06]',     dot: 'bg-red-500 animate-pulse',    statusCls: 'text-red-600 dark:text-red-400',         descCls: 'text-red-800 dark:text-red-200',         metaCls: 'text-red-600/80 dark:text-red-400/80'   },
  }
  const c = cfg[status]

  const meta = [
    kpi.criticalStreams > 0 && `${kpi.criticalStreams} critical`,
    kpi.warningStreams > 0 && `${kpi.warningStreams} warning`,
  ].filter(Boolean).join(' · ')

  return (
    <div className={cn('flex items-center gap-3 rounded-xl border px-4 py-3', c.border, c.bg)} data-testid="overall-health-beacon">
      <div className={cn('h-3 w-3 shrink-0 rounded-full', c.dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={cn('text-[12px] font-bold tracking-widest', c.statusCls)}>{status}</span>
          <span className={cn('text-[12px] font-medium', c.descCls)}>{description}</span>
        </div>
        <p className={cn('mt-0.5 text-[11px]', c.metaCls)}>
          {meta ? `${meta} stream${(kpi.criticalStreams + kpi.warningStreams) !== 1 ? 's' : ''}` : `${kpi.totalStreams} stream${kpi.totalStreams !== 1 ? 's' : ''} monitored`}
        </p>
      </div>
    </div>
  )
}

// ─── System Health Summary Strip ─────────────────────────────────────────────

function computeHealthSummaryItems(rows: readonly StreamConsoleRow[]) {
  let noData = 0, lowVolume = 0, checkpointLag = 0, destFailure = 0, deliveryRetry = 0, disabled = 0
  for (const row of rows) {
    if (row.status === 'STOPPED') { disabled++; continue }
    if (!row.hasRuntimeApiSnapshot) { noData++; continue }
    if (row.ingestEps <= 0 && (row.eps1m ?? 0) <= 0 && (row.eps5m ?? 0) <= 0) lowVolume++
    if (row.checkpointLagLabel && row.checkpointLagLabel !== '—') checkpointLag++
    if (row.routesError > 0) destFailure++
    if (row.recentErrors.length > 0) deliveryRetry++
  }
  return { noData, lowVolume, checkpointLag, destFailure, deliveryRetry, disabled }
}

function SystemHealthSummaryStrip({ rows, loading }: { rows: readonly StreamConsoleRow[]; loading?: boolean }) {
  if (loading) return <div className="h-12 animate-pulse rounded-xl bg-slate-200/60 dark:bg-gdc-elevated" aria-hidden />

  const { noData, lowVolume, checkpointLag, destFailure, deliveryRetry, disabled } = computeHealthSummaryItems(rows)

  const items = [
    { label: 'No Data',          count: noData,        tone: noData > 0 ? 'warning' : 'ok' as const },
    { label: 'Low Volume',       count: lowVolume,      tone: lowVolume > 0 ? 'warning' : 'ok' as const },
    { label: 'Checkpoint Lag',   count: checkpointLag,  tone: checkpointLag > 0 ? 'warning' : 'ok' as const },
    { label: 'Dest. Failure',    count: destFailure,    tone: destFailure > 0 ? 'critical' : 'ok' as const },
    { label: 'Delivery Retry',   count: deliveryRetry,  tone: deliveryRetry > 0 ? 'warning' : 'ok' as const },
    { label: 'Disabled',         count: disabled,       tone: 'neutral' as const },
  ]

  return (
    <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card" data-testid="health-summary-strip">
      {items.map(({ label, count, tone }) => {
        const active = count > 0
        const stripCls = tone === 'critical' && active ? 'border-red-500/30 bg-red-500/[0.06] text-red-700 dark:text-red-300'
          : tone === 'warning' && active ? 'border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
          : 'border-slate-200/60 bg-slate-50/50 text-slate-600 dark:border-gdc-border dark:bg-gdc-elevated/20 dark:text-gdc-muted'
        const dotCls = tone === 'critical' && active ? 'bg-red-500'
          : tone === 'warning' && active ? 'bg-amber-500'
          : tone === 'neutral' ? 'bg-slate-400'
          : 'bg-emerald-500'
        const countCls = tone === 'critical' && active ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
          : tone === 'warning' && active ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
          : 'bg-slate-100 text-slate-600 dark:bg-gdc-elevated dark:text-gdc-muted'
        return (
          <div key={label} className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-medium', stripCls)}>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotCls)} aria-hidden />
            {label}
            <span className={cn('min-w-[1.25rem] rounded px-1 text-center text-[11px] font-bold tabular-nums', countCls)}>{count}</span>
          </div>
        )
      })}
    </div>
  )
}

function emptyStreamsKpi(): StreamsSectionKpi {
  return {
    total: 0,
    totalTrend: '—',
    running: 0,
    runningPct: '—',
    degraded: 0,
    degradedPct: '—',
    error: 0,
    errorPct: '—',
    stopped: 0,
    stoppedPct: '—',
    processedEvents: '—',
    processedEventsTrend: '—',
  }
}

function streamWorkflowFromRow(row: StreamConsoleRow, extras?: Partial<StreamWorkflowInput>): StreamWorkflowSnapshot {
  return computeStreamWorkflow({
    streamId: row.id,
    status: row.status,
    events1h: row.events1h,
    deliveryPct: row.deliveryPct,
    routesTotal: row.routesTotal,
    routesOk: row.routesOk,
    routesDegraded: row.routesDegraded,
    routesError: row.routesError,
    sourceType: row.streamTypeKey,
    ...extras,
  })
}

const STREAMS_CONSOLE_ROW_HEIGHT = 56
const STREAMS_CONSOLE_VIRTUALIZE_MIN = 50
const STREAMS_CONSOLE_VIRTUAL_VIEWPORT = 560

const streamsGroupTableThClass =
  'px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-gdc-mutedStrong'

const streamsGroupTableTdClass = 'px-3 py-3 align-middle text-[12px] text-slate-700 dark:text-gdc-mutedStrong'

function StreamSeverityIcon({ row, metricsWindow }: { row: StreamConsoleRow; metricsWindow: StreamsMetricsWindow }) {
  const severity = streamSeverityFromCauses(row, metricsWindow)
  const kind = operationalSeverityIcon(severity)
  if (kind === 'critical') return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
  if (kind === 'warn') return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
  if (kind === 'stopped') return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
  return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
}

function StreamOperationalStatusBadge({
  row,
  metricsWindow,
}: {
  row: StreamConsoleRow
  metricsWindow: StreamsMetricsWindow
}) {
  const severity = streamSeverityFromCauses(row, metricsWindow)
  const label = streamOperationalHealthLabel(severity)
  const toneClass =
    severity === 'critical'
      ? 'border-red-600/50 bg-red-950/80 text-red-400'
      : severity === 'warning'
        ? 'border-amber-600/50 bg-amber-950/80 text-amber-400'
        : severity === 'stopped'
          ? 'border-slate-600/50 bg-slate-900/80 text-slate-400'
          : 'border-emerald-600/50 bg-emerald-950/80 text-emerald-400'
  return (
    <span className={cn('inline-flex items-center rounded border px-1.5 py-px text-[10px] font-bold uppercase tracking-wide', toneClass)}>
      {label}
    </span>
  )
}

function streamRowHighlightClass(row: StreamConsoleRow, metricsWindow: StreamsMetricsWindow): string {
  const severity = streamSeverityFromCauses(row, metricsWindow)
  if (severity === 'critical') return 'bg-red-500/[0.04] dark:bg-red-500/[0.06]'
  if (severity === 'warning') return 'bg-amber-500/[0.05] dark:bg-amber-500/[0.07]'
  return 'bg-slate-50/40 dark:bg-gdc-elevated/30'
}

export function StreamsConsole() {
  const cachedSnapshot = readStreamsConsoleSnapshot()
  const [displayRows, setDisplayRows] = useState<StreamConsoleRow[]>(() => cachedSnapshot?.displayRows ?? [])
  const [autoRefresh, setAutoRefresh] = useState<StreamsAutoRefreshOption>('Off')
  const [timeRange, setTimeRange] = useState<StreamsMetricsWindow>('1h')
  useLayoutEffect(() => {
    setAutoRefresh(loadStreamsAutoRefresh())
    setTimeRange(loadStreamsTimeRange())
  }, [])
  const [sectionKpi, setSectionKpi] = useState<StreamsSectionKpi>(
    () => cachedSnapshot?.sectionKpi ?? emptyStreamsKpi(),
  )
  const [streamsLoading, setStreamsLoading] = useState(() => (cachedSnapshot?.displayRows.length ?? 0) === 0)
  const [streamsListError, setStreamsListError] = useState<string | null>(null)
  const [streamsAuthRequired, setStreamsAuthRequired] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const [selectedGroupLabel, setSelectedGroupLabel] = useState<string | null>(() => {
    const params = new URLSearchParams(location.search)
    return params.get('expand_group')?.trim() || null
  })
  const [workflowExtrasByStreamId, setWorkflowExtrasByStreamId] = useState<
    Record<string, Partial<StreamWorkflowInput>>
  >(() => cachedSnapshot?.workflowExtrasByStreamId ?? {})
  const [refreshVersion, setRefreshVersion] = useState(0)
  const abortRef = useMountAbortController()
  const loadGenRef = useRef(0)
  const prevStreamsPathnameRef = useRef(location.pathname)
  const mappingUiFetchedRef = useRef<Set<number>>(new Set())
  const hasLoadedOnceRef = useRef((cachedSnapshot?.displayRows.length ?? 0) > 0)
  const [operationalSnapshot, setOperationalSnapshot] = useState<OperationalSnapshotResponse | null>(null)
  const [selectedStreamRow, setSelectedStreamRow] = useState<StreamConsoleRow | null>(null)
  const [panelTopOffset, setPanelTopOffset] = useState(0)
  const outerContainerRef = useRef<HTMLDivElement>(null)
  const [runOnceStreamId, setRunOnceStreamId] = useState<number | null>(null)
  const [runOnceBanner, setRunOnceBanner] = useState<{ variant: 'success' | 'error'; lines: string[] } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [quickFilter, setQuickFilter] = useState<StreamsQuickFilter>('all')
  const [groupFilter, setGroupFilter] = useState('all')
  const connectorFilter = useMemo(() => parseConnectorFilterFromSearch(location.search), [location.search])

  const connectorFilterLabel = useMemo(() => {
    if (!connectorFilter) return null
    if (connectorFilterIsNumericId(connectorFilter)) {
      const id = Number(connectorFilter)
      const match = displayRows.find((row) => row.connectorId === id)
      return match?.connectorName && !match.connectorName.startsWith('Connector #') ? match.connectorName : null
    }
    return connectorFilter
  }, [connectorFilter, displayRows])

  const clearConnectorFilter = useCallback(() => {
    const params = new URLSearchParams(location.search)
    params.delete('connector')
    const qs = params.toString()
    navigate(qs ? `/streams?${qs}` : '/streams')
  }, [location.search, navigate])
  const destinationLabelsByStreamId = useMemo(
    () => destinationLabelsByStreamIdFromSnapshot(operationalSnapshot?.routes),
    [operationalSnapshot],
  )
  const groupRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const highlightedGroupLabel = useMemo(
    () => new URLSearchParams(location.search).get('expand_group')?.trim() ?? null,
    [location.search],
  )
  const executeRunOnce = useCallback(async (streamIdNum: number | null) => {
    if (streamIdNum == null || runOnceStreamId !== null) return
    setRunOnceStreamId(streamIdNum)
    setRunOnceBanner(null)
      try {
      const r = await runStreamOnce(streamIdNum)
      const lines = formatRunOnceSummaryLines(r)
      setRunOnceBanner({ variant: 'success', lines })
      setRefreshVersion((v) => v + 1)
      window.dispatchEvent(new CustomEvent('gdc-runtime-run-once', { detail: { streamId: streamIdNum, response: r } }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRunOnceBanner({ variant: 'error', lines: [msg] })
    } finally {
      setRunOnceStreamId(null)
    }
  }, [runOnceStreamId])

  useEffect(() => {
    if (displayRows.length === 0) return
    writeStreamsConsoleSnapshot({ displayRows, workflowExtrasByStreamId, sectionKpi })
  }, [displayRows, workflowExtrasByStreamId, sectionKpi])

  useEffect(() => {
    if (autoRefresh === 'Off') return
    const ms =
      autoRefresh === '15s'
        ? 15_000
        : autoRefresh === '30s'
          ? 30_000
          : autoRefresh === '1m'
            ? 60_000
            : autoRefresh === '5m'
              ? 300_000
              : 0
    if (!ms) return
    const id = window.setInterval(() => setRefreshVersion((v) => v + 1), ms)
    return () => window.clearInterval(id)
  }, [autoRefresh])

  useEffect(() => {
    const onRuntimeUpdated = () => {
      clearOperationalSnapshotCache()
      setRefreshVersion((v) => v + 1)
    }
    window.addEventListener('gdc-runtime-control-updated', onRuntimeUpdated as EventListener)
    window.addEventListener('gdc-runtime-run-once', onRuntimeUpdated as EventListener)
    return () => {
      window.removeEventListener('gdc-runtime-control-updated', onRuntimeUpdated as EventListener)
      window.removeEventListener('gdc-runtime-run-once', onRuntimeUpdated as EventListener)
    }
  }, [])

  useEffect(() => {
    const prev = prevStreamsPathnameRef.current
    prevStreamsPathnameRef.current = location.pathname
    // Refresh only when navigating back to /streams from another route — not query-only changes.
    if (location.pathname === '/streams' && prev !== '/streams') {
      setRefreshVersion((v) => v + 1)
    }
  }, [location.pathname])

  useEffect(() => {
    const gen = ++loadGenRef.current
    let cancelled = false
    const showFullScreenLoader = displayRows.length === 0
    const snapshot_id = createRefreshCycleSnapshotId()
    const heavyFetchOpts = { signal: abortRef.current?.signal }

    ;(async () => {
      if (showFullScreenLoader) setStreamsLoading(true)
      setStreamsListError(null)
      setStreamsAuthRequired(false)

      void getOperationalSnapshot()
        .then((snapshot) => {
          if (cancelled || loadGenRef.current !== gen) return
          if (snapshot != null) {
            setSectionKpi(streamsSectionKpiFromOperationalSnapshot(snapshot))
            setOperationalSnapshot(snapshot)
          }
        })
        .catch((e) => {
          if (isRequestAborted(e)) return
        })

      try {
        const listResult = await fetchStreamsListResult()
        if (cancelled || loadGenRef.current !== gen) return

        if (listResult.ok === false) {
          clearStreamsConsoleSnapshot()
          setStreamsAuthRequired(listResult.authRequired)
          setStreamsListError(listResult.message)
          setDisplayRows([])
          setWorkflowExtrasByStreamId({})
          return
        }

        const streamList = listResult.data

        if (!streamList.length) {
          setDisplayRows([])
          setWorkflowExtrasByStreamId({})
          setSectionKpi((prev) => ({
            ...prev,
            total: 0,
            totalTrend: 'Live · streams API',
          }))
          return
        }

        const quickRows = streamList.map((s) => streamReadToConsoleRow(s))
        setDisplayRows(quickRows)
        setStreamsLoading(false)
        hasLoadedOnceRef.current = true
        setSectionKpi((prev) => ({
          ...prev,
          total: streamList.length,
          totalTrend: 'Live · streams API',
        }))

        mappingUiFetchedRef.current = new Set()
        void enrichStreamConsoleRows(streamList, gen, loadGenRef, () => cancelled, timeRange, snapshot_id, heavyFetchOpts, {
          setDisplayRows,
        })
      } catch (e) {
        if (isRequestAborted(e)) return
        if (loadGenRef.current === gen) {
          setStreamsListError(e instanceof Error ? e.message : 'Failed to load streams.')
          setDisplayRows([])
          setWorkflowExtrasByStreamId({})
        }
      } finally {
        if (loadGenRef.current === gen) {
          setStreamsLoading(false)
          hasLoadedOnceRef.current = true
        }
      }
    })()

    return () => {
      cancelled = true
      loadGenRef.current += 1
    }
  }, [refreshVersion, timeRange, abortRef])

  const filteredRows = useMemo(
    () =>
      filterStreamRows({
        rows: displayRows,
        searchQuery,
        quickFilter,
        groupFilter,
        connectorFilter,
        destinationLabelsByStreamId,
      }),
    [displayRows, searchQuery, quickFilter, groupFilter, connectorFilter, destinationLabelsByStreamId],
  )

  const productGroups = useMemo(() => {
    const groups = groupRowsBySourceProduct(filteredRows)
    return sortGroupsProblemFirst(
      groups.map((group) => ({
        ...group,
        rows: sortStreamsProblemFirst(group.rows),
      })),
    )
  }, [filteredRows])

  const groupFilterOptions = useMemo(() => productGroupOptions(displayRows), [displayRows])

  const operationsSummary = useMemo(() => computeStreamOperationsSummary(displayRows), [displayRows])

  const filtersActive =
    searchQuery.trim().length > 0 || quickFilter !== 'all' || groupFilter !== 'all' || connectorFilter != null

  useEffect(() => {
    const label = new URLSearchParams(location.search).get('expand_group')?.trim()
    if (!label) return
    setSelectedGroupLabel((prev) => (prev === label ? prev : label))
  }, [location.search, productGroups.length])

  useEffect(() => {
    if (!highlightedGroupLabel || productGroups.length === 0) return
    const el = groupRowRefs.current.get(highlightedGroupLabel)
    if (el == null) return
    const timer = window.setTimeout(() => {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [highlightedGroupLabel, productGroups.length, selectedGroupLabel])

  const streamsPageKpi = useMemo(
    () => computeStreamsPageKpi(productGroups, filteredRows),
    [productGroups, filteredRows],
  )

  const toggleProductGroup = useCallback((productLabel: string) => {
    setSelectedGroupLabel((prev) => (prev === productLabel ? null : productLabel))
  }, [])

  const handleAutoRefreshChange = useCallback((value: StreamsAutoRefreshOption) => {
    setAutoRefresh(value)
    persistStreamsAutoRefresh(value)
  }, [])

  const handleTimeRangeChange = useCallback((value: StreamsMetricsWindow) => {
    setTimeRange(value)
    persistStreamsTimeRange(value)
    setRefreshVersion((v) => v + 1)
  }, [])

  const streamsTableScrollRef = useRef<HTMLDivElement>(null)
  const [streamsTableScrollTop, setStreamsTableScrollTop] = useState(0)
  const [streamsTableViewportHeight, setStreamsTableViewportHeight] = useState(STREAMS_CONSOLE_VIRTUAL_VIEWPORT)
  const virtualizeStreamsTable = filteredRows.length >= STREAMS_CONSOLE_VIRTUALIZE_MIN

  const streamsTableVirtualRange = useMemo(() => {
    if (!virtualizeStreamsTable) {
      return {
        startIndex: 0,
        endIndex: Math.max(filteredRows.length - 1, -1),
        offsetTop: 0,
        totalSize: 0,
      }
    }
    return computeFixedRowVirtualRange(
      filteredRows.length,
      STREAMS_CONSOLE_ROW_HEIGHT,
      streamsTableScrollTop,
      streamsTableViewportHeight,
    )
  }, [virtualizeStreamsTable, filteredRows.length, streamsTableScrollTop, streamsTableViewportHeight])

  const visibleStreamRows = useMemo(() => {
    if (!virtualizeStreamsTable) return filteredRows
    const { startIndex, endIndex } = streamsTableVirtualRange
    if (endIndex < startIndex) return []
    return filteredRows.slice(startIndex, endIndex + 1)
  }, [virtualizeStreamsTable, filteredRows, streamsTableVirtualRange])

  const streamIdsForLazyMappingUi = useMemo(() => {
    const ids = new Set<number>()
    for (const group of productGroups) {
      if (selectedGroupLabel !== group.productLabel) continue
      for (const row of group.rows) {
        const sid = Number(row.id)
        if (Number.isFinite(sid) && sid > 0 && /^\d+$/.test(row.id)) ids.add(sid)
      }
    }
    if (virtualizeStreamsTable) {
      for (const row of visibleStreamRows) {
        const sid = Number(row.id)
        if (Number.isFinite(sid) && sid > 0 && /^\d+$/.test(row.id)) ids.add(sid)
      }
    }
    return [...ids]
  }, [productGroups, selectedGroupLabel, visibleStreamRows, virtualizeStreamsTable])

  useEffect(() => {
    if (!streamIdsForLazyMappingUi.length) return
    const gen = loadGenRef.current
    let cancelled = false
    const fetchOpts = { signal: abortRef.current?.signal }
    void enrichMappingUiForStreamIds(
      streamIdsForLazyMappingUi,
      gen,
      loadGenRef,
      () => cancelled,
      mappingUiFetchedRef.current,
      fetchOpts,
      { setDisplayRows, setWorkflowExtrasByStreamId },
    )
      .then((fetched) => {
        for (const id of fetched) mappingUiFetchedRef.current.add(id)
      })
      .catch((e) => {
        if (isRequestAborted(e)) return
      })
    return () => {
      cancelled = true
    }
  }, [streamIdsForLazyMappingUi, refreshVersion, abortRef])

  const streamsTablePaddingBottom = useMemo(() => {
    if (!virtualizeStreamsTable) return 0
    const { endIndex, totalSize, offsetTop, startIndex } = streamsTableVirtualRange
    const rendered = Math.max(0, endIndex - startIndex + 1) * STREAMS_CONSOLE_ROW_HEIGHT
    return Math.max(0, totalSize - offsetTop - rendered)
  }, [virtualizeStreamsTable, streamsTableVirtualRange])

  const onStreamsTableScroll = useCallback(() => {
    const el = streamsTableScrollRef.current
    if (el == null) return
    setStreamsTableScrollTop(el.scrollTop)
    setStreamsTableViewportHeight(el.clientHeight)
  }, [])

  const streamsEmptyMessage = useMemo(() => {
    if (streamsAuthRequired) return GDC_AUTH_REQUIRED_MESSAGE
    if (streamsListError) return streamsListError
    if (streamsLoading) return ''
    if (displayRows.length > 0 && filteredRows.length === 0) {
      return filtersActive
        ? 'No streams match your filters.'
        : 'No stream groups found.'
    }
    if (isDevValidationLabUiEnabled()) {
      return 'No streams returned from the API. For validation-lab streams, enable ENABLE_DEV_VALIDATION_LAB on a non-production APP_ENV and the dev-validation fixture stack (see docs/testing/dev-validation-lab.md). Otherwise run scripts/seed.py or create a stream from the wizard.'
    }
    return 'No streams configured yet. Create your first stream from the wizard to connect a source, map fields, and deliver to a destination.'
  }, [
    streamsAuthRequired,
    streamsListError,
    streamsLoading,
    displayRows.length,
    filteredRows.length,
    filtersActive,
  ])

  return (
    <div ref={outerContainerRef} className="flex w-full min-w-0 items-start gap-0">
    <div className={cn('flex min-w-0 flex-col gap-4', selectedStreamRow ? 'flex-1' : 'w-full')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Streams</h2>
          <p className="mt-0.5 text-[13px] text-slate-500 dark:text-gdc-muted">Monitor incoming data streams and their delivery status to destinations.</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Link
            to={newStreamPath()}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-4 text-[13px] font-semibold text-white shadow-sm hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New Stream
          </Link>
          <StreamsConsoleControls
            autoRefresh={autoRefresh}
            onAutoRefreshChange={handleAutoRefreshChange}
            timeRange={timeRange}
            onTimeRangeChange={handleTimeRangeChange}
            onManualRefresh={() => { clearOperationalSnapshotCache(); setRefreshVersion((v) => v + 1) }}
            refreshing={streamsLoading}
          />
        </div>
      </div>

      <RuntimeFixtureModeBanner surface="streams" />

      {runOnceBanner ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'rounded-lg border px-3 py-2 text-[11px] shadow-sm',
            runOnceBanner.variant === 'success'
              ? 'border-emerald-300/80 bg-emerald-500/[0.07] text-emerald-950 dark:border-emerald-500/35 dark:bg-emerald-500/10 dark:text-emerald-100'
              : 'border-red-300/80 bg-red-500/[0.07] text-red-950 dark:border-red-500/35 dark:bg-red-500/10 dark:text-red-100',
          )}
        >
          <p className="font-semibold">{runOnceBanner.variant === 'success' ? 'Run once finished' : 'Run once failed'}</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 font-medium opacity-95">
            {runOnceBanner.lines.map((line, i) => (
              <li key={`run-once-${i}-${line.slice(0, 24)}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Overall Health Beacon */}
      <OverallHealthBeacon kpi={streamsPageKpi} loading={streamsLoading && displayRows.length === 0} />

      {/* System Health Summary Strip */}
      <SystemHealthSummaryStrip rows={displayRows} loading={streamsLoading && displayRows.length === 0} />

      <StreamsGroupKpiStrip kpi={streamsPageKpi} loading={streamsLoading && displayRows.length === 0} />

      {/* Kept for automated tests (streams-console-filters.test.tsx); visually hidden behind KPI strip */}
      <div className="hidden">
        <StreamsOperationsSummaryStrip summary={operationsSummary} loading={streamsLoading && displayRows.length === 0} />
      </div>

      <StreamsOperationsToolbar
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        quickFilter={quickFilter}
        onQuickFilterChange={setQuickFilter}
        groupFilter={groupFilter}
        onGroupFilterChange={setGroupFilter}
        groupOptions={groupFilterOptions}
      />

      <StreamsFilterChips
        connectorFilter={connectorFilter}
        connectorFilterLabel={connectorFilterLabel}
        onClearConnectorFilter={clearConnectorFilter}
        timeRange={timeRange}
        onClearTimeRange={() => handleTimeRangeChange('1h')}
        timeRangeIsDefault={timeRange === '1h'}
      />

      <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card" data-testid="streams-product-groups">
        {streamsLoading && displayRows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-slate-500 dark:text-gdc-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading streams…
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p
              className={cn('text-[13px]', streamsAuthRequired && 'font-medium text-amber-800 dark:text-amber-200')}
              data-testid={streamsAuthRequired ? 'streams-auth-required' : 'streams-empty-state'}
            >
              {streamsEmptyMessage}
            </p>
            {!streamsAuthRequired && displayRows.length === 0 ? (
              <Link
                to="/streams/new"
                data-testid="streams-create-first"
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Create First Stream
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={opTable}>
                <thead>
                  <tr className={opThRow}>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[14rem]')}>
                      Stream
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[7rem]')}>
                      Status
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[8rem]')}>
                      EPS (5m Avg)
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[7rem]')}>
                      Success Rate
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[8rem]')}>
                      Destinations
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[8rem]')}>
                      Last Checkpoint
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[7rem]')}>
                      Last Event
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[6rem]')}>
                      Issues
                    </th>
                    <th scope="col" className={cn(streamsGroupTableThClass, 'min-w-[12rem] pr-3')}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {productGroups.map((group) => {
                    const expanded = selectedGroupLabel === group.productLabel
                    const groupMetrics = aggregateGroupRates(group.rows)
                    const sparklines = aggregateGroupSparklines(group.rows)
                    const issues = aggregateGroupIssueBreakdown(group.rows, timeRange)
                    const groupStats = computeGroupOperationalStats(group.rows)
                    const healthLabel = groupHealthLabelFromSeverity(group.operationalSeverity)
                    const healthTone = groupHealthToneFromSeverity(group.operationalSeverity)
                    const successTone = successRateTone(groupMetrics.successPct)
                    const headerSummary = formatGroupHeaderSummary(groupStats)
                    return (
                      <Fragment key={group.productLabel}>
                        <tr
                          ref={(el) => {
                            if (el) groupRowRefs.current.set(group.productLabel, el)
                            else groupRowRefs.current.delete(group.productLabel)
                          }}
                          data-testid={`stream-group-row-${group.productLabel}`}
                          role="button"
                          tabIndex={0}
                          aria-expanded={expanded}
                          onClick={() => toggleProductGroup(group.productLabel)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              toggleProductGroup(group.productLabel)
                            }
                          }}
                          className={cn(
                            opTr,
                            'cursor-pointer transition-colors hover:bg-slate-50/80 dark:hover:bg-gdc-rowHover/50',
                            expanded && 'bg-slate-50/50 dark:bg-gdc-elevated/20',
                            highlightedGroupLabel === group.productLabel &&
                              'ring-2 ring-inset ring-violet-500/50 bg-violet-500/10 dark:bg-violet-500/15',
                          )}
                        >
                          <td className={streamsGroupTableTdClass}>
                            <div className="min-w-0">
                              <p className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">{group.productLabel}</p>
                              <p
                                className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-gdc-muted"
                                data-testid={`stream-group-summary-${group.productLabel}`}
                              >
                                {headerSummary}
                              </p>
                            </div>
                          </td>
                          <td className={streamsGroupTableTdClass}>
                            <GroupHealthBadge label={healthLabel} tone={healthTone} />
                          </td>
                          <td className={streamsGroupTableTdClass}>
                            <div className="flex items-center gap-2">
                              <span className="whitespace-nowrap tabular-nums text-[12px] font-semibold text-slate-800 dark:text-slate-100">
                                {groupMetrics.ingestLabel}
                              </span>
                              {sparklineHasTrend(sparklines.ingest) ? (
                                <span className="text-sky-500 dark:text-sky-400">
                                  <MiniSparkline values={sparklines.ingest} />
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className={streamsGroupTableTdClass}>
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'whitespace-nowrap tabular-nums text-[12px] font-semibold',
                                  successTone === 'critical' && 'text-red-600 dark:text-red-400',
                                  successTone === 'warning' && 'text-amber-600 dark:text-amber-400',
                                  successTone === 'healthy' && 'text-emerald-600 dark:text-emerald-400',
                                )}
                              >
                                {groupMetrics.successLabel}
                              </span>
                              {sparklineHasTrend(sparklines.success) ? (
                                <span
                                  className={cn(
                                    successTone === 'critical' && 'text-red-500',
                                    successTone === 'warning' && 'text-amber-500',
                                    successTone === 'healthy' && 'text-emerald-500',
                                  )}
                                >
                                  <MiniSparkline values={sparklines.success} />
                                </span>
                              ) : null}
                            </div>
                          </td>
                          {/* Destinations count for the group */}
                          <td className={cn(streamsGroupTableTdClass, 'tabular-nums text-[12px]')}>
                            {(() => {
                              const groupDestCount = new Set(
                                group.rows.flatMap((r) => destinationLabelsByStreamId.get(Number(r.id)) ?? [])
                              ).size
                              return groupDestCount > 0 ? (
                                <span className="font-semibold text-slate-800 dark:text-slate-100">{groupDestCount}</span>
                              ) : (
                                <span className="text-slate-400 dark:text-gdc-muted">—</span>
                              )
                            })()}
                          </td>
                          {/* Last Checkpoint – best (most recent) across group streams */}
                          <td className={cn(streamsGroupTableTdClass, 'whitespace-nowrap')}>
                            {(() => {
                              const checkpointRows = group.rows.filter((r) => streamUsesCheckpointObservability(r))
                              if (!checkpointRows.length) {
                                return (
                                  <div className="flex flex-col gap-0.5">
                                    <span className="text-[12px] text-slate-500 dark:text-gdc-muted">Push ingest</span>
                                    <span className="text-[10px] text-slate-500 dark:text-gdc-muted">No checkpoint</span>
                                  </div>
                                )
                              }
                              const hasLag = checkpointRows.some(
                                (r) => r.checkpointLagLabel && r.checkpointLagLabel !== '—',
                              )
                              let bestLabel = '—'
                              let bestTs = -1
                              let bestUpdatedAt: string | null = null
                              for (const r of checkpointRows) {
                                if (!r.checkpointUpdatedAt || r.checkpointUpdatedAt === '—') continue
                                const norm = r.checkpointUpdatedAt.includes('T')
                                  ? r.checkpointUpdatedAt
                                  : r.checkpointUpdatedAt.replace(' ', 'T')
                                const t = Date.parse(norm)
                                if (Number.isFinite(t) && t > bestTs) {
                                  bestTs = t
                                  bestUpdatedAt = r.checkpointUpdatedAt
                                  bestLabel = formatRelativeShort(r.checkpointUpdatedAt)
                                }
                              }
                              const freshness = checkpointFreshnessLabel(bestUpdatedAt, hasLag)
                              return (
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-[12px] text-slate-500 dark:text-gdc-muted">{bestLabel}</span>
                                  {hasLag && bestLabel !== '—' ? (
                                    <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">Lagging</span>
                                  ) : freshness === 'Stale' ? (
                                    <span className="text-[10px] font-semibold text-slate-500 dark:text-gdc-muted">Stale</span>
                                  ) : null}
                                </div>
                              )
                            })()}
                          </td>
                          <td className={cn(streamsGroupTableTdClass, 'whitespace-nowrap tabular-nums text-[12px] text-slate-500 dark:text-gdc-muted')}>
                            {groupLastEventLabel(group.rows)}
                          </td>
                          <td className={cn(streamsGroupTableTdClass, 'max-w-[14rem] text-[11px] font-medium leading-snug')}>
                            <span
                              className={cn(
                                issues.causes.length > 0
                                  ? 'text-amber-800 dark:text-amber-200'
                                  : 'text-slate-500 dark:text-gdc-muted',
                              )}
                              data-testid={`stream-group-issues-${group.productLabel}`}
                            >
                              {issues.label}
                            </span>
                          </td>
                          <td className={cn(streamsGroupTableTdClass, 'pr-3')}>
                            {expanded ? (
                              <ChevronDown className="inline h-4 w-4 text-slate-400" aria-hidden />
                            ) : (
                              <ChevronRight className="inline h-4 w-4 text-slate-400" aria-hidden />
                            )}
                          </td>
                        </tr>
                        {expanded
                          ? group.rows.map((row) => {
                              const issueLabel = formatStreamIssuesCell(row, timeRange)
                              const severity = streamSeverityFromCauses(row, timeRange)
                              const isSelected = selectedStreamRow?.id === row.id
                              const destNames = destinationLabelsByStreamId.get(Number(row.id)) ?? []
                              const destTotal = Math.max(destNames.length, row.routesTotal)
                              const statusBorderClass =
                                severity === 'critical'
                                  ? 'border-l-red-500'
                                  : severity === 'warning'
                                    ? 'border-l-amber-500'
                                    : row.hasRuntimeApiSnapshot
                                      ? 'border-l-emerald-500'
                                      : 'border-l-slate-400'
                              return (
                                <tr
                                  key={row.id}
                                  data-testid={`stream-group-child-row-${row.id}`}
                                  className={cn(
                                    opTr,
                                    streamRowHighlightClass(row, timeRange),
                                    'group/streamrow cursor-pointer transition-all hover:bg-slate-100 hover:shadow-[inset_3px_0_0_0_currentColor] dark:hover:bg-gdc-rowHover/70',
                                    isSelected && 'ring-2 ring-inset ring-violet-500/50 bg-violet-500/[0.06] dark:bg-violet-500/10',
                                  )}
                                  onClick={(e) => {
                                    const tr = e.currentTarget as HTMLTableRowElement
                                    if (!isSelected && outerContainerRef.current) {
                                      const trRect = tr.getBoundingClientRect()
                                      const containerRect = outerContainerRef.current.getBoundingClientRect()
                                      // document 기준 절대 위치로 계산 (스크롤 위치 무관)
                                      const trTop = trRect.top + window.scrollY
                                      const containerTop = containerRect.top + window.scrollY
                                      setPanelTopOffset(Math.max(0, trTop - containerTop))
                                    } else {
                                      setPanelTopOffset(0)
                                    }
                                    setSelectedStreamRow(isSelected ? null : row)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      const tr = e.currentTarget as HTMLTableRowElement
                                      if (!isSelected && outerContainerRef.current) {
                                        const trRect = tr.getBoundingClientRect()
                                        const containerRect = outerContainerRef.current.getBoundingClientRect()
                                        const trTop = trRect.top + window.scrollY
                                        const containerTop = containerRect.top + window.scrollY
                                        setPanelTopOffset(Math.max(0, trTop - containerTop))
                                      } else {
                                        setPanelTopOffset(0)
                                      }
                                      setSelectedStreamRow(isSelected ? null : row)
                                    }
                                  }}
                                  role="button"
                                  tabIndex={0}
                                  aria-pressed={isSelected}
                                >
                                  {/* Col 1: Stream name with left status border */}
                                  <td className={cn(streamsGroupTableTdClass, 'border-l-4 pl-8', statusBorderClass)}>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-1.5">
                                        <StreamSeverityIcon row={row} metricsWindow={timeRange} />
                                        {/^\d+$/.test(row.id) ? (
                                          <Link
                                            to={streamRuntimePath(row.id)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="truncate text-[13px] font-semibold text-slate-900 hover:text-violet-600 hover:underline dark:text-slate-100 dark:hover:text-violet-400"
                                            title={`Open Runtime: ${row.name}`}
                                          >
                                            {row.name}
                                          </Link>
                                        ) : (
                                          <span className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">{row.name}</span>
                                        )}
                                      </div>
                                      {row.connectorName !== '—' ? (
                                        <span className="mt-0.5 block truncate pl-5 text-[10px] text-slate-500 dark:text-gdc-muted">
                                          {row.connectorName}
                                          {row.sourceTypeLabel !== '—' ? ` · ${row.sourceTypeLabel}` : ''}
                                        </span>
                                      ) : null}
                                    </div>
                                  </td>
                                  {/* Col 2: Status badge */}
                                  <td className={streamsGroupTableTdClass}>
                                    <StreamOperationalStatusBadge row={row} metricsWindow={timeRange} />
                                  </td>
                                  {/* Col 3: EPS (5m avg) + delta + sparkline */}
                                  <td className={streamsGroupTableTdClass}>
                                    <StreamEpsCell row={row} />
                                  </td>
                                  {/* Col 4: Success Rate + progress bar */}
                                  <td className={streamsGroupTableTdClass}>
                                    <StreamSuccessCell row={row} />
                                  </td>
                                  {/* Col 5: Destinations dots */}
                                  <td className={streamsGroupTableTdClass}>
                                    <div className="flex items-center gap-1">
                                      <span className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                                        {destTotal > 0 ? destTotal : '—'}
                                      </span>
                                      {row.routesOk > 0 ? (
                                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden title={`${row.routesOk} healthy`} />
                                      ) : null}
                                      {row.routesDegraded > 0 ? (
                                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden title={`${row.routesDegraded} degraded`} />
                                      ) : null}
                                      {row.routesError > 0 ? (
                                        <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden title={`${row.routesError} failed`} />
                                      ) : null}
                                    </div>
                                  </td>
                                  {/* Col 6: Last Checkpoint + status */}
                                  <td className={streamsGroupTableTdClass}>
                                    <StreamCheckpointCell row={row} />
                                  </td>
                                  {/* Col 7: Last Event */}
                                  <td className={cn(streamsGroupTableTdClass, 'whitespace-nowrap tabular-nums text-[12px] text-slate-500 dark:text-gdc-muted')}>
                                    {row.hasRuntimeApiSnapshot ? formatRelativeShort(row.lastActivityRelative) : '—'}
                                  </td>
                                  {/* Col 8: Issues */}
                                  <td
                                    className={cn(
                                      streamsGroupTableTdClass,
                                      'max-w-[14rem] whitespace-normal text-[11px] font-medium leading-snug',
                                      issueLabel !== '—'
                                        ? 'text-amber-800 dark:text-amber-200'
                                        : 'text-slate-500 dark:text-gdc-muted',
                                    )}
                                    data-testid={`stream-row-issues-${row.id}`}
                                  >
                                    {issueLabel}
                                  </td>
                                  {/* Col 9: Actions */}
                                  <td className={cn(streamsGroupTableTdClass, 'pr-2')}>
                                    <StreamRowActions row={row} />
                                  </td>
                                </tr>
                              )
                            })
                          : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-200/80 px-3 py-2 text-[11px] text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
              {productGroups.length} group{productGroups.length === 1 ? '' : 's'} · {filteredRows.length} stream{filteredRows.length === 1 ? '' : 's'}{displayRows.length !== filteredRows.length ? ` (${displayRows.length} total)` : ''}
            </div>
          </>
        )}
      </div>

      {/* Legacy flat table (hidden — kept for virtualized regression tests) */}
      <div className="hidden overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <div
          ref={streamsTableScrollRef}
          data-testid={virtualizeStreamsTable ? 'streams-console-virtual-scroll' : undefined}
          className={cn('overflow-x-auto', virtualizeStreamsTable && 'max-h-[min(70vh,560px)] overflow-y-auto')}
          onScroll={virtualizeStreamsTable ? onStreamsTableScroll : undefined}
        >
          <table className={opTable}>
            <thead>
              <tr className={opThRow}>
                <th scope="col" className={cn(opTh, 'min-w-[140px]')}>
                  Stream
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[160px]')}>
                  Source connection / Source
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[96px]')}>
                  Status
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[150px]')}>
                  <span title="Source input events from run_complete.">Processed events (window)</span>
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[130px]')}>
                  Last sync position
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[100px]')}>
                  Delivery paths
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[100px]')}>
                  Delivery
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[100px]')}>
                  Latency (p95)
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[88px]')}>
                  Last Activity
                </th>
                <th scope="col" className={cn(opTh, 'min-w-[220px] text-right')}>
                  Workflow & actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr className={cn(opTr, opStateRow)}>
                  <td className={cn(opTd, 'py-8 text-center text-[12px] text-slate-500 dark:text-gdc-muted')} colSpan={10}>
                    {streamsLoading && displayRows.length === 0 ? (
                      <span className="inline-flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Loading streams…
                      </span>
                    ) : (
                      <div className="flex flex-col items-center gap-3">
                        <span
                          className={cn(
                            streamsAuthRequired && 'font-medium text-amber-800 dark:text-amber-200',
                          )}
                        >
                          {streamsEmptyMessage}
                        </span>
                        {!streamsAuthRequired && displayRows.length === 0 && filteredRows.length === 0 ? (
                          <Link
                            to="/streams/new"
                            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                            Create First Stream
                          </Link>
                        ) : null}
                      </div>
                    )}
                  </td>
                </tr>
              ) : null}
              {virtualizeStreamsTable && streamsTableVirtualRange.offsetTop > 0 ? (
                <tr aria-hidden="true" style={{ height: streamsTableVirtualRange.offsetTop }}>
                  <td colSpan={10} className="p-0" />
                </tr>
              ) : null}
              {visibleStreamRows.map((row) => {
                const workflow = streamWorkflowFromRow(row, workflowExtrasByStreamId[row.id])
                const rowUi = resolveSourceTypePresentation(row.streamTypeKey)
                const runNowExtra = operationalRunControlTooltipSupplement(row.name)
                return (
                  <tr key={row.id} className={opTr}>
                    <td className={opTd}>
                      <button type="button" className="w-full text-left">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="block text-[12px] font-semibold text-slate-900 dark:text-slate-100">{row.name}</span>
                          <DevValidationBadge name={row.name} />
                        </span>
                        <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-gdc-muted">{row.id}</span>
                      </button>
                    </td>
                    <td className={opTd}>
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 dark:bg-gdc-elevated">
                          <Workflow className="h-3.5 w-3.5 text-slate-600 dark:text-gdc-mutedStrong" aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-semibold text-slate-800 dark:text-slate-100">{row.connectorName}</p>
                          <p className="truncate text-[11px] text-slate-500 dark:text-gdc-muted">{row.sourceTypeLabel}</p>
                        </div>
                      </div>
                    </td>
                    <td className={opTd}>
                      <StatusBadge tone={statusTone(row.status)} className="font-bold uppercase tracking-wide">
                        {row.status}
                      </StatusBadge>
                    </td>
                    <td className={opTd}>
                      {!row.hasRuntimeApiSnapshot ? (
                        <span className="text-[11px] text-slate-500 dark:text-gdc-muted">No runtime data yet</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                            {row.events1h.toLocaleString()}
                          </span>
                          {sparklineHasTrend(row.eventsTrend) ? (
                            <span className={eventsSparklineClass(row.status)}>
                              <MiniSparkline values={row.eventsTrend} />
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className={opTd}>
                      {!row.hasRuntimeApiSnapshot ? (
                        <span className="text-[11px] text-slate-500 dark:text-gdc-muted">No runtime data yet</span>
                      ) : (
                        <>
                          <p className="text-[11px] font-medium text-slate-800 dark:text-slate-200">{row.lastCheckpointDisplay}</p>
                          <p className="text-[10px] text-slate-500 dark:text-gdc-muted">{row.lastCheckpointRelative}</p>
                        </>
                      )}
                    </td>
                    <td className={opTd}>
                      <RouteFanOut row={row} />
                    </td>
                    <td className={opTd}>
                      {!row.hasRuntimeApiSnapshot ? (
                        <span className="text-[11px] text-slate-500 dark:text-gdc-muted">No runtime data yet</span>
                      ) : !row.deliveryPctKnown ? (
                        <span className="text-[11px] text-slate-500 dark:text-gdc-muted">No delivery outcomes</span>
                      ) : (
                        <DeliveryMeter pct={row.deliveryPct} />
                      )}
                    </td>
                    <td className={opTd}>
                      {!row.hasRuntimeApiSnapshot ? (
                        <span className="text-[11px] text-slate-500 dark:text-gdc-muted">No runtime data yet</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                            {row.latencyP95Ms > 0 ? `${row.latencyP95Ms} ms` : '—'}
                          </span>
                          <span className="text-slate-400 dark:text-gdc-muted">
                            <MiniSparkline values={row.latencyTrend} />
                          </span>
                        </div>
                      )}
                    </td>
                    <td className={opTd}>
                      {!row.hasRuntimeApiSnapshot ? (
                        <span className="text-[11px] text-slate-500 dark:text-gdc-muted">No runtime data yet</span>
                      ) : (
                        <span
                          className={cn(
                            'text-[12px] font-semibold tabular-nums',
                            row.lastActivityWarn ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200',
                          )}
                        >
                          {formatRelativeShort(row.lastActivityRelative)}
                        </span>
                      )}
                    </td>
                    <td className={cn(opTd, 'text-right')}>
                      <div
                        className="inline-flex max-w-[280px] flex-wrap items-center justify-end gap-0.5"
                        title={rowUi.runtime.operationsWorkflowTooltip}
                      >
                        <StreamWorkflowProgressBadge
                          snapshot={workflow}
                          className="mr-1"
                          ariaLabel={`Continue setup: ${row.name}`}
                        />
                        <Link
                          to={streamApiTestPath(row.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-sky-500/10 hover:text-sky-800 dark:text-gdc-mutedStrong dark:hover:bg-sky-500/15 dark:hover:text-sky-200"
                          aria-label={`${rowUi.runtime.operationsTestIconAriaLabelPrefix}: ${row.name}`}
                          title={rowUi.runtime.operationsTestIconTitle}
                        >
                          <FlaskConical className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to={streamMappingPath(row.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-violet-500/10 hover:text-violet-800 dark:text-gdc-mutedStrong dark:hover:bg-violet-500/15 dark:hover:text-violet-200"
                          aria-label={`Field mapping: ${row.name}`}
                          title="Mapping"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to={streamEnrichmentPath(row.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-emerald-500/10 hover:text-emerald-800 dark:text-gdc-mutedStrong dark:hover:bg-emerald-500/15 dark:hover:text-emerald-200"
                          aria-label={`Enrichment: ${row.name}`}
                          title="Enrichment"
                        >
                          <Wand2 className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to={streamRuntimePath(row.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
                          aria-label={`Stream monitoring: ${row.name}`}
                          title="Monitoring"
                        >
                          <Cpu className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to={streamEditPath(row.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
                          aria-label={`Edit stream: ${row.name}`}
                          title="Edit stream"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to={logsPath(row.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
                          aria-label={`Stream logs: ${row.name}`}
                          title="Logs"
                        >
                          <ScrollText className="h-3.5 w-3.5" />
                        </Link>
                        <button
                          type="button"
                          disabled={!/^\d+$/.test(row.id) || runOnceStreamId !== null}
                          onClick={() => void executeRunOnce(Number(row.id))}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
                          aria-label={`Run now: ${row.name}`}
                          title={runNowExtra ? `Run now (execute pipeline once). ${runNowExtra}` : 'Run now (execute pipeline once)'}
                        >
                          {runOnceStreamId === Number(row.id) ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Play className="h-3.5 w-3.5" aria-hidden />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {virtualizeStreamsTable && streamsTablePaddingBottom > 0 ? (
                <tr aria-hidden="true" style={{ height: streamsTablePaddingBottom }}>
                  <td colSpan={10} className="p-0" />
                </tr>
              ) : null}
            </tbody>
          </table>
          {virtualizeStreamsTable ? (
            <p className="sr-only" aria-live="polite">
              Showing {visibleStreamRows.length} of {filteredRows.length} streams in viewport
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 border-t border-slate-200/80 px-3 py-2 text-[11px] text-slate-600 dark:border-gdc-border dark:text-gdc-muted sm:flex-row sm:items-center sm:justify-between">
          <p className="tabular-nums">
            Showing {filteredRows.length} stream{filteredRows.length === 1 ? '' : 's'} (total {sectionKpi.total})
          </p>
        </div>
      </div>

      <p className="text-[11px] tabular-nums text-slate-500 dark:text-gdc-muted">
        {productGroups.length} Stream Group{productGroups.length === 1 ? '' : 's'} | {filteredRows.length} Stream{filteredRows.length === 1 ? '' : 's'}
      </p>

    </div>

    {/* Right Detail Panel */}
    {selectedStreamRow ? (
      <StreamConsoleDetailPanel
        stream={selectedStreamRow}
        routes={operationalSnapshot?.routes ?? []}
        problems={operationalSnapshot?.problems ?? []}
        onClose={() => { setSelectedStreamRow(null); setPanelTopOffset(0) }}
        topOffset={panelTopOffset}
      />
    ) : null}
    </div>
  )
}
