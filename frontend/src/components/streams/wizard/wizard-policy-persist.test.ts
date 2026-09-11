import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  actionTypeToPolicyResponse,
  buildRoutePolicyRuleSpecs,
  buildSharedPolicyRuleSpecs,
  dataPolicyResponseToActionType,
  dataPolicyResponseToActionTypeSafe,
  hydrateDataPolicyFromStreamRules,
  hydrateRoutePolicyOverrideFromRules,
  mergeEffectivePolicyResponses,
  persistWizardSharedAndRoutePolicy,
  WIZARD_CONFIDENTIAL_POLICY_NAME,
  WIZARD_RESTRICTED_POLICY_NAME,
} from './wizard-policy-persist'
import {
  buildInitialState,
  computeWizardRouteProcessingStatuses,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  mergeEffectiveWizardPolicy,
  normalizeWizardPolicyLevelResponse,
  normalizeWizardProtectionAction,
} from './wizard-state'
import { parseWizardDraftV2, saveWizardDraft, WIZARD_DRAFT_KEY_V2 } from './wizard-draft-migration'
import {
  buildRouteDraftKeyToIdMap,
  buildStreamGovernancePayload,
} from './wizard-governance-persist'
import { projectRouteProcessingStatusFromDeployIntent } from './wizard-deploy-projection'

vi.mock('../../../api/gdcPolicy', () => ({
  fetchStreamPolicyRules: vi.fn(async () => ({ stream_id: 7, rules: [], rule_count: 0 })),
  createPolicyRule: vi.fn(async () => ({ rule: { id: 1 } })),
  patchPolicyRule: vi.fn(async () => ({ rule: { id: 1 } })),
}))

vi.mock('../../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyRules: vi.fn(async () => ({ route_id: 1, stream_id: 7, rules: [], rule_count: 0 })),
  createRoutePolicyRule: vi.fn(async () => ({ rule: { id: 11 } })),
  patchRoutePolicyRule: vi.fn(async () => ({ rule: { id: 11 } })),
  deleteRoutePolicyRule: vi.fn(async () => undefined),
}))

import { createPolicyRule, fetchStreamPolicyRules, patchPolicyRule } from '../../../api/gdcPolicy'
import { createRoutePolicyRule, fetchRoutePolicyRules } from '../../../api/gdcRoutePolicy'

