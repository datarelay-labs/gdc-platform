import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type PolicyActionType = 'audit_only' | 'quarantine' | 'block' | 'require_review'

export type PolicyConditionJson = {
  sensitivity_class?: string
  classification_level?: string
}

export type PolicyRule = {
  id: number
  stream_id: number
  name: string
  enabled: boolean
  condition_json: PolicyConditionJson
  action_type: PolicyActionType
  created_at: string
  updated_at: string
}

export type StreamPolicyRulesResponse = {
  stream_id: number
  rules: PolicyRule[]
  rule_count: number
}

export type StreamPolicySummaryResponse = {
  stream_id: number
  total_policies: number
  matched_policies: number
  audit_events: number
  enabled_policy_count: number
  disabled_policy_count: number
  last_evaluated_at: string | null
}

export async function fetchStreamPolicyRules(
  streamId: number,
  enabledOnly = false,
): Promise<StreamPolicyRulesResponse | null> {
  const q = enabledOnly ? '?enabled_only=true' : ''
  return safeRequestJson<StreamPolicyRulesResponse>(
    `${RT}/streams/${streamId}/policy-rules${q}`,
    readJsonOpts,
  )
}

export async function fetchStreamPolicySummary(
  streamId: number,
  options?: GdcSignalOptions,
): Promise<StreamPolicySummaryResponse | null> {
  return safeRequestJson<StreamPolicySummaryResponse>(
    `${RT}/streams/${streamId}/policy/summary`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export async function createPolicyRule(
  streamId: number,
  body: {
    name: string
    enabled?: boolean
    condition_json: PolicyConditionJson
    action_type?: PolicyActionType
  },
): Promise<{ rule: PolicyRule } | null> {
  return requestJson(`${RT}/streams/${streamId}/policy-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchPolicyRule(
  streamId: number,
  ruleId: number,
  body: {
    name?: string
    enabled?: boolean
    condition_json?: PolicyConditionJson
    action_type?: PolicyActionType
  },
): Promise<{ rule: PolicyRule } | null> {
  return requestJson(`${RT}/streams/${streamId}/policy-rules/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
