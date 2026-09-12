/**
 * 5-card KPI strip for the Destinations management page.
 * Cards: Overall Capacity Usage | Delivery Success Rate | Active Destinations | Streams Connected | Alerts
 */

import { AlertTriangle, CheckCircle2, Server, Activity, Bell } from 'lucide-react'
import { formatOperationalCount, formatOperationalPercent } from '../../lib/observability-format'
import type { DestinationOverviewRow } from './use-destinations-overview-data'
import { SemiGauge, DonutChart, extractCapacityConfig } from './destination-mini-charts'

// ─── Derived KPI calculations ─────────────────────────────────────────────────

export type DestinationsKpi = {
  /** Overall capacity: sum(currentEps) / sum(limitEps) * 100, or null if no limits configured */
  overallCapacityPct: number | null
  overallCurrentEps: number
  overallLimitEps: number | null
  /**
   * Aggregate delivery success rate: Σ(estimated_success_count) / Σ(estimated_total_count).
   * Estimated counts are proportional to currentEps (same window for all destinations).
   */
  overallSuccessRatePct: number | null
  totalDeliveredEvents: number
  /** Active destination counts by health */
  activeCount: number
  healthyCount: number
  warningCount: number
  criticalCount: number
  disabledCount: number
  /** Connected streams (unique stream IDs across all routes) */
  connectedStreamCount: number
  totalRoutes: number
  activeRoutes: number
  /** Alert counts */
  totalAlerts: number
  capacityWarnings: number
  deliveryFailures: number
}

export function computeDestinationsKpi(rows: DestinationOverviewRow[]): DestinationsKpi {
  let sumCurrentEps = 0
  let sumLimitEps = 0
  let hasAnyLimit = false
  let successNumer = 0
  let successDenom = 0
  let totalDeliveredEvents = 0
  let activeCount = 0
  let healthyCount = 0
  let warningCount = 0
  let criticalCount = 0
  let disabledCount = 0
  const uniqueStreamIds = new Set<number>()
  let totalRoutes = 0
  let activeRoutes = 0
  let capacityWarnings = 0
  let deliveryFailures = 0

  for (const row of rows) {
    const rt = row.runtime
    const { limitEps, thresholds } = extractCapacityConfig(row)
    const currentEps = rt.currentEps ?? 0

    sumCurrentEps += currentEps
    if (limitEps != null) {
      sumLimitEps += limitEps
      hasAnyLimit = true
    }

    // Success rate: Σ(estimated_success_count) / Σ(estimated_total_count).
    // Since all destinations share the same time window, currentEps ∝ total_delivery_count.
    // estimated_success = (successRatePct/100) * currentEps  →  aggregate ratio = Σsuccess/Σtotal.
    if (rt.hasDeliveryActivity && rt.successRatePct != null && currentEps > 0) {
      const estimatedSuccess = (rt.successRatePct / 100) * currentEps
      successNumer += estimatedSuccess
      successDenom += currentEps
    }

    totalDeliveredEvents += currentEps

    // Health counts
    const h = rt.health
    if (!row.enabled) {
      disabledCount++
    } else {
      activeCount++
      if (h === 'Healthy') healthyCount++
      else if (h === 'Warning') warningCount++
      else if (h === 'Critical') criticalCount++
    }

    // Stream IDs
    for (const route of row.routes ?? []) {
      if (typeof route.stream_id === 'number') uniqueStreamIds.add(route.stream_id)
    }

    // Route counts
    const rc = row.routes?.length ?? 0
    totalRoutes += rc
    const enabledRoutes = row.routes?.filter((r) => r.route_enabled !== false).length ?? 0
    activeRoutes += enabledRoutes

    // Capacity warning: use per-destination warning threshold
    if (limitEps != null && limitEps > 0) {
      const usagePct = (currentEps / limitEps) * 100
      if (usagePct >= thresholds.warningPct) capacityWarnings++
    }
    if (h === 'Critical') deliveryFailures++
  }

  return {
    overallCapacityPct: hasAnyLimit && sumLimitEps > 0 ? Math.round((sumCurrentEps / sumLimitEps) * 100) : null,
    overallCurrentEps: Math.round(sumCurrentEps * 10) / 10,
    overallLimitEps: hasAnyLimit ? sumLimitEps : null,
    // Σ estimated_success / Σ estimated_total → same as Σsuccess_count / Σtotal_count
    overallSuccessRatePct: successDenom > 0 ? Math.round((successNumer / successDenom) * 10000) / 100 : null,
    totalDeliveredEvents: Math.round(totalDeliveredEvents),
    activeCount,
    healthyCount,
    warningCount,
    criticalCount,
    disabledCount,
    connectedStreamCount: uniqueStreamIds.size,
    totalRoutes,
    activeRoutes,
    totalAlerts: capacityWarnings + deliveryFailures,
    capacityWarnings,
    deliveryFailures,
  }
}

// ─── Individual KPI card ──────────────────────────────────────────────────────

function KpiCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-[#1e2a3b] bg-[#0f1a2a] p-4 shadow-sm ${className}`}
    >
      {children}
    </div>
  )
}

function KpiLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">{children}</p>
}

