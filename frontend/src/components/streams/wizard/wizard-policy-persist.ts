import {
  createPolicyRule,
  fetchStreamPolicyRules,
  patchPolicyRule,
  type PolicyActionType,
  type PolicyRule,
} from '../../../api/gdcPolicy'
import {
  createRoutePolicyRule,
  deleteRoutePolicyRule,
  fetchRoutePolicyRules,
  patchRoutePolicyRule,
  type RoutePolicyRule,
} from '../../../api/gdcRoutePolicy'
import {
  normalizeWizardPolicyLevelResponse,
  wizardRoutePolicyLevelDiffs,
  type WizardDataPolicyState,
  type WizardPolicyDeliveryBehavior,
  type WizardRouteDraft,
  type WizardRoutePolicyOverride,
  type WizardState,
} from './wizard-state'

export const WIZARD_RESTRICTED_POLICY_NAME = 'Wizard: RESTRICTED policy'
export const WIZARD_CONFIDENTIAL_POLICY_NAME = 'Wizard: CONFIDENTIAL policy'

export type PolicyPersistResult = {
  saved: boolean
  streamRulesUpserted: number
  routeRulesUpserted: number
  errors: string[]
}

type ClassificationLevelPolicy = 'RESTRICTED' | 'CONFIDENTIAL'

type PolicyRuleSpec = {
  name: string
  level: ClassificationLevelPolicy
  actionType: PolicyActionType
}

const POLICY_RESPONSE_TO_ACTION: Record<WizardPolicyDeliveryBehavior, PolicyActionType> = {
  continue: 'audit_only',
  require_review: 'require_review',
  quarantine: 'quarantine',
  block: 'block',
}

/**
 * Map Policy UI delivery control → Policy Engine action_type.
 * Protection actions (mask/tokenize/hash/remove/drop_field) are rejected — never silently coerced to audit_only.
 */
export function dataPolicyResponseToActionType(
  response: WizardPolicyDeliveryBehavior | string,
): PolicyActionType {
  if (
    response === 'mask' ||
    response === 'tokenize' ||
    response === 'hash' ||
    response === 'remove' ||
    response === 'drop_field' ||
    response === 'mask_partial' ||
    response === 'mask_full'
  ) {
    throw new Error(
      `Protection action "${String(response)}" is not a Policy action; configure it under Data Protection`,
    )
  }
  return POLICY_RESPONSE_TO_ACTION[normalizeWizardPolicyLevelResponse(response)]
}

/** Safe persist mapping: only Policy delivery values; legacy audit/mask already normalized upstream. */
export function dataPolicyResponseToActionTypeSafe(
  response: WizardPolicyDeliveryBehavior | string | undefined,
): PolicyActionType {
  return POLICY_RESPONSE_TO_ACTION[normalizeWizardPolicyLevelResponse(response)]
}

export function actionTypeToPolicyResponse(
  actionType: string | undefined,
): WizardPolicyDeliveryBehavior | null {
  if (actionType === 'block') return 'block'
  if (actionType === 'quarantine') return 'quarantine'
  if (actionType === 'require_review') return 'require_review'
  if (actionType === 'audit_only') return 'continue'
  return null
}

/** @deprecated use actionTypeToPolicyResponse — kept for call sites that typed restricted. */
export function actionTypeToRestrictedResponse(
  actionType: string | undefined,
): WizardDataPolicyState['restrictedResponse'] {
  return actionTypeToPolicyResponse(actionType) ?? 'continue'
}

/** @deprecated use actionTypeToPolicyResponse */
export function actionTypeToConfidentialResponse(
  actionType: string | undefined,
): WizardDataPolicyState['confidentialResponse'] {
  return actionTypeToPolicyResponse(actionType) ?? 'continue'
}

export function buildSharedPolicyRuleSpecs(
  dataPolicy: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
): PolicyRuleSpec[] {
  return [
    {
      name: WIZARD_RESTRICTED_POLICY_NAME,
      level: 'RESTRICTED',
      actionType: dataPolicyResponseToActionTypeSafe(dataPolicy.restrictedResponse),
    },
    {
      name: WIZARD_CONFIDENTIAL_POLICY_NAME,
      level: 'CONFIDENTIAL',
      actionType: dataPolicyResponseToActionTypeSafe(dataPolicy.confidentialResponse),
    },
  ]
}

