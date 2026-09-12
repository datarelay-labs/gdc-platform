import { memo, type RefObject } from 'react'
import { ClipboardList, Loader2, MoreVertical, Play } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  destinationDetailPath,
  logsExplorerPath,
  routeEditPath,
  runtimeOverviewPath,
  streamRuntimePath,
} from '../../config/nav-paths'
import { formatOperationalPercent, formatThroughputEps } from '../../lib/observability-format'
import { cn } from '../../lib/utils'
import { opTd, opTr } from '../dashboard/widgets/operational-table-styles'
import { StatusBadge } from '../shell/status-badge'
import {
  formatFailurePolicy,
  formatRateLimitCell,
  lastActivityIso,
  relativeShort,
  routePublicId,
  type RouteConsoleRow,
  type RouteUiStatus,
} from './routes-overview-helpers'

export type RoutesTableRowProps = {
  row: RouteConsoleRow
  selected: boolean
  showRateLimitCol: boolean
  testBusyId: number | null
  moreMenuOpen: boolean
  moreMenuRef: RefObject<HTMLDivElement | null> | undefined
  onSelect: (routeId: number) => void
  onTestRoute: (routeId: number, destinationId: number | null) => void
  onToggleMoreMenu: (routeId: number) => void
  onCloseMoreMenu: () => void
}

function uiStatusTone(s: RouteUiStatus) {
  switch (s) {
    case 'Healthy':
      return 'success' as const
    case 'Warning':
      return 'warning' as const
    case 'Error':
      return 'error' as const
    default:
      return 'neutral' as const
  }
}

function statusDotClass(s: RouteUiStatus): string {
  switch (s) {
    case 'Healthy':
      return 'bg-emerald-500'
    case 'Warning':
      return 'bg-amber-500'
    case 'Error':
      return 'bg-red-500'
    default:
      return 'bg-slate-400'
  }
}

function DeliveryMeter({ pct }: { pct: number }) {
  const tone =
    pct >= 99 ? 'bg-emerald-500' : pct >= 90 ? 'bg-amber-500' : pct <= 0 ? 'bg-slate-300 dark:bg-slate-600' : 'bg-red-500'
  const width = `${Math.min(100, Math.max(0, pct))}%`
  const label = formatOperationalPercent(pct)
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">{label}</p>
      <div className="h-1 w-full max-w-[96px] overflow-hidden rounded-full bg-slate-200/90 dark:bg-gdc-elevated">
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width }} />
      </div>
    </div>
  )
}

