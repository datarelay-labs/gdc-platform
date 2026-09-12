/**
 * Card grid view for Destinations.
 * Responsive: 5-6 cols on 4K → 1 col on mobile.
 */

import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { formatOperationalRate } from '../../lib/observability-format'
import type { DestinationOverviewRow } from './use-destinations-overview-data'
import { SemiGauge, DonutChart, HealthBadge, extractCapacityConfig } from './destination-mini-charts'

type DestinationCardViewProps = {
  rows: DestinationOverviewRow[]
  onSelectRow: (row: DestinationOverviewRow) => void
  onEditRow: (row: DestinationOverviewRow) => void
  onDeleteRow: (row: DestinationOverviewRow) => void
  onTestRow: (row: DestinationOverviewRow) => void
}

function typeLabel(t: string): string {
  switch (t) {
    case 'WEBHOOK_POST': return 'Webhook'
    case 'SYSLOG_UDP': return 'Syslog UDP'
    case 'SYSLOG_TCP': return 'Syslog TCP'
    case 'SYSLOG_TLS': return 'Syslog TLS'
    default: return t
  }
}

function formatEps(v: number | null): string {
  return formatOperationalRate(v)
}

function DestinationCard({
  row,
  onSelect,
  onEdit,
  onDelete,
  onTest,
}: {
  row: DestinationOverviewRow
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
  onTest: () => void
}) {
  const rt = row.runtime
  const { limitEps, thresholds } = extractCapacityConfig(row)
  const capacityPct = limitEps != null && limitEps > 0 ? Math.round(((rt.currentEps ?? 0) / limitEps) * 100) : null

  return (
    <div
      className={cn(
        'group relative flex cursor-pointer flex-col rounded-xl border bg-[#0f1a2a] p-4 shadow-sm transition-all hover:border-violet-500/40 hover:shadow-violet-900/20',
        row.enabled ? 'border-[#1e2a3b]' : 'border-[#1e2a3b] opacity-60',
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect() }}
    >
      {/* Kebab menu */}
      <div
        className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <DestinationCardMenu onEdit={onEdit} onDelete={onDelete} onTest={onTest} />
      </div>

      {/* Header */}
      <div className="flex items-start gap-2 pr-6">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#1e2a3b] bg-[#0a1628] text-[13px] font-bold text-slate-400">
          {row.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-bold text-slate-100">{row.name}</p>
          <p className="text-[10px] text-slate-500">{typeLabel(row.destination_type)}</p>
        </div>
      </div>

      {/* Status */}
      <div className="mt-2.5">
        <HealthBadge health={rt.health} />
      </div>

      {/* Gauges row */}
      <div className="mt-3 flex items-center justify-around">
        <div className="flex flex-col items-center gap-0.5">
          <SemiGauge pct={capacityPct} size={52} strokeWidth={5} showLabel thresholds={thresholds} />
          <span className="text-[9px] text-slate-500">Capacity</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <DonutChart successPct={rt.successRatePct} size={44} strokeWidth={5} />
          <span className="text-[9px] text-slate-500">Success</span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <div className="rounded-md border border-[#1e2a3b] bg-[#0a1628] px-2 py-1.5">
          <p className="text-[9px] uppercase tracking-wider text-slate-500">EPS</p>
          <p className="tabular-nums text-[12px] font-bold text-slate-200">{formatEps(rt.currentEps)}</p>
        </div>
        <div className="rounded-md border border-[#1e2a3b] bg-[#0a1628] px-2 py-1.5">
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Streams</p>
          <p className="tabular-nums text-[12px] font-bold text-slate-200">{rt.connectedStreams}</p>
        </div>
      </div>

      {/* Bottom info */}
      {rt.recentIssues.length > 0 && (
        <p className="mt-2 truncate text-[10px] text-amber-400" title={rt.recentIssues.join(' · ')}>
          {rt.recentIssues[0]}
        </p>
      )}
    </div>
  )
}

// ─── Card overflow menu ───────────────────────────────────────────────────────

function DestinationCardMenu({
  onEdit,
  onDelete,
  onTest,
}: {
  onEdit: () => void
  onDelete: () => void
  onTest: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded-md border border-[#1e2a3b] bg-[#0a1628] text-slate-400 hover:text-slate-200"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-30 min-w-[130px] rounded-lg border border-[#1e2a3b] bg-[#0a1628] py-1 shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          {[
            { label: 'Edit', action: onEdit },
            { label: 'Test delivery', action: onTest },
            { label: 'Delete', action: onDelete, danger: true },
          ].map(({ label, action, danger }) => (
            <button
              key={label}
              type="button"
              onClick={() => { setOpen(false); action() }}
              className={cn(
                'block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[#1e2a3b]',
                danger ? 'text-red-400' : 'text-slate-300'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Card grid ────────────────────────────────────────────────────────────────

import { useState } from 'react'

export function DestinationCardView({ rows, onSelectRow, onEditRow, onDeleteRow, onTestRow }: DestinationCardViewProps) {
  if (rows.length === 0) {
    return (
      <div className="py-16 text-center text-[12px] text-slate-500">
        No destinations match the current filters.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {rows.map((row) => (
        <DestinationCard
          key={row.id}
          row={row}
          onSelect={() => onSelectRow(row)}
          onEdit={() => onEditRow(row)}
          onDelete={() => onDeleteRow(row)}
          onTest={() => onTestRow(row)}
        />
      ))}
    </div>
  )
}