export function buildRoutePolicyRuleSpecs(
  shared: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
  override: WizardRoutePolicyOverride | undefined,
): PolicyRuleSpec[] {
  const diffs = wizardRoutePolicyLevelDiffs(shared, override)
  const specs: PolicyRuleSpec[] = []
  if (diffs.includes('restricted') && override?.restrictedResponse) {
    specs.push({
      name: WIZARD_RESTRICTED_POLICY_NAME,
      level: 'RESTRICTED',
      actionType: dataPolicyResponseToActionTypeSafe(override.restrictedResponse),
    })
  }
  if (diffs.includes('confidential') && override?.confidentialResponse) {
    specs.push({
      name: WIZARD_CONFIDENTIAL_POLICY_NAME,
      level: 'CONFIDENTIAL',
      actionType: dataPolicyResponseToActionTypeSafe(override.confidentialResponse),
    })
  }
  return specs
}

export function mergeEffectivePolicyResponses(
  shared: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
  override: WizardRoutePolicyOverride | undefined,
): Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'> {
  return {
    restrictedResponse: override?.restrictedResponse ?? shared.restrictedResponse,
    confidentialResponse: override?.confidentialResponse ?? shared.confidentialResponse,
  }
}

function isWizardClassificationPolicyRule(
  rule: Pick<PolicyRule, 'name' | 'condition_json'>,
): ClassificationLevelPolicy | null {
  const level = String(rule.condition_json?.classification_level || '').trim().toUpperCase()
  if (rule.name === WIZARD_RESTRICTED_POLICY_NAME || level === 'RESTRICTED') return 'RESTRICTED'
  if (rule.name === WIZARD_CONFIDENTIAL_POLICY_NAME || level === 'CONFIDENTIAL') return 'CONFIDENTIAL'
  return null
}

export function hydrateDataPolicyFromStreamRules(
  dataPolicy: WizardDataPolicyState,
  rules: readonly PolicyRule[],
): WizardDataPolicyState {
  let restrictedResponse = dataPolicy.restrictedResponse
  let confidentialResponse = dataPolicy.confidentialResponse
  for (const rule of rules) {
    const level = isWizardClassificationPolicyRule(rule)
    const mapped = actionTypeToPolicyResponse(rule.action_type)
    if (mapped == null) continue
    if (level === 'RESTRICTED') restrictedResponse = mapped
    if (level === 'CONFIDENTIAL') confidentialResponse = mapped
  }
  return { ...dataPolicy, restrictedResponse, confidentialResponse }
}

export function hydrateRoutePolicyOverrideFromRules(
  shared: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
  rules: readonly RoutePolicyRule[],
  existing?: WizardRoutePolicyOverride,
): WizardRoutePolicyOverride | undefined {
  let restrictedResponse = existing?.restrictedResponse
  let confidentialResponse = existing?.confidentialResponse
  let found = false
  for (const rule of rules) {
    const level = isWizardClassificationPolicyRule(rule)
    const mapped = actionTypeToPolicyResponse(rule.action_type)
    if (mapped == null) continue
    if (level === 'RESTRICTED') {
      restrictedResponse = mapped
      found = true
    }
    if (level === 'CONFIDENTIAL') {
      confidentialResponse = mapped
      found = true
    }
  }
  if (!found && !existing) return undefined
  return {
    deliveryBehavior: existing?.deliveryBehavior ?? 'continue',
    restrictedResponse: restrictedResponse ?? shared.restrictedResponse,
    confidentialResponse: confidentialResponse ?? shared.confidentialResponse,
  }
}

async function upsertStreamPolicyRule(streamId: number, spec: PolicyRuleSpec, existing: PolicyRule | undefined) {
  if (existing) {
    await patchPolicyRule(streamId, existing.id, {
      name: spec.name,
      enabled: true,
      condition_json: { classification_level: spec.level },
      action_type: spec.actionType,
    })
    return
  }
  await createPolicyRule(streamId, {
    name: spec.name,
    enabled: true,
    condition_json: { classification_level: spec.level },
    action_type: spec.actionType,
  })
}

