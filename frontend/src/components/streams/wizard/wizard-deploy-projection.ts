import type { RouteProcessingConcernKey } from '../route-processing/route-processing-labels'
import {
  computeWizardRouteProcessingStatuses,
  normalizeWizardRouteProcessingInherit,
  wizardDataProtectionIntentReady,
  type RouteProcessingStatus,
  type WizardDataProtectionState,
  type WizardRouteDraft,
  type WizardRouteProcessingInherit,
  type WizardRouteProcessingStatuses,
} from './wizard-state'

/** How deploy persists (or does not persist) a projected concern override. */
export type DeployIntentPersistKind =
  | 'none'
  | 'intent_only'
  | 'governance'
  | 'route_transform'
  | 'route_protection'
  | 'route_classification'

export type RouteProcessingConcernProjection = {
  status: RouteProcessingStatus
  persistKind: DeployIntentPersistKind
}

export type RouteDeployIntentProjection = {
  statuses: WizardRouteProcessingStatuses
  concerns: Record<RouteProcessingConcernKey, RouteProcessingConcernProjection>
}

export type ConcernProjectedCount = {
  override: number
  mixed: number
}

export type RouteProcessingProjectedCounts = Record<RouteProcessingConcernKey, ConcernProjectedCount>

export const DEPLOY_INTENT_PERSIST_LABEL: Record<Exclude<DeployIntentPersistKind, 'none'>, string> = {
  intent_only: 'Intent only',
  governance: 'Persisted through governance rules',
  route_transform: 'Persisted through route transform',
  route_protection: 'Persisted through route protection',
  route_classification: 'Persisted through route classification',
}

function routeHasProtectionFieldOverrides(
  dataProtection: Pick<WizardDataProtectionState, 'routeOverrides'>,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeOverrides.some((o) => o.enabled && o.routeDraftKey === routeDraftKey)
}

function routeHasClassificationOverride(
  dataProtection: Pick<WizardDataProtectionState, 'routeClassificationOverrides'>,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeClassificationOverrides.some(
    (o) => o.enabled && o.routeDraftKey === routeDraftKey,
  )
}

function routeHasProtectionOverrideIntents(draft: WizardRouteDraft): boolean {
  return (draft.overrides?.protection?.intents ?? []).some(
    (intent) => wizardDataProtectionIntentReady(intent) && intent.protectionAction !== 'audit',
  )
}

function persistKindForConcern(
  concern: RouteProcessingConcernKey,
  status: RouteProcessingStatus,
  inherit: WizardRouteProcessingInherit,
  protectionFieldOverrides: boolean,
  classificationOverride: boolean,
  protectionOverrideIntents: boolean,
  classificationRulesReady: boolean,
): DeployIntentPersistKind {
  if (status === 'Inherited') return 'none'

  switch (concern) {
    case 'transform':
      if (!inherit.transform) return 'route_transform'
      return 'intent_only'
    case 'policy':
      if (!inherit.policy) return 'governance'
      return 'intent_only'
    case 'protection':
      if (!inherit.protection && protectionOverrideIntents) return 'route_protection'
      if (protectionFieldOverrides) return 'governance'
      return 'intent_only'
    case 'classification':
      if (classificationRulesReady) return 'route_classification'
      if (classificationOverride) return 'governance'
      return 'intent_only'
    default:
      return 'intent_only'
  }
}

/**
 * Projects route processing status from wizard deploy intent (pure function; no API).
 * Used by Deploy Summary — not post-deploy Effective API truth.
 */
export function projectRouteProcessingStatusFromDeployIntent(
  draft: WizardRouteDraft,
  dataProtection: WizardDataProtectionState,
): RouteDeployIntentProjection {
  const statuses = computeWizardRouteProcessingStatuses(draft, dataProtection)
  const inherit = normalizeWizardRouteProcessingInherit(draft.inherit)
  const protectionFieldOverrides = routeHasProtectionFieldOverrides(dataProtection, draft.key)
  const classificationOverride = routeHasClassificationOverride(dataProtection, draft.key)
  const protectionOverrideIntents = routeHasProtectionOverrideIntents(draft)
  const classificationRulesReady = (draft.overrides?.classification?.rules ?? []).some(
    (rule) => rule.enabled !== false && Boolean(rule.sensitivityClass) && Boolean(rule.classificationLevel),
  )

  const concern = (key: RouteProcessingConcernKey): RouteProcessingConcernProjection => ({
    status: statuses[key],
    persistKind: persistKindForConcern(
      key,
      statuses[key],
      inherit,
      protectionFieldOverrides,
      classificationOverride,
      protectionOverrideIntents,
      classificationRulesReady,
    ),
  })

  return {
    statuses,
    concerns: {
      transform: concern('transform'),
      protection: concern('protection'),
      classification: concern('classification'),
      policy: concern('policy'),
    },
  }
}

export function accumulateRouteProcessingProjectedCounts(
  routeDrafts: readonly WizardRouteDraft[],
  dataProtection: WizardDataProtectionState,
): RouteProcessingProjectedCounts {
  const counts: RouteProcessingProjectedCounts = {
    transform: { override: 0, mixed: 0 },
    protection: { override: 0, mixed: 0 },
    classification: { override: 0, mixed: 0 },
    policy: { override: 0, mixed: 0 },
  }

  for (const draft of routeDrafts) {
    const projection = projectRouteProcessingStatusFromDeployIntent(draft, dataProtection)
    for (const key of ['transform', 'protection', 'classification', 'policy'] as const) {
      const status = projection.statuses[key]
      if (status === 'Overridden') counts[key].override += 1
      else if (status === 'Mixed') counts[key].mixed += 1
    }
  }

  return counts
}

export function deployIntentPersistLabel(kind: DeployIntentPersistKind): string | null {
  if (kind === 'none') return null
  return DEPLOY_INTENT_PERSIST_LABEL[kind]
}

export function formatProjectedCountLine(count: ConcernProjectedCount): string {
  if (count.override === 0 && count.mixed === 0) return 'Shared default'
  const parts: string[] = []
  if (count.override > 0) parts.push(`Override: ${count.override}`)
  if (count.mixed > 0) parts.push(`Mixed: ${count.mixed}`)
  return parts.join(' · ')
}
