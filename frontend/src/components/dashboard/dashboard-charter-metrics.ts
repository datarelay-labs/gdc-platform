import type { ConnectorRead } from '../../api/gdcConnectors'
import type { DestinationListItem } from '../../api/gdcDestinations'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { mapBackendStreamStatus } from '../../api/streamRows'
import type {
  DashboardOutcomeTimeseriesResponse,
  DashboardSummaryResponse,
  HealthOverviewResponse,
  ObservabilitySummaryResponse,
  RuntimeAlertSummaryItem,
  StreamRead,
} from '../../api/types/gdcApi'
import { formatThroughputEps } from '../../lib/observability-format'
import {
  aggregateDeliverySuccessRateFromSnapshot,
  countHealthFromRows,
  deriveOverallHealthPostureFromSnapshot,
  formatOperationalEps,
  formatOperationalSuccessRate,
  selectGlobalKpi,
} from '../../lib/operational-snapshot-selectors'
import { formatCompactInt } from '../runtime/runtime-monitoring-aggregates'
import {
  groupRowsBySourceProduct,
  type ProductStreamGroup,
  type StreamRuntimeStatus,
} from '../../lib/source-product-group'

export type OverallHealthCounts = {
  healthy: number
  warning: number
  critical: number
  posture: 'healthy' | 'warning' | 'critical'
}

export type StreamGroupHealthCounts = {
  healthy: number
  warning: number
  critical: number
  groups: ProductStreamGroup<StreamGroupRow>[]
}

export type StreamGroupRow = {
  connectorName: string
  connectorProductGroup?: string | null
  status: StreamRuntimeStatus
  openSchemaFieldDriftCount?: number
}

export type TrafficOverviewMetrics = {
  incomingEvents: number | null
  outgoingEvents: number | null
  deliverySuccessRatePct: number | null
  windowLabel: string
}

export type OperationalIssueCounts = {
  noDataStreams: number | null
  lowVolumeStreams: number | null
  schemaDriftCount: number | null
  destinationCapacityWarnings: number | null
}

export type RecentAlertsSummary = {
  total: number
  critical: number
  warning: number
  hasAlerts: boolean
}

const cardClass =
  'rounded-xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm dark:border-[rgba(120,150,220,0.2)] dark:bg-[#111827]/95 dark:shadow-[0_4px_24px_-8px_rgba(0,0,0,0.5)] dark:ring-1 dark:ring-[rgba(120,150,220,0.1)]'

export { cardClass as dashboardCardClass }

function safeNonNeg(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x) || x < 0) return 0
  return Math.floor(x)
}

export function openSchemaFieldDriftCount(
  stream: Pick<OperationalSnapshotResponse['streams'][number], 'open_schema_field_drift_count'> | undefined,
): number {
  return safeNonNeg(stream?.open_schema_field_drift_count ?? 0)
}

export function deriveFleetSchemaDriftFromSnapshot(snapshot: OperationalSnapshotResponse | null): {
  openDriftCount: number
  affectedStreamCount: number
} {
  const streams = snapshot?.streams ?? []
  let openDriftCount = 0
  let affectedStreamCount = 0
  for (const stream of streams) {
    const n = openSchemaFieldDriftCount(stream)
    openDriftCount += n
    if (n > 0) affectedStreamCount += 1
  }
  return { openDriftCount, affectedStreamCount }
}

export function deriveOverallHealth(health: HealthOverviewResponse | null): OverallHealthCounts {
  const streams = health?.streams
  const healthy = safeNonNeg(streams?.healthy)
  const warning = safeNonNeg(streams?.degraded)
  const critical = safeNonNeg(streams?.unhealthy) + safeNonNeg(streams?.critical)
  let posture: OverallHealthCounts['posture'] = 'healthy'
  if (critical > 0) posture = 'critical'
  else if (warning > 0) posture = 'warning'
  return { healthy, warning, critical, posture }
}

export function deriveOverallHealthFromSnapshot(snapshot: OperationalSnapshotResponse | null): OverallHealthCounts {
  if (snapshot == null) {
    return { healthy: 0, warning: 0, critical: 0, posture: 'healthy' }
  }
  return deriveOverallHealthPostureFromSnapshot(snapshot)
}

function streamRowsFromBundle(
  streams: readonly StreamRead[],
  connectors: readonly ConnectorRead[],
): StreamGroupRow[] {
  const connectorById = new Map<number, ConnectorRead>()
  for (const c of connectors) connectorById.set(c.id, c)

  return streams.map((s) => {
    const connector = s.connector_id != null ? connectorById.get(s.connector_id) : undefined
    return {
      connectorName: connector?.name?.trim() || (s.connector_id != null ? `Connector #${s.connector_id}` : 'Unknown source'),
      connectorProductGroup: connector?.product_group ?? null,
      status: mapBackendStreamStatus(s.status),
    }
  })
}

export function deriveStreamGroupHealth(
  streams: readonly StreamRead[],
  connectors: readonly ConnectorRead[],
): StreamGroupHealthCounts {
  const groups = groupRowsBySourceProduct(streamRowsFromBundle(streams, connectors))
  let healthy = 0
  let warning = 0
  let critical = 0
  for (const g of groups) {
    if (g.worstStatus === 'ERROR') critical += 1
    else if (g.worstStatus === 'DEGRADED') warning += 1
    else healthy += 1
  }
  return { healthy, warning, critical, groups }
}

export function deriveStreamGroupHealthFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
  connectors: readonly ConnectorRead[],
): StreamGroupHealthCounts {
  if (snapshot == null) return { healthy: 0, warning: 0, critical: 0, groups: [] }
  const connectorById = new Map<number, ConnectorRead>()
  for (const c of connectors) connectorById.set(c.id, c)
  const rows: StreamGroupRow[] = (snapshot.streams ?? []).map((s) => {
    const connector = s.connector_id != null ? connectorById.get(s.connector_id) : undefined
    const status =
      !s.enabled
        ? 'STOPPED'
        : s.health_status === 'HEALTHY'
          ? 'RUNNING'
          : s.health_status === 'DEGRADED'
            ? 'DEGRADED'
            : s.health_status === 'ERROR'
              ? 'ERROR'
              : 'STOPPED'
    return {
      connectorName: connector?.name?.trim() || (s.connector_id != null ? `Connector #${s.connector_id}` : s.stream_name),
      connectorProductGroup: connector?.product_group ?? null,
      status,
      openSchemaFieldDriftCount: openSchemaFieldDriftCount(s),
    }
  })
  const groups = groupRowsBySourceProduct(rows)
  let healthy = 0
  let warning = 0
  let critical = 0
  for (const g of groups) {
    if (g.worstStatus === 'ERROR') critical += 1
    else if (g.worstStatus === 'DEGRADED') warning += 1
    else healthy += 1
  }
  return { healthy, warning, critical, groups }
}

