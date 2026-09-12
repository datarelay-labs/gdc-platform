/**
 * Lightweight SVG chart primitives for the Destinations dashboard.
 * No external chart library — pure SVG.
 */

import { cn } from '../../lib/utils'
import { formatOperationalPercent } from '../../lib/observability-format'

// ─── Capacity config types and helpers ────────────────────────────────────────

export type CapacityThresholds = {
  /** Warning starts at this percentage (1–99) */
  warningPct: number
  /** Critical starts at this percentage (1–100) */
  criticalPct: number
}

export const DEFAULT_CAPACITY_THRESHOLDS: CapacityThresholds = {
  warningPct: 70,
  criticalPct: 85,
}

export type CapacityConfig = {
  limitEps: number | null
  thresholds: CapacityThresholds
}

/** Extract capacity limit + thresholds from a destination row's rate_limit_json.
 * Read priority for limit: capacity_limit_eps → eps_limit → limit_eps → null
 */
export function extractCapacityConfig(row: {
  rate_limit_json?: Record<string, unknown> | null | undefined
}): CapacityConfig {
  const rl = row.rate_limit_json as Record<string, unknown> | null | undefined
  let limitEps: number | null = null
  if (rl && typeof rl === 'object') {
    const eps = rl.capacity_limit_eps ?? rl.eps_limit ?? rl.limit_eps
    if (typeof eps === 'number' && eps > 0) limitEps = eps
  }
  const rawWarning =
    rl && typeof rl.capacity_warning_threshold_pct === 'number'
      ? (rl.capacity_warning_threshold_pct as number)
      : DEFAULT_CAPACITY_THRESHOLDS.warningPct
  const rawCritical =
    rl && typeof rl.capacity_critical_threshold_pct === 'number'
      ? (rl.capacity_critical_threshold_pct as number)
      : DEFAULT_CAPACITY_THRESHOLDS.criticalPct
  return {
    limitEps,
    thresholds: {
      warningPct: Math.max(1, Math.min(99, rawWarning)),
      criticalPct: Math.max(1, Math.min(100, rawCritical)),
    },
  }
}

/** Backward-compat helper — prefer extractCapacityConfig().limitEps */
export function extractCapacityLimitEps(row: {
  rate_limit_json?: Record<string, unknown> | null | undefined
}): number | null {
  return extractCapacityConfig(row).limitEps
}

// ─── Color helpers ────────────────────────────────────────────────────────────

export function capacityColor(
  pct: number | null,
  thresholds: CapacityThresholds = DEFAULT_CAPACITY_THRESHOLDS,
): string {
  if (pct == null) return '#64748b'
  if (pct >= thresholds.criticalPct) return '#ef4444'
  if (pct >= thresholds.warningPct) return '#f59e0b'
  return '#10b981'
}

export function successRateColor(pct: number | null): string {
  if (pct == null) return '#64748b'
  if (pct < 90) return '#ef4444'
  if (pct < 98) return '#f59e0b'
  return '#10b981'
}

export function queueDepthColor(depth: number, threshold = 100): string {
  if (depth === 0) return '#10b981'
  if (depth > threshold) return '#ef4444'
  return '#f59e0b'
}

// ─── Semi-circle Gauge ────────────────────────────────────────────────────────

type SemiGaugeProps = {
  /** 0–100, or null for "no data" */
  pct: number | null
  size?: number
  strokeWidth?: number
  /** Extra CSS class for outer <svg> */
  className?: string
  /** Whether to show the centre label */
  showLabel?: boolean
  /** Override label (default: formatted pct) */
  label?: string
  thresholds?: CapacityThresholds
}

/**
 * A clean SaaS-style semi-circle gauge (top half of a circle).
 * Arc sweeps from 9 o'clock to 3 o'clock (left → right, 180°).
 */
