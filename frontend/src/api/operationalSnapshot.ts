import { GDC_CRITICAL_READ_JSON_TIMEOUT_MS, safeRequestJson } from '../api'
import {
  canUseOperationalFixture,
  clearOperationalSnapshotFixtureCache,
  getRuntimeFixtureFileName,
  loadOperationalSnapshotFixture,
} from '../lib/runtime-operational-fixture-mode'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { cachedRequest, clearSharedRequestCache } from './requestCache'

const RT = `${GDC_API_PREFIX}/runtime`
const readJsonOpts = { timeoutMs: GDC_CRITICAL_READ_JSON_TIMEOUT_MS }
const SNAPSHOT_CACHE_TTL_MS = 30_000
const SNAPSHOT_CACHE_NAMESPACE = 'operational-snapshot'

export type OperationalHealthStatus = 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'IDLE'
export type OperationalProblemSeverity = 'warning' | 'critical'
export type OperationalProblemScope = 'stream' | 'route' | 'destination' | 'global'

export type OperationalGlobalSnapshot = {
  health_status: OperationalHealthStatus
  total_streams: number
  enabled_streams: number
  running_streams: number
  error_streams: number
  total_routes: number
  enabled_routes: number
  total_destinations: number
  enabled_destinations: number
  total_eps_1m: number
  total_eps_5m: number
  avg_latency_ms: number | null
  last_activity_at: string | null
}

export type OperationalStreamSnapshot = {
  stream_id: number
  stream_name: string
  connector_id: number | null
  source_id: number | null
  enabled: boolean
  status: string | null
  health_status: OperationalHealthStatus
  eps_1m: number
  eps_5m: number
  success_rate_5m: number
  failure_rate_5m: number
  avg_latency_ms: number | null
  route_count: number
  healthy_route_count: number
  failed_route_count: number
  last_success_at: string | null
  last_error_at: string | null
  last_error_message: string | null
  checkpoint_updated_at: string | null
  checkpoint_lag_seconds: number | null
  /** Confirmed open StreamSchemaFieldDrift rows for this stream. */
  open_schema_field_drift_count?: number
}

export type OperationalRouteSnapshot = {
  route_id: number
  stream_id: number
  stream_name: string | null
  destination_id: number | null
  destination_name: string | null
  destination_type: string | null
  enabled: boolean
  failure_policy: string | null
  health_status: OperationalHealthStatus
  delivered_eps_1m: number
  failed_eps_1m: number
  success_rate_5m: number
  retry_rate_5m: number
  avg_latency_ms: number | null
  last_success_at: string | null
  last_error_at: string | null
  last_error_message: string | null
}

export type OperationalDestinationSnapshot = {
  destination_id: number
  destination_name: string
  destination_type: string | null
  enabled: boolean
  health_status: OperationalHealthStatus
  inbound_eps_1m: number
  failed_eps_1m: number
  avg_latency_ms: number | null
  route_count: number
  last_success_at: string | null
  last_error_at: string | null
  last_error_message: string | null
}

export type OperationalProblem = {
  severity: OperationalProblemSeverity
  scope: OperationalProblemScope
  stream_id: number | null
  route_id: number | null
  destination_id: number | null
  title: string
  message: string
  last_seen_at: string | null
}

export type OperationalSnapshotResponse = {
  global: OperationalGlobalSnapshot
  streams: OperationalStreamSnapshot[]
  routes: OperationalRouteSnapshot[]
  destinations: OperationalDestinationSnapshot[]
  problems: OperationalProblem[]
  updated_at: string
}

export function operationalSnapshotRequestKey(): string {
  return 'latest'
}

function logDevTiming(startedAt: number): void {
  if (!import.meta.env.DEV) return
  const elapsedMs =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now() - startedAt
      : Date.now() - startedAt
  console.info('[observability] operational snapshot fetch ms', { elapsed_ms: Math.round(elapsedMs) })
}

async function fetchOperationalSnapshotUncached(): Promise<OperationalSnapshotResponse | null> {
  return safeRequestJson<OperationalSnapshotResponse>(`${RT}/operational-snapshot`, readJsonOpts)
}

export function clearOperationalSnapshotCache(key?: string): void {
  clearSharedRequestCache(SNAPSHOT_CACHE_NAMESPACE, key)
  clearOperationalSnapshotFixtureCache()
}

async function fetchOperationalSnapshotResolved(): Promise<OperationalSnapshotResponse | null> {
  if (await canUseOperationalFixture()) {
    const fixture = await loadOperationalSnapshotFixture()
    if (fixture != null) return fixture
  }
  return fetchOperationalSnapshotUncached()
}

export async function getOperationalSnapshot(): Promise<OperationalSnapshotResponse | null> {
  const fixtureActive = await canUseOperationalFixture()
  const key = fixtureActive ? `fixture:${getRuntimeFixtureFileName()}` : operationalSnapshotRequestKey()
  const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  return cachedRequest(SNAPSHOT_CACHE_NAMESPACE, key, fetchOperationalSnapshotResolved, {
    ttlMs: SNAPSHOT_CACHE_TTL_MS,
  }).finally(() => logDevTiming(startedAt))
}