export function deriveTrafficOverview(
  observability: ObservabilitySummaryResponse | null,
  dashboard: DashboardSummaryResponse | null,
  windowLabel: string,
): TrafficOverviewMetrics {
  const totals = observability?.totals
  const summary = dashboard?.summary

  const incoming =
    totals?.processed_events != null
      ? safeNonNeg(totals.processed_events)
      : summary?.processed_events != null
        ? safeNonNeg(summary.processed_events)
        : null

  const outgoing =
    totals?.delivery_success_events != null
      ? safeNonNeg(totals.delivery_success_events)
      : summary?.recent_successes != null
        ? safeNonNeg(summary.recent_successes)
        : null

  const success =
    totals?.delivery_success_events != null
      ? safeNonNeg(totals.delivery_success_events)
      : summary?.recent_successes != null
        ? safeNonNeg(summary.recent_successes)
        : 0
  const failed =
    totals?.delivery_failed_events != null
      ? safeNonNeg(totals.delivery_failed_events)
      : summary?.recent_failures != null
        ? safeNonNeg(summary.recent_failures)
        : 0
  const denom = success + failed
  const deliverySuccessRatePct = denom > 0 ? (100 * success) / denom : null

  return { incomingEvents: incoming, outgoingEvents: outgoing, deliverySuccessRatePct, windowLabel }
}

const SNAPSHOT_WINDOW_SECONDS = 300

export function deriveTrafficOverviewFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
): TrafficOverviewMetrics {
  if (snapshot == null) {
    return { incomingEvents: null, outgoingEvents: null, deliverySuccessRatePct: null, windowLabel: '5m' }
  }
  const g = selectGlobalKpi(snapshot)
  const ingestEps = g.eps5m ?? g.eps1m ?? 0
  const incoming = ingestEps > 0 ? Math.round(ingestEps * SNAPSHOT_WINDOW_SECONDS) : null
  const successRate = aggregateDeliverySuccessRateFromSnapshot(snapshot)
  const outgoing =
    incoming != null && successRate != null ? Math.round((incoming * successRate) / 100) : null
  return {
    incomingEvents: incoming,
    outgoingEvents: outgoing,
    deliverySuccessRatePct: successRate,
    windowLabel: '5m',
  }
}

export function deriveOperationalIssues(
  health: HealthOverviewResponse | null,
  dashboard: DashboardSummaryResponse | null,
  streamsList: readonly StreamRead[] = [],
): OperationalIssueCounts {
  const streams = health?.streams
  const summary = dashboard?.summary

  const noDataStreams =
    streams?.excluded_no_outcome != null
      ? safeNonNeg(streams.excluded_no_outcome)
      : streams?.idle != null
        ? safeNonNeg(streams.idle)
        : null

  const lowVolumeStreams =
    streams?.degraded != null
      ? safeNonNeg(streams.degraded)
      : streamsList.length > 0
        ? streamsList.filter((s) => mapBackendStreamStatus(s.status) === 'DEGRADED').length
        : null

  const validation = dashboard?.validation_operational
  const schemaDriftCount = validation
    ? safeNonNeg(validation.open_checkpoint_drift_alerts) +
      safeNonNeg(validation.failing_validations_count) +
      safeNonNeg(validation.degraded_validations_count)
    : null

  const destinationCapacityWarnings =
    summary?.rate_limited_destination_streams != null
      ? safeNonNeg(summary.rate_limited_destination_streams)
      : health?.destinations?.degraded != null
        ? safeNonNeg(health.destinations.degraded)
        : null

  return {
    noDataStreams,
    lowVolumeStreams,
    schemaDriftCount,
    destinationCapacityWarnings,
  }
}

export function deriveOperationalIssuesFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
  _dashboard: DashboardSummaryResponse | null,
): OperationalIssueCounts {
  const streams = snapshot?.streams ?? []
  const idleCount = streams.filter((s) => s.enabled && s.health_status === 'IDLE').length
  const degradedCount = streams.filter((s) => s.enabled && s.health_status === 'DEGRADED').length
  const schemaDriftCount = deriveFleetSchemaDriftFromSnapshot(snapshot).openDriftCount
  const destinationCapacityWarnings = (snapshot?.problems ?? []).filter(
    (p) => p.scope === 'destination' && p.severity === 'warning',
  ).length

  return {
    noDataStreams: idleCount > 0 ? idleCount : null,
    lowVolumeStreams: degradedCount > 0 ? degradedCount : null,
    schemaDriftCount,
    destinationCapacityWarnings: destinationCapacityWarnings > 0 ? destinationCapacityWarnings : null,
  }
}

export function deriveRecentAlertsSummary(alerts: readonly RuntimeAlertSummaryItem[]): RecentAlertsSummary {
  let critical = 0
  let warning = 0
  for (const item of alerts) {
    if (item.severity === 'ERROR') critical += 1
    else warning += 1
  }
  const total = critical + warning
  return { total, critical, warning, hasAlerts: total > 0 }
}

export function formatMetricCount(value: number | null | undefined): string {
  if (value == null) return '—'
  return formatCompactInt(value)
}

