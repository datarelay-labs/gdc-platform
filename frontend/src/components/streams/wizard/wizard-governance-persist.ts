import { putStreamGovernance, type StreamGovernanceDocument } from '../../../api/gdcStreamGovernance'
import { inferWizardSensitivityClass } from './wizard-data-protection-fields'
import { normalizeWizardDetectedField } from './wizard-data-protection-fields'
import type { UnionSchema } from '../../../utils/unionSchema'
import {
  wizardDataProtectionIntentReady,
  wizardRoutePolicyLevelDiffs,
  type WizardDataPolicyState,
  type WizardDataProtectionState,
  type WizardRouteDraft,
  type WizardRouteClassificationOverride,
  type WizardRouteProtectionOverride,
  type WizardState,
} from './wizard-state'

export type RouteDraftKeyToIdMap = Map<string, number>

export type GovernancePersistResult = {
  saved: boolean
  errors: string[]
  warnings: string[]
}

export function buildRouteDraftKeyToIdMap(
  routeDrafts: readonly WizardRouteDraft[],
  routeIds: readonly number[],
): RouteDraftKeyToIdMap {
  const map = new Map<string, number>()
  routeDrafts.forEach((draft, index) => {
    const routeId = routeIds[index]
    if (typeof routeId === 'number' && Number.isFinite(routeId)) {
      map.set(draft.key, routeId)
    }
  })
  return map
}

function normalizeOverrideFieldPath(path: string): string {
  const normalized = normalizeWizardDetectedField(path)
  return normalized || path.trim()
}

export function isDuplicateRouteOverride(
  overrides: readonly WizardRouteProtectionOverride[],
  fieldPath: string,
  routeDraftKey: string,
  excludeKey?: string,
): boolean {
  const normalizedField = normalizeOverrideFieldPath(fieldPath)
  return overrides.some(
    (o) =>
      o.key !== excludeKey &&
      normalizeOverrideFieldPath(o.fieldPath) === normalizedField &&
      o.routeDraftKey === routeDraftKey,
  )
}

export function isDuplicateRouteClassificationOverride(
  overrides: readonly WizardRouteClassificationOverride[],
  routeDraftKey: string,
  excludeKey?: string,
): boolean {
  return overrides.some(
    (o) => o.key !== excludeKey && o.routeDraftKey === routeDraftKey,
  )
}

function policyOnlyOverrideForRoute(
  draft: WizardRouteDraft,
  routeId: number,
  dataPolicy?: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
): { route_id: number; delivery_behavior: string; enabled: true } | null {
  if (draft.inherit?.policy !== false) return null
  const behavior = draft.overrides?.policy?.deliveryBehavior
  if (!behavior || behavior === 'continue') return null
  const levelDiffs = dataPolicy
    ? wizardRoutePolicyLevelDiffs(dataPolicy, draft.overrides?.policy)
    : []
  if (levelDiffs.length > 0 && behavior !== 'require_review') {
    return null
  }
  return {
    route_id: routeId,
    delivery_behavior: behavior,
    enabled: true,
  }
}

export function buildStreamGovernancePayload(
  dataProtection: WizardDataProtectionState,
  routeDraftKeyToId: RouteDraftKeyToIdMap,
  routeDrafts?: readonly WizardRouteDraft[],
  dataPolicy?: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
  unionSchema?: UnionSchema | null,
): StreamGovernanceDocument {
  const validIntents = dataProtection.intents.filter(wizardDataProtectionIntentReady)

  const rules = validIntents.flatMap((intent) => {
    const fieldPath = normalizeOverrideFieldPath(intent.detectedField)
    const sensitivityType = inferWizardSensitivityClass(fieldPath, unionSchema)
    if (!sensitivityType) return []
    return [
      {
        field_path: fieldPath,
        sensitivity_type: sensitivityType,
        default_protection_action: intent.protectionAction,
        default_delivery_behavior: intent.deliveryBehavior,
        enabled: true,
      },
    ]
  })

  const protectionOverrides = dataProtection.routeOverrides
    .filter((o) => o.enabled)
    .map((override) => {
      const routeId = routeDraftKeyToId.get(override.routeDraftKey)
      if (routeId == null) return null
      return {
        field_path: normalizeOverrideFieldPath(override.fieldPath),
        route_id: routeId,
        protection_action: override.protectionAction,
        delivery_behavior: override.deliveryBehavior,
        enabled: true,
      }
    })
    .filter((o): o is NonNullable<typeof o> => o != null)

  const classificationOverrides = dataProtection.routeClassificationOverrides
    .filter((o) => o.enabled && o.routeDraftKey)
    .map((override) => {
      const routeId = routeDraftKeyToId.get(override.routeDraftKey)
      if (routeId == null) return null
      return {
        route_id: routeId,
        classification_level: override.classificationLevel,
        enabled: true,
      }
    })
    .filter((o): o is NonNullable<typeof o> => o != null)

  const policyOverrides = (routeDrafts ?? [])
    .map((draft) => {
      const routeId = routeDraftKeyToId.get(draft.key)
      if (routeId == null) return null
      return policyOnlyOverrideForRoute(draft, routeId, dataPolicy)
    })
    .filter((o): o is NonNullable<typeof o> => o != null)

  const route_overrides = [...protectionOverrides, ...classificationOverrides, ...policyOverrides]

  return {
    enabled: validIntents.length > 0 || route_overrides.length > 0,
    rules,
    route_overrides,
  }
}

export function governancePayloadHasContent(payload: StreamGovernanceDocument): boolean {
  return payload.rules.length > 0 || payload.route_overrides.length > 0
}

export async function persistWizardStreamGovernance(
  streamId: number,
  state: WizardState,
  routeIds: readonly number[],
): Promise<GovernancePersistResult> {
  const routeDraftKeyToId = buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, routeIds)
  const payload = buildStreamGovernancePayload(
    state.dataProtection,
    routeDraftKeyToId,
    state.destinations.routeDrafts,
    state.dataPolicy,
    state.apiTest.unionSchema,
  )

  if (!governancePayloadHasContent(payload)) {
    return { saved: true, errors: [], warnings: [] }
  }

  const warnings: string[] = []
  const skippedProtection = state.dataProtection.routeOverrides.filter(
    (o) => o.enabled && !routeDraftKeyToId.has(o.routeDraftKey),
  )
  const skippedClassification = state.dataProtection.routeClassificationOverrides.filter(
    (o) => o.enabled && !routeDraftKeyToId.has(o.routeDraftKey),
  )
  const skippedCount = skippedProtection.length + skippedClassification.length
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} route override(s) skipped — route was not created.`)
  }

  try {
    await putStreamGovernance(streamId, payload)
    return { saved: true, errors: [], warnings }
  } catch (err) {
    return {
      saved: false,
      errors: [`governance: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
    }
  }
}
