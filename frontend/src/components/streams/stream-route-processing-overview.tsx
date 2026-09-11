import { ExternalLink, Loader2, RefreshCw, Route } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchDestinationsList, type DestinationListItem } from '../../api/gdcDestinations'
import {
  fetchGovernanceWorkspaceSnapshot,
  type GovernanceWorkspaceRouteSnapshot,
} from '../../api/gdcGovernanceWorkspaceSnapshot'
import { fetchRoutesList, type RouteRead } from '../../api/gdcRoutes'
import { routeEditPath } from '../../config/nav-paths'
import { useMountAbortController } from '../../hooks/use-mount-abort-signal'
import { isRequestAborted } from '../../lib/request-abort'
import { cn } from '../../lib/utils'
import { RouteEditTransformPanel } from '../routes/route-edit-transform-panel'
import { StreamSharedProcessingSection } from './route-processing/stream-global-processing-section'
import { StreamRouteProcessingNavigator } from './route-processing/stream-route-processing-navigator'
import { RouteProcessingDetailHeader } from './route-processing/route-processing-detail-header'
import { RouteProcessingInheritToggle } from './route-processing/route-processing-inherit-toggle'
import { RouteProcessingModeSelector } from './route-processing/route-processing-mode-selector'
import { ROUTE_PROCESSING_COPY } from './route-processing/route-processing-labels'
import { ClassificationPanel } from './classification-panel'
import { ProtectionPanel } from './protection-panel'
import { PolicyPanel } from './policy-panel'

type ProcessingStatus = 'Inherited' | 'Overridden' | 'Mixed'

type RouteProcessingStatuses = {
  transform: ProcessingStatus | null
  protection: ProcessingStatus | null
  classification: ProcessingStatus | null
  policy: ProcessingStatus | null
}

type DetailTab = 'transform' | 'data_protection' | 'classification' | 'policy' | 'delivery'

const DETAIL_TABS: ReadonlyArray<{ key: DetailTab; label: string }> = [
  { key: 'transform', label: 'Transform' },
  { key: 'data_protection', label: 'Data Protection' },
  { key: 'classification', label: 'Classification' },
  { key: 'policy', label: 'Policy' },
  { key: 'delivery', label: 'Delivery' },
]

function statusesFromSnapshotRow(row: GovernanceWorkspaceRouteSnapshot | undefined): RouteProcessingStatuses {
  return {
    transform: row?.transform?.processing_status ?? null,
    protection: row?.protection?.processing_status ?? null,
    classification: row?.classification?.processing_status ?? null,
    policy: row?.policy?.processing_status ?? null,
  }
}

function routeStatusesUseShared(statuses: RouteProcessingStatuses | undefined): boolean {
  if (!statuses) return false
  return (
    statuses.transform === 'Inherited' &&
    statuses.protection === 'Inherited' &&
    statuses.classification === 'Inherited' &&
    statuses.policy === 'Inherited'
  )
}