export function formatSuccessRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(2)}%`
}

/** Label shown on snapshot-derived rate KPIs (not affected by analytics window). */
export const SNAPSHOT_KPI_BASIS_LABEL = '5m snapshot'

export type DashboardKpiItem = {
  id: string
  label: string
  value: string
  sub: string
  /** Snapshot basis for rate KPIs; omitted when value is window-scoped (e.g. alerts). */
  basisLabel?: string
  tone: 'blue' | 'green' | 'violet' | 'teal' | 'amber' | 'red' | 'neutral'
  sparkline: number[]
  /** Navigation target for click action. */
  href?: string
  /** Active Streams segmented bar data. */
  streamSegments?: { healthy: number; warning: number; failed: number; stopped: number }
  /** Success Rate bullet chart value (0-100). */
  bulletValue?: number
  /** Success Rate bullet chart target (default 99). */
  bulletTarget?: number
  /** Delivery Gap extended data. */
  deliveryGap?: { gapEps: number; gapPct: number; routesHolding: number }
  /** Active Alerts extended data. */
  alertMeta?: { critical: number; warning: number; oldestAgeLabel: string }
}

// ── Overall Health Beacon ──────────────────────────────────────────────────

/** Operator-facing overall health labels (charter: Healthy / Warning / Critical). */
export type OverallHealthBeaconLabel = 'Healthy' | 'Warning' | 'Critical'

export type OverallHealthBeacon = {
  label: OverallHealthBeaconLabel
  description: string
  lastIncidentAt: string | null
  posture: 'healthy' | 'warning' | 'critical'
}

/** Primary operational-issue IDs shown on the Dashboard (detail metrics demoted elsewhere). */
export const PRIMARY_OPERATIONAL_ISSUE_IDS = [
  'no-data',
  'low-volume',
  'schema-drift',
  'capacity-warning',
] as const

// ── System Health Summary Strip ────────────────────────────────────────────

export type SystemHealthSummaryItemId =
  | 'no-data'
  | 'low-volume'
  | 'schema-drift'
  | 'capacity-warning'
  | 'checkpoint-lag'
  | 'replay-queue'

export type SystemHealthSummaryItem = {
  id: SystemHealthSummaryItemId
  label: string
  count: number
  status: 'ok' | 'warning' | 'critical'
}

// ── Stream Health Matrix ───────────────────────────────────────────────────

export type StreamHealthMatrixCellStatus = 'healthy' | 'warning' | 'failed' | 'no-data' | 'not-connected'

export type StreamHealthMatrixCell = {
  status: StreamHealthMatrixCellStatus
  routeCount: number
}

export type StreamHealthMatrixRow = {
  label: string
  streamCount: number
  streamIds: number[]
  cells: StreamHealthMatrixCell[]
}

export type StreamHealthMatrixData = {
  rows: StreamHealthMatrixRow[]
  columns: Array<{ id: number; name: string }>
  totalRows: number
  totalColumns: number
}

// ── Operational Problem Display ────────────────────────────────────────────

export type OperationalProblemDisplay = {
  id: string
  severity: 'warning' | 'critical'
  title: string
  message: string
  lastSeenAt: string | null
  scope: string
  streamId: number | null
  destinationId: number | null
  routeId: number | null
}

export type TrafficChartPoint = {
  label: string
  ingested: number
  delivered: number
  failed: number
}

export type FlowLaneCounts = {
  sources: number
  streams: number
  destinations: number
  routes: number
}

export type FlowCategoryCount = {
  label: string
  count: number
}

export type FlowBreakdown = {
  sources: FlowCategoryCount[]
  streams: number
  destinations: FlowCategoryCount[]
}

export type StreamsOperationalStatus = {
  running: number
  warning: number
  stopped: number
}

export type TopSourceIngestItem = {
  name: string
  rateEps: number
}

export type SystemHealthItem = {
  id: string
  label: string
  status: 'healthy' | 'warning' | 'critical'
  sublabel?: string
}

function windowSeconds(label: string): number {
  switch (label) {
    case '15m':
      return 900
    case '1h':
      return 3600
    case '6h':
      return 21600
    case '24h':
      return 86400
    default:
      return 3600
  }
}

export function deriveFlowLaneCounts(
  observability: ObservabilitySummaryResponse | null,
  dashboard: DashboardSummaryResponse | null,
  streams: readonly StreamRead[],
  connectorCount: number,
  destinationCount = 0,
): FlowLaneCounts {
  const totals = observability?.totals
  const summary = dashboard?.summary
  return {
    sources: connectorCount > 0 ? connectorCount : safeNonNeg(streams.length > 0 ? new Set(streams.map((s) => s.connector_id).filter(Boolean)).size : 0),
    streams: totals?.streams_total ?? summary?.total_streams ?? streams.length,
    destinations:
      summary?.total_destinations != null && summary.total_destinations > 0
        ? summary.total_destinations
        : destinationCount,
    routes: totals?.routes_total ?? summary?.total_routes ?? 0,
  }
}

export function deriveFlowLaneCountsFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
  connectorCount: number,
  destinationCount = 0,
): FlowLaneCounts {
  if (snapshot == null) {
    return { sources: connectorCount, streams: 0, destinations: destinationCount, routes: 0 }
  }
  const g = selectGlobalKpi(snapshot)
  return {
    sources: connectorCount > 0 ? connectorCount : new Set((snapshot.streams ?? []).map((s) => s.connector_id).filter(Boolean)).size,
    streams: g.totalStreams,
    destinations: g.totalDestinations > 0 ? g.totalDestinations : destinationCount,
    routes: g.totalRoutes,
  }
}

type SourceFlowCategory = 'Database' | 'API' | 'Files' | 'Streaming'

function connectorFlowCategory(c: ConnectorRead): SourceFlowCategory {
  const st = String(c.source_type ?? '').toUpperCase()
  const ct = String(c.connector_type ?? '').toLowerCase()
  if (st === 'DATABASE_QUERY' || ct === 'relational_database') return 'Database'
  if (
    st === 'S3' ||
    st === 'S3_OBJECT_POLLING' ||
    st === 'REMOTE_FILE' ||
    st === 'REMOTE_FILE_POLLING' ||
    ct === 's3_compatible' ||
    ct === 'remote_file'
  ) {
    return 'Files'
  }
  if (
    st === 'HTTP_API_POLLING' ||
    st === 'WEBHOOK' ||
    st === 'WEBHOOK_RECEIVER' ||
    ct === 'generic_http' ||
    ct === 'webhook_receiver'
  ) {
    return 'API'
  }
  return 'Streaming'
}

type DestinationFlowCategory = 'Database' | 'Data Lake' | 'API' | 'Warehouse' | 'Streaming'

function destinationFlowCategory(d: DestinationListItem): DestinationFlowCategory {
  switch (d.destination_type) {
    case 'WEBHOOK_POST':
      return 'API'
    case 'SYSLOG_UDP':
    case 'SYSLOG_TCP':
    case 'SYSLOG_TLS':
      return 'Streaming'
    default:
      return 'API'
  }
}

function countByCategory<T extends string>(items: readonly { category: T }[], order: readonly T[]): FlowCategoryCount[] {
  const tallies = new Map<T, number>()
  for (const item of items) tallies.set(item.category, (tallies.get(item.category) ?? 0) + 1)
  return order.map((label) => ({ label, count: tallies.get(label) ?? 0 })).filter((row) => row.count > 0)
}

export function deriveFlowBreakdown(
  observability: ObservabilitySummaryResponse | null,
  dashboard: DashboardSummaryResponse | null,
  streams: readonly StreamRead[],
  connectors: readonly ConnectorRead[],
  destinations: readonly DestinationListItem[],
): FlowBreakdown {
  const totals = observability?.totals
  const summary = dashboard?.summary
  const sourceItems = connectors.map((c) => ({ category: connectorFlowCategory(c) }))
  const destItems = destinations.map((d) => ({ category: destinationFlowCategory(d) }))
  return {
    sources: countByCategory(sourceItems, ['Database', 'API', 'Files', 'Streaming'] as const),
    streams: totals?.streams_total ?? summary?.total_streams ?? streams.length,
    destinations: countByCategory(destItems, ['Database', 'Data Lake', 'API', 'Warehouse', 'Streaming'] as const),
  }
}

/** Flow breakdown: connector/destination catalogs for type labels; stream count from operational snapshot. */
export function deriveFlowBreakdownFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
  connectors: readonly ConnectorRead[],
  destinations: readonly DestinationListItem[],
): FlowBreakdown {
  const sourceItems = connectors.map((c) => ({ category: connectorFlowCategory(c) }))
  const destItems = destinations.map((d) => ({ category: destinationFlowCategory(d) }))
  const streams = snapshot != null ? selectGlobalKpi(snapshot).totalStreams : 0
  return {
    sources: countByCategory(sourceItems, ['Database', 'API', 'Files', 'Streaming'] as const),
    streams,
    destinations: countByCategory(destItems, ['Database', 'Data Lake', 'API', 'Warehouse', 'Streaming'] as const),
  }
}

export function deriveStreamsOperationalStatus(
  dashboard: DashboardSummaryResponse | null,
  streams: readonly StreamRead[],
): StreamsOperationalStatus {
  const summary = dashboard?.summary
  if (summary) {
    return {
      running: safeNonNeg(summary.running_streams),
      warning:
        safeNonNeg(summary.error_streams) +
        safeNonNeg(summary.rate_limited_source_streams) +
        safeNonNeg(summary.rate_limited_destination_streams),
      stopped: safeNonNeg(summary.stopped_streams) + safeNonNeg(summary.paused_streams),
    }
  }
  let running = 0
  let warning = 0
  let stopped = 0
  for (const s of streams) {
    const st = mapBackendStreamStatus(s.status)
    if (st === 'RUNNING') running += 1
    else if (st === 'DEGRADED' || st === 'ERROR') warning += 1
    else if (st === 'STOPPED') stopped += 1
  }
  return { running, warning, stopped }
}

export function deriveStreamsOperationalStatusFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
): StreamsOperationalStatus {
  if (snapshot == null) return { running: 0, warning: 0, stopped: 0 }
  const g = selectGlobalKpi(snapshot)
  const streams = snapshot.streams ?? []
  const running = g.runningStreams > 0 ? g.runningStreams : streams.filter((s) => s.enabled && s.health_status === 'HEALTHY').length
  const warning =
    g.errorStreams > 0
      ? g.errorStreams + streams.filter((s) => s.enabled && s.health_status === 'DEGRADED').length
      : streams.filter((s) => s.enabled && (s.health_status === 'DEGRADED' || s.health_status === 'ERROR')).length
  const stopped = streams.filter((s) => !s.enabled || s.health_status === 'IDLE').length
  return { running, warning, stopped }
}

export function deriveTopSourcesByIngestRate(
  connectors: readonly ConnectorRead[],
  operationalSnapshot: OperationalSnapshotResponse | null,
  observability: ObservabilitySummaryResponse | null,
  limit = 5,
): TopSourceIngestItem[] {
  const connectorNameById = new Map<number, string>()
  for (const c of connectors) {
    connectorNameById.set(c.id, c.name?.trim() || `Connector #${c.id}`)
  }

  if (operationalSnapshot?.streams?.length) {
    // Use eps_5m (same window as KPI strip) with eps_1m as fallback
    const epsByConnector = new Map<number, number>()
    for (const stream of operationalSnapshot.streams) {
      const connectorId = stream.connector_id
      if (connectorId == null) continue
      const eps = safeNonNeg(stream.eps_5m > 0 ? stream.eps_5m : stream.eps_1m)
      epsByConnector.set(connectorId, (epsByConnector.get(connectorId) ?? 0) + eps)
    }
    // Include connectors with 0 EPS so the panel always shows source names
    const ranked = [...epsByConnector.entries()]
      .map(([connectorId, rateEps]) => ({
        name: connectorNameById.get(connectorId) ?? `Connector #${connectorId}`,
        rateEps,
      }))
      .sort((a, b) => b.rateEps - a.rateEps)
      .slice(0, limit)
    if (ranked.length > 0) return ranked
  }

  const totalEps = observability?.totals?.throughput_eps ?? 0
  if (totalEps > 0 && connectors.length === 1) {
    return [{ name: connectorNameById.get(connectors[0].id) ?? `Connector #${connectors[0].id}`, rateEps: totalEps }]
  }

  return []
}