describe('Protection / Policy semantic boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps Policy delivery controls onto Policy Engine actions without Protection coercion', () => {
    expect(dataPolicyResponseToActionType('continue')).toBe('audit_only')
    expect(dataPolicyResponseToActionType('require_review')).toBe('require_review')
    expect(dataPolicyResponseToActionType('quarantine')).toBe('quarantine')
    expect(dataPolicyResponseToActionType('block')).toBe('block')
    expect(() => dataPolicyResponseToActionType('mask')).toThrow(/not a Policy action/)
    expect(() => dataPolicyResponseToActionType('tokenize')).toThrow(/not a Policy action/)
    expect(() => dataPolicyResponseToActionType('hash')).toThrow(/not a Policy action/)
    expect(() => dataPolicyResponseToActionType('drop_field')).toThrow(/not a Policy action/)
    expect(actionTypeToPolicyResponse('audit_only')).toBe('continue')
    expect(actionTypeToPolicyResponse('require_review')).toBe('require_review')
    expect(actionTypeToPolicyResponse('block')).toBe('block')
  })

  it('legacy draft mask/audit normalize to Continue for Policy (Mask stays Protection)', () => {
    expect(normalizeWizardPolicyLevelResponse('mask')).toBe('continue')
    expect(normalizeWizardPolicyLevelResponse('audit')).toBe('continue')
    expect(normalizeWizardProtectionAction('mask_partial')).toBe('mask_partial')
    expect(normalizeWizardProtectionAction('drop_field')).toBe('drop_field')
  })

  it('migrates legacy Policy mask in draft without inventing Protection audit', () => {
    const state = buildInitialState()
    state.dataPolicy.confidentialResponse = 'mask' as never
    state.dataPolicy.restrictedResponse = 'audit' as never
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.ssn',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
      },
    ]
    saveWizardDraft(state, 'route_processing')
    const loaded = parseWizardDraftV2(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '')
    expect(loaded?.state.dataPolicy.confidentialResponse).toBe('continue')
    expect(loaded?.state.dataPolicy.restrictedResponse).toBe('continue')
    expect(loaded?.state.dataProtection.intents[0]?.protectionAction).toBe('mask_full')
  })

  it('builds shared stream policy specs from Policy-only values', () => {
    expect(
      buildSharedPolicyRuleSpecs({ restrictedResponse: 'quarantine', confidentialResponse: 'continue' }),
    ).toEqual([
      {
        name: WIZARD_RESTRICTED_POLICY_NAME,
        level: 'RESTRICTED',
        actionType: 'quarantine',
      },
      {
        name: WIZARD_CONFIDENTIAL_POLICY_NAME,
        level: 'CONFIDENTIAL',
        actionType: 'audit_only',
      },
    ])
    expect(dataPolicyResponseToActionTypeSafe('require_review')).toBe('require_review')
  })

  it('persists only differing route policy levels', () => {
    const specs = buildRoutePolicyRuleSpecs(
      { restrictedResponse: 'quarantine', confidentialResponse: 'continue' },
      { deliveryBehavior: 'continue', confidentialResponse: 'block' },
    )
    expect(specs).toEqual([
      {
        name: WIZARD_CONFIDENTIAL_POLICY_NAME,
        level: 'CONFIDENTIAL',
        actionType: 'block',
      },
    ])
  })

  it('merges partial route override onto shared policy', () => {
    const effective = mergeEffectivePolicyResponses(
      { restrictedResponse: 'quarantine', confidentialResponse: 'continue' },
      { deliveryBehavior: 'continue', confidentialResponse: 'block' },
    )
    expect(effective).toEqual({
      restrictedResponse: 'quarantine',
      confidentialResponse: 'block',
    })
    expect(
      mergeEffectiveWizardPolicy(
        { restrictedResponse: 'quarantine', confidentialResponse: 'continue' },
        { deliveryBehavior: 'continue', confidentialResponse: 'block' },
      ),
    ).toEqual(effective)
  })

  it('hydrates shared dataPolicy from stream classification-level rules with round-trip fidelity', () => {
    const next = hydrateDataPolicyFromStreamRules(buildInitialState().dataPolicy, [
      {
        id: 1,
        stream_id: 7,
        name: WIZARD_RESTRICTED_POLICY_NAME,
        enabled: true,
        condition_json: { classification_level: 'RESTRICTED' },
        action_type: 'block',
        created_at: '',
        updated_at: '',
      },
      {
        id: 2,
        stream_id: 7,
        name: WIZARD_CONFIDENTIAL_POLICY_NAME,
        enabled: true,
        condition_json: { classification_level: 'CONFIDENTIAL' },
        action_type: 'require_review',
        created_at: '',
        updated_at: '',
      },
    ])
    expect(next.restrictedResponse).toBe('block')
    expect(next.confidentialResponse).toBe('require_review')
  })

  it('Protection Mask persist intent stays Mask; Policy Block stays Block', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'i1',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    state.dataPolicy.restrictedResponse = 'block'
    state.dataPolicy.confidentialResponse = 'quarantine'
    saveWizardDraft(state, 'route_processing')
    const loaded = parseWizardDraftV2(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '')
    expect(loaded?.state.dataProtection.intents[0]?.protectionAction).toBe('mask_partial')
    expect(loaded?.state.dataPolicy.restrictedResponse).toBe('block')
    expect(loaded?.state.dataPolicy.confidentialResponse).toBe('quarantine')
  })

  it('round-trips Shared Policy Continue/Review/Quarantine/Block', () => {
    for (const value of ['continue', 'require_review', 'quarantine', 'block'] as const) {
      const state = buildInitialState()
      state.dataPolicy.restrictedResponse = value
      state.dataPolicy.confidentialResponse = value
      saveWizardDraft(state, 'route_processing')
      const loaded = parseWizardDraftV2(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '')
      expect(loaded?.state.dataPolicy.restrictedResponse).toBe(value)
      expect(loaded?.state.dataPolicy.confidentialResponse).toBe(value)
      expect(dataPolicyResponseToActionType(value)).toBe(dataPolicyResponseToActionTypeSafe(value))
      expect(actionTypeToPolicyResponse(dataPolicyResponseToActionType(value))).toBe(value)
    }
  })

  it('does not emit dummy classification when persisting policy-only override', () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'route-c',
        destinationId: 30,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'quarantine' } },
      },
    ]
    const payload = buildStreamGovernancePayload(
      state.dataProtection,
      buildRouteDraftKeyToIdMap(state.destinations.routeDrafts, [303]),
      state.destinations.routeDrafts,
      state.dataPolicy,
    )
    expect(payload.route_overrides).toEqual([
      { route_id: 303, delivery_behavior: 'quarantine', enabled: true },
    ])
  })

  it('projects policy-only override as deployable governance, not intent_only', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      {
        key: 'route-c',
        destinationId: 30,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'block' } },
      },
      state.dataProtection,
    )
    expect(projection.concerns.policy.persistKind).toBe('governance')
    expect(projection.statuses.classification).toBe('Inherited')
  })

  it('keeps Protection-only and Policy-only statuses independent', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'mask_full',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    const protectionOnly = computeWizardRouteProcessingStatuses(
      {
        key: 'r1',
        destinationId: 1,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
      state.dataProtection,
      state.dataPolicy,
    )
    const policyOnly = computeWizardRouteProcessingStatuses(
      {
        key: 'r2',
        destinationId: 2,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'block' } },
      },
      state.dataProtection,
      state.dataPolicy,
    )
    expect(protectionOnly.protection).toBe('Overridden')
    expect(protectionOnly.policy).toBe('Inherited')
    expect(policyOnly.protection).toBe('Inherited')
    expect(policyOnly.policy).toBe('Overridden')
  })

  it('upserts shared Continue/Quarantine and route Block without Protection actions', async () => {
    vi.mocked(fetchStreamPolicyRules).mockResolvedValueOnce({
      stream_id: 7,
      rule_count: 0,
      rules: [],
    })
    vi.mocked(fetchRoutePolicyRules).mockResolvedValueOnce({
      route_id: 9,
      stream_id: 7,
      rule_count: 0,
      rules: [],
    })
    const state = buildInitialState()
    state.dataPolicy.restrictedResponse = 'quarantine'
    state.dataPolicy.confidentialResponse = 'continue'
    state.destinations.routeDrafts = [
      {
        key: 'route-9',
        destinationId: 1,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: false },
        overrides: { policy: { deliveryBehavior: 'continue', confidentialResponse: 'block' } },
      },
    ]

    const result = await persistWizardSharedAndRoutePolicy(7, state, [9])

    expect(result.saved).toBe(true)
    expect(createPolicyRule).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        name: WIZARD_CONFIDENTIAL_POLICY_NAME,
        condition_json: { classification_level: 'CONFIDENTIAL' },
        action_type: 'audit_only',
      }),
    )
    expect(createRoutePolicyRule).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        name: WIZARD_CONFIDENTIAL_POLICY_NAME,
        action_type: 'block',
      }),
    )
    expect(patchPolicyRule).not.toHaveBeenCalled()
  })

  it('hydrates route policy override from route rules without copying full shared policy', () => {
    const override = hydrateRoutePolicyOverrideFromRules(
      { restrictedResponse: 'quarantine', confidentialResponse: 'continue' },
      [
        {
          id: 11,
          stream_id: 7,
          route_id: 3,
          name: WIZARD_CONFIDENTIAL_POLICY_NAME,
          enabled: true,
          condition_json: { classification_level: 'CONFIDENTIAL' },
          action_type: 'block',
          created_at: '',
          updated_at: '',
        },
      ],
    )
    expect(override?.confidentialResponse).toBe('block')
    expect(override?.restrictedResponse).toBe('quarantine')
  })
})
