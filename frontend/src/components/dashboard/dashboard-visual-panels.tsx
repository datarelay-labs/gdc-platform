import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  CheckCircle2,
  Clock,
  Cloud,
  Database,
  FileText,
  Flame,
  Gauge,
  GitMerge,
  HardDrive,
  Layers,
  Link as LinkIcon,
  Minus,
  Radio,
  RotateCcw,
  TrendingDown,
  TrendingUp,
  VolumeX,
  XCircle,
  Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { destinationDetailPath, NAV_PATH, streamRuntimePath, streamsExpandedGroupPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { formatThroughputEps } from '../../lib/observability-format'
import type { RuntimeAlertSummaryItem } from '../../api/types/gdcApi'
import {
  dashboardCardClass,
  type DashboardKpiItem,
  type FlowBreakdown,
  type FlowLaneCounts,
  type OperationalProblemDisplay,
  type OverallHealthBeacon,
  type RecentAlertsSummary,
  type StreamGroupHealthCounts,
  type StreamHealthMatrixData,
  type StreamsOperationalStatus,
  type SystemHealthItem,
  type SystemHealthSummaryItem,
  type TopSourceIngestItem,
  type OverallHealthCounts,
  type TrafficChartPoint,
  donutSlicesFromCounts,
  formatMetricCount,
  formatSuccessRate,
  operationalStatusDonutSlices,
} from './dashboard-charter-metrics'

function postureHeroClass(posture: OverallHealthCounts['posture']): string {
  if (posture === 'critical') {
    return 'border-red-500/40 bg-gradient-to-r from-red-950/50 via-red-900/20 to-transparent shadow-[0_0_16px_-6px_rgba(239,68,68,0.35)]'
  }
  if (posture === 'warning') {
    return 'border-amber-500/35 bg-gradient-to-r from-amber-950/45 via-amber-900/15 to-transparent shadow-[0_0_14px_-6px_rgba(245,158,11,0.3)]'
  }
  return 'border-emerald-500/35 bg-gradient-to-r from-emerald-950/40 via-emerald-900/12 to-transparent shadow-[0_0_14px_-6px_rgba(34,197,94,0.28)]'
}

function postureLabel(posture: OverallHealthCounts['posture']): string {
  if (posture === 'critical') return 'Critical'
  if (posture === 'warning') return 'Warning'
  return 'Healthy'
}

const KPI_SPARK: Record<DashboardKpiItem['tone'], string> = {
  blue: '#38bdf8',
  green: '#34d399',
  violet: '#a78bfa',
  teal: '#2dd4bf',
  amber: '#fbbf24',
  red: '#f87171',
  neutral: '#94a3b8',
}

const KPI_ICON: Record<string, typeof Layers> = {
  'active-streams': Layers,
  'incoming-events': ArrowDownToLine,
  'outgoing-events': ArrowUpFromLine,
  'ingest-rate': ArrowDownToLine,
  'delivery-rate': ArrowUpFromLine,
  'delivery-gap': TrendingDown,
  'success-rate': Gauge,
  'active-alerts': Bell,
}

const KPI_ICON_BG: Record<DashboardKpiItem['tone'], string> = {
  blue: 'bg-sky-500/15 text-sky-400',
  green: 'bg-emerald-500/15 text-emerald-400',
  violet: 'bg-violet-500/15 text-violet-400',
  teal: 'bg-teal-500/15 text-teal-400',
  amber: 'bg-amber-500/15 text-amber-400',
  red: 'bg-red-500/15 text-red-400',
  neutral: 'bg-slate-500/15 text-slate-400',
}

export function DashboardRunningBadge({
  engineStatus,
  dashboardFailed,
  posture,
}: {
  engineStatus?: string | null
  /** When true, the dashboard summary API failed so engineStatus is not reliable. */
  dashboardFailed?: boolean
  posture: 'healthy' | 'warning' | 'critical'
}) {
  // engineStatus == null without a failure means the field wasn't returned yet (loading race),
  // treat the same as a failure so we do not show a misleading RUNNING state.
  const isUnknown = dashboardFailed || engineStatus == null
  const running = !isUnknown && engineStatus === 'RUNNING'

  return (
    <div
      data-testid="dashboard-running-badge"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold',
        isUnknown
          ? 'border-slate-600/40 bg-slate-700/20 text-slate-400'
          : running && posture === 'healthy'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            : running
              ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
              : posture === 'critical'
                ? 'border-red-500/40 bg-red-500/10 text-red-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            isUnknown ? 'bg-slate-500' : running ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.7)]' : 'bg-amber-400',
          )}
          aria-hidden
        />
        {isUnknown ? 'Unknown' : running ? 'RUNNING' : String(engineStatus)}
      </span>
      {running && posture === 'healthy' ? (
        <>
          <span className="text-slate-600 dark:text-slate-500" aria-hidden>
            |
          </span>
          <span className="inline-flex items-center gap-1 text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            All Systems Operational
          </span>
        </>
      ) : null}
    </div>
  )
}

/** Shows a "FIXTURE DATA" badge only when dev fixture mode is active. Returns null in normal operation. */
export function DataModeBadge({ isFixtureMode }: { isFixtureMode: boolean }) {
  if (!isFixtureMode) return null
  return (
    <div
      data-testid="dashboard-fixture-mode-badge"
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/60 bg-amber-500/15 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-amber-300"
      title="Dashboard is showing fixture / test data, not live backend data"
    >
      <span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_2px_rgba(251,191,36,0.6)]" aria-hidden />
      Fixture Mode
    </div>
  )
}