function connectorsStatusFromGroups(groupHealth: StreamGroupHealthCounts | null): SystemHealthItem['status'] {
  if (!groupHealth) return 'warning'
  if (groupHealth.critical > 0) return 'critical'
  if (groupHealth.warning > 0) return 'warning'
  return 'healthy'
}

function workersStatusFromDashboard(dashboard: DashboardSummaryResponse | null): SystemHealthItem['status'] {
  if (dashboard?.runtime_engine_status === 'STOPPED') return 'critical'
  if (dashboard?.runtime_engine_status === 'DEGRADED') return 'warning'
  const workers = dashboard?.active_worker_count
  if (workers != null && workers > 0) return 'healthy'
  if (dashboard?.runtime_engine_status === 'RUNNING') return 'healthy'
  return 'warning'
}

export function deriveSystemHealth(
  health: HealthOverviewResponse | null,
  dashboard: DashboardSummaryResponse | null,
  groupHealth: StreamGroupHealthCounts | null = null,
): SystemHealthItem[] {
  const posture = (counts: { healthy?: number; degraded?: number; unhealthy?: number; critical?: number } | undefined): SystemHealthItem['status'] => {
    if (!counts) return 'warning'
    if (safeNonNeg(counts.critical) + safeNonNeg(counts.unhealthy) > 0) return 'critical'
    if (safeNonNeg(counts.degraded) > 0) return 'warning'
    return 'healthy'
  }
  return [
    { id: 'connectors', label: 'Connectors', status: connectorsStatusFromGroups(groupHealth) },
    { id: 'streams', label: 'Streams', status: posture(health?.streams) },
    { id: 'destinations', label: 'Destinations', status: posture(health?.destinations) },
    { id: 'routes', label: 'Routes', status: posture(health?.routes) },
    { id: 'workers', label: 'Workers', status: workersStatusFromDashboard(dashboard) },
  ]
}

