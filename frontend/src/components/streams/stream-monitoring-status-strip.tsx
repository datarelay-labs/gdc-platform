import { Activity, Clock, Send, TrendingUp } from 'lucide-react'
import { cn } from '../../lib/utils'
import { formatOperationalPercent } from '../../lib/observability-format'
import { eventsPerSecFromWindow, formatEventsPerSecRate } from '../../lib/stream-console-metrics'
import type { StreamRuntimeStatus } from '../../api/streamRows'
import type { StreamRuntimeMetricsResponse } from '../../api/types/gdcApi'

function MiniSparkline({ values, className }: { values: readonly number[]; className?: string }) {
  const w = 56
  const h = 20
  const padX = 1
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
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn('shrink-0', className)} aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" points={pts.join(' ')} />
    </svg>
  )
}

function MetricCard({
  label,
  value,
  subValue,
  icon: Icon,
  iconClassName,
  sparkline,
  sparklineClassName,
}: {
  label: string
  value: string
  subValue?: string | null
  icon: typeof Activity
  iconClassName: string
  sparkline?: readonly number[]
  sparklineClassName?: string
}) {
  return (
    <div className="flex min-h-[5.5rem] flex-col rounded-xl border border-slate-200/70 bg-white/90 p-4 shadow-sm dark:border-gdc-border/90 dark:bg-gdc-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-50">{value}</p>
          {subValue ? <p className="mt-0.5 text-[10px] tabular-nums text-slate-500 dark:text-gdc-muted">{subValue}</p> : null}
        </div>
        <span className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconClassName)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
      {sparkline ? (
        <div className="mt-2 flex justify-end">
          <MiniSparkline values={sparkline} className={sparklineClassName} />
        </div>
      ) : null}
    </div>
  )
}

export type StreamMonitoringStatusStripProps = {
  displayStatus: StreamRuntimeStatus
  backendStreamId: number | undefined
  hasRuntimeObsApi: boolean
  backendStatusLabel?: string | null
  healthScore?: number | null
  events1h: number | null
  eventsSparkline: readonly number[]
  deliveryPct: number | null
  deliveryLabel: string | null
  routesTotal: number | null
  routesOk: number | null
  routesErr: number | null
  showCheckpointObservability: boolean
  runtimeMetrics: StreamRuntimeMetricsResponse | null
  failedLastHour: number | null
  errorRate: number | null
  lastErrorAt: string | null
  lastEventRelative?: string | null
  windowSeconds?: number | null
  onExpandObservability?: () => void
}

export function StreamMonitoringStatusStrip({
  events1h,
  eventsSparkline,
  deliveryPct,
  runtimeMetrics,
  lastEventRelative,
  lastErrorAt,
  windowSeconds,
}: StreamMonitoringStatusStripProps) {
  const winSec = Math.max(
    1,
    windowSeconds ?? runtimeMetrics?.metrics_window_seconds ?? 3600,
  )
  const eventsHour = events1h ?? runtimeMetrics?.kpis.events_last_hour ?? 0
  const deliveredHour = runtimeMetrics?.kpis.delivered_last_hour ?? 0
  const failedHour = runtimeMetrics?.kpis.failed_last_hour ?? 0
  const hasDeliveryOutcomes = deliveredHour + failedHour > 0
  const rawSuccessRate = deliveryPct ?? runtimeMetrics?.kpis.delivery_success_rate ?? null
  const successRate = hasDeliveryOutcomes && rawSuccessRate != null ? rawSuccessRate : null

  const ingestLabel =
    eventsHour > 0
      ? `${formatEventsPerSecRate(eventsHour, winSec).replace(' /s', '')} events/sec`
      : '0 events/sec'
  const deliveryLabel =
    hasDeliveryOutcomes || deliveredHour > 0
      ? `${formatEventsPerSecRate(deliveredHour, winSec).replace(' /s', '')} events/sec`
      : '0 events/sec'
  const successLabel = successRate != null ? formatOperationalPercent(successRate) : '—'
  const lastEvent = lastEventRelative ?? '—'
  const lastEventAt = runtimeMetrics?.stream.last_run_at ?? lastErrorAt ?? null
  const lastEventSub = lastEventAt ? lastEventAt.slice(0, 19).replace('T', ' ') : null

  const ingestSpark = eventsSparkline.length ? eventsSparkline : [eventsPerSecFromWindow(eventsHour, winSec)]
  const deliverySpark = ingestSpark.map((v) => (successRate != null ? (v * successRate) / 100 : 0))
  const successSpark =
    successRate != null
      ? [successRate, successRate, successRate, successRate, successRate, successRate, successRate]
      : []

  return (
    <section
      aria-label="Stream monitoring status"
      data-testid="stream-monitoring-status-strip"
      className="grid grid-cols-2 gap-3 xl:grid-cols-4"
    >
      <MetricCard
        label="Ingest Rate"
        value={ingestLabel}
        icon={Activity}
        iconClassName="bg-sky-500/15 text-sky-600 dark:bg-sky-500/20 dark:text-sky-400"
        sparkline={ingestSpark}
        sparklineClassName="text-sky-500 dark:text-sky-400"
      />
      <MetricCard
        label="Delivery Rate"
        value={deliveryLabel}
        icon={Send}
        iconClassName="bg-violet-500/15 text-violet-600 dark:bg-violet-500/20 dark:text-violet-400"
        sparkline={deliverySpark}
        sparklineClassName="text-violet-500 dark:text-violet-400"
      />
      <MetricCard
        label="Success Rate"
        value={successLabel}
        icon={TrendingUp}
        iconClassName="bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
        sparkline={successSpark}
        sparklineClassName="text-emerald-500 dark:text-emerald-400"
      />
      <MetricCard
        label="Last Event"
        value={lastEvent}
        subValue={lastEventSub}
        icon={Clock}
        iconClassName="bg-slate-500/15 text-slate-600 dark:bg-slate-500/20 dark:text-slate-400"
      />
    </section>
  )
}
