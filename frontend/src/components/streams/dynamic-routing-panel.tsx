import { GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchStreamDynamicRoutes,
  fetchStreamDynamicRoutingSummary,
  type DynamicRoute,
  type StreamDynamicRoutingSummaryResponse,
} from '../../api/gdcDynamicRouting'
import { compatibleGovernancePreload } from '../../lib/stream-governance-snapshot'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'

export function DynamicRoutingPanel({
  streamId,
  initialSummary,
}: {
  streamId: number
  initialSummary?: StreamDynamicRoutingSummaryResponse | null
}) {
  const preload = compatibleGovernancePreload(streamId, initialSummary)
  const preloadRef = useRef(preload)
  preloadRef.current = preload
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<StreamDynamicRoutingSummaryResponse | null>(preload ?? null)
  const [routes, setRoutes] = useState<DynamicRoute[]>([])

  useEffect(() => {
    if (preload != null) setSummary(preload)
  }, [preload])

  const load = useCallback(async (opts?: { skipSummary?: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      const skipSummary = opts?.skipSummary === true
      if (skipSummary) {
        const r = await fetchStreamDynamicRoutes(streamId)
        setRoutes(r?.routes ?? [])
        if (preloadRef.current == null && r == null) {
          setError('Dynamic routing APIs unavailable.')
        }
        return
      }
      const [s, r] = await Promise.all([
        fetchStreamDynamicRoutingSummary(streamId),
        fetchStreamDynamicRoutes(streamId),
      ])
      setSummary(s)
      setRoutes(r?.routes ?? [])
      if (s == null && r == null) {
        setError('Dynamic routing APIs unavailable.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [streamId])

  useEffect(() => {
    const skipSummary = preloadRef.current != null
    void load({ skipSummary })
  }, [streamId, load])

  return (
    <section
      className="rounded-xl border border-slate-200/90 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
      aria-label="Dynamic Routing"
      data-testid="dynamic-routing-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          <GitBranch className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          Dynamic Routing
        </p>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
          Refresh
        </button>
      </div>

      {error ? (
        <p className="mt-2 text-[11px] text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      <p className="mt-3 text-[11px] font-semibold text-slate-700 dark:text-slate-200">Routing metrics</p>
      <dl className="mt-1 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3" data-testid="dynamic-routing-metrics">
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Total routes</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">
            {summary?.total_dynamic_routes ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Matched routes</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">
            {summary?.matched_dynamic_routes ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Deliveries</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">
            {summary?.dynamic_deliveries ?? '—'}
          </dd>
        </div>
      </dl>

      <div className="mt-3 overflow-x-auto" data-testid="dynamic-routing-rules-table">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Name</th>
              <th className={opTh}>Condition</th>
              <th className={opTh}>Route</th>
              <th className={opTh}>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {routes.length === 0 ? (
              <tr className={opTr}>
                <td className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')} colSpan={4}>
                  {loading ? 'Loading…' : 'No dynamic routes.'}
                </td>
              </tr>
            ) : (
              routes.map((rule) => (
                <tr key={rule.id} className={opTr} data-testid={`dynamic-route-row-${rule.id}`}>
                  <td className={opTd}>{rule.name}</td>
                  <td className={cn(opTd, 'font-mono text-[10px]')}>
                    {rule.condition_json?.sensitivity_class
                      ?? rule.condition_json?.classification_level
                      ?? '—'}
                  </td>
                  <td className={opTd}>
                    {rule.route_name ?? (rule.route_id != null ? `Route #${rule.route_id}` : '—')}
                    {' → '}
                    {rule.destination_name ?? (rule.destination_id != null ? `Destination #${rule.destination_id}` : '—')}
                  </td>
                  <td className={opTd}>{rule.enabled ? 'Yes' : 'No'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