export function deriveSystemHealthFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
  dashboard: DashboardSummaryResponse | null,
  groupHealth: StreamGroupHealthCounts | null = null,
): SystemHealthItem[] {
  const postureFromCounts = (counts: ReturnType<typeof countHealthFromRows>): SystemHealthItem['status'] => {
    if (counts.critical > 0) return 'critical'
    if (counts.warning > 0) return 'warning'
    return 'healthy'
  }
  const streamCounts = countHealthFromRows(snapshot?.streams ?? [])
  const routeCounts = countHealthFromRows(snapshot?.routes ?? [])
  const destCounts = countHealthFromRows(snapshot?.destinations ?? [])
  const totalStreams = snapshot?.global?.total_streams ?? (snapshot?.streams?.length ?? 0)
  const totalDests = snapshot?.global?.total_destinations ?? (snapshot?.destinations?.length ?? 0)
  const totalRoutes = snapshot?.global?.total_routes ?? (snapshot?.routes?.length ?? 0)
  const workerCount = dashboard?.active_worker_count
  const issueCount = (streamCounts.critical + streamCounts.warning)
  return [
    { id: 'connectors', label: 'Connectors', status: connectorsStatusFromGroups(groupHealth) },
    { id: 'streams', label: 'Streams', status: postureFromCounts(streamCounts), sublabel: totalStreams > 0 ? `${totalStreams} total` : undefined },
    { id: 'destinations', label: 'Destinations', status: postureFromCounts(destCounts), sublabel: totalDests > 0 ? `${totalDests} / ${totalDests}` : undefined },
    { id: 'routes', label: 'Routes', status: postureFromCounts(routeCounts), sublabel: totalRoutes > 0 ? `${totalRoutes} paths` : undefined },
    { id: 'workers', label: 'Workers', status: workersStatusFromDashboard(dashboard), sublabel: workerCount != null ? `${workerCount} active` : undefined },
    { id: 'checkpoint', label: 'Checkpoint', status: issueCount > 0 ? 'warning' : 'healthy', sublabel: issueCount > 0 ? `${issueCount} issue${issueCount > 1 ? 's' : ''}` : 'OK' },
  ]
}

export function operationalStatusDonutSlices(
  status: StreamsOperationalStatus,
): Array<{ name: string; value: number; color: string; pct: number }> {
  const total = status.running + status.warning + status.stopped
  if (total <= 0) {
    return [{ name: 'No streams', value: 1, color: '#64748b', pct: 100 }]
  }
  const mk = (name: string, value: number, color: string) => ({
    name,
    value,
    color,
    pct: (100 * value) / total,
  })
  return [
    mk('Running', status.running, '#22c55e'),
    mk('Warning', status.warning, '#f59e0b'),
    mk('Stopped', status.stopped, '#64748b'),
  ].filter((s) => s.value > 0)
}

function formatDeltaPct(current: number, previous: number): string {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    if (current > 0 && previous === 0) return '↗ 100%'
    return '—'
  }
  const pct = ((current - previous) / previous) * 100
  const arrow = pct > 0 ? '↗ ' : pct < 0 ? '↘ ' : ''
  const sign = pct >= 0 ? '+' : ''
  return `${arrow}${sign}${pct.toFixed(1)}%`
}

function sparklineDelta(values: number[]): { current: number; previous: number } {
  if (values.length < 2) {
    const v = values[0] ?? 0
    return { current: v, previous: v }
  }
  return { current: values[values.length - 1] ?? 0, previous: values[0] ?? 0 }
}

export function deriveTrafficChartSeries(
  outcomeTs: DashboardOutcomeTimeseriesResponse | null,
): TrafficChartPoint[] {
  if (!outcomeTs?.buckets?.length) return []
  return outcomeTs.buckets.map((b) => {
    const ts = String(b.bucket_start ?? '')
    const label = ts.length >= 16 ? ts.slice(11, 16) : ts
    const delivered = safeNonNeg(b.success)
    const failed = safeNonNeg(b.failed)
    const ingested = delivered + failed + safeNonNeg(b.rate_limited)
    return { label, ingested, delivered, failed }
  })
}

export function sparklineFromBuckets(outcomeTs: DashboardOutcomeTimeseriesResponse | null): number[] {
  const series = deriveTrafficChartSeries(outcomeTs)
  if (!series.length) return []
  return series.map((p) => p.ingested)
}

export function deriveDashboardKpis(input: {
  observability: ObservabilitySummaryResponse | null
  dashboard: DashboardSummaryResponse | null
  traffic: TrafficOverviewMetrics
  alertsSummary: RecentAlertsSummary
  outcomeTs: DashboardOutcomeTimeseriesResponse | null
  windowLabel: string
}): DashboardKpiItem[] {
  const { observability, dashboard, traffic, alertsSummary, outcomeTs, windowLabel } = input
  const totals = observability?.totals
  const summary = dashboard?.summary
  const winSec = windowSeconds(windowLabel)

  const running = totals?.streams_running ?? summary?.running_streams ?? 0
  const streamsTotal = totals?.streams_total ?? summary?.total_streams ?? running

  const ingestEps =
    totals?.throughput_eps != null && totals.throughput_eps >= 0
      ? totals.throughput_eps
      : traffic.incomingEvents != null && winSec > 0
        ? traffic.incomingEvents / winSec
        : 0

  const deliveryEps =
    totals?.delivery_success_events != null && winSec > 0
      ? totals.delivery_success_events / winSec
      : traffic.outgoingEvents != null && winSec > 0
        ? traffic.outgoingEvents / winSec
        : 0

  const alertSub =
    alertsSummary.critical > 0 || alertsSummary.warning > 0
      ? `${alertsSummary.critical} Critical, ${alertsSummary.warning} Warning`
      : 'No alerts in window'

  const ingestSpark = sparklineFromBuckets(outcomeTs)
  const deliverySpark = deriveTrafficChartSeries(outcomeTs).map((p) => p.delivered)
  const successSpark = deriveTrafficChartSeries(outcomeTs).map((p) =>
    p.delivered + p.failed > 0 ? (100 * p.delivered) / (p.delivered + p.failed) : 0,
  )
  const ingestDelta = sparklineDelta(ingestSpark.length ? ingestSpark : [ingestEps])
  const deliveryDelta = sparklineDelta(deliverySpark.length ? deliverySpark : [deliveryEps])
  const successDelta = sparklineDelta(successSpark.length ? successSpark : [traffic.deliverySuccessRatePct ?? 0])
  const windowCompare = `vs last ${windowLabel}`

  return [
    {
      id: 'active-streams',
      label: 'Active Streams',
      value: String(running),
      sub: `${running} running · ${streamsTotal} total`,
      tone: 'blue',
      sparkline: [],
    },
    {
      id: 'ingest-rate',
      label: 'Ingest Rate',
      value: `${formatThroughputEps(ingestEps)} events/sec`,
      sub: `${formatDeltaPct(ingestDelta.current, ingestDelta.previous)} ${windowCompare}`,
      tone: 'green',
      sparkline: ingestSpark,
    },
    {
      id: 'delivery-rate',
      label: 'Delivery Rate',
      value: `${formatThroughputEps(deliveryEps)} events/sec`,
      sub: `${formatDeltaPct(deliveryDelta.current, deliveryDelta.previous)} ${windowCompare}`,
      tone: 'violet',
      sparkline: deliverySpark,
    },
    {
      id: 'success-rate',
      label: 'Success Rate',
      value: formatSuccessRate(traffic.deliverySuccessRatePct),
      sub: `${formatDeltaPct(successDelta.current, successDelta.previous)} ${windowCompare}`,
      tone: 'teal',
      sparkline: successSpark,
    },
    {
      id: 'active-alerts',
      label: 'Active Alerts',
      value: String(alertsSummary.total),
      sub: alertSub,
      tone: alertsSummary.critical > 0 ? 'red' : alertsSummary.warning > 0 ? 'amber' : 'neutral',
      sparkline: [alertsSummary.total],
    },
  ]
}

