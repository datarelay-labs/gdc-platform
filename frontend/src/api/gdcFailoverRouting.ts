import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type FailoverRoute = {
  id: number
  stream_id: number
  primary_destination_id: number
  primary_destination_name: string | null
  secondary_destination_id: number
  secondary_destination_name: string | null
  enabled: boolean
  policy: string
  created_at: string
  updated_at: string
}

export type StreamFailoverRoutesResponse = {
  stream_id: number
  routes: FailoverRoute[]
  route_count: number
}

export type StreamFailoverRoutingSummaryResponse = {
  stream_id: number
  total_failover_routes: number
  failover_attempts: number
  failover_successes: number
  failover_failures: number
  last_evaluated_at: string | null
}

export async function fetchStreamFailoverRoutes(
  streamId: number,
  enabledOnly = false,
): Promise<StreamFailoverRoutesResponse | null> {
  const q = enabledOnly ? '?enabled_only=true' : ''
  return safeRequestJson<StreamFailoverRoutesResponse>(
    `${RT}/streams/${streamId}/failover-routes${q}`,
    readJsonOpts,
  )
}

export async function fetchStreamFailoverRoutingSummary(
  streamId: number,
  options?: GdcSignalOptions,
): Promise<StreamFailoverRoutingSummaryResponse | null> {
  return safeRequestJson<StreamFailoverRoutingSummaryResponse>(
    `${RT}/streams/${streamId}/failover-routing/summary`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export async function createFailoverRoute(
  streamId: number,
  body: {
    primary_destination_id: number
    secondary_destination_id: number
    enabled?: boolean
  },
): Promise<{ route: FailoverRoute } | null> {
  return requestJson(`${RT}/streams/${streamId}/failover-routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchFailoverRoute(
  streamId: number,
  routeId: number,
  body: {
    primary_destination_id?: number
    secondary_destination_id?: number
    enabled?: boolean
  },
): Promise<{ route: FailoverRoute } | null> {
  return requestJson(`${RT}/streams/${streamId}/failover-routes/${routeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
