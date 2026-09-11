import {
  createRouteClassificationRule,
  deleteRouteClassificationRule,
  fetchRouteClassificationRules,
  patchRouteClassificationRule,
  type RouteClassificationRule,
} from '../../../api/gdcRouteClassification'
import { inferWizardSensitivityClass } from './wizard-data-protection-fields'
import type { UnionSchema } from '../../../utils/unionSchema'
import {
  newWizardRouteClassificationRuleKey,
  normalizeWizardClassificationLevel,
  normalizeWizardSensitivityClass,
  wizardDataProtectionIntentReady,
  type WizardClassificationLevel,
  type WizardDataProtectionState,
  type WizardProtectionAction,
  type WizardRouteClassificationOverrideState,
  type WizardRouteClassificationRuleDraft,
  type WizardRouteDraft,
  type WizardSensitivityClass,
  type WizardState,
} from './wizard-state'

export type RouteClassificationPersistResult = {
  saved: boolean
  routesUpdated: number
  errors: string[]
}

export type WantedClassificationRule = {
  name: string
  sensitivityClass: WizardSensitivityClass
  classificationLevel: WizardClassificationLevel
}

const CLASSIFICATION_STRENGTH: Record<WizardClassificationLevel, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
}

function classificationLevelForAction(action: WizardProtectionAction): WizardClassificationLevel | null {
  switch (action) {
    case 'audit':
      return null
    case 'mask_full':
    case 'mask_partial':
    case 'tokenize':
    case 'hash':
      return 'CONFIDENTIAL'
    default:
      return 'CONFIDENTIAL'
  }
}

export function classificationRuleName(sensitivityClass: WizardSensitivityClass): string {
  switch (sensitivityClass) {
    case 'secret':
      return 'Wizard: secret classification'
    case 'security_metadata':
      return 'Wizard: security metadata classification'
    default:
      return 'Wizard: personal data classification'
  }
}

export function buildRouteClassificationWantedRules(
  override: WizardRouteClassificationOverrideState | undefined,
): WantedClassificationRule[] {
  const wanted: WantedClassificationRule[] = []
  const seen = new Set<string>()
  for (const rule of override?.rules ?? []) {
    if (rule.enabled === false) continue
    const sensitivityClass = normalizeWizardSensitivityClass(rule.sensitivityClass)
    if (seen.has(sensitivityClass)) continue
    seen.add(sensitivityClass)
    wanted.push({
      name: rule.name.trim() || classificationRuleName(sensitivityClass),
      sensitivityClass,
      classificationLevel: normalizeWizardClassificationLevel(rule.classificationLevel),
    })
  }
  return wanted
}

export function routeClassificationOverrideRulesReady(draft: WizardRouteDraft): boolean {
  return buildRouteClassificationWantedRules(draft.overrides?.classification).length > 0
}

export function buildRouteClassificationOverrideFromGlobal(
  dataProtection: WizardDataProtectionState,
  unionSchema?: UnionSchema | null,
): WizardRouteClassificationOverrideState {
  const byClass = new Map<WizardSensitivityClass, WizardClassificationLevel>()
  for (const intent of dataProtection.intents) {
    if (!wizardDataProtectionIntentReady(intent)) continue
    const level = classificationLevelForAction(intent.protectionAction)
    if (!level) continue
    const sensitivityClass = inferWizardSensitivityClass(intent.detectedField, unionSchema)
    if (!sensitivityClass) continue
    const existing = byClass.get(sensitivityClass)
    if (!existing || CLASSIFICATION_STRENGTH[level] > CLASSIFICATION_STRENGTH[existing]) {
      byClass.set(sensitivityClass, level)
    }
  }
  const rules: WizardRouteClassificationRuleDraft[] = [...byClass.entries()].map(([sensitivityClass, classificationLevel]) => ({
    key: newWizardRouteClassificationRuleKey(),
    name: classificationRuleName(sensitivityClass),
    sensitivityClass,
    classificationLevel,
    enabled: true,
  }))
  return { rules }
}

export function buildRouteClassificationOverrideFromRules(
  rules: readonly RouteClassificationRule[],
): WizardRouteClassificationOverrideState {
  return {
    rules: rules
      .filter((rule) => rule.enabled)
      .map((rule) => {
        const sensitivityClass = normalizeWizardSensitivityClass(
          typeof rule.condition_json?.sensitivity_class === 'string' ? rule.condition_json.sensitivity_class : 'pii',
        )
        return {
          key: newWizardRouteClassificationRuleKey(),
          name: rule.name,
          sensitivityClass,
          classificationLevel: normalizeWizardClassificationLevel(rule.classification_level),
          enabled: true,
        }
      }),
  }
}

async function syncRouteClassificationRules(routeId: number, wanted: WantedClassificationRule[]): Promise<void> {
  const existing = (await fetchRouteClassificationRules(routeId))?.rules ?? []
  const wantedByClass = new Map(wanted.map((rule) => [rule.sensitivityClass, rule]))

  for (const spec of wanted) {
    const current = existing.find(
      (rule) => String(rule.condition_json?.sensitivity_class || '') === spec.sensitivityClass,
    )
    if (current) {
      if (
        current.classification_level !== spec.classificationLevel ||
        current.name !== spec.name ||
        !current.enabled
      ) {
        await patchRouteClassificationRule(routeId, current.id, {
          name: spec.name,
          enabled: true,
          condition_json: { sensitivity_class: spec.sensitivityClass },
          classification_level: spec.classificationLevel,
        })
      }
      continue
    }
    await createRouteClassificationRule(routeId, {
      name: spec.name,
      enabled: true,
      condition_json: { sensitivity_class: spec.sensitivityClass },
      classification_level: spec.classificationLevel,
    })
  }

  for (const rule of existing) {
    const sensitivityClass = String(rule.condition_json?.sensitivity_class || '')
    if (wantedByClass.has(sensitivityClass as WizardSensitivityClass)) continue
    await deleteRouteClassificationRule(routeId, rule.id)
  }
}

export async function persistWizardRouteClassification(
  state: WizardState,
  routeIds: readonly (number | null | undefined)[],
): Promise<RouteClassificationPersistResult> {
  const result: RouteClassificationPersistResult = { saved: false, routesUpdated: 0, errors: [] }
  const drafts = state.destinations.routeDrafts

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]
    const routeId = routeIds[index]
    if (!draft || typeof routeId !== 'number' || !Number.isFinite(routeId)) continue

    try {
      const wanted =
        draft.inherit?.classification === false
          ? buildRouteClassificationWantedRules(draft.overrides?.classification)
          : []
      await syncRouteClassificationRules(routeId, wanted)
      result.routesUpdated += 1
    } catch (err) {
      result.errors.push(`route-classification ${routeId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.saved = result.errors.length === 0
  return result
}

export async function loadWizardRouteClassification(routeDrafts: WizardRouteDraft[]): Promise<WizardRouteDraft[]> {
  return Promise.all(
    routeDrafts.map(async (draft) => {
      const routeId = Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN)
      if (!Number.isFinite(routeId)) return draft
      try {
        const response = await fetchRouteClassificationRules(routeId)
        const rules = (response?.rules ?? []).filter((rule) => rule.enabled)
        if (rules.length === 0) return draft
        return {
          ...draft,
          inherit: { ...draft.inherit, classification: false },
          overrides: {
            ...draft.overrides,
            classification: buildRouteClassificationOverrideFromRules(rules),
          },
        }
      } catch {
        return draft
      }
    }),
  )
}