function chartTrendSub(
  delta: { current: number; previous: number },
  windowLabel: string | undefined,
): string {
  const trend = formatDeltaPct(delta.current, delta.previous)
  if (trend === '—' || !windowLabel) return ''
  return `${trend} chart trend (${windowLabel})`
}

/**
 * Aggregate actual delivery EPS from route-level delivered_eps_1m fields.
 * Returns null when no routes are present (route data unavailable).
 */
function aggregateDeliveryEpsFromRoutes(snapshot: OperationalSnapshotResponse): number | null {
  const routes = snapshot.routes ?? []
  if (routes.length === 0) return null
  let total = 0
  for (const r of routes) {
    total += safeNonNeg(r.delivered_eps_1m)
  }
  return total
}

export function deriveDashboardKpisFromSnapshot(input: {
  snapshot: OperationalSnapshotResponse | null
  alertsSummary: RecentAlertsSummary
  /** When true, alerts API failed and data is unavailable (not genuinely 0). */
  alertsFailed?: boolean
  outcomeTs: DashboardOutcomeTimeseriesResponse | null
  /** Analytics window — affects chart sparklines only, not snapshot KPI values. */
  chartWindowLabel?: string
  /** Full alert items for oldest-age calculation. */
  alertsItems?: readonly import('../../api/types/gdcApi').RuntimeAlertSummaryItem[]
}): DashboardKpiItem[] {
  const { snapshot, alertsSummary, alertsFailed, outcomeTs, chartWindowLabel, alertsItems } = input
  if (snapshot == null) return []
  const g = selectGlobalKpi(snapshot)
  const traffic = deriveTrafficOverviewFromSnapshot(snapshot)
  const running = g.runningStreams
  const ingestEps = g.eps5m ?? g.eps1m ?? 0
  // Use actual delivery EPS from routes (delivered_eps_1m). Null = no routes configured.
  const deliveryEpsRaw = aggregateDeliveryEpsFromRoutes(snapshot)

  // ── Stream segments (active-streams card) ──
  const streamSnaps = snapshot.streams ?? []
  const streamSegments = {
    healthy: streamSnaps.filter((s) => s.enabled && s.health_status === 'HEALTHY').length,
    warning: streamSnaps.filter((s) => s.enabled && s.health_status === 'DEGRADED').length,
    failed: streamSnaps.filter((s) => s.enabled && s.health_status === 'ERROR').length,
    stopped: streamSnaps.filter((s) => !s.enabled || s.health_status === 'IDLE').length,
  }

  // ── Delivery Gap ──
  const deliveryEps = deliveryEpsRaw ?? 0
  const gapEps = Math.max(0, ingestEps - deliveryEps)
  const gapPct = ingestEps > 0 ? (gapEps / ingestEps) * 100 : 0
  const routesHolding = (snapshot.routes ?? []).filter((r) => r.health_status === 'ERROR').length
  const gapTone: DashboardKpiItem['tone'] =
    gapPct >= 5 ? 'red' : gapPct >= 1 ? 'amber' : 'neutral'

  // ── Success Rate bullet chart ──
  const successRatePct = traffic.deliverySuccessRatePct
  const bulletTarget = 99

  // ── Alert oldest age ──
  let oldestAgeLabel = '—'
  if (alertsItems && alertsItems.length > 0) {
    const oldest = alertsItems.reduce((a, b) =>
      (a.latest_occurrence ?? '') < (b.latest_occurrence ?? '') ? a : b,
    )
    if (oldest.latest_occurrence) {
      const diffMin = Math.max(0, Math.floor((Date.now() - new Date(oldest.latest_occurrence).getTime()) / 60_000))
      oldestAgeLabel = diffMin < 60 ? `${diffMin}m` : `${Math.floor(diffMin / 60)}h ${diffMin % 60}m`
    }
  }

  const alertSub = alertsFailed
    ? 'Alerts unavailable'
    : alertsSummary.critical > 0 || alertsSummary.warning > 0
      ? `${alertsSummary.critical} Critical, ${alertsSummary.warning} Warning`
      : 'No alerts in window'

  const ingestSpark = sparklineFromBuckets(outcomeTs)
  const deliverySpark = deriveTrafficChartSeries(outcomeTs).map((p) => p.delivered)
  const successSpark = deriveTrafficChartSeries(outcomeTs).map((p) =>
    p.delivered + p.failed > 0 ? (100 * p.delivered) / (p.delivered + p.failed) : 0,
  )
  const gapSpark = ingestSpark.map((ing, i) => Math.max(0, ing - (deliverySpark[i] ?? 0)))
  const ingestTrend = chartTrendSub(sparklineDelta(ingestSpark), chartWindowLabel)
  const deliveryTrend = chartTrendSub(sparklineDelta(deliverySpark), chartWindowLabel)
  const successTrend = chartTrendSub(sparklineDelta(successSpark), chartWindowLabel)

  // Delivery Rate: use real route data; null means no routes → show "—"
  const deliveryEpsDisplay =
    deliveryEpsRaw != null ? formatOperationalEps(deliveryEpsRaw, 'events/sec') : '—'
  const deliveryBasisLabel =
    deliveryEpsRaw != null ? SNAPSHOT_KPI_BASIS_LABEL : 'No route data'

  return [
    {
      id: 'active-streams',
      label: 'Active Streams',
      value: String(running),
      sub: `${streamSegments.healthy} Healthy · ${streamSegments.warning} Warning · ${streamSegments.failed} Failed`,
      basisLabel: 'Live snapshot',
      tone: streamSegments.failed > 0 ? 'red' : streamSegments.warning > 0 ? 'amber' : 'blue',
      sparkline: [],
      href: '/streams',
      streamSegments,
    },
    {
      id: 'ingest-rate',
      label: 'Ingest Rate',
      value: formatOperationalEps(ingestEps, 'events/sec'),
      sub: ingestTrend,
      basisLabel: SNAPSHOT_KPI_BASIS_LABEL,
      tone: 'green',
      sparkline: ingestSpark,
      href: '/streams',
    },
    {
      id: 'delivery-rate',
      label: 'Delivery Rate',
      value: deliveryEpsDisplay,
      sub: deliveryTrend,
      basisLabel: deliveryBasisLabel,
      tone: 'violet',
      sparkline: deliverySpark,
      href: '/destinations',
    },
    {
      id: 'delivery-gap',
      label: 'Delivery Gap',
      value: ingestEps > 0 ? formatOperationalEps(gapEps, 'events/sec') : '—',
      sub: ingestEps > 0 ? `${gapPct.toFixed(1)}% gap · ${routesHolding} routes holding` : 'No ingest data',
      basisLabel: SNAPSHOT_KPI_BASIS_LABEL,
      tone: gapTone,
      sparkline: gapSpark,
      href: '/destinations',
      deliveryGap: { gapEps, gapPct, routesHolding },
    },
    {
      id: 'success-rate',
      label: 'Success Rate',
      value: formatOperationalSuccessRate(successRatePct),
      sub: successTrend,
      basisLabel: SNAPSHOT_KPI_BASIS_LABEL,
      tone: successRatePct != null && successRatePct >= bulletTarget ? 'teal' : successRatePct != null && successRatePct >= 90 ? 'amber' : 'red',
      sparkline: successSpark,
      href: '/destinations',
      bulletValue: successRatePct ?? undefined,
      bulletTarget,
    },
    {
      id: 'active-alerts',
      label: 'Active Alerts',
      value: alertsFailed ? '—' : String(alertsSummary.total),
      sub: alertSub,
      tone: alertsFailed ? 'neutral' : alertsSummary.critical > 0 ? 'red' : alertsSummary.warning > 0 ? 'amber' : 'neutral',
      sparkline: alertsFailed ? [] : [alertsSummary.total],
      alertMeta: {
        critical: alertsSummary.critical,
        warning: alertsSummary.warning,
        oldestAgeLabel,
      },
    },
  ]
}

