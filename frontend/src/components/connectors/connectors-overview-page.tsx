import { Loader2, Plus, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { deleteConnector, CONNECTORS_LIST_LOAD_FAILED_MESSAGE } from '../../api/gdcConnectors'
import type { CurlImportDraft } from '../../api/gdcBackup'
import { useConnectorsOverviewData } from '../../hooks/use-connectors-overview-data'
import {
  connectorHealthBadgeClass,
  connectorStreamsFilterPath,
  formatAuthCheckResult,
  formatAuthHealthCheckStatus,
  formatEventTrendDisplay,
  eventTrendBadgeClass,
  type ConnectorDashboardRow,
} from '../../lib/connector-operational-health'
import { formatRelativeShort } from '../../lib/stream-console-metrics'
import { navigateToConnectorWizardWithDraft } from '../../utils/httpImportDraft'
import { DevValidationBadge } from '../shell/dev-validation-badge'
import { isDevValidationLabEntityName } from '../../utils/devValidationLab'
import { ConnectorRowActions } from './connector-row-actions'
import { ConnectorRowExpand } from './connector-row-expand'
import { ConnectorStreamsPopover } from './connector-streams-popover'
import { CurlImportPanel, PostmanImportPanel } from './http-import-panel'
import { formatOperationalCount, formatThroughputEps } from '../../lib/observability-format'

function formatEventsToday(n: number): string {
  return formatOperationalCount(n, { compact: true })
}

function formatEps(eps: number): string {
  if (!Number.isFinite(eps)) return '0'
  if (eps >= 1000) return `${(eps / 1000).toFixed(1)}K`
  return formatThroughputEps(eps)
}

export function ConnectorsOverviewPage() {
  const navigate = useNavigate()
  const {
    rows,
    loading,
    refreshing,
    slowLoading,
    showRetry,
    error,
    refreshError,
    usingStaleData,
    authRequired,
    apiBacked,
    operationsBacked,
    supplementaryError,
    reload,
    patchConnector,
  } = useConnectorsOverviewData()
  const [showImport, setShowImport] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [labFilterOnly, setLabFilterOnly] = useState(false)
  const [expandedConnectorId, setExpandedConnectorId] = useState<number | null>(null)
  const [authTestingId, setAuthTestingId] = useState<number | null>(null)

  const visibleRows = useMemo(
    () => (labFilterOnly ? rows.filter((r) => isDevValidationLabEntityName(r.name)) : rows),
    [rows, labFilterOnly],
  )
  const hasRows = useMemo(() => visibleRows.length > 0, [visibleRows.length])
  const labCount = useMemo(() => rows.filter((r) => isDevValidationLabEntityName(r.name)).length, [rows])
  const showEmptyState = !loading && !error && !usingStaleData && rows.length === 0
  const loadFailed = !loading && !!error && rows.length === 0
  const showBlockingLoad = loading && rows.length === 0

  const onApproveImport = useCallback(
    (draft: CurlImportDraft) => {
      navigateToConnectorWizardWithDraft(navigate, draft)
    },
    [navigate],
  )

  async function onDelete(row: ConnectorDashboardRow) {
    const ok = window.confirm(`Delete connector "${row.name}"?`)
    if (!ok) return
    try {
      setDeleteError(null)
      await deleteConnector(row.id)
      if (expandedConnectorId === row.id) setExpandedConnectorId(null)
      reload({ bustCache: true })
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleExpand = useCallback((connectorId: number) => {
    setExpandedConnectorId((prev) => (prev === connectorId ? null : connectorId))
  }, [])

  return (
    <div className="flex w-full min-w-0 flex-col gap-4" data-testid="connectors-overview-page">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-gdc-foreground">Connectors</h2>
          <p className="text-[13px] text-slate-600 dark:text-gdc-muted">
            Operational dashboard — auth, data freshness, stream health, and delivery impact.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-9 cursor-pointer select-none items-center gap-1.5 rounded-md border border-amber-200/80 bg-amber-50/80 px-2 text-[11px] font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50">
            <input
              type="checkbox"
              className="rounded border-amber-400 text-amber-700 focus:ring-amber-500"
              checked={labFilterOnly}
              onChange={(e) => setLabFilterOnly(e.target.checked)}
              aria-label="Dev validation lab only filter"
            />
            Dev validation lab only
            <span className="ml-1 rounded bg-amber-100 px-1 font-mono text-[10px] text-amber-900 dark:bg-amber-900/60 dark:text-amber-50">{labCount}</span>
          </label>
          <button
            type="button"
            onClick={() => reload({ bustCache: true })}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            aria-busy={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          >
            {showImport ? 'Hide import' : 'Import from cURL / Postman'}
          </button>
          <Link to="/connectors/new" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700">
            <Plus className="h-3.5 w-3.5" />
            Create Connector
          </Link>
        </div>
      </div>

      {showImport ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <CurlImportPanel onApprove={onApproveImport} />
          <PostmanImportPanel onApprove={onApproveImport} />
        </div>
      ) : null}

      <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
        <span
          className={`inline-flex rounded px-2 py-0.5 font-semibold ${
            apiBacked
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-100'
              : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-100'
          }`}
        >
          {apiBacked ? 'API-backed' : 'Local preview'}
        </span>
        {operationsBacked ? (
          <span className="ml-2 inline-flex rounded bg-violet-100 px-2 py-0.5 font-semibold text-violet-800 dark:bg-violet-500/15 dark:text-violet-100">
            Runtime metrics
          </span>
        ) : null}
        <span className="ml-2 text-[11px] text-slate-500 dark:text-gdc-muted">
          {rows.length} total · {labCount} Dev validation lab · sorted by health
        </span>
      </div>

      {loadFailed ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          data-testid="connectors-load-failed"
        >
          <p>{error ?? CONNECTORS_LIST_LOAD_FAILED_MESSAGE}</p>
          <button
            type="button"
            onClick={() => reload({ bustCache: true })}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-100"
            data-testid="connectors-retry-button"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Retry
          </button>
        </div>
      ) : null}

      {usingStaleData && refreshError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="connectors-stale-data-banner"
        >
          <div>
            <p className="font-semibold">Using last successful data.</p>
            <p className="text-[11px]">Latest refresh failed.</p>
          </div>
          <button
            type="button"
            onClick={() => reload({ bustCache: true })}
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-50"
            data-testid="connectors-stale-retry-button"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Retry
          </button>
        </div>
      ) : null}

      {error && !loadFailed ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          data-testid="connectors-error-banner"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={() => reload({ bustCache: true })}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-100"
            data-testid="connectors-retry-button"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Retry
          </button>
        </div>
      ) : null}

      {authRequired ? (
        <p className="sr-only" data-testid="connectors-auth-required">
          {error}
        </p>
      ) : null}

      {deleteError ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-2 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
          {deleteError}
        </p>
      ) : null}

      {supplementaryError ? (
        <p
          className="rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="connectors-supplementary-error"
        >
          Stream counts could not be refreshed. Connector list is still available.
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        {showEmptyState ? (
          <div
            className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center"
            data-testid="connectors-empty-state"
          >
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">No connectors yet</p>
            <p className="max-w-md text-[12px] text-slate-600 dark:text-gdc-muted">
              Create your first connector to start collecting data.
            </p>
            <Link
              to="/connectors/new"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700"
            >
              <Plus className="h-3.5 w-3.5" />
              Create Connector
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[12px] text-slate-700 dark:text-gdc-mutedStrong">
              <thead className="border-b border-slate-200/80 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-gdc-divider dark:bg-gdc-tableHeader dark:text-gdc-mutedStrong">
                <tr>
                  <th className="px-3 py-2">Connector</th>
                  <th className="px-3 py-2">Health</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Affected</th>
                  <th className="px-3 py-2">Streams</th>
                  <th className="px-3 py-2">Events Trend</th>
                  <th className="px-3 py-2">Last Event</th>
                  <th className="px-3 py-2">Last Auth Test</th>
                  <th className="px-3 py-2">Auth Check</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {showBlockingLoad ? (
                  <tr>
                    <td className="px-3 py-5 text-slate-500 dark:text-gdc-muted" colSpan={11} data-testid="connectors-loading">
                      <div className="flex flex-col items-start gap-2">
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          Loading connectors...
                        </span>
                        {slowLoading ? (
                          <div className="text-[11px] text-slate-500 dark:text-gdc-muted" data-testid="connectors-slow-loading">
                            <p className="font-medium text-slate-700 dark:text-gdc-mutedStrong">Still loading...</p>
                            <p>This may take longer than expected.</p>
                          </div>
                        ) : null}
                        {showRetry ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => reload({ bustCache: true })}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                              data-testid="connectors-loading-retry-button"
                            >
                              <RefreshCw className="h-3 w-3" aria-hidden />
                              Retry
                            </button>
                            <span className="text-[11px] text-slate-500 dark:text-gdc-muted">Keep waiting</span>
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ) : loadFailed ? (
                  <tr>
                    <td className="px-3 py-8 text-center text-slate-500 dark:text-gdc-muted" colSpan={11} data-testid="connectors-load-failed-table">
                      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {CONNECTORS_LIST_LOAD_FAILED_MESSAGE}
                      </p>
                      <button
                        type="button"
                        onClick={() => reload({ bustCache: true })}
                        className="mt-3 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                      >
                        <RefreshCw className="h-3 w-3" aria-hidden />
                        Retry
                      </button>
                    </td>
                  </tr>
                ) : !hasRows ? (
                  <tr>
                    <td className="px-3 py-5 text-slate-500 dark:text-gdc-muted" colSpan={11}>
                      {labFilterOnly && rows.length > 0
                        ? 'No Dev validation lab connectors. Toggle off the filter to see all connectors.'
                        : null}
                    </td>
                  </tr>
                ) : (
                  visibleRows.flatMap((row) => {
                    const auth = formatAuthCheckResult(row)
                    const ops = row.operations
                    const authCheck = formatAuthHealthCheckStatus(
                      row.auth_health_check_interval ?? ops?.auth_health_check_interval ?? 'disabled',
                    )
                    const lastEvent = row.lastEventActive
                    const eventTrend = formatEventTrendDisplay(ops?.event_trend_percent)
                    const streamTotal = ops?.stream_count ?? row.stream_count ?? 0
                    const affectedStreams =
                      ops?.affected_stream_count ?? row.streamCounts.warning + row.streamCounts.critical
                    const affectedDestinations = ops?.affected_destination_count ?? 0
                    const destinationTotal = ops?.destination_count ?? 0
                    const isExpanded = expandedConnectorId === row.id
                    const expandStreams = isExpanded ? (ops?.streams ?? []) : []

                    const mainRow = (
                      <tr
                        key={row.id}
                        className={`border-t border-slate-200/70 transition-colors hover:bg-slate-50/80 dark:border-gdc-divider dark:hover:bg-gdc-rowHover ${
                          isExpanded ? 'bg-slate-50/50 dark:bg-gdc-elevated/30' : ''
                        }`}
                        data-testid={`connector-row-${row.id}`}
                      >
                        <td className="px-3 py-2 font-medium text-slate-800 dark:text-gdc-foreground">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => toggleExpand(row.id)}
                              className="inline-flex items-center gap-1 text-left text-violet-700 hover:underline dark:text-violet-300"
                              aria-expanded={isExpanded}
                              data-testid={`connector-expand-toggle-${row.id}`}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                              )}
                              {row.name}
                            </button>
                            <DevValidationBadge name={row.name} />
                          </div>
                          <p className="mt-0.5 font-mono text-[10px] text-slate-500 dark:text-gdc-muted">{row.base_url ?? row.host ?? '—'}</p>
                          {ops ? (
                            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted" title="Runtime summary">
                              EPS {formatEps(ops.eps)} · Events {formatEventsToday(ops.events_24h)} (24h) · Destinations{' '}
                              {destinationTotal}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-[11px] font-semibold ${connectorHealthBadgeClass(row.health)}`}
                            data-testid={`connector-health-${row.id}`}
                          >
                            {row.health}
                          </span>
                        </td>
                        <td className="max-w-[160px] px-3 py-2 text-[11px] text-slate-600 dark:text-gdc-muted" data-testid={`connector-reason-${row.id}`}>
                          {row.healthReason}
                        </td>
                        <td className="px-3 py-2 text-[11px]" data-testid={`connector-affected-${row.id}`}>
                          <div>
                            <span className="text-slate-500 dark:text-gdc-muted">Streams </span>
                            <span className="tabular-nums font-medium text-slate-800 dark:text-gdc-foreground">
                              {affectedStreams} / {streamTotal}
                            </span>
                          </div>
                          <div className="mt-0.5">
                            <span className="text-slate-500 dark:text-gdc-muted">Destinations </span>
                            <span className="tabular-nums font-medium text-slate-800 dark:text-gdc-foreground">
                              {affectedDestinations}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <ConnectorStreamsPopover
                            streamCount={streamTotal}
                            streams={ops?.streams ?? []}
                            streamCounts={row.streamCounts}
                          />
                        </td>
                        <td className="px-3 py-2 text-[11px]" data-testid={`connector-event-trend-${row.id}`}>
                          {eventTrend ? (
                            <span
                              className={`inline-flex rounded px-2 py-0.5 text-[10px] font-semibold ${eventTrendBadgeClass(eventTrend.severity)}`}
                              title={
                                ops
                                  ? `Last 1h: ${ops.events_last_1h} · Previous 1h: ${ops.events_previous_1h}`
                                  : undefined
                              }
                            >
                              {eventTrend.label}
                            </span>
                          ) : (
                            <span className="text-slate-400 dark:text-gdc-muted">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px]" data-testid={`connector-last-event-${row.id}`}>
                          {lastEvent ? formatRelativeShort(lastEvent) : 'Never'}
                          {ops && ops.stale_stream_count > 0 ? (
                            <p className="text-[10px] text-amber-700 dark:text-amber-200">{ops.stale_stream_count} stale</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-[11px]">
                          {authTestingId === row.id ? (
                            <div className="text-slate-500 dark:text-gdc-muted" data-testid={`connector-auth-testing-${row.id}`}>
                              Testing…
                            </div>
                          ) : (
                            <>
                              <div>{row.last_auth_check_at ? formatRelativeShort(row.last_auth_check_at) : '—'}</div>
                              <div className={auth.label === 'Failed' ? 'text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-gdc-muted'}>
                                {auth.label}
                                {auth.detail && row.healthReason !== 'Authentication Failed' ? ` · ${auth.detail}` : ''}
                              </div>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px]" data-testid={`connector-auth-check-${row.id}`}>
                          <div>Configured: {authCheck.configured}</div>
                          <div className="text-slate-500 dark:text-gdc-muted">Execution: {authCheck.execution}</div>
                        </td>
                        <td className="px-3 py-2 text-[11px]">{row.updated_at ? formatRelativeShort(row.updated_at) : '—'}</td>
                        <td className="px-3 py-2">
                          <ConnectorRowActions
                            row={row}
                            onAuthCheckStart={() => setAuthTestingId(row.id)}
                            onAuthCheckEnd={() => setAuthTestingId((current) => (current === row.id ? null : current))}
                            onAuthCheckComplete={(connectorId, patch) => {
                              patchConnector(connectorId, patch)
                            }}
                            onDelete={() => void onDelete(row)}
                            onViewStreams={() => navigate(connectorStreamsFilterPath(row.id, row.name))}
                          />
                        </td>
                      </tr>
                    )

                    if (!isExpanded) return [mainRow]

                    return [
                      mainRow,
                      <ConnectorRowExpand
                        key={`${row.id}-expand`}
                        connectorName={row.name}
                        streams={expandStreams}
                        loading={operationsBacked && !ops}
                      />,
                    ]
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
