import {
  buildInitialState,
  migrateLegacyStepIndex,
  normalizeUnknownNormalFieldPolicy,
  normalizeUnknownSensitiveFieldPolicy,
  normalizeWizardDestinations,
  normalizeWizardPolicyLevelResponse,
  normalizeWizardProtectionAction,
  normalizeWizardRouteClassificationOverride,
  normalizeWizardRouteProtectionOverride,
  WIZARD_STEP_KEYS,
  type WizardLegacySubstepKey,
  type WizardState,
  type WizardStepKey,
} from './wizard-state'

export const WIZARD_DRAFT_KEY_V1 = 'gdc-stream-wizard-draft-v1' as const
export const WIZARD_DRAFT_KEY_V2 = 'gdc-stream-wizard-draft-v2' as const
export const WIZARD_DRAFT_VERSION = 2 as const

export type WizardDraftEnvelopeV2 = {
  version: typeof WIZARD_DRAFT_VERSION
  savedAt: number
  stepKey: WizardStepKey
  state: WizardState
}

type WizardDraftEnvelopeV1 = {
  savedAt?: number
  stepIndex?: number
  stepKey?: WizardLegacySubstepKey
  state?: Partial<WizardState>
}

function isWizardStepKey(value: unknown): value is WizardStepKey {
  return typeof value === 'string' && (WIZARD_STEP_KEYS as readonly string[]).includes(value)
}

function normalizeDraftStepKey(stepKey: unknown): WizardStepKey {
  if (stepKey === 'data_protection' || stepKey === 'transform') return 'route_processing'
  return isWizardStepKey(stepKey) ? stepKey : 'connect'
}

function hydrateWizardState(raw: Partial<WizardState> | undefined): WizardState {
  const base = buildInitialState()
  if (!raw) return base
  return {
    ...base,
    ...raw,
    connector: { ...base.connector, ...raw.connector },
    stream: { ...base.stream, ...raw.stream },
    apiTest: { ...base.apiTest, ...raw.apiTest },
    destinations: normalizeWizardDestinations(raw.destinations),
    dataPolicy: {
      ...base.dataPolicy,
      ...raw.dataPolicy,
      restrictedResponse: normalizeWizardPolicyLevelResponse(
        raw.dataPolicy?.restrictedResponse ?? base.dataPolicy.restrictedResponse,
      ),
      confidentialResponse: normalizeWizardPolicyLevelResponse(
        raw.dataPolicy?.confidentialResponse ?? base.dataPolicy.confidentialResponse,
      ),
    },
    dataProtection: {
      ...base.dataProtection,
      ...raw.dataProtection,
      unknownNormalFieldPolicy: normalizeUnknownNormalFieldPolicy(
        raw.dataProtection?.unknownNormalFieldPolicy,
      ),
      unknownSensitiveFieldPolicy: normalizeUnknownSensitiveFieldPolicy(
        raw.dataProtection?.unknownSensitiveFieldPolicy,
      ),
      intents: Array.isArray(raw.dataProtection?.intents)
        ? raw.dataProtection.intents.map((intent) => ({
            key: intent.key || `dp-${Math.random().toString(36).slice(2, 10)}`,
            detectedField: intent.detectedField ?? '',
            protectionAction: normalizeWizardProtectionAction(intent.protectionAction),
            deliveryBehavior: intent.deliveryBehavior ?? 'continue',
          }))
        : base.dataProtection.intents,
      routeOverrides: Array.isArray(raw.dataProtection?.routeOverrides)
        ? raw.dataProtection.routeOverrides.map((override) => normalizeWizardRouteProtectionOverride(override))
        : base.dataProtection.routeOverrides,
      routeClassificationOverrides: Array.isArray(raw.dataProtection?.routeClassificationOverrides)
        ? raw.dataProtection.routeClassificationOverrides.map((override) =>
            normalizeWizardRouteClassificationOverride(override),
          )
        : base.dataProtection.routeClassificationOverrides,
    },
    mapping: Array.isArray(raw.mapping) ? raw.mapping : base.mapping,
    enrichment: Array.isArray(raw.enrichment) ? raw.enrichment : base.enrichment,
    transformRules: Array.isArray(raw.transformRules) ? raw.transformRules : base.transformRules,
    unmappedFieldsPolicy:
      raw.unmappedFieldsPolicy === 'drop_unmapped' ? 'drop_unmapped' : base.unmappedFieldsPolicy,
  }
}