export function donutSlicesFromCounts(
  healthy: number,
  warning: number,
  critical: number,
): Array<{ name: string; value: number; color: string; pct: number }> {
  const total = healthy + warning + critical
  if (total <= 0) {
    return [{ name: 'No groups', value: 1, color: '#64748b', pct: 100 }]
  }
  const mk = (name: string, value: number, color: string) => ({
    name,
    value,
    color,
    pct: (100 * value) / total,
  })
  return [
    mk('Healthy', healthy, '#22c55e'),
    mk('Warning', warning, '#f59e0b'),
    mk('Critical', critical, '#ef4444'),
  ].filter((s) => s.value > 0)
}

export function streamStatusDonutSlicesFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
): Array<{ name: string; value: number; color: string; pct: number }> {
  if (snapshot == null) return donutSlicesFromCounts(0, 0, 0)
  const counts = countHealthFromRows(snapshot.streams ?? [])
  return donutSlicesFromCounts(counts.healthy, counts.warning, counts.critical)
}

export function streamStatusDonutSlices(health: HealthOverviewResponse | null): Array<{ name: string; value: number; color: string; pct: number }> {
  const s = health?.streams
  return donutSlicesFromCounts(safeNonNeg(s?.healthy), safeNonNeg(s?.degraded), safeNonNeg(s?.unhealthy) + safeNonNeg(s?.critical))
}

// ── Overall Health Beacon ──────────────────────────────────────────────────

export function deriveOverallHealthBeacon(
  snapshot: OperationalSnapshotResponse | null,
  alertsSummary: RecentAlertsSummary,
): OverallHealthBeacon {
  if (snapshot == null) {
    return { label: 'Healthy', description: 'Loading operational state…', lastIncidentAt: null, posture: 'healthy' }
  }

  const globalHealth = snapshot.global.health_status
  const problems = snapshot.problems ?? []
  const criticalProblems = problems.filter((p) => p.severity === 'critical')
  const warningProblems = problems.filter((p) => p.severity === 'warning')

  const latestProblemAt =
    problems.length > 0
      ? problems.reduce<string | null>((acc, p) => {
          if (!p.last_seen_at) return acc
          if (!acc) return p.last_seen_at
          return p.last_seen_at > acc ? p.last_seen_at : acc
        }, null)
      : null

  let label: OverallHealthBeaconLabel
  let description: string
  let posture: OverallHealthBeacon['posture']

  if (alertsSummary.critical > 0 || globalHealth === 'ERROR' || criticalProblems.length > 0) {
    label = 'Critical'
    const firstCritical = criticalProblems[0]
    description = firstCritical ? firstCritical.title : 'Critical delivery issues detected'
    posture = 'critical'
  } else if (alertsSummary.warning > 0 || globalHealth === 'DEGRADED' || warningProblems.length > 0) {
    label = 'Warning'
    description = warningProblems[0]?.title ?? 'Some delivery paths are degraded'
    posture = 'warning'
  } else {
    label = 'Healthy'
    description = 'All delivery paths healthy'
    posture = 'healthy'
  }

  return { label, description, lastIncidentAt: latestProblemAt, posture }
}

// ── System Health Summary Strip ────────────────────────────────────────────

export function deriveSystemHealthSummaryStrip(
  snapshot: OperationalSnapshotResponse | null,
  _dashboard: DashboardSummaryResponse | null,
): SystemHealthSummaryItem[] {
  const streams = snapshot?.streams ?? []
  const problems = snapshot?.problems ?? []

  const noDataCount = streams.filter((s) => s.enabled && s.health_status === 'IDLE').length
  const lowVolumeCount = streams.filter((s) => s.enabled && s.health_status === 'DEGRADED').length
  const schemaDriftCount = deriveFleetSchemaDriftFromSnapshot(snapshot).openDriftCount

  const capacityWarningCount = problems.filter(
    (p) => p.scope === 'destination' && p.severity === 'warning',
  ).length

  const checkpointLagCount =
    streams.filter((s) => s.enabled && s.checkpoint_lag_seconds != null && s.checkpoint_lag_seconds > 300).length +
    problems.filter((p) => {
      const t = p.title.toLowerCase()
      return t.includes('checkpoint') || t.includes('lag')
    }).length

  const all: SystemHealthSummaryItem[] = [
    {
      id: 'no-data',
      label: 'No Data Streams',
      count: noDataCount,
      status: noDataCount > 0 ? 'critical' : 'ok',
    },
    {
      id: 'low-volume',
      label: 'Low Volume Streams',
      count: lowVolumeCount,
      status: lowVolumeCount > 0 ? 'warning' : 'ok',
    },
    {
      id: 'schema-drift',
      label: 'Schema Drift',
      count: schemaDriftCount,
      status: schemaDriftCount > 0 ? 'warning' : 'ok',
    },
    {
      id: 'capacity-warning',
      label: 'Capacity Warning',
      count: capacityWarningCount,
      status: capacityWarningCount > 0 ? 'warning' : 'ok',
    },
    {
      id: 'checkpoint-lag',
      label: 'Checkpoint Lag',
      count: checkpointLagCount,
      status: checkpointLagCount > 0 ? 'warning' : 'ok',
    },
    {
      id: 'replay-queue',
      label: 'Replay Queue',
      count: 0,
      status: 'ok',
    },
  ]
  return all
}