function RoutesTableRowInner({
  row,
  selected,
  showRateLimitCol,
  testBusyId,
  moreMenuOpen,
  moreMenuRef,
  onSelect,
  onTestRoute,
  onToggleMoreMenu,
  onCloseMoreMenu,
}: RoutesTableRowProps) {
  const m = row.metrics
  const sr = m ? m.success_rate : null
  const eps = m ? m.eps_current : 0
  const lat = m ? m.avg_latency_ms : null
  const errCount = m ? m.failed_last_hour : null
  const lastAct = relativeShort(lastActivityIso(m))
  const logsHref = logsExplorerPath({
    route_id: row.route.id,
    stream_id: row.stream?.id ?? undefined,
    destination_id: row.destination?.id ?? row.route.destination_id ?? undefined,
  })
  const streamId = row.stream?.id
  const destId = row.destination?.id ?? row.route.destination_id

  return (
    <tr
      className={cn(opTr, selected ? 'bg-violet-500/[0.09] dark:bg-violet-500/15' : '', 'cursor-pointer')}
      onClick={() => onSelect(row.route.id)}
      data-testid={`routes-table-row-${row.route.id}`}
    >
      <td className={opTd}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onSelect(row.route.id)
          }}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <span className={cn('mt-0.5 h-2 w-2 shrink-0 rounded-full', statusDotClass(row.uiStatus))} aria-hidden />
          <span className="text-[12px] font-semibold text-violet-800 dark:text-violet-200">{routePublicId(row.route.id)}</span>
        </button>
      </td>
      <td className={opTd}>
        <span className="text-[12px] font-medium text-slate-800 dark:text-slate-200">{(row.stream?.name ?? '').trim() || '—'}</span>
      </td>
      <td className={opTd}>
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold text-slate-900 dark:text-slate-100">
            {(row.destination?.name ?? '').trim() || '—'}
          </p>
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {row.destination?.destination_type?.replace(/_/g, ' ') ?? '—'}
          </p>
        </div>
      </td>
      <td className={opTd}>
        <StatusBadge tone={uiStatusTone(row.uiStatus)}>{row.uiStatus}</StatusBadge>
      </td>
      <td className={opTd}>
        <span className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
          {m ? formatThroughputEps(eps) : '—'}
        </span>
      </td>
      <td className={opTd}>{sr != null ? <DeliveryMeter pct={sr} /> : <span className="text-slate-400">—</span>}</td>
      <td className={opTd}>
        <span className="text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
          {lat != null && lat >= 0 ? `${Math.round(lat)} ms` : '—'}
        </span>
      </td>
      <td className={opTd}>
        <span
          className={cn(
            'text-[12px] font-semibold tabular-nums',
            errCount != null && errCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-100',
          )}
        >
          {errCount != null ? errCount.toLocaleString() : '—'}
        </span>
      </td>
      <td className={opTd}>
        <span className="text-[11px] tabular-nums text-slate-600 dark:text-gdc-muted">{lastAct}</span>
      </td>
      <td className={opTd}>
        <span className="text-[11px] font-medium text-slate-700 dark:text-gdc-mutedStrong">
          {formatFailurePolicy(row.route.failure_policy)}
        </span>
      </td>
      {showRateLimitCol ? (
        <td className={opTd}>
          <span className="text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
            {formatRateLimitCell(row.route.rate_limit_json)}
          </span>
        </td>
      ) : null}
      <td className={cn(opTd, 'text-right')} onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex items-center justify-end gap-0.5">
          <button
            type="button"
            disabled={row.destination == null || testBusyId === row.route.id}
            onClick={() => void onTestRoute(row.route.id, row.destination?.id ?? row.route.destination_id ?? null)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
            aria-label={`Test route ${routePublicId(row.route.id)}`}
            title="Test Route"
          >
            {testBusyId === row.route.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
          <Link
            to={logsHref}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
            aria-label={`View logs for route ${routePublicId(row.route.id)}`}
            title="View Logs"
          >
            <ClipboardList className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <div className="relative" ref={moreMenuOpen ? moreMenuRef : undefined}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleMoreMenu(row.route.id)
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
              aria-label="More route actions"
              aria-expanded={moreMenuOpen}
            >
              <MoreVertical className="h-3.5 w-3.5" aria-hidden />
            </button>
            {moreMenuOpen ? (
              <div
                role="menu"
                className="absolute right-0 z-40 mt-1 w-[11.5rem] rounded-md border border-slate-200/90 bg-white py-1 text-[11px] shadow-lg dark:border-gdc-border dark:bg-gdc-card"
                onClick={(e) => e.stopPropagation()}
              >
                <Link
                  to={routeEditPath(String(row.route.id))}
                  className="block px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-gdc-rowHover"
                  onClick={onCloseMoreMenu}
                >
                  Edit Route
                </Link>
                <Link
                  to={runtimeOverviewPath({
                    stream_id: streamId ?? undefined,
                    route_id: row.route.id,
                    destination_id: destId ?? undefined,
                  })}
                  className="flex items-center gap-1.5 px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-gdc-rowHover"
                  onClick={onCloseMoreMenu}
                >
                  View Runtime
                </Link>
                <Link
                  to={logsHref}
                  className="block px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-gdc-rowHover"
                  onClick={onCloseMoreMenu}
                >
                  View Logs
                </Link>
                {streamId != null ? (
                  <Link
                    to={streamRuntimePath(String(streamId))}
                    className="block px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-gdc-rowHover"
                    onClick={onCloseMoreMenu}
                  >
                    Open Stream
                  </Link>
                ) : (
                  <span className="block cursor-not-allowed px-3 py-1.5 text-slate-400">Open Stream</span>
                )}
                {destId != null ? (
                  <Link
                    to={destinationDetailPath(String(destId))}
                    className="block px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-gdc-rowHover"
                    onClick={onCloseMoreMenu}
                  >
                    Open Destination
                  </Link>
                ) : (
                  <span className="block cursor-not-allowed px-3 py-1.5 text-slate-400">Open Destination</span>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  )
}

export function routesTableRowPropsEqual(prev: RoutesTableRowProps, next: RoutesTableRowProps): boolean {
  return (
    prev.row === next.row &&
    prev.selected === next.selected &&
    prev.showRateLimitCol === next.showRateLimitCol &&
    prev.testBusyId === next.testBusyId &&
    prev.moreMenuOpen === next.moreMenuOpen &&
    prev.onSelect === next.onSelect &&
    prev.onTestRoute === next.onTestRoute &&
    prev.onToggleMoreMenu === next.onToggleMoreMenu &&
    prev.onCloseMoreMenu === next.onCloseMoreMenu
  )
}

export const RoutesTableRow = memo(RoutesTableRowInner, routesTableRowPropsEqual)

export const ROUTES_TABLE_ROW_HEIGHT = 52
export const ROUTES_VIRTUAL_SCROLL_THRESHOLD = 24
