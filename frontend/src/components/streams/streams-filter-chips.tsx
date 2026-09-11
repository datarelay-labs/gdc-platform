import { X } from 'lucide-react'
import type { StreamsMetricsWindow, StreamsOperationalFilter } from '../../constants/streamConsoleFilters'
import { streamsTimeRangeLabel } from '../../constants/streamConsoleFilters'

const OPERATIONAL_FILTER_LABEL: Record<StreamsOperationalFilter, string> = {
  'no-data': 'No Data',
  'low-volume': 'Low Volume',
  'schema-drift': 'Schema Drift',
}

type StreamsFilterChipsProps = {
  connectorFilter: string | null
  connectorFilterLabel: string | null
  onClearConnectorFilter: () => void
  operationalFilter?: StreamsOperationalFilter | null
  onClearOperationalFilter?: () => void
  timeRange: StreamsMetricsWindow
  onClearTimeRange?: () => void
  timeRangeIsDefault?: boolean
}

export function StreamsFilterChips({
  connectorFilter,
  connectorFilterLabel,
  onClearConnectorFilter,
  operationalFilter = null,
  onClearOperationalFilter,
  timeRange,
  onClearTimeRange,
  timeRangeIsDefault = timeRange === '1h',
}: StreamsFilterChipsProps) {
  const showConnector = connectorFilter != null
  const showOperational = operationalFilter != null
  const showTimeRange = !timeRangeIsDefault

  if (!showConnector && !showOperational && !showTimeRange) return null

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="streams-filter-chips"
      aria-label="Active stream filters"
    >
      {showOperational ? (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-amber-200/80 bg-amber-50/80 py-0.5 pl-2.5 pr-1 text-[11px] font-medium text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid={`streams-operational-filter-chip-${operationalFilter}`}
        >
          <span className="text-amber-700/80 dark:text-amber-200/80">Filter</span>
          <span className="font-semibold">{OPERATIONAL_FILTER_LABEL[operationalFilter]}</span>
          {onClearOperationalFilter ? (
            <button
              type="button"
              onClick={onClearOperationalFilter}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-amber-200/60 dark:hover:bg-amber-500/20"
              aria-label="Clear operational filter"
              data-testid="streams-clear-operational-filter"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          ) : null}
        </span>
      ) : null}
      {showConnector ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-violet-200/80 bg-violet-50/80 py-0.5 pl-2.5 pr-1 text-[11px] font-medium text-violet-950 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100">
          <span className="text-violet-700/80 dark:text-violet-200/80">Connector</span>
          <span className="font-semibold">{connectorFilterLabel ?? connectorFilter}</span>
          <button
            type="button"
            onClick={onClearConnectorFilter}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-violet-200/60 dark:hover:bg-violet-500/20"
            aria-label="Clear connector filter"
            data-testid="streams-clear-connector-filter"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ) : null}
      {showTimeRange ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200/80 bg-slate-50/80 py-0.5 pl-2.5 pr-1 text-[11px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-foreground">
          <span className="text-slate-500 dark:text-gdc-muted">Time Range</span>
          <span className="font-semibold">{streamsTimeRangeLabel(timeRange)}</span>
          {onClearTimeRange ? (
            <button
              type="button"
              onClick={onClearTimeRange}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-slate-200/60 dark:hover:bg-gdc-rowHover"
              aria-label="Reset time range to default"
              data-testid="streams-clear-time-range"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