/** Primary Dashboard operational issues only (checkpoint / replay demoted from primary). */
export function derivePrimaryOperationalIssueStrip(
  snapshot: OperationalSnapshotResponse | null,
  dashboard: DashboardSummaryResponse | null,
): SystemHealthSummaryItem[] {
  const primary = new Set<string>(PRIMARY_OPERATIONAL_ISSUE_IDS)
  return deriveSystemHealthSummaryStrip(snapshot, dashboard).filter((item) => primary.has(item.id))
}

/**
 * Charter primary traffic KPIs from the operational snapshot (no mock values).
 * Incoming / Outgoing are estimated event counts over the 5m snapshot window.
 */
export function derivePrimaryTrafficKpisFromSnapshot(
  snapshot: OperationalSnapshotResponse | null,
): DashboardKpiItem[] {
  const traffic = deriveTrafficOverviewFromSnapshot(snapshot)
  const successRatePct = traffic.deliverySuccessRatePct
  const bulletTarget = 99
  return [
    {
      id: 'incoming-events',
      label: 'Incoming Events',
      value: formatMetricCount(traffic.incomingEvents),
      sub: traffic.incomingEvents == null ? 'No ingest in window' : `${SNAPSHOT_KPI_BASIS_LABEL} estimate`,
      basisLabel: SNAPSHOT_KPI_BASIS_LABEL,
      tone: 'green',
      sparkline: [],
      href: '/streams',
    },
    {
      id: 'outgoing-events',
      label: 'Outgoing Events',
      value: formatMetricCount(traffic.outgoingEvents),
      sub: traffic.outgoingEvents == null ? 'No delivery in window' : `${SNAPSHOT_KPI_BASIS_LABEL} estimate`,
      basisLabel: SNAPSHOT_KPI_BASIS_LABEL,
      tone: 'violet',
      sparkline: [],
      href: '/destinations',
    },
    {
      id: 'success-rate',
      label: 'Delivery Success Rate',
      value: formatOperationalSuccessRate(successRatePct),
      sub: successRatePct == null ? 'No delivery outcomes' : `Target ${bulletTarget}%`,
      basisLabel: SNAPSHOT_KPI_BASIS_LABEL,
      tone:
        successRatePct != null && successRatePct >= bulletTarget
          ? 'teal'
          : successRatePct != null && successRatePct >= 90
            ? 'amber'
            : 'red',
      sparkline: [],
      href: '/destinations',
      bulletValue: successRatePct ?? undefined,
      bulletTarget,
    },
  ]
}

// ── Stream Health Matrix ───────────────────────────────────────────────────

const STATUS_PRIORITY: Record<string, number> = { HEALTHY: 0, IDLE: 1, DEGRADED: 2, ERROR: 3 }

function worstStatus(a: string | null, b: string): string {
  if (a == null) return b
  return (STATUS_PRIORITY[b] ?? 0) > (STATUS_PRIORITY[a] ?? 0) ? b : a
}

function cellStatusFromHealthStatus(s: string | null, routeCount: number): StreamHealthMatrixCellStatus {
  if (routeCount === 0) return 'not-connected'
  if (s === 'ERROR') return 'failed'
  if (s === 'DEGRADED') return 'warning'
  if (s === 'IDLE') return 'no-data'
  return 'healthy'
}

export function deriveStreamHealthMatrix(
  snapshot: OperationalSnapshotResponse | null,
  connectors: readonly ConnectorRead[],
): StreamHealthMatrixData {
  if (snapshot == null) return { rows: [], columns: [], totalRows: 0, totalColumns: 0 }

  const connectorMap = new Map<number, ConnectorRead>()
  for (const c of connectors) connectorMap.set(c.id, c)

  // Group enabled streams by source product group label
  const groupMap = new Map<string, number[]>()
  for (const s of snapshot.streams ?? []) {
    if (!s.enabled) continue
    const connector = s.connector_id != null ? connectorMap.get(s.connector_id) : undefined
    const groupLabel =
      connector?.product_group?.trim() ||
      connector?.name?.trim() ||
      (s.connector_id != null ? `Connector #${s.connector_id}` : s.stream_name)
    const existing = groupMap.get(groupLabel)
    if (existing) {
      existing.push(s.stream_id)
    } else {
      groupMap.set(groupLabel, [s.stream_id])
    }
  }

  // Top 7 groups by stream count
  const topGroups = [...groupMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 7)

  // Top 5 destinations by inbound EPS, then by route count
  const allDestinations = snapshot.destinations ?? []
  const topDestinations = [...allDestinations]
    .sort((a, b) => b.inbound_eps_1m - a.inbound_eps_1m || b.route_count - a.route_count)
    .slice(0, 5)

  // Build route lookup: `${stream_id}:${destination_id}` → worst health_status string
  const routeWorst = new Map<string, string>()
  for (const r of snapshot.routes ?? []) {
    if (r.destination_id == null) continue
    const key = `${r.stream_id}:${r.destination_id}`
    routeWorst.set(key, worstStatus(routeWorst.get(key) ?? null, r.health_status))
  }

  // Build matrix rows
  const rows: StreamHealthMatrixRow[] = topGroups.map(([label, streamIds]) => {
    const cells: StreamHealthMatrixCell[] = topDestinations.map((dest) => {
      let cellWorst: string | null = null
      let routeCount = 0
      for (const sid of streamIds) {
        const key = `${sid}:${dest.destination_id}`
        const status = routeWorst.get(key)
        if (status != null) {
          routeCount++
          cellWorst = worstStatus(cellWorst, status)
        }
      }
      return { status: cellStatusFromHealthStatus(cellWorst, routeCount), routeCount }
    })
    return { label, streamCount: streamIds.length, streamIds, cells }
  })

  return {
    rows,
    columns: topDestinations.map((d) => ({ id: d.destination_id, name: d.destination_name })),
    totalRows: groupMap.size,
    totalColumns: allDestinations.length,
  }
}

// ── Operational Problems (individual issue list) ───────────────────────────

export function deriveOperationalProblems(
  snapshot: OperationalSnapshotResponse | null,
): OperationalProblemDisplay[] {
  if (snapshot == null) return []
  return (snapshot.problems ?? []).slice(0, 5).map((p, i) => ({
    id: `problem-${i}-${p.last_seen_at ?? i}`,
    severity: p.severity,
    title: p.title,
    message: p.message,
    lastSeenAt: p.last_seen_at,
    scope: p.scope,
    streamId: p.stream_id,
    destinationId: p.destination_id,
    routeId: p.route_id,
  }))
}
