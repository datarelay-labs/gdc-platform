import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type DynamicRoute = {
  id: number
  stream_id: number
  name: string
  enabled: boolean
  condition_json: { sensitivity_class?: string; classification_level?: string }
  route_id: number | null
  route_name: string | null
  destination_id: number
  destination_name: string | null
  created_at: string
  updated_at: string
}

export type StreamDynamicRoutesResponse = {
  stream_id: number
  routes: DynamicRoute[]
  route_count: number
}

export type StreamDynamicRoutingSummaryResponse = {
  stream_id: number
  total_dynamic_routes: number
  matched_dynamic_routes: number
  dynamic_deliveries: number
  last_evaluated_at: string | null
}

export async function fetchStreamDynamicRoutes(
  streamId: number,
  enabledOnly = false,
): Promise<StreamDynamicRoutesResponse | null> {
  const q = enabledOnly ? '?enabled_only=true' : ''
  return safeRequestJson<StreamDynamicRoutesResponse>(
    `${RT}/streams/${streamId}/dynamic-routes${q}`,
    readJsonOpts,
  )
}

export async function fetchStreamDynamicRoutingSummary(
  streamId: number,
  options?: GdcSignalOptions,
): Promise<StreamDynamicRoutingSummaryResponse | null> {
  return safeRequestJson<StreamDynamicRoutingSummaryResponse>(
    `${RT}/streams/${streamId}/dynamic-routing/summary`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export async function createDynamicRoute(
  streamId: number,
  body: {
    name: string
    enabled?: boolean
    condition_json: { sensitivity_class?: string; classification_level?: string }
    route_id?: number
    destination_id?: number
  },
): Promise<{ route: DynamicRoute } | null> {
  return requestJson(`${RT}/streams/${streamId}/dynamic-routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchDynamicRoute(
  streamId: number,
  routeId: number,
  body: {
    name?: string
    enabled?: boolean
    condition_json?: { sensitivity_class?: string; classification_level?: string }
    route_id?: number
    destination_id?: number
  },
): Promise<{ route: DynamicRoute } | null> {
  return requestJson(`${RT}/streams/${streamId}/dynamic-routes/${routeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
