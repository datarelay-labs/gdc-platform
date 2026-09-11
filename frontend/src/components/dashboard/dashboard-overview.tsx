import { ChevronDown, Plus, RefreshCw } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { loadDashboardRefreshMs, persistDashboardRefreshMs } from '../../localPreferences'
import { Link } from 'react-router-dom'
import type { ExtendedMetricsWindow } from '../../api/gdcRuntime'
import { newStreamPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import {
  deriveDashboardKpisFromSnapshot,
  deriveOperationalProblems,
  deriveOverallHealthBeacon,
  deriveOverallHealthFromSnapshot,
  derivePrimaryOperationalIssueStrip,
  derivePrimaryTrafficKpisFromSnapshot,
  deriveRecentAlertsSummary,
  deriveStreamGroupHealthFromSnapshot,
  deriveStreamHealthMatrix,
  deriveSystemHealthFromSnapshot,
  deriveTopSourcesByIngestRate,
  deriveTrafficChartSeries,
  SNAPSHOT_KPI_BASIS_LABEL,
} from './dashboard-charter-metrics'
import {
  DashboardGroupKpiStrip,
  DashboardGroupSummaryPanel,
  DashboardKpiStrip,
  DashboardRunningBadge,
  DataModeBadge,
  EventsOverTimeChart,
  OperationalProblemsList,
  OverallHealthBeaconCard,
  OverallHealthHero,
  RecentAlertsPanel,
  StreamHealthMatrix,
  SystemHealthBar,
  SystemHealthSummaryStrip,
  TopSourcesByIngestRatePanel,
} from './dashboard-visual-panels'
import { useDashboardOverviewData } from './use-dashboard-overview-data'
import { RuntimeFixtureModeBanner } from '../runtime/runtime-fixture-mode-banner'

const WINDOW_OPTIONS: ExtendedMetricsWindow[] = ['15m', '1h', '6h', '24h', '7d', '30d']

const REFRESH_OPTIONS: { label: string; ms: number | null }[] = [
  { label: 'Off', ms: null },
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
]

function windowButtonLabel(w: ExtendedMetricsWindow): string {
  if (w === '15m') return 'Last 15 min'
  if (w === '1h') return 'Last 1 hour'
  if (w === '6h') return 'Last 6 hours'
  if (w === '24h') return 'Last 24 hours'
  if (w === '7d') return 'Last 7 days'
  if (w === '30d') return 'Last 30 days'
  return w
}

function windowChipLabel(w: ExtendedMetricsWindow): string {
  if (w === '15m') return '15m'
  if (w === '1h') return '1h'
  if (w === '6h') return '6h'
  if (w === '24h') return '24h'
  if (w === '7d') return '7d'
  if (w === '30d') return '30d'
  return w
}

function refreshLabel(ms: number | null): string {
  if (ms == null) return 'Refresh: Off'
  if (ms === 15_000) return 'Refresh: 15s'
  if (ms === 30_000) return 'Refresh: 30s'
  if (ms === 60_000) return 'Refresh: 1m'
  if (ms === 300_000) return 'Refresh: 5m'
  return `Refresh: ${ms / 1000}s`
}

const selectClass = cn(
  'appearance-none rounded-lg border border-slate-200/80 bg-white py-1.5 pl-3 pr-8 text-[12px] font-medium text-slate-700',
  'dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200',
)

export function DashboardOverview() {
  const [metricsWindow, setMetricsWindow] = useState<ExtendedMetricsWindow>('24h')
  const [refreshMs, setRefreshMs] = useState<number | null>(null)
  const recentAlertsRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setRefreshMs(loadDashboardRefreshMs())
  }, [])

  const { bundle, loading, loadError, reload } = useDashboardOverviewData(metricsWindow, refreshMs)
  const initialLoading = loading && bundle == null
  const windowLabel = windowChipLabel(metricsWindow)
  const windowLongLabel = windowButtonLabel(metricsWindow)

  const overallHealth = useMemo(
    () => deriveOverallHealthFromSnapshot(bundle?.operationalSnapshot ?? null),
    [bundle?.operationalSnapshot],
  )
  const groupHealth = useMemo(
    () => deriveStreamGroupHealthFromSnapshot(bundle?.operationalSnapshot ?? null, bundle?.connectors ?? []),
    [bundle?.operationalSnapshot, bundle?.connectors],
  )
  const operationalProblems = useMemo(
    () => deriveOperationalProblems(bundle?.operationalSnapshot ?? null),
    [bundle?.operationalSnapshot],
  )
  const trafficSeries = useMemo(() => deriveTrafficChartSeries(bundle?.outcomeTs ?? null), [bundle?.outcomeTs])
  const alertsSummary = useMemo(
    () => deriveRecentAlertsSummary(bundle?.alerts?.items ?? []),
    [bundle?.alerts?.items],
  )
  const primaryTrafficKpis = useMemo(
    () => derivePrimaryTrafficKpisFromSnapshot(bundle?.operationalSnapshot ?? null),
    [bundle?.operationalSnapshot],
  )
  const kpiItems = useMemo(
    () =>
      deriveDashboardKpisFromSnapshot({
        snapshot: bundle?.operationalSnapshot ?? null,
        alertsSummary,
        alertsFailed: bundle?.alertsFailed,
        outcomeTs: bundle?.outcomeTs ?? null,
        chartWindowLabel: windowLabel,
        alertsItems: bundle?.alerts?.items ?? [],
      }),
    [bundle?.operationalSnapshot, alertsSummary, bundle?.alertsFailed, bundle?.outcomeTs, windowLabel, bundle?.alerts?.items],
  )
  const secondaryKpis = useMemo(
    () => kpiItems.filter((k) => k.id === 'active-streams' || k.id === 'delivery-gap' || k.id === 'active-alerts'),
    [kpiItems],
  )
  const topSources = useMemo(
    () =>
      deriveTopSourcesByIngestRate(
        bundle?.connectors ?? [],
        bundle?.operationalSnapshot ?? null,
        null,
        6,
      ),
    [bundle?.connectors, bundle?.operationalSnapshot],
  )
  const systemHealth = useMemo(
    () => deriveSystemHealthFromSnapshot(bundle?.operationalSnapshot ?? null, bundle?.dashboard ?? null, groupHealth),
    [bundle?.operationalSnapshot, bundle?.dashboard, groupHealth],
  )
  const overallHealthBeacon = useMemo(
    () => deriveOverallHealthBeacon(bundle?.operationalSnapshot ?? null, alertsSummary),
    [bundle?.operationalSnapshot, alertsSummary],
  )
  const primaryOperationalIssues = useMemo(
    () => derivePrimaryOperationalIssueStrip(bundle?.operationalSnapshot ?? null, bundle?.dashboard ?? null),
    [bundle?.operationalSnapshot, bundle?.dashboard],
  )
  const streamHealthMatrix = useMemo(
    () => deriveStreamHealthMatrix(bundle?.operationalSnapshot ?? null, bundle?.connectors ?? []),
    [bundle?.operationalSnapshot, bundle?.connectors],
  )

  const totalStreams = bundle?.operationalSnapshot?.global.total_streams ?? bundle?.streams.length ?? 0
  const isFreshInstall = !initialLoading && totalStreams === 0

  const scrollToAlerts = () => {
    recentAlertsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="w-full min-w-0 space-y-3">
      {/* ── Header ── */}
      <div className="flex flex-col gap-2 border-b border-slate-200/80 pb-3 dark:border-gdc-divider lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Dashboard</h1>
          <p className="mt-0.5 text-[12px] text-slate-600 dark:text-gdc-muted">Operational overview of your data delivery platform</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Fixture mode badge — only shown when active */}
          <DataModeBadge isFixtureMode={bundle?.isFixtureMode ?? false} />

          {/* Engine status badge */}
          {!isFreshInstall ? (
            <DashboardRunningBadge
              engineStatus={bundle?.dashboard?.runtime_engine_status}
              dashboardFailed={bundle?.dashboardFailed}
              posture={overallHealth.posture}
            />
          ) : null}

          {/* Time Range selector */}
          <div className="relative">
            <label htmlFor="dashboard-window-select" className="sr-only">
              Analytics window
            </label>
            <select
              id="dashboard-window-select"
              value={metricsWindow}
              onChange={(e) => setMetricsWindow(e.target.value as ExtendedMetricsWindow)}
              title="Affects events chart, alerts, and analytics — snapshot KPIs use a fixed 5m window"
              aria-describedby="dashboard-window-hint"
              className={selectClass}
            >
              {WINDOW_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {windowButtonLabel(w)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          </div>

          {/* Auto Refresh selector */}
          <div className="relative">
            <label htmlFor="dashboard-refresh-select" className="sr-only">
              Auto refresh interval
            </label>
            <select
              id="dashboard-refresh-select"
              value={refreshMs === null ? 'off' : String(refreshMs)}
              onChange={(e) => {
                const val = e.target.value === 'off' ? null : Number(e.target.value)
                setRefreshMs(val)
                persistDashboardRefreshMs(val)
              }}
              className={selectClass}
              title={refreshLabel(refreshMs)}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.label} value={o.ms === null ? 'off' : String(o.ms)}>
                  {o.ms === null ? 'Auto-refresh: Off' : `Auto-refresh: ${o.label}`}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          </div>

          {/* Manual refresh */}
          <button
            type="button"
            onClick={() => void reload()}
            disabled={initialLoading}
            className={cn(
              'inline-flex items-center justify-center rounded-lg border p-2 transition-colors',
              'border-slate-200/80 text-slate-600 hover:border-slate-300 hover:bg-slate-50',
              'disabled:cursor-not-allowed disabled:opacity-50 dark:border-gdc-border dark:text-gdc-muted dark:hover:bg-gdc-section/60',
            )}
            title="Refresh data now"
            aria-label="Refresh dashboard data now"
          >
            <RefreshCw className={cn('h-4 w-4', initialLoading && 'animate-spin')} aria-hidden />
          </button>
        </div>
      </div>

      {/* Fixture mode admin banner */}
      <RuntimeFixtureModeBanner surface="dashboard" />

      {/* Window hint */}
      {!isFreshInstall ? (
        <p id="dashboard-window-hint" className="text-[10px] text-slate-500 dark:text-gdc-muted">
          Snapshot KPIs ({SNAPSHOT_KPI_BASIS_LABEL}) reflect live operational state. The time range selector affects
          events over time, alerts, and analytics only.
        </p>
      ) : null}

      {/* Load error */}
      {loadError ? (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100"
          role="alert"
        >
          {loadError}
        </div>
      ) : null}

      {initialLoading ? (
        <p className="text-[12px] text-slate-500 dark:text-gdc-muted" role="status">
          Loading dashboard data…
        </p>
      ) : null}

      {/* ── Content ── */}
      {isFreshInstall ? (
        <section
          className="rounded-xl border border-violet-200/80 bg-violet-50/50 px-4 py-4 dark:border-violet-500/30 dark:bg-violet-500/10"
          data-testid="dashboard-empty-state"
        >
          <h3 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Welcome to Data Relay</h3>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-600 dark:text-gdc-mutedStrong">
            No streams are configured yet. Create your first stream to start collecting, transforming, and delivering data.
          </p>
          <Link
            to={newStreamPath()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Create First Stream
          </Link>
        </section>
      ) : (
        <div className={cn('space-y-3', initialLoading && 'opacity-80')}>

          {/* ── Primary: Overall Health (Healthy / Warning / Critical) ── */}
          <OverallHealthHero health={overallHealth} basisLabel={SNAPSHOT_KPI_BASIS_LABEL} />

          {/* ── Primary: posture beacon + operational issue counts ── */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
            <div className="lg:w-[220px] lg:shrink-0">
              <OverallHealthBeaconCard beacon={overallHealthBeacon} onFocusAlerts={scrollToAlerts} />
            </div>
            <div className="flex-1">
              <SystemHealthSummaryStrip items={primaryOperationalIssues} />
            </div>
          </div>

          {/* ── Primary: Incoming / Outgoing / Delivery Success ── */}
          <DashboardKpiStrip items={primaryTrafficKpis} columns={3} onFocusAlerts={scrollToAlerts} />

          {/* ── Stream groups (Source Product) — drill-down to Streams ── */}
          <DashboardGroupKpiStrip groupHealth={groupHealth} />
          <DashboardGroupSummaryPanel groupHealth={groupHealth} />

          {/* ── Issue details (demoted) + supporting context ── */}
          <div className="grid gap-3 lg:grid-cols-12">
            <OperationalProblemsList problems={operationalProblems} className="lg:col-span-4" />
            <TopSourcesByIngestRatePanel sources={topSources} className="lg:col-span-8" />
          </div>

          {/* ── Secondary: supporting stream/route KPIs (not primary traffic) ── */}
          {secondaryKpis.length > 0 ? (
            <DashboardKpiStrip
              items={secondaryKpis}
              columns={3}
              onFocusAlerts={scrollToAlerts}
              testId="dashboard-secondary-kpi-strip"
            />
          ) : null}

          {/* ── Secondary: Stream Health Matrix ── */}
          <StreamHealthMatrix matrix={streamHealthMatrix} />

          {/* ── Secondary: Events Over Time | Recent Alerts ── */}
          <div className="grid gap-3 lg:grid-cols-12">
            <EventsOverTimeChart series={trafficSeries} windowLabel={windowLongLabel} loading={initialLoading} className="lg:col-span-7" />
            <div className="lg:col-span-5" ref={(el) => { recentAlertsRef.current = el }}>
              <RecentAlertsPanel
                summary={alertsSummary}
                items={bundle?.alerts?.items ?? []}
                alertsFailed={bundle?.alertsFailed}
              />
            </div>
          </div>

          {/* ── Bottom: System Health Pill Row (includes checkpoint demoted from primary) ── */}
          <SystemHealthBar items={systemHealth} />
        </div>
      )}

      <div className="flex flex-col gap-0.5 border-t border-slate-200/70 pt-2 text-[10px] leading-relaxed text-slate-500 dark:border-gdc-border dark:text-gdc-muted sm:flex-row sm:items-center sm:justify-between">
        <p>© 2025 Data Relay Platform</p>
        <p>All times shown in UTC</p>
      </div>
    </div>
  )
}
