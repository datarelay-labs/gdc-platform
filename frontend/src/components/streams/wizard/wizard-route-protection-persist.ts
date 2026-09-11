import {
  createRouteProtectionRule,
  deleteRouteProtectionRule,
  fetchRouteProtectionRules,
  patchRouteProtectionRule,
  type RouteProtectionRule,
} from '../../../api/gdcRouteProtection'
import { wizardProtectionActionToMode, type ProtectionMode } from '../../../api/gdcProtection'
import { inferWizardSensitivityClass, normalizeWizardDetectedField } from './wizard-data-protection-fields'
import type { UnionSchema } from '../../../utils/unionSchema'
import { protectionActionNeedsFieldRule } from './wizard-data-protection-persist'
import {
  newWizardDataProtectionIntentKey,
  wizardDataProtectionIntentReady,
  type WizardDataProtectionIntent,
  type WizardProtectionAction,
  type WizardRouteDraft,
  type WizardRouteProtectionOverrideState,
  type WizardState,
} from './wizard-state'

export type RouteProtectionPersistResult = {
  saved: boolean
  routesUpdated: number
  errors: string[]
}

type WantedProtectionRule = {
  fieldPath: string
  sensitivityClass: string
  protectionMode: ProtectionMode
}

function protectionModeToWizardAction(mode: string): WizardProtectionAction {
  switch (mode) {
    case 'partial_mask':
      return 'mask_partial'
    case 'full_mask':
      return 'mask_full'
    case 'tokenization':
      return 'tokenize'
    case 'hash':
      return 'hash'
    case 'drop_field':
      return 'drop_field'
    default:
      return 'mask_partial'
  }
}

export function buildRouteProtectionWantedRules(
  override: WizardRouteProtectionOverrideState | undefined,
  unionSchema?: UnionSchema | null,
): WantedProtectionRule[] {
  const wanted: WantedProtectionRule[] = []
  const seen = new Set<string>()
  for (const intent of override?.intents ?? []) {
    if (!wizardDataProtectionIntentReady(intent)) continue
    if (!protectionActionNeedsFieldRule(intent.protectionAction)) continue
    const fieldPath = normalizeWizardDetectedField(intent.detectedField) || intent.detectedField.trim()
    if (!fieldPath || seen.has(fieldPath)) continue
    const sensitivityClass = inferWizardSensitivityClass(fieldPath, unionSchema)
    if (!sensitivityClass) continue
    seen.add(fieldPath)
    wanted.push({
      fieldPath,
      sensitivityClass,
      protectionMode: wizardProtectionActionToMode(
        intent.protectionAction as 'mask_partial' | 'mask_full' | 'tokenize' | 'hash' | 'drop_field',
      ),
    })
  }
  return wanted
}

export function routeProtectionOverrideIntentsReady(draft: WizardRouteDraft): boolean {
  return buildRouteProtectionWantedRules(draft.overrides?.protection).length > 0
}

export function buildRouteProtectionOverrideFromRules(
  rules: readonly RouteProtectionRule[],
): WizardRouteProtectionOverrideState {
  const intents: WizardDataProtectionIntent[] = rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      key: newWizardDataProtectionIntentKey(),
      detectedField: rule.field_path,
      protectionAction: protectionModeToWizardAction(rule.protection_mode),
      deliveryBehavior: 'continue',
    }))
  return {
    intents,
    unknownNormalFieldPolicy: 'pass_through',
    unknownSensitiveFieldPolicy: 'auto_protect',
  }
}

async function syncRouteProtectionRules(routeId: number, wanted: WantedProtectionRule[]): Promise<void> {
  const existing = (await fetchRouteProtectionRules(routeId))?.rules ?? []
  const wantedByPath = new Map(wanted.map((rule) => [rule.fieldPath, rule]))

  for (const spec of wanted) {
    const current = existing.find((rule) => rule.field_path === spec.fieldPath)
    if (current) {
      if (
        current.protection_mode !== spec.protectionMode ||
        current.sensitivity_class !== spec.sensitivityClass ||
        !current.enabled
      ) {
        await patchRouteProtectionRule(routeId, current.id, {
          protection_mode: spec.protectionMode,
          sensitivity_class: spec.sensitivityClass,
          enabled: true,
        })
      }
      continue
    }
    await createRouteProtectionRule(routeId, {
      field_path: spec.fieldPath,
      sensitivity_class: spec.sensitivityClass,
      protection_mode: spec.protectionMode,
      enabled: true,
    })
  }

  for (const rule of existing) {
    if (wantedByPath.has(rule.field_path)) continue
    await deleteRouteProtectionRule(routeId, rule.id)
  }
}

export async function persistWizardRouteProtection(
  state: WizardState,
  routeIds: readonly (number | null | undefined)[],
): Promise<RouteProtectionPersistResult> {
  const result: RouteProtectionPersistResult = { saved: false, routesUpdated: 0, errors: [] }
  const drafts = state.destinations.routeDrafts

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]
    const routeId = routeIds[index]
    if (!draft || typeof routeId !== 'number' || !Number.isFinite(routeId)) continue

    try {
      const wanted =
        draft.inherit?.protection === false
          ? buildRouteProtectionWantedRules(draft.overrides?.protection, state.apiTest.unionSchema)
          : []
      await syncRouteProtectionRules(routeId, wanted)
      result.routesUpdated += 1
    } catch (err) {
      result.errors.push(`route-protection ${routeId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.saved = result.errors.length === 0
  return result
}

export async function loadWizardRouteProtection(routeDrafts: WizardRouteDraft[]): Promise<WizardRouteDraft[]> {
  return Promise.all(
    routeDrafts.map(async (draft) => {
      const routeId = Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN)
      if (!Number.isFinite(routeId)) return draft
      try {
        const response = await fetchRouteProtectionRules(routeId)
        const rules = (response?.rules ?? []).filter((rule) => rule.enabled)
        if (rules.length === 0) {
          return {
            ...draft,
            inherit: { ...draft.inherit, protection: true },
          }
        }
        return {
          ...draft,
          inherit: { ...draft.inherit, protection: false },
          overrides: {
            ...draft.overrides,
            protection: buildRouteProtectionOverrideFromRules(rules),
          },
        }
      } catch {
        return draft
      }
    }),
  )
}