function KpiStat({ value, sub, color = 'text-slate-100' }: { value: string; sub?: string; color?: string }) {
  return (
    <div>
      <span className={`text-2xl font-bold tabular-nums ${color}`}>{value}</span>
      {sub ? <span className="ml-1.5 text-[11px] text-slate-500">{sub}</span> : null}
    </div>
  )
}

// ─── KPI Strip ────────────────────────────────────────────────────────────────

type DestinationsKpiStripProps = {
  kpi: DestinationsKpi
  loading?: boolean
}

export function DestinationsKpiStrip({ kpi, loading }: DestinationsKpiStripProps) {
  const dim = loading ? 'opacity-50' : ''

  return (
    <div className={`grid grid-cols-2 gap-3 xl:grid-cols-5 ${dim}`}>

      {/* 1. Overall Capacity Usage */}
      <KpiCard>
        <KpiLabel>Overall Capacity Usage</KpiLabel>
        <div className="flex items-center gap-3">
          <SemiGauge pct={kpi.overallCapacityPct} size={72} strokeWidth={7} showLabel />
          <div className="min-w-0">
            {kpi.overallLimitEps != null ? (
              <>
                <div className="text-[11px] text-slate-400">
                  <span className="tabular-nums font-semibold text-slate-200">{kpi.overallCurrentEps.toLocaleString()}</span>
                  {' / '}
                  <span className="tabular-nums">{kpi.overallLimitEps.toLocaleString()}</span>
                  {' EPS'}
                </div>
              </>
            ) : (
              <div className="text-[11px] text-slate-500">No capacity limits configured</div>
            )}
          </div>
        </div>
      </KpiCard>

      {/* 2. Delivery Success Rate */}
      <KpiCard>
        <KpiLabel>Delivery Success Rate</KpiLabel>
        <div className="flex items-center gap-3">
          <DonutChart successPct={kpi.overallSuccessRatePct} size={60} strokeWidth={7} />
          <div className="min-w-0 space-y-1">
            {kpi.overallSuccessRatePct != null ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-[11px] text-slate-300">
                    Success <span className="tabular-nums font-semibold">{formatOperationalPercent(kpi.overallSuccessRatePct)}</span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  <span className="text-[11px] text-slate-400">
                    Failed <span className="tabular-nums">{formatOperationalPercent(100 - kpi.overallSuccessRatePct)}</span>
                  </span>
                </div>
              </>
            ) : (
              <span className="text-[12px] text-slate-500">No delivery data</span>
            )}
            <div className="text-[10px] text-slate-500">
              Events: <span className="tabular-nums text-slate-400">{formatOperationalCount(kpi.totalDeliveredEvents)}</span>
            </div>
          </div>
        </div>
      </KpiCard>

      {/* 3. Active Destinations */}
      <KpiCard>
        <KpiLabel>Active Destinations</KpiLabel>
        <div className="flex items-start gap-3">
          <div>
            <KpiStat value={String(kpi.activeCount)} />
          </div>
          <div className="space-y-1 pt-1">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="text-slate-400">Healthy <span className="tabular-nums font-semibold text-slate-300">{kpi.healthyCount}</span></span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="text-slate-400">Warning <span className="tabular-nums font-semibold text-amber-300">{kpi.warningCount}</span></span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              <span className="text-slate-400">Critical <span className="tabular-nums font-semibold text-red-300">{kpi.criticalCount}</span></span>
            </div>
          </div>
        </div>
      </KpiCard>

      {/* 4. Streams Connected */}
      <KpiCard>
        <KpiLabel>Streams Connected</KpiLabel>
        <div className="flex items-start gap-3">
          <div>
            <KpiStat value={String(kpi.connectedStreamCount)} />
          </div>
          <div className="space-y-1 pt-1">
            <div className="text-[11px] text-slate-400">
              Total Routes <span className="tabular-nums font-semibold text-slate-300">{kpi.totalRoutes}</span>
            </div>
            <div className="text-[11px] text-slate-400">
              Active Routes <span className="tabular-nums font-semibold text-slate-300">{kpi.activeRoutes}</span>
            </div>
          </div>
        </div>
      </KpiCard>

      {/* 5. Alerts */}
      <KpiCard>
        <KpiLabel>Alerts</KpiLabel>
        <div className="flex items-start gap-3">
          <div>
            <KpiStat
              value={String(kpi.totalAlerts)}
              color={kpi.totalAlerts > 0 ? 'text-amber-300' : 'text-slate-100'}
            />
          </div>
          <div className="space-y-1 pt-1">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="text-slate-400">
                Capacity Warning <span className="tabular-nums font-semibold text-slate-300">{kpi.capacityWarnings}</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              <span className="text-slate-400">
                Delivery Failure <span className="tabular-nums font-semibold text-red-300">{kpi.deliveryFailures}</span>
              </span>
            </div>
          </div>
        </div>
      </KpiCard>
    </div>
  )
}

// ─── Unused imports suppression ───────────────────────────────────────────────
// (Suppress tree-shaking warnings for icon imports used implicitly)
void AlertTriangle
void CheckCircle2
void Server
void Activity
void Bell