export function OverallHealthHero({
  health,
  basisLabel,
}: {
  health: OverallHealthCounts
  basisLabel: string
}) {
  return (
    <section
      aria-label="Overall health hero"
      data-testid="dashboard-overall-health-hero"
      className={cn(
        'relative overflow-hidden rounded-xl border px-4 py-2.5',
        postureHeroClass(health.posture),
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          {health.posture === 'healthy' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
          ) : (
            <AlertTriangle
              className={cn('h-4 w-4 shrink-0', health.posture === 'critical' ? 'text-red-400' : 'text-amber-400')}
              aria-hidden
            />
          )}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Overall health</p>
            <p
              className={cn(
                'text-lg font-bold leading-tight tracking-tight',
                health.posture === 'critical' ? 'text-red-300' : health.posture === 'warning' ? 'text-amber-300' : 'text-emerald-300',
              )}
              data-testid="dashboard-overall-posture-label"
            >
              {postureLabel(health.posture)}
            </p>
          </div>
          <span className="hidden text-[10px] text-slate-500 sm:inline">· {basisLabel}</span>
        </div>

        <div className="flex gap-2 sm:gap-3" data-testid="dashboard-overall-health">
          {(
            [
              ['Healthy', health.healthy, 'healthy', 'dashboard-health-healthy'],
              ['Warning', health.warning, 'warning', 'dashboard-health-warning'],
              ['Critical', health.critical, 'critical', 'dashboard-health-critical'],
            ] as const
          ).map(([label, count, tone, testId]) => (
            <Link
              key={testId}
              to={NAV_PATH.streams}
              data-testid={testId}
              className={cn(
                'min-w-[4.5rem] rounded-lg border px-2.5 py-1 text-center transition hover:brightness-110',
                tone === 'healthy' && 'border-emerald-500/30 bg-emerald-500/10',
                tone === 'warning' && 'border-amber-500/30 bg-amber-500/10',
                tone === 'critical' && 'border-red-500/35 bg-red-500/10',
              )}
            >
              <p className="text-[8px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
              <p
                className={cn(
                  'mt-0.5 text-lg font-bold tabular-nums leading-none',
                  tone === 'healthy' && 'text-emerald-300',
                  tone === 'warning' && 'text-amber-300',
                  tone === 'critical' && 'text-red-300',
                )}
              >
                {formatMetricCount(count)}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

function parseKpiTrend(sub: string): { badge: string; footnote: string } {
  const chartIdx = sub.indexOf(' chart trend (')
  if (chartIdx !== -1) {
    return { badge: sub.slice(0, chartIdx).trim(), footnote: sub.slice(chartIdx + 1).trim() }
  }
  const vsIdx = sub.indexOf(' vs last ')
  if (vsIdx === -1) return { badge: sub, footnote: '' }
  return { badge: sub.slice(0, vsIdx).trim(), footnote: sub.slice(vsIdx + 1).trim() }
}

function splitKpiValue(value: string): { primary: string; unit: string | null } {
  const match = value.match(/^(.+?)\s+(events\/sec)$/)
  if (match) return { primary: match[1], unit: match[2] }
  return { primary: value, unit: null }
}

// ── Overall Health Beacon ──────────────────────────────────────────────────

function fmtTimeAgo(iso: string | null): string | null {
  if (!iso) return null
  try {
    const diffMin = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
    if (diffMin < 1) return 'just now'
    if (diffMin < 60) return `${diffMin}m ago`
    const h = Math.floor(diffMin / 60)
    const m = diffMin % 60
    return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`
  } catch {
    return null
  }
}

export function OverallHealthBeaconCard({
  beacon,
  onFocusAlerts,
}: {
  beacon: OverallHealthBeacon
  onFocusAlerts?: () => void
}) {
  const isHealthy = beacon.posture === 'healthy'
  const isWarning = beacon.posture === 'warning'

  const borderClass = isHealthy
    ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-950/50 via-emerald-900/15 to-transparent'
    : isWarning
      ? 'border-amber-500/40 bg-gradient-to-br from-amber-950/50 via-amber-900/15 to-transparent'
      : 'border-red-500/40 bg-gradient-to-br from-red-950/50 via-red-900/20 to-transparent'

  const labelClass = isHealthy ? 'text-emerald-300' : isWarning ? 'text-amber-300' : 'text-red-300'

  const isClickable = beacon.posture !== 'healthy' && onFocusAlerts != null

  const incidentLabel = fmtTimeAgo(beacon.lastIncidentAt)

  return (
    <section
      aria-label="Overall health beacon"
      data-testid="dashboard-overall-health-beacon"
      className={cn(
        'rounded-xl border px-4 py-3',
        borderClass,
        isClickable && 'cursor-pointer transition hover:brightness-110',
      )}
      onClick={isClickable ? onFocusAlerts : undefined}
      role={isClickable ? 'button' : undefined}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Overall Health</p>
      <div className="mt-1.5 flex items-center gap-2">
        {isHealthy ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
        ) : isWarning ? (
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden />
        ) : (
          <XCircle className="h-5 w-5 shrink-0 text-red-400" aria-hidden />
        )}
        <p className={cn('text-xl font-bold leading-tight tracking-tight', labelClass)} data-testid="dashboard-beacon-label">
          {beacon.label}
        </p>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{beacon.description}</p>
      {incidentLabel ? (
        <p className="mt-1 text-[10px] text-slate-500">Last incident: {incidentLabel}</p>
      ) : (
        <p className="mt-1 text-[10px] text-slate-600">No recent incidents</p>
      )}
    </section>
  )
}

// ── System Health Summary Strip ────────────────────────────────────────────

const SUMMARY_ITEM_ICON: Record<SystemHealthSummaryItem['id'], typeof Layers> = {
  'no-data': AlertCircle,
  'low-volume': VolumeX,
  'schema-drift': GitMerge,
  'capacity-warning': Database,
  'checkpoint-lag': Clock,
  'replay-queue': RotateCcw,
}

const SUMMARY_ITEM_HREF: Record<SystemHealthSummaryItem['id'], string> = {
  'no-data': '/streams?filter=no-data',
  'low-volume': '/streams?filter=low-volume',
  'schema-drift': '/streams?filter=schema-drift',
  'capacity-warning': '/destinations?filter=warning',
  'checkpoint-lag': '/streams?filter=checkpoint-lag',
  'replay-queue': '/governance/replay',
}

export function SystemHealthSummaryStrip({ items }: { items: SystemHealthSummaryItem[] }) {
  const cols =
    items.length <= 4
      ? 'grid-cols-2 sm:grid-cols-4'
      : 'grid-cols-3 sm:grid-cols-6'
  return (
    <section
      aria-label="Operational issues"
      data-testid="dashboard-operational-issues"
      className={cn(dashboardCardClass, 'flex-1')}
    >
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Operational Issues</p>
      <div className={cn('grid gap-2', cols)} data-testid="dashboard-system-health-summary">
        {items.map((item) => {
          const Icon = SUMMARY_ITEM_ICON[item.id] ?? AlertTriangle
          const href = SUMMARY_ITEM_HREF[item.id] ?? '/streams'
          const hasIssue = item.count > 0
          const isWarning = item.status === 'warning'
          const isCritical = item.status === 'critical'
          return (
            <Link
              key={item.id}
              to={href}
              data-testid={`dashboard-summary-${item.id}`}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-center transition hover:brightness-110',
                isCritical
                  ? 'border-red-500/40 bg-red-500/10'
                  : isWarning
                    ? 'border-amber-500/35 bg-amber-500/8'
                    : 'border-slate-700/50 bg-slate-800/30',
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0',
                  isCritical ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-slate-500',
                )}
                aria-hidden
              />
              <p
                className={cn(
                  'text-[9px] font-semibold uppercase leading-tight tracking-wide',
                  isCritical ? 'text-red-300' : isWarning ? 'text-amber-300' : 'text-slate-500',
                )}
              >
                {item.label}
              </p>
              <p
                className={cn(
                  'text-[1.1rem] font-bold tabular-nums leading-none',
                  isCritical ? 'text-red-300' : isWarning ? 'text-amber-300' : hasIssue ? 'text-slate-300' : 'text-slate-500',
                )}
              >
                {item.count}
              </p>
            </Link>
          )
        })}
      </div>
    </section>
  )
}

// ── KPI Card sub-components ────────────────────────────────────────────────

function ActiveStreamsSegBar({ seg }: { seg: NonNullable<DashboardKpiItem['streamSegments']> }) {
  const total = seg.healthy + seg.warning + seg.failed + seg.stopped
  if (total === 0) return null
  const hp = (seg.healthy / total) * 100
  const wp = (seg.warning / total) * 100
  const fp = (seg.failed / total) * 100
  return (
    <div className="mt-2">
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="flex h-full">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${hp}%` }} />
          <div className="h-full bg-amber-500 transition-all" style={{ width: `${wp}%` }} />
          <div className="h-full bg-red-500 transition-all" style={{ width: `${fp}%` }} />
        </div>
      </div>
      <div className="mt-1.5 flex gap-3 text-[10px]">
        <span className="inline-flex items-center gap-1 text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> {seg.healthy} Healthy
        </span>
        <span className="inline-flex items-center gap-1 text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden /> {seg.warning} Warning
        </span>
        <span className="inline-flex items-center gap-1 text-red-400">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400" aria-hidden /> {seg.failed} Failed
        </span>
      </div>
    </div>
  )
}

function SuccessRateBullet({ value, target }: { value: number; target: number }) {
  const clampedPct = Math.min(100, Math.max(0, value))
  const targetPct = Math.min(100, Math.max(0, target))
  return (
    <div className="mt-2">
      <div className="relative h-3 w-full overflow-hidden rounded-sm bg-slate-800">
        <div className="absolute inset-y-0 left-0 bg-red-900/50" style={{ width: '90%' }} />
        <div className="absolute inset-y-0 bg-amber-900/50" style={{ left: '90%', width: '8%' }} />
        <div className="absolute inset-y-0 bg-emerald-900/50" style={{ left: '98%', right: 0 }} />
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-sm',
            clampedPct >= target ? 'bg-teal-500/80' : clampedPct >= 90 ? 'bg-amber-500/80' : 'bg-red-500/70',
          )}
          style={{ width: `${clampedPct}%` }}
        />
        <div className="absolute inset-y-0 w-0.5 bg-white/60" style={{ left: `${targetPct}%` }} aria-hidden />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-600">
        <span>0%</span>
        <span className="text-slate-500">Target: {target}%</span>
        <span>100%</span>
      </div>
    </div>
  )
}

function MiniSparkline({ values, color, sparkId }: { values: number[]; color: string; sparkId: string }) {
  const data =
    values.length > 1
      ? values.map((y, i) => ({ i, y }))
      : [{ i: 0, y: values[0] ?? 0 }, { i: 1, y: values[0] ?? 0 }]
  const gradId = `kpi-spark-${sparkId}`
  return (
    <div className="mt-auto h-9 w-full pt-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="y"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function DashboardKpiStrip({
  items,
  onFocusAlerts,
  columns,
  testId = 'dashboard-kpi-strip',
}: {
  items: DashboardKpiItem[]
  onFocusAlerts?: () => void
  /** Override grid columns (default 6). Use 3 for primary traffic strip. */
  columns?: 3 | 6
  testId?: string
}) {
  return (
    <section
      aria-label="Dashboard KPI strip"
      data-testid={testId}
      className={cn('grid gap-3 sm:grid-cols-2', columns === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-6')}
    >
      {items.map((kpi) => {
        const Icon = KPI_ICON[kpi.id] ?? Activity
        const { primary, unit } = splitKpiValue(kpi.value)
        const { badge, footnote } = parseKpiTrend(kpi.sub)
        const subPositive = badge.startsWith('↑') || badge.startsWith('↗') || badge.startsWith('+')
        const subNegative = badge.startsWith('↓') || badge.startsWith('↘') || badge.startsWith('-')
        const isAlertKpi = kpi.id === 'active-alerts'
        const isActiveStreams = kpi.id === 'active-streams'
        const isSuccessRate = kpi.id === 'success-rate'
        const isDeliveryGap = kpi.id === 'delivery-gap'

        const cardContent = (
          <div
            key={kpi.id}
            className={cn(dashboardCardClass, 'flex min-h-[7.25rem] flex-col', kpi.href && 'transition hover:brightness-110')}
            data-testid={`dashboard-kpi-${kpi.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-medium text-slate-400">{kpi.label}</p>
              <span className={cn('inline-flex rounded-lg p-1.5', KPI_ICON_BG[kpi.tone])} aria-hidden>
                <Icon className="h-4 w-4" />
              </span>
            </div>
            <p className="mt-2 text-[1.75rem] font-bold tabular-nums leading-none tracking-tight text-slate-50">
              {primary}
              {unit ? <span className="ml-1 text-[12px] font-normal text-slate-500">{unit}</span> : null}
            </p>
            {kpi.basisLabel ? (
              <p className="mt-1 text-[10px] font-medium text-slate-500 dark:text-gdc-muted">{kpi.basisLabel}</p>
            ) : null}

            {/* Specialized sub-rendering */}
            {isActiveStreams && kpi.streamSegments ? (
              <ActiveStreamsSegBar seg={kpi.streamSegments} />
            ) : isSuccessRate && kpi.bulletValue != null ? (
              <SuccessRateBullet value={kpi.bulletValue} target={kpi.bulletTarget ?? 99} />
            ) : isAlertKpi && kpi.alertMeta ? (
              <div className="mt-1.5 space-y-0.5">
                <p className={cn('text-[11px] font-medium', kpi.tone === 'red' ? 'text-red-400' : kpi.tone === 'amber' ? 'text-amber-400' : 'text-slate-500')}>
                  {kpi.alertMeta.critical > 0 ? `${kpi.alertMeta.critical} Critical` : ''}{kpi.alertMeta.critical > 0 && kpi.alertMeta.warning > 0 ? ', ' : ''}{kpi.alertMeta.warning > 0 ? `${kpi.alertMeta.warning} Warning` : ''}
                  {kpi.alertMeta.critical === 0 && kpi.alertMeta.warning === 0 ? 'No active alerts' : ''}
                </p>
                {kpi.alertMeta.oldestAgeLabel !== '—' && (kpi.alertMeta.critical > 0 || kpi.alertMeta.warning > 0) ? (
                  <p className="text-[10px] text-slate-500">Oldest: {kpi.alertMeta.oldestAgeLabel}</p>
                ) : null}
              </div>
            ) : isDeliveryGap && kpi.deliveryGap ? (
              <div className="mt-1.5 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1">
                  <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold',
                    kpi.deliveryGap.gapPct >= 5 ? 'bg-red-500/20 text-red-300' : kpi.deliveryGap.gapPct >= 1 ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700/50 text-slate-400',
                  )}>
                    {kpi.deliveryGap.gapPct.toFixed(1)}% gap
                  </span>
                  {kpi.deliveryGap.routesHolding > 0 ? (
                    <span className="text-[10px] text-amber-400">{kpi.deliveryGap.routesHolding} routes holding</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {badge !== '—' && badge !== '0' ? (
                  <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium',
                    subPositive && 'text-emerald-400',
                    subNegative && 'text-red-400',
                    !subPositive && !subNegative && 'text-slate-500',
                  )}>
                    {subPositive ? <TrendingUp className="h-3 w-3" aria-hidden /> : null}
                    {subNegative ? <TrendingDown className="h-3 w-3" aria-hidden /> : null}
                    {badge}
                  </span>
                ) : null}
                {footnote ? <span className="text-[11px] text-slate-500">{footnote}</span> : null}
              </div>
            )}

            {kpi.sparkline.length > 0 && !isActiveStreams && !isSuccessRate ? (
              <MiniSparkline values={kpi.sparkline} color={KPI_SPARK[kpi.tone]} sparkId={kpi.id} />
            ) : null}
          </div>
        )

        if (isAlertKpi) {
          return (
            <button key={kpi.id} type="button" onClick={onFocusAlerts} className="text-left">
              {cardContent}
            </button>
          )
        }

        if (kpi.href) {
          return <Link key={kpi.id} to={kpi.href}>{cardContent}</Link>
        }

        return cardContent
      })}
    </section>
  )
}

const GROUP_KPI_ICON_BG = {
  healthy: 'bg-emerald-500/15 text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-400',
  critical: 'bg-red-500/15 text-red-400',
} as const

export function DashboardGroupKpiStrip({ groupHealth }: { groupHealth: StreamGroupHealthCounts }) {
  const cards = [
    { id: 'healthy-groups', label: 'Healthy Groups', value: groupHealth.healthy, tone: 'healthy' as const, icon: CheckCircle2 },
    { id: 'warning-groups', label: 'Warning Groups', value: groupHealth.warning, tone: 'warning' as const, icon: AlertTriangle },
    { id: 'critical-groups', label: 'Critical Groups', value: groupHealth.critical, tone: 'critical' as const, icon: XCircle },
  ]

  return (
    <section
      aria-label="Stream group KPI summary"
      data-testid="dashboard-group-kpi-strip"
      className="grid gap-3 sm:grid-cols-3"
    >
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <Link
            key={card.id}
            to={NAV_PATH.streams}
            data-testid={`dashboard-kpi-${card.id}`}
            className={cn(dashboardCardClass, 'flex min-h-[5.5rem] flex-col transition hover:brightness-110')}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-medium text-slate-400">{card.label}</p>
              <span className={cn('inline-flex rounded-lg p-1.5', GROUP_KPI_ICON_BG[card.tone])} aria-hidden>
                <Icon className="h-4 w-4" />
              </span>
            </div>
            <p className="mt-2 text-[1.75rem] font-bold tabular-nums leading-none tracking-tight text-slate-50">
              {formatMetricCount(card.value)}
            </p>
          </Link>
        )
      })}
    </section>
  )
}

function affectedStreamsLabel(issueCount: number, streamCount: number): string {
  const n = issueCount > 0 ? issueCount : streamCount
  return `${n} stream${n === 1 ? '' : 's'} affected`
}

function groupSchemaDriftStats(group: { rows: Array<{ openSchemaFieldDriftCount?: number }> }): {
  openDrift: number
  driftStreams: number
} {
  let openDrift = 0
  let driftStreams = 0
  for (const row of group.rows) {
    const n = row.openSchemaFieldDriftCount ?? 0
    if (n > 0) {
      openDrift += n
      driftStreams += 1
    }
  }
  return { openDrift, driftStreams }
}

function groupDriftCaption(group: { rows: Array<{ openSchemaFieldDriftCount?: number }> }): string | null {
  const { openDrift, driftStreams } = groupSchemaDriftStats(group)
  if (openDrift <= 0) return null
  return `${driftStreams} drift stream${driftStreams === 1 ? '' : 's'} · ${openDrift} open drift`
}

export function DashboardGroupSummaryPanel({ groupHealth }: { groupHealth: StreamGroupHealthCounts }) {
  const criticalGroups = groupHealth.groups.filter((g) => g.worstStatus === 'ERROR')
  const warningGroups = groupHealth.groups.filter((g) => g.worstStatus === 'DEGRADED')
  const driftGroups = groupHealth.groups.filter((g) => groupSchemaDriftStats(g).openDrift > 0)
  const hasAny = criticalGroups.length > 0 || warningGroups.length > 0
  const hasDrift = driftGroups.length > 0

  if (!hasAny && !hasDrift) {
    return (
      <section
        aria-label="Stream group summary"
        data-testid="dashboard-group-summary"
        className={cn(dashboardCardClass, 'text-[12px] text-slate-500 dark:text-gdc-muted')}
      >
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Group status</h2>
        <p className="mt-2">All stream groups are healthy in this window.</p>
      </section>
    )
  }

  return (
    <section aria-label="Stream group summary" data-testid="dashboard-group-summary" className={dashboardCardClass}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Groups needing attention</h2>
        <Link to={NAV_PATH.streams} className="text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-300">
          View all groups →
        </Link>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {criticalGroups.length > 0 ? (
          <div data-testid="dashboard-group-summary-critical">
            <p className="text-[11px] font-bold uppercase tracking-wide text-red-400">Critical groups</p>
            <ul className="mt-2 space-y-2">
              {criticalGroups.map((group) => (
                <li key={group.productLabel}>
                  <Link
                    to={streamsExpandedGroupPath(group.productLabel)}
                    data-testid={`dashboard-group-summary-critical-${group.productLabel}`}
                    className="block rounded-lg border border-red-500/25 bg-red-500/5 px-2.5 py-2 transition hover:border-red-500/40"
                  >
                    <p className="text-[13px] font-semibold text-slate-100">{group.productLabel}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{affectedStreamsLabel(group.issueCount, group.rows.length)}</p>
                    {groupDriftCaption(group) ? (
                      <p className="mt-0.5 text-[11px] text-amber-300" data-testid={`dashboard-group-drift-${group.productLabel}`}>
                        {groupDriftCaption(group)}
                      </p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {warningGroups.length > 0 ? (
          <div data-testid="dashboard-group-summary-warning">
            <p className="text-[11px] font-bold uppercase tracking-wide text-amber-400">Warning groups</p>
            <ul className="mt-2 space-y-2">
              {warningGroups.map((group) => (
                <li key={group.productLabel}>
                  <Link
                    to={streamsExpandedGroupPath(group.productLabel)}
                    data-testid={`dashboard-group-summary-warning-${group.productLabel}`}
                    className="block rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 transition hover:border-amber-500/40"
                  >
                    <p className="text-[13px] font-semibold text-slate-100">{group.productLabel}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{affectedStreamsLabel(group.issueCount, group.rows.length)}</p>
                    {groupDriftCaption(group) ? (
                      <p className="mt-0.5 text-[11px] text-amber-300" data-testid={`dashboard-group-drift-${group.productLabel}`}>
                        {groupDriftCaption(group)}
                      </p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {hasDrift ? (
        <div className="mt-3" data-testid="dashboard-group-summary-schema-drift">
          <p className="text-[11px] font-bold uppercase tracking-wide text-amber-400">Schema drift</p>
          <ul className="mt-2 space-y-2">
            {driftGroups.map((group) => (
              <li key={`drift-${group.productLabel}`}>
                <Link
                  to={streamsExpandedGroupPath(group.productLabel, { filter: 'schema-drift' })}
                  data-testid={`dashboard-group-summary-schema-drift-${group.productLabel}`}
                  className="block rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 transition hover:border-amber-500/40"
                >
                  <p className="text-[13px] font-semibold text-slate-100">{group.productLabel}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">{groupDriftCaption(group)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function recentAlertTargetPath(item: RuntimeAlertSummaryItem): string {
  const sid = item.stream_id
  if (typeof sid === 'number' && Number.isFinite(sid) && sid > 0) {
    return streamRuntimePath(String(sid))
  }
  return NAV_PATH.streams
}

// ── Flow Overview (Node Flow) ──────────────────────────────────────────────

const FLOW_H = 220       // container height px
const FLOW_ITEM_H = 40   // each node card height px
const FLOW_ITEM_GAP = 8  // gap between node cards px
const FLOW_CAT_W = 144   // node column width px
const FLOW_HUB_R = 30    // hub radius px

/** Compute top-Y for each item so they are vertically centered in the container. */
function flowItemYs(n: number): number[] {
  const count = Math.max(1, n)
  const totalH = count * FLOW_ITEM_H + Math.max(0, count - 1) * FLOW_ITEM_GAP
  const startY = Math.max(0, (FLOW_H - totalH) / 2)
  return Array.from({ length: count }, (_, i) => startY + i * (FLOW_ITEM_H + FLOW_ITEM_GAP))
}

/** Simple cubic-bezier connector path (stroke only, no fill). */
function flowCurvePath(x0: number, y0: number, x1: number, y1: number): string {
  const cpx = (x0 + x1) / 2
  return `M ${x0} ${y0} C ${cpx} ${y0}, ${cpx} ${y1}, ${x1} ${y1}`
}

const FLOW_SRC_COLORS = ['#38bdf8', '#06b6d4', '#22d3ee', '#0ea5e9', '#7dd3fc'] as const
const FLOW_DST_COLORS = ['#a78bfa', '#c084fc', '#8b5cf6', '#9333ea', '#6ee7b7'] as const

type FlowIcon = typeof Activity

const FLOW_SRC_ICONS: Record<string, FlowIcon> = {
  API: Cloud,
  Database,
  Files: FileText,
  Streaming: Radio,
  Webhook: LinkIcon,
}

const FLOW_DST_ICONS: Record<string, FlowIcon> = {
  API: Cloud,
  Streaming: Radio,
  Storage: HardDrive,
  'Data Lake': Layers,
  Warehouse: Database,
  Database,
}

export function DataFlowOverview({
  flow,
  breakdown,
  streamsStatus,
  className,
}: {
  flow: FlowLaneCounts
  breakdown: FlowBreakdown
  streamsStatus: StreamsOperationalStatus
  className?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [containerW, setContainerW] = useState<number>(460)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setContainerW(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(([entry]) => setContainerW(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const sources = breakdown.sources.filter((s) => s.count > 0)
  const dests = breakdown.destinations.filter((d) => d.count > 0)

  // Use at most 5 items per column to keep the diagram readable
  const srcItems = sources.slice(0, 5)
  const dstItems = dests.slice(0, 5)

  const srcYs = flowItemYs(srcItems.length)
  const dstYs = flowItemYs(dstItems.length)

  const hubCX = containerW / 2
  const hubCY = FLOW_H / 2

  // Connector attachment points (right edge of src card, left edge of dst card)
  const lineSrcX = FLOW_CAT_W + 4
  const lineDstX = containerW - FLOW_CAT_W - 4
  const hubLeft = hubCX - FLOW_HUB_R - 2
  const hubRight = hubCX + FLOW_HUB_R + 2

  const totalSrc = sources.reduce((s, i) => s + i.count, 0) || 1
  const totalDst = dests.reduce((s, i) => s + i.count, 0) || 1

  return (
    <section
      aria-label="Data flow overview"
      data-testid="dashboard-data-flow"
      className={cn(dashboardCardClass, className)}
    >
      {/* Header */}
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Flow Overview</h2>
        <span className="text-[10px] text-slate-500 dark:text-gdc-muted">
          {flow.routes} delivery paths configured
        </span>
      </div>

      {/* Count summary */}
      <div className="mt-2 flex items-baseline justify-between px-1 text-[11px]">
        <span className="font-semibold text-sky-400">
          Sources <span className="text-xl font-bold tabular-nums text-slate-50">{formatMetricCount(flow.sources)}</span>
        </span>
        <span className="font-semibold text-emerald-400">
          Streams <span className="text-xl font-bold tabular-nums text-slate-50">{formatMetricCount(breakdown.streams)}</span>
        </span>
        <span className="font-semibold text-violet-400">
          Destinations <span className="text-xl font-bold tabular-nums text-slate-50">{formatMetricCount(flow.destinations)}</span>
        </span>
      </div>

      {/* Node flow diagram */}
      <div ref={wrapRef} className="relative mt-2 w-full" style={{ height: FLOW_H }}>

        {/* SVG connector layer — simple bezier curves */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={containerW}
          height={FLOW_H}
          aria-hidden
          data-testid="dashboard-data-flow-connectors"
        >
          {/* Left curves: source node → hub */}
          {srcItems.map((src, i) => {
            const srcCY = srcYs[i] + FLOW_ITEM_H / 2
            const color = FLOW_SRC_COLORS[i % FLOW_SRC_COLORS.length]
            return (
              <g key={src.label}>
                <path
                  d={flowCurvePath(lineSrcX, srcCY, hubLeft, hubCY)}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeOpacity={0.5}
                />
                <circle cx={lineSrcX} cy={srcCY} r={2.5} fill={color} fillOpacity={0.7} />
              </g>
            )
          })}

          {/* Right curves: hub → destination node */}
          {dstItems.map((dst, i) => {
            const dstCY = dstYs[i] + FLOW_ITEM_H / 2
            const color = FLOW_DST_COLORS[i % FLOW_DST_COLORS.length]
            return (
              <g key={dst.label}>
                <path
                  d={flowCurvePath(hubRight, hubCY, lineDstX, dstCY)}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeOpacity={0.5}
                />
                <circle cx={lineDstX} cy={dstCY} r={2.5} fill={color} fillOpacity={0.7} />
              </g>
            )
          })}
        </svg>

        {/* Source node cards (left column) */}
        {(srcItems.length > 0 ? srcItems : [{ label: 'Sources', count: flow.sources }]).map((src, i) => {
          const Icon = FLOW_SRC_ICONS[src.label] ?? Activity
          const pct = srcItems.length > 0 ? Math.round((src.count / totalSrc) * 100) : 100
          const topY = srcYs[i] ?? 0
          return (
            <div
              key={src.label}
              className="absolute flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/5 px-2 py-1"
              style={{ left: 0, top: topY, width: FLOW_CAT_W, height: FLOW_ITEM_H }}
            >
              <span className="shrink-0 rounded-md bg-sky-500/15 p-1">
                <Icon className="h-3.5 w-3.5 text-sky-400" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold leading-tight text-sky-300/90">{src.label}</p>
                <p className="text-[11px] tabular-nums leading-tight text-slate-400">
                  <span className="font-bold text-sky-200">{src.count}</span>
                  <span className="ml-1 text-[10px] text-slate-500">{pct}%</span>
                </p>
              </div>
            </div>
          )
        })}

        {/* Stream Runtime hub (centered) */}
        <div
          className="absolute flex flex-col items-center"
          data-testid="dashboard-data-flow-streams-pill"
          style={{ left: hubCX - 34, top: hubCY - 40, width: 68 }}
        >
          <div className="flex h-[60px] w-[60px] items-center justify-center rounded-full border border-emerald-500/55 bg-emerald-500/20 shadow-[0_0_18px_-4px_rgba(52,211,153,0.6)]">
            <Activity className="h-5 w-5 text-emerald-100" aria-hidden />
          </div>
          <p className="mt-0.5 text-[10px] font-semibold leading-tight text-emerald-300/90">Streams</p>
          <p className="text-lg font-bold tabular-nums leading-tight text-slate-50">{formatMetricCount(breakdown.streams)}</p>
        </div>

        {/* Destination node cards (right column) */}
        {(dstItems.length > 0 ? dstItems : [{ label: 'Destinations', count: flow.destinations }]).map((dst, i) => {
          const Icon = FLOW_DST_ICONS[dst.label] ?? Activity
          const pct = dstItems.length > 0 ? Math.round((dst.count / totalDst) * 100) : 100
          const topY = dstYs[i] ?? 0
          return (
            <div
              key={dst.label}
              className="absolute flex items-center justify-end gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/5 px-2 py-1"
              style={{ right: 0, top: topY, width: FLOW_CAT_W, height: FLOW_ITEM_H }}
            >
              <div className="min-w-0 text-right">
                <p className="truncate text-[11px] font-semibold leading-tight text-violet-300/90">{dst.label}</p>
                <p className="text-[11px] tabular-nums leading-tight text-slate-400">
                  <span className="font-bold text-violet-200">{dst.count}</span>
                  <span className="ml-1 text-[10px] text-slate-500">{pct}%</span>
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-violet-500/15 p-1">
                <Icon className="h-3.5 w-3.5 text-violet-400" aria-hidden />
              </span>
            </div>
          )
        })}
      </div>

      {/* Stream status row */}
      <div className="mt-2 flex justify-center gap-5 border-t border-slate-700/30 pt-2">
        <span className="inline-flex items-center gap-1.5 text-[11px]">
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
          <span className="tabular-nums font-bold text-emerald-400">{streamsStatus.running}</span>
          <span className="text-slate-500">Running</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px]">
          <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden />
          <span className="tabular-nums font-bold text-amber-400">{streamsStatus.warning}</span>
          <span className="text-slate-500">Warning</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px]">
          <span className="h-2 w-2 rounded-full bg-slate-500" aria-hidden />
          <span className="tabular-nums font-bold text-slate-400">{streamsStatus.stopped}</span>
          <span className="text-slate-500">Stopped</span>
        </span>
      </div>
    </section>
  )
}

export function EventsOverTimeChart({
  series,
  windowLabel,
  loading,
  className,
}: {
  series: TrafficChartPoint[]
  windowLabel: string
  loading: boolean
  className?: string
}) {
  const empty = series.length === 0 || series.every((p) => p.ingested + p.delivered + p.failed === 0)

  return (
    <section
      aria-label="Events over time"
      data-testid="dashboard-events-over-time"
      className={cn(dashboardCardClass, className, loading && 'opacity-80')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Events Over Time</h2>
        <span className="text-[10px] font-medium text-slate-500 dark:text-gdc-muted">{windowLabel}</span>
      </div>
      <div className="mt-2 h-[13rem] w-full">
        {empty && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <p className="text-[12px] font-semibold text-slate-400">No event data</p>
            <p className="text-[10px] text-slate-500 dark:text-gdc-muted">No events recorded in this window.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
              <defs>
                <linearGradient id="dash-ingested-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="dash-delivered-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="dash-failed-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f87171" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#f87171" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#94a3b8' }}
              />
              <Area type="monotone" dataKey="ingested" name="Ingested" stroke="#38bdf8" strokeWidth={2.5} fill="url(#dash-ingested-fill)" dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="delivered" name="Delivered" stroke="#34d399" strokeWidth={2.5} fill="url(#dash-delivered-fill)" dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="failed" name="Failed" stroke="#f87171" strokeWidth={2} fill="url(#dash-failed-fill)" dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500 dark:text-gdc-muted">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-400" /> Ingested</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Delivered</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-400" /> Failed</span>
      </div>
    </section>
  )
}

function DonutPanel({
  title,
  totalLabel,
  slices,
  testId,
  footer,
}: {
  title: string
  totalLabel: string
  slices: Array<{ name: string; value: number; color: string; pct: number }>
  testId: string
  footer?: ReactNode
}) {
  const total = slices.reduce((a, s) => a + s.value, 0)

  return (
    <section aria-label={title} data-testid={testId} className={dashboardCardClass}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        {footer}
      </div>
      <div className="mt-2 flex items-center gap-4">
        <div className="relative h-[8.5rem] w-[8.5rem] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={slices} dataKey="value" innerRadius={38} outerRadius={56} paddingAngle={2} stroke="none">
                {slices.map((s) => (
                  <Cell key={s.name} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value, name) => [`${value}`, String(name)]}
                contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <p className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{formatMetricCount(total)}</p>
            <p className="text-[9px] uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{totalLabel}</p>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {slices.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-1.5 text-[11px]">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-slate-700 dark:text-slate-200">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
                <span className="truncate">{s.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-slate-500 dark:text-gdc-muted">
                {formatMetricCount(s.value)} <span className="text-[9px]">({s.pct.toFixed(1)}%)</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export function StreamsStatusDonut({ status }: { status: StreamsOperationalStatus }) {
  const slices = operationalStatusDonutSlices(status)
  return (
    <DonutPanel
      title="Streams by Status"
      totalLabel="Total"
      slices={slices}
      testId="dashboard-streams-by-status"
      footer={
        <Link to={NAV_PATH.streams} className="text-[10px] font-semibold text-violet-600 hover:underline dark:text-violet-300">
          View all streams →
        </Link>
      }
    />
  )
}

export function TopSourcesByIngestRatePanel({ sources, className }: { sources: TopSourceIngestItem[]; className?: string }) {
  const max = Math.max(1, ...sources.map((s) => s.rateEps))

  const barGradients = [
    'from-teal-600 to-teal-400',
    'from-sky-600 to-sky-400',
    'from-emerald-600 to-emerald-400',
    'from-orange-600 to-orange-400',
    'from-violet-600 to-violet-400',
  ]

  return (
    <section aria-label="Top sources by ingest rate" data-testid="dashboard-top-sources" className={cn(dashboardCardClass, className)}>
      <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Top Sources</h2>
      <p className="text-[10px] text-slate-500 dark:text-gdc-muted">by ingest rate</p>

      {sources.length === 0 ? (
        <p className="mt-4 text-[11px] text-slate-500 dark:text-gdc-muted">No sources configured.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {sources.map((source, idx) => {
            const pct = (100 * source.rateEps) / max
            const noThroughput = source.rateEps === 0
            const rateLabel = noThroughput
              ? 'No recent throughput'
              : source.rateEps >= 1000
                ? `${formatMetricCount(Math.round(source.rateEps))}/s`
                : `${formatThroughputEps(source.rateEps)}/s`
            const barGrad = barGradients[idx % barGradients.length]
            return (
              <li key={source.name}>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate font-medium text-slate-200">{source.name}</span>
                  <span className={cn('shrink-0 tabular-nums', noThroughput ? 'text-[10px] italic text-slate-500' : 'font-semibold text-sky-400')}>
                    {rateLabel}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800/70">
                  <div
                    className={cn('h-full rounded-full bg-gradient-to-r transition-all', noThroughput ? 'opacity-20' : '', barGrad)}
                    style={{ width: `${noThroughput ? 4 : Math.max(8, pct)}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function fmtAlertTime(iso: string): string {
  try {
    const d = new Date(iso)
    const diffMin = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60_000))
    if (diffMin < 1) return 'just now'
    if (diffMin < 60) return `${diffMin} min ago`
    return `${Math.floor(diffMin / 60)}h ago`
  } catch {
    return iso
  }
}

export function RecentAlertsPanel({
  summary,
  items,
  alertsFailed,
  className,
}: {
  summary: RecentAlertsSummary
  items: RuntimeAlertSummaryItem[]
  /** When true, alerts API call failed — show unavailable state instead of 0 alerts. */
  alertsFailed?: boolean
  className?: string
}) {
  const top = items.slice(0, 4)

  return (
    <section aria-label="Recent alerts" data-testid="dashboard-recent-alerts" className={cn(dashboardCardClass, className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Recent Alerts</h2>
        <Link to={NAV_PATH.streams} className="text-[11px] font-semibold text-violet-400 hover:underline">
          View all →
        </Link>
      </div>

      {/* Alert cards */}
      {summary.hasAlerts ? (
        <ul className="mt-3 space-y-2">
          {top.map((item, i) => {
            const isCritical = item.severity === 'ERROR'
            return (
              <li key={`${item.stream_id}-${item.latest_occurrence}-${i}`}>
                <div
                  className={cn(
                    'rounded-lg border px-3 py-2.5',
                    isCritical
                      ? 'border-red-500/30 bg-red-500/5'
                      : 'border-amber-500/30 bg-amber-500/5',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {/* Severity + Stream name row */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide',
                            isCritical
                              ? 'bg-red-500/20 text-red-300'
                              : 'bg-amber-500/20 text-amber-300',
                          )}
                        >
                          {isCritical ? 'Critical' : 'Warning'}
                        </span>
                        <p className="truncate text-[12px] font-semibold text-slate-100">{item.stream_name}</p>
                      </div>
                      {/* Summary / connector line */}
                      {item.connector_name ? (
                        <p className="mt-1 truncate text-[11px] text-slate-400">{item.connector_name}</p>
                      ) : null}
                      {/* Timestamp + event count */}
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        {fmtAlertTime(item.latest_occurrence)}
                        <span className="mx-1 text-slate-700">·</span>
                        <span className="tabular-nums">{item.count}</span> {item.count === 1 ? 'event' : 'events'}
                      </p>
                    </div>
                    {/* Investigate button */}
                    <Link
                      to={recentAlertTargetPath(item)}
                      data-testid={`dashboard-recent-alert-link-${item.stream_id}`}
                      className="shrink-0 self-start rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[10px] font-semibold text-sky-300 transition hover:bg-sky-500/20"
                    >
                      Investigate
                    </Link>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}

      {/* Empty state */}
      {!summary.hasAlerts && !alertsFailed ? (
        <div className="mt-3 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-700/30 bg-slate-900/10 py-6 text-center">
          <CheckCircle2 className="h-5 w-5 text-slate-600" aria-hidden />
          <p className="text-[12px] font-semibold text-slate-400">No alerts in this window</p>
          <p className="text-[10px] text-slate-500 dark:text-gdc-muted">All streams operating within normal parameters.</p>
        </div>
      ) : null}

      {/* API failure state */}
      {alertsFailed ? (
        <div className="mt-3 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/5 py-6 text-center">
          <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
          <p className="text-[12px] font-semibold text-amber-400">Unavailable</p>
          <p className="text-[10px] text-slate-500 dark:text-gdc-muted">Alert data could not be loaded</p>
        </div>
      ) : null}
    </section>
  )
}

function systemHealthStatusLabel(status: SystemHealthItem['status']): string {
  if (status === 'healthy') return 'Healthy'
  if (status === 'warning') return 'Warning'
  return 'Critical'
}

function SystemHealthStatusIcon({ status }: { status: SystemHealthItem['status'] }) {
  const healthy = status === 'healthy'
  const warning = status === 'warning'

  return (
    <span
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-full',
        healthy && 'bg-emerald-500/20',
        warning && 'bg-amber-500/20',
        !healthy && !warning && 'bg-red-500/20',
      )}
      aria-hidden
    >
      {healthy ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
      ) : warning ? (
        <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-red-400" />
      )}
    </span>
  )
}

const SYSTEM_HEALTH_HREF: Record<string, string> = {
  connectors: '/connectors',
  streams: '/streams',
  destinations: '/destinations',
  routes: '/routes',
  workers: '/admin',
  checkpoint: '/streams?filter=checkpoint-lag',
}

export function SystemHealthBar({ items }: { items: SystemHealthItem[] }) {
  return (
    <section
      aria-label="System health"
      data-testid="dashboard-system-health"
      className="rounded-xl border border-slate-200/80 bg-white px-4 py-3 dark:border-[rgba(120,150,220,0.2)] dark:bg-[#111827]/95 dark:ring-1 dark:ring-[rgba(120,150,220,0.1)]"
    >
      <div className="flex items-center gap-4 sm:gap-6">
        <p className="shrink-0 text-[12px] font-semibold text-slate-400">System Health</p>
        <div className="flex min-w-0 flex-1 items-start justify-between gap-1 sm:gap-2">
          {items.map((item) => {
            const healthy = item.status === 'healthy'
            const warning = item.status === 'warning'
            const href = SYSTEM_HEALTH_HREF[item.id] ?? '/streams'
            return (
              <Link
                key={item.id}
                to={href}
                className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg p-1 text-center transition hover:bg-slate-800/30"
                data-testid={`dashboard-system-health-${item.id}`}
              >
                <span className="text-[11px] font-medium text-slate-200">{item.label}</span>
                <SystemHealthStatusIcon status={item.status} />
                <span
                  className={cn(
                    'text-[11px] font-semibold',
                    healthy ? 'text-emerald-400' : warning ? 'text-amber-400' : 'text-red-400',
                  )}
                >
                  {systemHealthStatusLabel(item.status)}
                </span>
                {item.sublabel ? (
                  <span className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted">{item.sublabel}</span>
                ) : null}
              </Link>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── Stream Health Matrix ───────────────────────────────────────────────────

const MATRIX_CELL_ICON: Record<import('./dashboard-charter-metrics').StreamHealthMatrixCellStatus, typeof Layers> = {
  healthy: CheckCircle2,
  warning: AlertTriangle,
  failed: XCircle,
  'no-data': Minus,
  'not-connected': Minus,
}

const MATRIX_CELL_CLASS: Record<import('./dashboard-charter-metrics').StreamHealthMatrixCellStatus, string> = {
  healthy: 'text-emerald-400 bg-emerald-500/10',
  warning: 'text-amber-400 bg-amber-500/10',
  failed: 'text-red-400 bg-red-500/10',
  'no-data': 'text-slate-500 bg-slate-700/20',
  'not-connected': 'text-slate-700 bg-transparent',
}

export function StreamHealthMatrix({
  matrix,
  className,
}: {
  matrix: StreamHealthMatrixData
  className?: string
}) {
  if (matrix.rows.length === 0) {
    return (
      <section
        aria-label="Stream Health Matrix"
        data-testid="dashboard-stream-health-matrix"
        className={cn(dashboardCardClass, className)}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Stream Health Matrix</h2>
        </div>
        <div className="mt-4 flex flex-col items-center justify-center gap-1.5 py-6 text-center">
          <p className="text-[12px] font-semibold text-slate-400">No delivery path data</p>
          <p className="text-[10px] text-slate-500">Configure streams and destinations to see the matrix.</p>
        </div>
      </section>
    )
  }

  const showViewAll = matrix.totalRows > matrix.rows.length || matrix.totalColumns > matrix.columns.length

  return (
    <section
      aria-label="Stream Health Matrix"
      data-testid="dashboard-stream-health-matrix"
      className={cn(dashboardCardClass, className)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Stream Health Matrix</h2>
        <div className="flex items-center gap-2">
          {showViewAll ? (
            <Link to={NAV_PATH.streams} className="text-[11px] font-semibold text-violet-400 hover:underline">
              View all →
            </Link>
          ) : null}
        </div>
      </div>
      <p className="text-[10px] text-slate-500 dark:text-gdc-muted">Source / Destination delivery status</p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[320px] text-[11px]">
          <thead>
            <tr>
              <th className="pb-2 pr-3 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Source / Destination
              </th>
              {matrix.columns.map((col) => (
                <th key={col.id} className="pb-2 text-center text-[10px] font-semibold leading-tight text-slate-400">
                  <Link
                    to={destinationDetailPath(String(col.id))}
                    className="truncate hover:text-violet-400"
                    title={col.name}
                  >
                    {col.name.length > 10 ? `${col.name.slice(0, 10)}…` : col.name}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {matrix.rows.map((row) => (
              <tr key={row.label} className="group">
                <td className="py-1.5 pr-3">
                  <Link
                    to={streamsExpandedGroupPath(row.label)}
                    className="flex items-baseline gap-1.5 hover:text-violet-300"
                  >
                    <span className="truncate font-medium text-slate-200">{row.label}</span>
                    <span className="shrink-0 text-[10px] text-slate-500">{row.streamCount}</span>
                  </Link>
                </td>
                {row.cells.map((cell, ci) => {
                  const CellIcon = MATRIX_CELL_ICON[cell.status]
                  const colDest = matrix.columns[ci]
                  return (
                    <td key={ci} className="py-1.5 text-center">
                      {colDest ? (
                        <Link
                          to={destinationDetailPath(String(colDest.id))}
                          title={`${row.label} → ${colDest.name}: ${cell.status}`}
                          className={cn(
                            'inline-flex h-6 w-6 items-center justify-center rounded',
                            MATRIX_CELL_CLASS[cell.status],
                          )}
                        >
                          <CellIcon className="h-3.5 w-3.5" aria-hidden />
                        </Link>
                      ) : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Total streams row */}
      <div className="mt-3 border-t border-slate-700/30 pt-2">
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden /> Healthy</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden /> Warning</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-400" aria-hidden /> Failed</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-600" aria-hidden /> No data / Not connected</span>
        </div>
      </div>
    </section>
  )
}

// ── Operational Problems List (with timeline indicators) ───────────────────

function problemNavPath(problem: OperationalProblemDisplay): string {
  if (problem.streamId != null) return streamRuntimePath(String(problem.streamId))
  if (problem.destinationId != null) return destinationDetailPath(String(problem.destinationId))
  return NAV_PATH.streams
}

function IssueTimelineBar({ lastSeenAt }: { lastSeenAt: string | null }) {
  if (!lastSeenAt) {
    return <div className="h-1.5 w-full rounded-full bg-slate-800/60" />
  }
  const now = Date.now()
  const windowMs = 24 * 60 * 60 * 1000
  const seenMs = new Date(lastSeenAt).getTime()
  const positionPct = Math.min(100, Math.max(0, ((seenMs - (now - windowMs)) / windowMs) * 100))
  return (
    <div className="relative h-1.5 w-full overflow-visible rounded-full bg-slate-800/60">
      <div
        className="absolute top-0 h-1.5 rounded-full bg-slate-700/80"
        style={{ width: `${positionPct}%` }}
      />
      <div
        className="absolute -top-0.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-slate-900 bg-amber-400"
        style={{ left: `${positionPct}%` }}
        aria-hidden
      />
    </div>
  )
}

export function OperationalProblemsList({
  problems,
  className,
}: {
  problems: OperationalProblemDisplay[]
  className?: string
}) {
  if (problems.length === 0) {
    return (
      <section
        aria-label="Issue details"
        data-testid="dashboard-operational-problem-details"
        className={cn(dashboardCardClass, className)}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Issue details</h2>
        </div>
        <div className="mt-4 flex flex-col items-center justify-center gap-1.5 py-4 text-center">
          <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden />
          <p className="text-[12px] font-semibold text-emerald-400">No open issues</p>
          <p className="text-[10px] text-slate-500">Drill-down detail appears here when problems are detected.</p>
        </div>
      </section>
    )
  }

  return (
    <section
      aria-label="Issue details"
      data-testid="dashboard-operational-problem-details"
      className={cn(dashboardCardClass, className)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Issue details</h2>
        <Link to={NAV_PATH.streams} className="text-[11px] font-semibold text-violet-400 hover:underline">
          View all →
        </Link>
      </div>
      <ul className="mt-3 space-y-3">
        {problems.map((problem) => {
          const isCritical = problem.severity === 'critical'
          const timeAgo = fmtTimeAgo(problem.lastSeenAt)
          return (
            <li key={problem.id}>
              <Link
                to={problemNavPath(problem)}
                data-testid={`dashboard-problem-${problem.id}`}
                className={cn(
                  'block rounded-lg border px-3 py-2 transition hover:brightness-110',
                  isCritical ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5',
                )}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-0.5 h-2 w-2 shrink-0 rounded-full',
                      isCritical ? 'bg-red-400 shadow-[0_0_6px_1px_rgba(248,113,113,0.6)]' : 'bg-amber-400',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold text-slate-100">{problem.title}</p>
                    {timeAgo ? (
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        Last seen: {timeAgo}
                      </p>
                    ) : null}
                    <div className="mt-2">
                      <IssueTimelineBar lastSeenAt={problem.lastSeenAt} />
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** @deprecated Use StreamsStatusDonut with operational status instead. */
export function StreamGroupHealthPanel({
  groupHealth,
}: {
  groupHealth: import('./dashboard-charter-metrics').StreamGroupHealthCounts
}) {
  const slices = donutSlicesFromCounts(groupHealth.healthy, groupHealth.warning, groupHealth.critical)
  return (
    <DonutPanel
      title="Stream group health"
      totalLabel="Groups"
      slices={slices}
      testId="dashboard-stream-group-health"
      footer={
        <Link to={NAV_PATH.streams} className="text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-300">
          View all streams →
        </Link>
      }
    />
  )
}

/** @deprecated Removed from main dashboard layout. */
export function TrafficOverviewPanel({
  traffic,
  series,
  loading,
}: {
  traffic: import('./dashboard-charter-metrics').TrafficOverviewMetrics
  series: TrafficChartPoint[]
  loading: boolean
}) {
  const rate = traffic.deliverySuccessRatePct ?? 0
  const empty = series.length === 0

  return (
    <section aria-label="Traffic overview" data-testid="dashboard-traffic-overview" className={cn(dashboardCardClass, loading && 'opacity-80')}>
      <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Traffic overview</h2>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">Window {traffic.windowLabel}</p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {(
          [
            ['Incoming', formatMetricCount(traffic.incomingEvents), 'text-sky-400'],
            ['Outgoing', formatMetricCount(traffic.outgoingEvents), 'text-emerald-400'],
            ['Success', formatSuccessRate(traffic.deliverySuccessRatePct), rate >= 99 ? 'text-teal-400' : 'text-amber-300'],
          ] as const
        ).map(([label, value, color]) => (
          <div key={label} className="rounded-lg border border-slate-200/60 bg-slate-50/50 px-2 py-2 dark:border-gdc-border dark:bg-gdc-section/60">
            <p className="text-[10px] font-semibold uppercase text-slate-500 dark:text-gdc-muted">{label}</p>
            <p className={cn('mt-0.5 text-lg font-bold tabular-nums', color)}>{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 h-[160px] w-full">
        {empty && !loading ? (
          <div className="flex h-full items-center justify-center text-[12px] text-slate-500 dark:text-gdc-muted">No traffic trend data.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} width={32} />
              <Line type="monotone" dataKey="ingested" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="delivered" stroke="#34d399" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  )
}

const ISSUE_ROW_STYLES = {
  'no-data': {
    bar: 'bg-red-500',
    count: 'text-red-400',
    chip: 'border-red-500/40 bg-red-500/10 text-red-300',
    icon: Flame,
    iconClass: 'text-red-400',
  },
  'low-volume': {
    bar: 'bg-orange-500',
    count: 'text-orange-400',
    chip: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
    icon: Zap,
    iconClass: 'text-orange-400',
  },
  'schema-drift': {
    bar: 'bg-amber-500',
    count: 'text-amber-400',
    chip: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    icon: AlertTriangle,
    iconClass: 'text-amber-400',
  },
  'dest-capacity': {
    bar: 'bg-sky-500',
    count: 'text-sky-400',
    chip: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    icon: Database,
    iconClass: 'text-sky-400',
  },
} as const

type IssueKey = keyof typeof ISSUE_ROW_STYLES

export function OperationalStatusChips({
  issues,
}: {
  issues: import('./dashboard-charter-metrics').OperationalIssueCounts
}) {
  const chips: Array<{ key: IssueKey; label: string; count: number | null }> = [
    { key: 'no-data', label: 'No Data Streams', count: issues.noDataStreams },
    { key: 'low-volume', label: 'Low Volume Streams', count: issues.lowVolumeStreams },
    { key: 'schema-drift', label: 'Schema Drift', count: issues.schemaDriftCount },
    { key: 'dest-capacity', label: 'Destination Capacity', count: issues.destinationCapacityWarnings },
  ]

  return (
    <div
      aria-label="Operational status chips"
      data-testid="dashboard-status-chips"
      className="flex flex-wrap gap-2"
    >
      {chips.map(({ key, label, count }) => {
        const style = ISSUE_ROW_STYLES[key]
        const Icon = style.icon
        const n = count ?? 0
        return (
          <Link
            key={key}
            to={NAV_PATH.streams}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition hover:brightness-110',
              style.chip,
            )}
          >
            <Icon className={cn('h-3.5 w-3.5 shrink-0', style.iconClass)} aria-hidden />
            <span>{label}</span>
            <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/20 text-[11px] font-bold tabular-nums')}>
              {n}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

const ISSUE_DRILLDOWN_HREF: Record<IssueKey, string> = {
  'no-data': '/streams?filter=no-data',
  'low-volume': '/streams?filter=low-volume',
  'schema-drift': '/streams?filter=schema-drift',
  'dest-capacity': '/destinations?filter=warning',
}

/** Operational issue counts surfaced on the main dashboard (existing APIs only). */
export function OperationalIssuesPanel({
  issues,
  className,
}: {
  issues: import('./dashboard-charter-metrics').OperationalIssueCounts
  className?: string
}) {
  const rows: Array<{ key: IssueKey; label: string; count: number | null; testId: string }> = [
    { key: 'no-data', label: 'No data streams', count: issues.noDataStreams, testId: 'dashboard-issue-no-data' },
    { key: 'low-volume', label: 'Low volume streams', count: issues.lowVolumeStreams, testId: 'dashboard-issue-low-volume' },
    { key: 'schema-drift', label: 'Schema drift', count: issues.schemaDriftCount, testId: 'dashboard-issue-schema-drift' },
    { key: 'dest-capacity', label: 'Destination capacity', count: issues.destinationCapacityWarnings, testId: 'dashboard-issue-destination-capacity' },
  ]
  const max = Math.max(1, ...rows.map((r) => r.count ?? 0))

  return (
    <section
      aria-label="Operational issues"
      data-testid="dashboard-operational-issues-panel"
      className={cn(dashboardCardClass, className)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Operational Issues</h2>
        <Link to={NAV_PATH.streams} className="text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-300">
          View all issues
        </Link>
      </div>
      <ul className="mt-4 space-y-3">
        {rows.map((row) => {
          const n = row.count ?? 0
          const pct = (100 * n) / max
          const hot = n > 0
          const style = ISSUE_ROW_STYLES[row.key]
          return (
            <li key={row.testId}>
              <Link
                to={ISSUE_DRILLDOWN_HREF[row.key]}
                data-testid={row.testId}
                className="block rounded-lg border border-transparent p-1 transition hover:border-violet-500/30"
              >
                <div className="flex items-center justify-between gap-2 text-[12px]">
                  <span className={cn('font-medium', hot ? 'text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-gdc-muted')}>{row.label}</span>
                  <span className={cn('text-lg font-bold tabular-nums', hot ? style.count : 'text-slate-500')}>{formatMetricCount(n)}</span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800">
                  <div
                    className={cn('h-full rounded-full transition-all', hot ? style.bar : 'bg-slate-500/40')}
                    style={{ width: `${Math.max(hot ? 8 : 0, pct)}%` }}
                  />
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