export function SemiGauge({ pct, size = 80, strokeWidth = 8, className, showLabel = true, label, thresholds = DEFAULT_CAPACITY_THRESHOLDS }: SemiGaugeProps) {
  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2

  // Arc from 180° to 360° (left half → right half)
  // Start point: left end of diameter
  const startX = cx - r
  const startY = cy
  // End point: right end
  const endX = cx + r
  const endY = cy

  // Full arc path (track)
  const trackPath = `M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${endY}`

  // Active fill arc
  const clampedPct = Math.max(0, Math.min(100, pct ?? 0))
  const angleDeg = (clampedPct / 100) * 180
  const angleRad = ((angleDeg - 180) * Math.PI) / 180
  const fillEndX = cx + r * Math.cos(angleRad)
  const fillEndY = cy + r * Math.sin(angleRad)
  const largeArc = angleDeg > 180 ? 1 : 0
  const fillPath = `M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${fillEndX} ${fillEndY}`

  const color = capacityColor(pct, thresholds)
  const trackColor = 'rgba(100,116,139,0.18)'

  const displayLabel = label ?? (pct != null ? formatOperationalPercent(pct) : '—')

  return (
    <svg
      width={size}
      height={size / 2 + 12}
      viewBox={`0 0 ${size} ${size / 2 + 12}`}
      className={className}
      aria-hidden
    >
      {/* Track */}
      <path
        d={trackPath}
        fill="none"
        stroke={trackColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {/* Fill */}
      {pct != null && clampedPct > 0 && (
        <path
          d={fillPath}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      )}
      {/* Needle dot */}
      {pct != null && (
        <circle cx={fillEndX} cy={fillEndY} r={strokeWidth / 2 + 0.5} fill={color} />
      )}
      {/* Label */}
      {showLabel && (
        <text
          x={cx}
          y={cy + 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={size * 0.2}
          fontWeight="700"
          fill={color}
          className="tabular-nums"
        >
          {displayLabel}
        </text>
      )}
    </svg>
  )
}

// ─── Large Semi-circle Gauge (for drawer) ─────────────────────────────────────

type LargeSemiGaugeProps = {
  pct: number | null
  label?: string
  sublabel?: string
  thresholds?: CapacityThresholds
}

export function LargeSemiGauge({ pct, label, sublabel, thresholds = DEFAULT_CAPACITY_THRESHOLDS }: LargeSemiGaugeProps) {
  const size = 160
  const strokeWidth = 14
  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2

  const startX = cx - r
  const startY = cy
  const endX = cx + r

  const trackPath = `M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${startY}`

  const clampedPct = Math.max(0, Math.min(100, pct ?? 0))
  const angleDeg = (clampedPct / 100) * 180
  const angleRad = ((angleDeg - 180) * Math.PI) / 180
  const fillEndX = cx + r * Math.cos(angleRad)
  const fillEndY = cy + r * Math.sin(angleRad)
  const largeArc = angleDeg > 180 ? 1 : 0
  const fillPath = `M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${fillEndX} ${fillEndY}`

  const color = capacityColor(pct, thresholds)
  const trackColor = 'rgba(100,116,139,0.18)'
  const displayLabel = label ?? (pct != null ? formatOperationalPercent(pct) : '—')

  return (
    <div className="flex flex-col items-center">
      <svg
        width={size}
        height={size / 2 + 20}
        viewBox={`0 0 ${size} ${size / 2 + 20}`}
        aria-hidden
      >
        <path d={trackPath} fill="none" stroke={trackColor} strokeWidth={strokeWidth} strokeLinecap="round" />
        {pct != null && clampedPct > 0 && (
          <path d={fillPath} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
        )}
        {pct != null && (
          <circle cx={fillEndX} cy={fillEndY} r={strokeWidth / 2 + 1} fill={color} />
        )}
        <text x={cx} y={cy + 4} textAnchor="middle" dominantBaseline="middle" fontSize="26" fontWeight="700" fill={color} className="tabular-nums">
          {displayLabel}
        </text>
        {sublabel && (
          <text x={cx} y={cy + 22} textAnchor="middle" dominantBaseline="middle" fontSize="11" fill="#94a3b8">
            {sublabel}
          </text>
        )}
        <text x={cx - r} y={size / 2 + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">0%</text>
        <text x={cx + r} y={size / 2 + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">100%</text>
      </svg>
    </div>
  )
}

// ─── Capacity Gauge Preview Card (for create/edit form) ────────────────────────

type CapacityGaugePreviewCardProps = {
  warningPct: number
  criticalPct: number
  limitEps: number | null
  unlimited: boolean
}

export function CapacityGaugePreviewCard({
  warningPct,
  criticalPct,
  limitEps,
  unlimited,
}: CapacityGaugePreviewCardProps) {
  const EXAMPLE_PCT = 84
  const thresholds: CapacityThresholds = { warningPct, criticalPct }
  const fillColor = capacityColor(EXAMPLE_PCT, thresholds)

  const displayLimit = limitEps != null && limitEps > 0 ? limitEps : 5000
  const exampleEps = Math.round(displayLimit * EXAMPLE_PCT / 100)

  const size = 160
  const sw = 13
  const r = (size - sw) / 2
  const cx = size / 2
  const cy = size / 2
  const startX = cx - r
  const startY = cy

  function arcPt(pct: number) {
    const rad = ((pct / 100) * 180 - 180) * (Math.PI / 180)
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
  }

  function arcSeg(fromPct: number, toPct: number): string {
    const f = fromPct === 0 ? { x: startX, y: startY } : arcPt(fromPct)
    const t = arcPt(toPct)
    const span = ((toPct - fromPct) / 100) * 180
    return `M ${f.x} ${f.y} A ${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${t.x} ${t.y}`
  }

  const fillEnd = arcPt(EXAMPLE_PCT)
  const fillLargeArc = (EXAMPLE_PCT / 100) * 180 > 180 ? 1 : 0
  const fillPath = `M ${startX} ${startY} A ${r} ${r} 0 ${fillLargeArc} 1 ${fillEnd.x} ${fillEnd.y}`

  const warnPct = Math.max(1, Math.min(99, warningPct))
  const critPct = Math.max(warnPct + 1, Math.min(100, criticalPct))

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Capacity Gauge Preview</p>

      {unlimited ? (
        <div className="flex items-center justify-center rounded-xl border border-[#1e2a3b] bg-[#0a1628] py-10">
          <p className="text-[12px] italic text-slate-500">No capacity limit</p>
        </div>
      ) : (
        <div className="flex justify-center rounded-xl border border-[#1e2a3b] bg-[#0a1628] py-3">
          <svg
            width={size}
            height={size / 2 + 30}
            viewBox={`0 0 ${size} ${size / 2 + 30}`}
            aria-hidden
          >
            {/* Zone background arcs */}
            <path d={arcSeg(0, warnPct)} fill="none" stroke="#10b981" strokeWidth={sw} strokeLinecap="butt" opacity={0.18} />
            <path d={arcSeg(warnPct, critPct)} fill="none" stroke="#f59e0b" strokeWidth={sw} strokeLinecap="butt" opacity={0.18} />
            <path d={arcSeg(critPct, 100)} fill="none" stroke="#ef4444" strokeWidth={sw} strokeLinecap="round" opacity={0.18} />
            {/* Fill arc to example pct */}
            <path d={fillPath} fill="none" stroke={fillColor} strokeWidth={sw} strokeLinecap="round" />
            {/* Needle dot */}
            <circle cx={fillEnd.x} cy={fillEnd.y} r={sw / 2 + 1.5} fill={fillColor} />
            {/* Center labels */}
            <text x={cx} y={cy + 2} textAnchor="middle" dominantBaseline="middle" fontSize="24" fontWeight="700" fill={fillColor}>
              {EXAMPLE_PCT}%
            </text>
            <text x={cx} y={cy + 20} textAnchor="middle" dominantBaseline="middle" fontSize="9.5" fill="#94a3b8">
              {exampleEps.toLocaleString()} / {displayLimit.toLocaleString()} EPS
            </text>
            {/* End labels */}
            <text x={cx - r} y={size / 2 + 22} textAnchor="middle" fontSize="8" fill="#64748b">0%</text>
            <text x={cx + r} y={size / 2 + 22} textAnchor="middle" fontSize="8" fill="#64748b">100%</text>
          </svg>
        </div>
      )}

      {/* Legend */}
      <div className="rounded-xl border border-[#1e2a3b] bg-[#0a1628] p-3 space-y-1.5">
        {[
          { label: `0 – ${warnPct}%`, status: 'Healthy', color: '#10b981' },
          { label: `${warnPct} – ${critPct}%`, status: 'Warning', color: '#f59e0b' },
          { label: `${critPct} – 100%`, status: 'Critical', color: '#ef4444' },
          { label: '→ 90% Target', color: '#64748b' },
        ].map(({ label, status, color }) => (
          <div key={label} className="flex items-center gap-2 text-[10px]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-slate-500">{label}</span>
            {status && <span className="ml-auto text-slate-600">{status}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Donut Chart ──────────────────────────────────────────────────────────────

type DonutChartProps = {
  /** 0–100, or null */
  successPct: number | null
  size?: number
  strokeWidth?: number
  className?: string
  showLabel?: boolean
}

export function DonutChart({ successPct, size = 56, strokeWidth = 7, className, showLabel = true }: DonutChartProps) {
  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2
  const circumference = 2 * Math.PI * r

  const clampedPct = Math.max(0, Math.min(100, successPct ?? 0))
  const successArc = (clampedPct / 100) * circumference
  const failureArc = circumference - successArc

  const color = successRateColor(successPct)
  const trackColor = successPct != null ? '#ef444455' : 'rgba(100,116,139,0.18)'

  const displayLabel = successPct != null ? formatOperationalPercent(successPct) : '—'

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('rotate-[-90deg]', className)}
      aria-hidden
    >
      {/* Track (failure arc) */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={successPct != null && clampedPct < 100 ? trackColor : 'rgba(100,116,139,0.18)'}
        strokeWidth={strokeWidth}
        strokeDasharray={`${failureArc} ${successArc}`}
        strokeDashoffset={0}
      />
      {/* Success arc */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={`${successArc} ${failureArc}`}
        strokeDashoffset={0}
      />
      {/* Label (rotated back) */}
      {showLabel && (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={size * 0.2}
          fontWeight="700"
          fill={color}
          className="tabular-nums"
          style={{ transform: `rotate(90deg)`, transformOrigin: `${cx}px ${cy}px` }}
        >
          {displayLabel}
        </text>
      )}
    </svg>
  )
}

// ─── Vertical Bar Sparkline ───────────────────────────────────────────────────

type SparklineBarProps = {
  values: number[]
  width?: number
  height?: number
  barWidth?: number
  gap?: number
  threshold?: number
  currentValue?: number | null
  className?: string
}

export function SparklineBar({
  values,
  width = 64,
  height = 28,
  barWidth = 4,
  gap = 2,
  threshold = 100,
  currentValue = null,
  className,
}: SparklineBarProps) {
  if (values.length === 0) {
    // No data — just show current value if available
    return (
      <span className={cn('text-[11px] tabular-nums text-slate-400', className)}>
        {currentValue != null ? currentValue : '—'}
      </span>
    )
  }

  const max = Math.max(...values, 1)
  const barCount = Math.floor(width / (barWidth + gap))
  const visible = values.slice(-barCount)

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {visible.map((v, i) => {
        const barH = Math.max(2, (v / max) * height)
        const x = i * (barWidth + gap)
        const y = height - barH
        const color = queueDepthColor(v, threshold)
        return <rect key={i} x={x} y={y} width={barWidth} height={barH} rx={1} fill={color} opacity={0.85} />
      })}
    </svg>
  )
}

// ─── Line Sparkline ───────────────────────────────────────────────────────────

type SparklineLineProps = {
  values: number[]
  width?: number
  height?: number
  color?: string
  className?: string
}

export function SparklineLine({ values, width = 80, height = 28, color = '#6366f1', className }: SparklineLineProps) {
  if (values.length < 2) return null

  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1

  const step = width / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = i * step
      const y = height - ((v - min) / range) * (height - 4) - 2
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ─── Capacity Usage Cell ──────────────────────────────────────────────────────

type CapacityCellProps = {
  currentEps: number | null
  capacityLimitEps: number | null
  thresholds?: CapacityThresholds
}

export function CapacityCell({ currentEps, capacityLimitEps, thresholds = DEFAULT_CAPACITY_THRESHOLDS }: CapacityCellProps) {
  if (capacityLimitEps == null) {
    return (
      <div className="flex flex-col items-center gap-0.5">
        <SemiGauge pct={null} size={60} strokeWidth={6} thresholds={thresholds} />
        <span className="text-[10px] text-slate-400">No limit</span>
      </div>
    )
  }
  const pct = capacityLimitEps > 0 ? Math.round(((currentEps ?? 0) / capacityLimitEps) * 100) : null
  return (
    <div className="flex flex-col items-center">
      <SemiGauge pct={pct} size={60} strokeWidth={6} thresholds={thresholds} />
    </div>
  )
}

// ─── Queue Depth Cell ─────────────────────────────────────────────────────────

type QueueDepthCellProps = {
  depth: number | null
  history?: number[]
  threshold?: number
}

export function QueueDepthCell({ depth, history, threshold = 100 }: QueueDepthCellProps) {
  const d = depth ?? 0
  const color = queueDepthColor(d, threshold)
  return (
    <div className="flex flex-col gap-0.5">
      <span className="tabular-nums text-[12px] font-semibold" style={{ color }}>
        {d.toLocaleString()}
      </span>
      {history && history.length > 0 ? (
        <SparklineBar values={history} width={56} height={20} barWidth={4} gap={2} threshold={threshold} />
      ) : null}
    </div>
  )
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

type HealthBadgeProps = {
  health: string
  className?: string
}

const HEALTH_BADGE: Record<string, string> = {
  Healthy: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  Warning: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  Critical: 'border-red-500/40 bg-red-500/10 text-red-300',
  Disabled: 'border-slate-600 bg-slate-700/30 text-slate-400',
  Idle: 'border-slate-600 bg-slate-700/30 text-slate-400',
  Error: 'border-red-500/40 bg-red-500/10 text-red-300',
}

export function HealthBadge({ health, className }: HealthBadgeProps) {
  const cls = HEALTH_BADGE[health] ?? 'border-slate-600 bg-slate-700/30 text-slate-400'
  const dot: Record<string, string> = {
    Healthy: 'bg-emerald-400',
    Warning: 'bg-amber-400',
    Critical: 'bg-red-400',
    Disabled: 'bg-slate-500',
    Idle: 'bg-slate-500',
    Error: 'bg-red-400',
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold', cls, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot[health] ?? 'bg-slate-500')} />
      {health}
    </span>
  )
}