async function upsertRoutePolicyRule(routeId: number, spec: PolicyRuleSpec, existing: RoutePolicyRule | undefined) {
  if (existing) {
    await patchRoutePolicyRule(routeId, existing.id, {
      name: spec.name,
      enabled: true,
      condition_json: { classification_level: spec.level },
      action_type: spec.actionType,
    })
    return
  }
  await createRoutePolicyRule(routeId, {
    name: spec.name,
    enabled: true,
    condition_json: { classification_level: spec.level },
    action_type: spec.actionType,
  })
}

function findNamedRule<T extends { name: string; condition_json?: { classification_level?: string } }>(
  rules: readonly T[],
  spec: PolicyRuleSpec,
): T | undefined {
  return rules.find(
    (rule) =>
      rule.name === spec.name ||
      String(rule.condition_json?.classification_level || '').toUpperCase() === spec.level,
  )
}

export async function persistWizardSharedAndRoutePolicy(
  streamId: number,
  state: WizardState,
  routeIds: readonly number[],
): Promise<PolicyPersistResult> {
  const result: PolicyPersistResult = {
    saved: false,
    streamRulesUpserted: 0,
    routeRulesUpserted: 0,
    errors: [],
  }

  try {
    const existingStream = (await fetchStreamPolicyRules(streamId))?.rules ?? []
    for (const spec of buildSharedPolicyRuleSpecs(state.dataPolicy)) {
      await upsertStreamPolicyRule(streamId, spec, findNamedRule(existingStream, spec))
      result.streamRulesUpserted += 1
    }
  } catch (err) {
    result.errors.push(`shared-policy: ${err instanceof Error ? err.message : String(err)}`)
  }

  const routeDrafts = state.destinations.routeDrafts
  for (let index = 0; index < routeDrafts.length; index += 1) {
    const draft = routeDrafts[index]
    const routeId = routeIds[index]
    if (!draft || typeof routeId !== 'number' || !Number.isFinite(routeId)) continue
    try {
      const existingRoute = (await fetchRoutePolicyRules(routeId))?.rules ?? []
      const wanted = draft.inherit?.policy === false
        ? buildRoutePolicyRuleSpecs(state.dataPolicy, draft.overrides?.policy)
        : []
      const wantedNames = new Set(wanted.map((spec) => spec.name))
      for (const spec of wanted) {
        await upsertRoutePolicyRule(routeId, spec, findNamedRule(existingRoute, spec))
        result.routeRulesUpserted += 1
      }
      for (const rule of existingRoute) {
        if (rule.name !== WIZARD_RESTRICTED_POLICY_NAME && rule.name !== WIZARD_CONFIDENTIAL_POLICY_NAME) continue
        if (wantedNames.has(rule.name)) continue
        await deleteRoutePolicyRule(routeId, rule.id)
      }
    } catch (err) {
      result.errors.push(`route-policy ${routeId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.saved = result.errors.length === 0
  return result
}

export async function loadWizardPolicyFromRuntime(
  streamId: number,
  routeDrafts: WizardRouteDraft[],
  dataPolicy: WizardDataPolicyState,
): Promise<{ dataPolicy: WizardDataPolicyState; routeDrafts: WizardRouteDraft[] }> {
  const streamRules = (await fetchStreamPolicyRules(streamId))?.rules ?? []
  const nextPolicy = hydrateDataPolicyFromStreamRules(dataPolicy, streamRules)
  const nextDrafts = await Promise.all(
    routeDrafts.map(async (draft) => {
      const routeId = Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN)
      if (!Number.isFinite(routeId)) return draft
      try {
        const routeRules = (await fetchRoutePolicyRules(routeId))?.rules ?? []
        const override = hydrateRoutePolicyOverrideFromRules(nextPolicy, routeRules, draft.overrides?.policy)
        if (!override) return draft
        const hasLevelDiff = wizardRoutePolicyLevelDiffs(nextPolicy, override).length > 0
        if (!hasLevelDiff && draft.inherit.policy) return draft
        return {
          ...draft,
          inherit: { ...draft.inherit, policy: false },
          overrides: { ...draft.overrides, policy: override },
        }
      } catch {
        return draft
      }
    }),
  )
  return { dataPolicy: nextPolicy, routeDrafts: nextDrafts }
}