function stepKeyFromLegacyEnvelope(envelope: WizardDraftEnvelopeV1): WizardStepKey {
  if (typeof envelope.stepIndex === 'number' && Number.isFinite(envelope.stepIndex)) {
    return WIZARD_STEP_KEYS[migrateLegacyStepIndex(Math.max(0, Math.floor(envelope.stepIndex)))] ?? 'connect'
  }
  if (envelope.stepKey === 'connector' || envelope.stepKey === 'stream' || envelope.stepKey === 'api_test') {
    return 'connect'
  }
  if (envelope.stepKey === 'preview') return 'sample'
  if (envelope.stepKey === 'mapping' || envelope.stepKey === 'enrichment' || envelope.stepKey === 'data_protection') {
    return 'route_processing'
  }
  if (envelope.stepKey === 'destinations') return 'destinations'
  if (envelope.stepKey === 'review' || envelope.stepKey === 'done') return 'deploy'
  return 'connect'
}

function migrateV1Envelope(envelope: WizardDraftEnvelopeV1): WizardDraftEnvelopeV2 {
  return {
    version: WIZARD_DRAFT_VERSION,
    savedAt: envelope.savedAt ?? Date.now(),
    stepKey: stepKeyFromLegacyEnvelope(envelope),
    state: hydrateWizardState(envelope.state),
  }
}

export function parseWizardDraftV2(raw: string): WizardDraftEnvelopeV2 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WizardDraftEnvelopeV2> & WizardDraftEnvelopeV1
    if (parsed.version === WIZARD_DRAFT_VERSION && parsed.state) {
      return {
        version: WIZARD_DRAFT_VERSION,
        savedAt: parsed.savedAt ?? Date.now(),
        stepKey: normalizeDraftStepKey(parsed.stepKey),
        state: hydrateWizardState(parsed.state),
      }
    }
    if (parsed.state) {
      return migrateV1Envelope(parsed)
    }
    return null
  } catch {
    return null
  }
}

export function loadWizardDraft(): WizardDraftEnvelopeV2 | null {
  if (typeof localStorage === 'undefined') return null
  const v2Raw = localStorage.getItem(WIZARD_DRAFT_KEY_V2)
  if (v2Raw) {
    const parsed = parseWizardDraftV2(v2Raw)
    if (parsed) return parsed
  }
  const v1Raw = localStorage.getItem(WIZARD_DRAFT_KEY_V1)
  if (!v1Raw) return null
  const migrated = parseWizardDraftV2(v1Raw)
  if (!migrated) return null
  try {
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify(migrated))
  } catch {
    /* ignore quota errors during migration */
  }
  return migrated
}

/** Strip creation outcome so drafts stay reusable for a new stream. */
export function stateForDraftPersistence(state: WizardState): WizardState {
  if (state.outcome?.streamId == null) return state
  return { ...state, outcome: null }
}

export function saveWizardDraft(state: WizardState, stepKey: WizardStepKey): void {
  const envelope: WizardDraftEnvelopeV2 = {
    version: WIZARD_DRAFT_VERSION,
    savedAt: Date.now(),
    stepKey,
    state: stateForDraftPersistence(state),
  }
  localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify(envelope))
}

export function clearWizardDraft(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
  localStorage.removeItem(WIZARD_DRAFT_KEY_V1)
}

export function wizardStepIndexForKey(steps: ReadonlyArray<{ key: WizardStepKey }>, stepKey: WizardStepKey): number {
  const idx = steps.findIndex((s) => s.key === stepKey)
  return idx >= 0 ? idx : 0
}
