import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import type { PolicyActionType, PolicyConditionJson, PolicyRule } from './gdcPolicy'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type RoutePolicyRule = PolicyRule & {
  route_id: number
}

export type RoutePolicyRulesResponse = {
  route_id: number
  stream_id: number
  rules: RoutePolicyRule[]
  rule_count: number
}

export type RoutePolicyEffective = {
  route_id: number
  stream_id: number
  persisted_source: 'route' | 'stream'
  fallback_used: boolean
  rule_count: number
  processing_status: 'Inherited' | 'Overridden' | 'Mixed'
}

export async function fetchRoutePolicyRules(
  routeId: number,
  enabledOnly = false,
): Promise<RoutePolicyRulesResponse | null> {
  const q = enabledOnly ? '?enabled_only=true' : ''
  return safeRequestJson<RoutePolicyRulesResponse>(
    `${RT}/routes/${routeId}/policy-rules${q}`,
    readJsonOpts,
  )
}

export async function createRoutePolicyRule(
  routeId: number,
  body: {
    name: string
    enabled?: boolean
    condition_json: PolicyConditionJson
    action_type?: PolicyActionType
  },
): Promise<{ rule: RoutePolicyRule } | null> {
  return requestJson(`${RT}/routes/${routeId}/policy-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchRoutePolicyRule(
  routeId: number,
  ruleId: number,
  body: {
    name?: string
    enabled?: boolean
    condition_json?: PolicyConditionJson
    action_type?: PolicyActionType
  },
): Promise<{ rule: RoutePolicyRule } | null> {
  return requestJson(`${RT}/routes/${routeId}/policy-rules/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteRoutePolicyRule(routeId: number, ruleId: number): Promise<void> {
  await requestJson(`${RT}/routes/${routeId}/policy-rules/${ruleId}`, {
    method: 'DELETE',
  })
}

export async function fetchRoutePolicyEffective(
  routeId: number,
  options?: GdcSignalOptions,
): Promise<RoutePolicyEffective | null> {
  return safeRequestJson<RoutePolicyEffective>(
    `${RT}/routes/${routeId}/policy/effective`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}