function StreamRouteDetailTabs({
  streamId,
  route,
  destinationLabel,
  destinationMissing,
  processingStatuses,
  statusesPending,
  snapshotRow,
}: {
  streamId: number
  route: RouteRead
  destinationLabel: string | null
  destinationMissing: boolean
  processingStatuses: RouteProcessingStatuses | undefined
  statusesPending: boolean
  snapshotRow: GovernanceWorkspaceRouteSnapshot | undefined
}) {
  const [tab, setTab] = useState<DetailTab>('transform')
  useEffect(() => {
    setTab('transform')
  }, [route.id])
  const routeEditHref = routeEditPath(String(route.id))
  const usesShared = routeStatusesUseShared(processingStatuses)
  const routeMode = usesShared ? 'shared' : 'override'
  const panelId = 'stream-route-detail-tabpanel'

  return (
    <section
      className="rounded-lg border border-slate-200/90 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="route-processing-detail"
    >
      <RouteProcessingDetailHeader
        routeLabel={route.name?.trim() || `Route #${route.id}`}
        destinationLabel={destinationLabel}
        destinationMissing={destinationMissing}
        processingStatuses={processingStatuses}
        statusesPending={statusesPending}
        actions={
          <Link
            to={routeEditHref}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
            data-testid="stream-route-open-route-edit"
          >
            Open Route Edit
            <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        }
      />

      <div className="space-y-3 border-b border-slate-100 px-3 py-3 dark:border-gdc-border">
        <RouteProcessingModeSelector mode={routeMode} onChange={() => {}} readonly />
        {usesShared ? (
          <p className="text-[11px] text-slate-600 dark:text-gdc-muted" data-testid="stream-route-shared-mode-summary">
            {ROUTE_PROCESSING_COPY.routeUsesShared} Use{' '}
            <Link to={routeEditHref} className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
              Route Edit
            </Link>{' '}
            to override processing for this route.
          </p>
        ) : (
          <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
            This route overrides Shared Processing for one or more concerns. Edit in{' '}
            <Link to={routeEditHref} className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
              Route Edit
            </Link>
            .
          </p>
        )}
      </div>

      <div
        className="flex flex-wrap gap-1 border-b border-slate-100 px-2 pt-2 dark:border-gdc-border"
        role="tablist"
        aria-label="Route processing stages"
      >
        {DETAIL_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`stream-route-detail-tab-${item.key}`}
            aria-selected={tab === item.key}
            aria-controls={panelId}
            onClick={() => setTab(item.key)}
            className={cn(
              '-mb-px border-b-2 px-2.5 pb-2 text-[11px] font-semibold',
              tab === item.key
                ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
            )}
            data-testid={`stream-route-detail-tab-${item.key}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div id={panelId} role="tabpanel" aria-labelledby={`stream-route-detail-tab-${tab}`} className="space-y-3 p-3">
        {tab === 'transform' ? (
          <div className="space-y-3" data-testid="route-processing-transform-section">
            <RouteProcessingInheritToggle
              checked={processingStatuses?.transform === 'Inherited'}
              onChange={() => {}}
              concernLabel="Transform"
              readonly
              processingStatus={processingStatuses?.transform}
              statusPending={statusesPending}
              data-testid="stream-route-inherit-transform"
            />
            <RouteEditTransformPanel
              routeId={route.id}
              streamId={streamId}
              initialEffective={snapshotRow?.transform}
            />
          </div>
        ) : null}

        {tab === 'data_protection' ? (
          <div className="space-y-4" data-testid="route-processing-data-protection-section">
            <RouteProcessingInheritToggle
              checked={processingStatuses?.protection === 'Inherited'}
              onChange={() => {}}
              concernLabel="Data Protection"
              readonly
              processingStatus={processingStatuses?.protection}
              statusPending={statusesPending}
              data-testid="stream-route-inherit-protection"
            />
            <section data-testid="route-processing-protection-section">
              <p className="mb-2 text-[11px] font-semibold text-slate-800 dark:text-slate-100">Protection Rules</p>
              <ProtectionPanel
                streamId={streamId}
                routeId={route.id}
                canOperate
                initialEffective={snapshotRow?.protection}
              />
            </section>
          </div>
        ) : null}

        {tab === 'classification' ? (
          <div className="space-y-4" data-testid="route-processing-classification-section">
            <RouteProcessingInheritToggle
              checked={processingStatuses?.classification === 'Inherited'}
              onChange={() => {}}
              concernLabel="Classification"
              readonly
              processingStatus={processingStatuses?.classification}
              statusPending={statusesPending}
              data-testid="stream-route-inherit-classification"
            />
            <ClassificationPanel
              streamId={streamId}
              routeId={route.id}
              canOperate
              initialEffective={snapshotRow?.classification}
            />
          </div>
        ) : null}

        {tab === 'policy' ? (
          <div className="space-y-4" data-testid="route-processing-policy-section">
            <RouteProcessingInheritToggle
              checked={processingStatuses?.policy === 'Inherited'}
              onChange={() => {}}
              concernLabel="Policy"
              readonly
              processingStatus={processingStatuses?.policy}
              statusPending={statusesPending}
              data-testid="stream-route-inherit-policy"
            />
            <PolicyPanel
              streamId={streamId}
              routeId={route.id}
              canOperate
              initialEffective={snapshotRow?.policy}
            />
          </div>
        ) : null}

        {tab === 'delivery' ? (
          <div className="space-y-2" data-testid="route-processing-delivery-section">
            <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
              Delivery settings are route-specific — destination, failure policy, rate limits, and enable/disable.
            </p>
            <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-slate-600 dark:text-gdc-muted">Enabled</dt>
                <dd className="text-slate-900 dark:text-slate-100">{route.enabled ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-600 dark:text-gdc-muted">Failure policy</dt>
                <dd className="text-slate-900 dark:text-slate-100">{route.failure_policy ?? '—'}</dd>
              </div>
            </dl>
            <Link
              to={routeEditPath(String(route.id))}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
            >
              Edit delivery settings
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export function StreamRouteProcessingOverview({ streamId }: { streamId: number }) {
  const abortRef = useMountAbortController()
  const loadGenRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [routes, setRoutes] = useState<RouteRead[]>([])
  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
  const [statusByRoute, setStatusByRoute] = useState<Record<number, RouteProcessingStatuses>>({})
  const [snapshotByRoute, setSnapshotByRoute] = useState<Record<number, GovernanceWorkspaceRouteSnapshot>>({})
  const [statusesLoading, setStatusesLoading] = useState(true)
  const [selectedRouteId, setSelectedRouteId] = useState<number | null>(null)

  const destinationById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current
    const isCurrent = () => loadGenRef.current === gen
    const fetchOpts = { signal: abortRef.current?.signal }
    setLoading(true)
    setStatusesLoading(true)
    setError(null)
    try {
      const [allRoutes, dests, snapshot] = await Promise.all([
        fetchRoutesList(fetchOpts),
        fetchDestinationsList(fetchOpts),
        fetchGovernanceWorkspaceSnapshot(streamId, fetchOpts),
      ])
      if (!isCurrent()) return
      const streamRoutes = (allRoutes ?? []).filter((r) => r.stream_id === streamId)
      const nextSnapshotByRoute: Record<number, GovernanceWorkspaceRouteSnapshot> = {}
      const statuses: Record<number, RouteProcessingStatuses> = {}
      for (const row of snapshot?.routes ?? []) {
        nextSnapshotByRoute[row.route_id] = row
      }
      for (const route of streamRoutes) {
        statuses[route.id] = statusesFromSnapshotRow(nextSnapshotByRoute[route.id])
      }
      setRoutes(streamRoutes)
      setDestinations(dests ?? [])
      setSnapshotByRoute(nextSnapshotByRoute)
      setStatusByRoute(statuses)
      setSelectedRouteId((prev) => {
        if (prev != null && streamRoutes.some((r) => r.id === prev)) return prev
        return streamRoutes[0]?.id ?? null
      })
    } catch (e) {
      if (!isCurrent() || isRequestAborted(e)) return
      setError(e instanceof Error ? e.message : String(e))
      setStatusByRoute({})
      setSnapshotByRoute({})
    } finally {
      if (isCurrent()) {
        setLoading(false)
        setStatusesLoading(false)
      }
    }
  }, [streamId, abortRef])

  useEffect(() => {
    void load()
    return () => {
      loadGenRef.current += 1
    }
  }, [load])

  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null

  return (
    <section
      id="route-processing-section"
      className="space-y-4 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      aria-label="Route Processing Overview"
      data-testid="route-processing-overview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Route className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          Route Processing
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
        <p className="text-[11px] text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      <StreamSharedProcessingSection streamId={streamId} routeCount={routes.length} />

      <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.55fr)]" data-testid="route-processing-split-layout">
        <StreamRouteProcessingNavigator
          routes={routes}
          destinations={destinations}
          statusByRoute={statusByRoute}
          statusesLoading={statusesLoading}
          selectedRouteId={selectedRouteId}
          onSelect={setSelectedRouteId}
          loading={loading}
        />

        {selectedRoute != null ? (
          <StreamRouteDetailTabs
            streamId={streamId}
            route={selectedRoute}
            destinationLabel={
              selectedRoute.destination_id != null
                ? destinationById.get(selectedRoute.destination_id)?.name?.trim() ??
                  `Destination #${selectedRoute.destination_id}`
                : null
            }
            destinationMissing={
              selectedRoute.destination_id == null || !destinationById.get(selectedRoute.destination_id)
            }
            processingStatuses={statusByRoute[selectedRoute.id]}
            statusesPending={statusesLoading && statusByRoute[selectedRoute.id] === undefined}
            snapshotRow={snapshotByRoute[selectedRoute.id]}
          />
        ) : (
          <section
            className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-slate-200/90 p-6 text-center dark:border-gdc-border"
            data-testid="route-processing-detail-empty"
          >
            <p className="text-[12px] text-slate-500 dark:text-gdc-muted">{ROUTE_PROCESSING_COPY.selectRouteDetail}</p>
          </section>
        )}
      </div>
    </section>
  )
}
