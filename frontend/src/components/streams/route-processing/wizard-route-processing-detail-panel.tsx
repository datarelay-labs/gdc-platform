import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import type { DestinationListItem } from '../../../api/gdcDestinations'
import { StepDataProtection } from '../wizard/step-data-protection'
import { StepMappingCombined } from '../wizard/step-mapping-combined'
import type { WizardEnrichmentRule } from '../wizard/enrichment-rules-model'
import { failurePolicyBehaviorLabel, formatWizardRateLimitDraft } from '../wizard/wizard-delivery-helpers'
import {
  WizardSharedClassificationSection,
} from '../wizard/wizard-shared-classification-section'
import {
  POLICY_DELIVERY_OPTIONS,
  RESPONSE_CONFIDENTIAL_OPTIONS,
  RESPONSE_RESTRICTED_OPTIONS,
  WizardSharedPolicySection,
} from '../wizard/wizard-shared-policy-section'
import {
  buildRouteClassificationOverrideFromGlobal,
} from '../wizard/wizard-classification-persist'
import {
  buildRoutePolicyOverrideFromGlobal,
  buildRouteProtectionOverrideFromGlobal,
  buildRouteTransformOverrideFromGlobal,
  computeWizardRouteProcessingStatuses,
  newWizardRouteClassificationOverrideKey,
  newWizardRouteClassificationRuleKey,
  normalizeWizardClassificationLevel,
  normalizeWizardPolicyDeliveryBehavior,
  type WizardClassificationLevel,
  type WizardDataPolicyState,
  type WizardDataProtectionState,
  type WizardDestinationsState,
  type WizardMappingRow,
  type WizardRouteClassificationRuleDraft,
  type WizardRouteDraft,
  type WizardRouteFailoverDraft,
  type WizardRouteProcessingInherit,
  type WizardSensitivityClass,
  type WizardState,
} from '../wizard/wizard-state'
import { ROUTE_PROCESSING_COPY, routeDraftUsesSharedProcessing } from './route-processing-labels'
import { RouteProcessingModeSelector, type RouteProcessingMode } from './route-processing-mode-selector'
import { RouteProcessingDetailHeader } from './route-processing-detail-header'
import { RouteProcessingInheritToggle } from './route-processing-inherit-toggle'

const inputCls =
  'h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

type DetailTab = 'transform' | 'data_protection' | 'classification' | 'policy' | 'delivery'

const TABS: ReadonlyArray<{ key: DetailTab; label: string }> = [
  { key: 'transform', label: 'Transform' },
  { key: 'data_protection', label: 'Data Protection' },
  { key: 'classification', label: 'Classification' },
  { key: 'policy', label: 'Policy' },
  { key: 'delivery', label: 'Delivery' },
]

function patchRouteDraft(
  drafts: WizardRouteDraft[],
  key: string,
  patch: Partial<WizardRouteDraft>,
): WizardRouteDraft[] {
  return drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft))
}

function buildRouteScopedState(global: WizardState, draft: WizardRouteDraft): WizardState {
  const override = draft.overrides?.transform
  if (!override) return global
  return {
    ...global,
    mapping: override.mapping,
    mappingMode: override.mappingMode,
    fullEventJsonataExpression: override.fullEventJsonataExpression,
    fullEventRegexConfigJson: override.fullEventRegexConfigJson,
    transformRules: override.transformRules,
    enrichment: override.enrichment,
    unmappedFieldsPolicy: override.unmappedFieldsPolicy,
  }
}

function buildRouteProtectionState(global: WizardState, draft: WizardRouteDraft): WizardState {
  const override = draft.overrides?.protection
  if (!override) return global
  return {
    ...global,
    dataProtection: {
      ...global.dataProtection,
      intents: override.intents,
      unknownNormalFieldPolicy: override.unknownNormalFieldPolicy,
      unknownSensitiveFieldPolicy: override.unknownSensitiveFieldPolicy,
      routeOverrides: global.dataProtection.routeOverrides.filter((o) => o.routeDraftKey === draft.key),
    },
  }
}

function classificationFloorForRoute(
  dataProtection: WizardDataProtectionState,
  routeKey: string,
): WizardClassificationLevel | null {
  const row = dataProtection.routeClassificationOverrides.find((o) => o.enabled && o.routeDraftKey === routeKey)
  return row ? row.classificationLevel : null
}

export function WizardRouteProcessingDetailPanel({
  state,
  draft,
  destination,
  destinations = [],
  onChangeDataProtection,
  onChangeDestinations,
  showOutputAside = true,
  deployStatus,
  deployStatusLabel,
}: {
  state: WizardState
  draft: WizardRouteDraft
  destination: DestinationListItem | undefined
  destinations?: DestinationListItem[]
  onChangeMapping: (rows: WizardMappingRow[]) => void
  onChangeMappingMode: (mode: WizardState['mappingMode']) => void
  onChangeFullEventJsonata: (expression: string) => void
  onChangeFullEventRegexConfigJson: (json: string) => void
  onChangeEnrichment: (rules: WizardEnrichmentRule[]) => void
  onChangeUnmappedFieldsPolicy?: (policy: WizardState['unmappedFieldsPolicy']) => void
  onChangeDataProtection: (patch: Partial<WizardDataProtectionState>) => void
  onChangeDataPolicy?: (patch: Partial<WizardDataPolicyState>) => void
  onChangeDestinations: (patch: Partial<WizardDestinationsState>) => void
  dataProtectionDrawerOpen?: boolean
  onDataProtectionDrawerOpenChange?: (open: boolean) => void
  showOutputAside?: boolean
  deployStatus?: 'ready' | 'warning' | 'error'
  deployStatusLabel?: string
}) {
  const [tab, setTab] = useState<DetailTab>('transform')
  const routeLabel = destination?.name?.trim() || `Destination #${draft.destinationId}`
  const destinationMissing = !draft.destinationId || draft.destinationId <= 0 || !destination
  const panelId = 'route-detail-tabpanel'

  const patchRoute = (patch: Partial<WizardRouteDraft>) => {
    onChangeDestinations({
      routeDrafts: patchRouteDraft(state.destinations.routeDrafts, draft.key, patch),
    })
  }

  const usesShared = routeDraftUsesSharedProcessing(draft)
  const routeMode: RouteProcessingMode = usesShared ? 'shared' : 'override'

  const patchInherit = (concern: keyof WizardRouteProcessingInherit, inherit: boolean) => {
    const nextInherit = { ...draft.inherit, [concern]: inherit }
    const nextOverrides = { ...draft.overrides }
    if (concern === 'transform' && !inherit && !nextOverrides.transform) {
      nextOverrides.transform = buildRouteTransformOverrideFromGlobal(state)
    }
    if (concern === 'protection' && !inherit && !nextOverrides.protection) {
      nextOverrides.protection = buildRouteProtectionOverrideFromGlobal(state.dataProtection)
    }
    if (concern === 'policy' && !inherit && !nextOverrides.policy) {
      nextOverrides.policy = buildRoutePolicyOverrideFromGlobal(state.dataPolicy)
    }
    if (concern === 'classification') {
      const others = state.dataProtection.routeClassificationOverrides.filter((o) => o.routeDraftKey !== draft.key)
      if (inherit) {
        onChangeDataProtection({ routeClassificationOverrides: others })
        delete nextOverrides.classification
      } else {
        if (!classificationFloorForRoute(state.dataProtection, draft.key)) {
          onChangeDataProtection({
            routeClassificationOverrides: [
              ...others,
              {
                key: newWizardRouteClassificationOverrideKey(),
                routeDraftKey: draft.key,
                classificationLevel: normalizeWizardClassificationLevel(state.dataPolicy.defaultClassification),
                enabled: true,
              },
            ],
          })
        }
        if (!nextOverrides.classification) {
          nextOverrides.classification = buildRouteClassificationOverrideFromGlobal(
            state.dataProtection,
            state.apiTest.unionSchema,
          )
        }
      }
    }
    patchRoute({ inherit: nextInherit, overrides: nextOverrides })
  }

  const patchRouteMode = (mode: RouteProcessingMode) => {
    if (mode === 'shared') {
      const others = state.dataProtection.routeClassificationOverrides.filter((o) => o.routeDraftKey !== draft.key)
      onChangeDataProtection({ routeClassificationOverrides: others })
      patchRoute({
        inherit: { transform: true, protection: true, classification: true, policy: true },
        overrides: {
          ...draft.overrides,
          classification: undefined,
        },
      })
      return
    }
    const nextOverrides = { ...draft.overrides }
    if (!nextOverrides.transform) nextOverrides.transform = buildRouteTransformOverrideFromGlobal(state)
    if (!nextOverrides.protection) nextOverrides.protection = buildRouteProtectionOverrideFromGlobal(state.dataProtection)
    if (!nextOverrides.policy) nextOverrides.policy = buildRoutePolicyOverrideFromGlobal(state.dataPolicy)
    if (!nextOverrides.classification) {
      nextOverrides.classification = buildRouteClassificationOverrideFromGlobal(
        state.dataProtection,
        state.apiTest.unionSchema,
      )
    }
    if (!classificationFloorForRoute(state.dataProtection, draft.key)) {
      onChangeDataProtection({
        routeClassificationOverrides: [
          ...state.dataProtection.routeClassificationOverrides,
          {
            key: newWizardRouteClassificationOverrideKey(),
            routeDraftKey: draft.key,
            classificationLevel: normalizeWizardClassificationLevel(state.dataPolicy.defaultClassification),
            enabled: true,
          },
        ],
      })
    }
    patchRoute({
      inherit: { transform: false, protection: false, classification: false, policy: false },
      overrides: nextOverrides,
    })
  }

  const patchRouteTransform = (patch: Partial<WizardState>) => {
    const current = draft.overrides?.transform ?? buildRouteTransformOverrideFromGlobal(state)
    const next = {
      mapping: patch.mapping ?? current.mapping,
      mappingMode: patch.mappingMode ?? current.mappingMode,
      fullEventJsonataExpression: patch.fullEventJsonataExpression ?? current.fullEventJsonataExpression,
      fullEventRegexConfigJson: patch.fullEventRegexConfigJson ?? current.fullEventRegexConfigJson,
      transformRules: patch.transformRules ?? current.transformRules,
      enrichment: patch.enrichment ?? current.enrichment,
      unmappedFieldsPolicy: patch.unmappedFieldsPolicy ?? current.unmappedFieldsPolicy,
    }
    patchRoute({ overrides: { ...draft.overrides, transform: next } })
  }

  const patchRouteProtection = (patch: Partial<WizardDataProtectionState>) => {
    const current = draft.overrides?.protection ?? buildRouteProtectionOverrideFromGlobal(state.dataProtection)
    patchRoute({
      overrides: {
        ...draft.overrides,
        protection: {
          intents: patch.intents ?? current.intents,
          unknownNormalFieldPolicy: patch.unknownNormalFieldPolicy ?? current.unknownNormalFieldPolicy,
          unknownSensitiveFieldPolicy: patch.unknownSensitiveFieldPolicy ?? current.unknownSensitiveFieldPolicy,
        },
      },
    })
  }

  const routeTransformState = useMemo(() => buildRouteScopedState(state, draft), [draft, state])
  const routeProtectionState = useMemo(() => buildRouteProtectionState(state, draft), [draft, state])
  const processingStatuses = useMemo(
    () => computeWizardRouteProcessingStatuses(draft, state.dataProtection, state.dataPolicy),
    [draft, state.dataProtection, state.dataPolicy],
  )
  const classificationFloor = classificationFloorForRoute(state.dataProtection, draft.key)

  const epsVal = typeof draft.rateLimitJson.per_second === 'number' ? String(draft.rateLimitJson.per_second) : ''
  const burstVal = typeof draft.rateLimitJson.burst_size === 'number' ? String(draft.rateLimitJson.burst_size) : ''
  const failoverEnabled = draft.failover?.enabled === true
  const standbyDestinationId = draft.failover?.secondaryDestinationId ?? 0
  const standbyOptions = destinations.filter(
    (row) => row.id !== draft.destinationId && row.enabled !== false,
  )

  const patchFailover = (patch: Partial<WizardRouteFailoverDraft>) => {
    const current: WizardRouteFailoverDraft = draft.failover ?? {
      enabled: false,
      secondaryDestinationId: null,
    }
    patchRoute({
      failover: {
        ...current,
        ...patch,
      },
    })
  }

  return (
    <section
      className="rounded-lg border border-slate-200/90 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="route-processing-detail-panel"
    >
      <RouteProcessingDetailHeader
        routeLabel={routeLabel}
        destinationLabel={destination?.name}
        destinationMissing={destinationMissing}
        processingStatuses={processingStatuses}
        deployStatus={deployStatus}
        deployStatusLabel={deployStatusLabel}
      />

      <div className="space-y-3 border-b border-slate-100 px-3 py-3 dark:border-gdc-border">
        <RouteProcessingModeSelector mode={routeMode} onChange={patchRouteMode} />
        {usesShared ? (
          <p className="text-[11px] text-slate-600 dark:text-gdc-muted" data-testid="route-shared-mode-summary">
            {ROUTE_PROCESSING_COPY.routeUsesShared} {ROUTE_PROCESSING_COPY.routeUsesSharedHint}
          </p>
        ) : null}
      </div>

      <div
        className="flex flex-wrap gap-1 border-b border-slate-100 px-2 pt-2 dark:border-gdc-border"
        role="tablist"
        aria-label="Route processing stages"
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`route-detail-tab-${item.key}`}
            aria-selected={tab === item.key}
            aria-controls={panelId}
            onClick={() => setTab(item.key)}
            className={cn(
              '-mb-px border-b-2 px-2.5 pb-2 text-[11px] font-semibold',
              tab === item.key
                ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
            )}
            data-testid={`route-detail-tab-${item.key}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div id={panelId} role="tabpanel" aria-labelledby={`route-detail-tab-${tab}`} className="space-y-3 p-3">
        {tab === 'transform' ? (
          <div className="space-y-3" data-testid="route-detail-transform">
            <RouteProcessingInheritToggle
              checked={draft.inherit.transform}
              onChange={(checked) => patchInherit('transform', checked)}
              concernLabel="Transform"
              processingStatus={processingStatuses.transform}
              data-testid="route-inherit-transform"
            />
            {draft.inherit.transform ? (
              <p className="text-[11px] text-slate-600 dark:text-gdc-muted" data-testid="route-transform-inherited-summary">
                Inherited from Shared Processing. Uncheck inherit to configure a route-specific transform.
              </p>
            ) : (
              <StepMappingCombined
                state={routeTransformState}
                onChangeMapping={(rows) => patchRouteTransform({ mapping: rows })}
                onChangeMappingMode={(mode) => patchRouteTransform({ mappingMode: mode })}
                onChangeFullEventJsonata={(expr) => patchRouteTransform({ fullEventJsonataExpression: expr })}
                onChangeFullEventRegexConfigJson={(json) => patchRouteTransform({ fullEventRegexConfigJson: json })}
                onChangeEnrichment={(rules) => patchRouteTransform({ enrichment: rules })}
                onChangeUnmappedFieldsPolicy={(policy) => patchRouteTransform({ unmappedFieldsPolicy: policy })}
                onChangeDataProtection={() => {}}
                showOutputAside={showOutputAside}
              />
            )}
          </div>
        ) : null}

        {tab === 'data_protection' ? (
          <div className="space-y-4" data-testid="route-detail-data-protection">
            <RouteProcessingInheritToggle
              checked={draft.inherit.protection}
              onChange={(checked) => patchInherit('protection', checked)}
              concernLabel="Data Protection"
              processingStatus={processingStatuses.protection}
              data-testid="route-inherit-protection"
            />
            {draft.inherit.protection ? (
              <p className="text-[11px] text-slate-600 dark:text-gdc-muted" data-testid="route-protection-inherited-summary">
                Inherited from Shared Processing. Uncheck inherit to configure route-specific protection rules.
              </p>
            ) : (
              <StepDataProtection state={routeProtectionState} onChange={(patch) => patchRouteProtection(patch)} />
            )}
          </div>
        ) : null}

        {tab === 'classification' ? (
          <div className="space-y-4" data-testid="route-detail-classification">
            <RouteProcessingInheritToggle
              checked={draft.inherit.classification}
              onChange={(checked) => patchInherit('classification', checked)}
              concernLabel="Classification"
              processingStatus={processingStatuses.classification}
              data-testid="route-inherit-classification"
            />
            {draft.inherit.classification ? (
              <WizardSharedClassificationSection
                dataPolicy={state.dataPolicy}
                dataProtection={state.dataProtection}
                readOnly
              />
            ) : (
              <div className="space-y-4">
                <label className="grid max-w-xs gap-1 text-[11px]">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">Classification floor</span>
                  <select
                    value={classificationFloor ?? normalizeWizardClassificationLevel(state.dataPolicy.defaultClassification)}
                    onChange={(e) => {
                      const level = normalizeWizardClassificationLevel(e.target.value)
                      const others = state.dataProtection.routeClassificationOverrides.filter(
                        (o) => o.routeDraftKey !== draft.key,
                      )
                      onChangeDataProtection({
                        routeClassificationOverrides: [
                          ...others,
                          {
                            key: newWizardRouteClassificationOverrideKey(),
                            routeDraftKey: draft.key,
                            classificationLevel: level,
                            enabled: true,
                          },
                        ],
                      })
                    }}
                    className={cn(inputCls, 'appearance-none pr-8')}
                    data-testid="route-classification-floor"
                  >
                    {(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const).map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                  <span className="text-[10px] text-slate-500 dark:text-gdc-muted">
                    Floor is applied after shared classification. It never downgrades the shared level.
                  </span>
                </label>
                <div className="space-y-2" data-testid="route-classification-rules">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Classification rules</p>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center rounded-md border border-slate-200/90 bg-white px-2 text-[10px] font-semibold text-violet-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-violet-300"
                      data-testid="route-classification-rule-add"
                      onClick={() => {
                        const current = draft.overrides?.classification?.rules ?? []
                        const used = new Set(current.map((rule) => rule.sensitivityClass))
                        const nextClass: WizardSensitivityClass =
                          used.has('pii') ? (used.has('secret') ? 'security_metadata' : 'secret') : 'pii'
                        const nextRule: WizardRouteClassificationRuleDraft = {
                          key: newWizardRouteClassificationRuleKey(),
                          name: `Wizard: ${nextClass} classification`,
                          sensitivityClass: nextClass,
                          classificationLevel: 'CONFIDENTIAL',
                          enabled: true,
                        }
                        patchRoute({
                          overrides: {
                            ...draft.overrides,
                            classification: { rules: [...current, nextRule] },
                          },
                        })
                      }}
                    >
                      Add rule
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
                    Route rules replace shared classification rules for this route. They persist through the existing
                    classification-rules API.
                  </p>
                  {(draft.overrides?.classification?.rules ?? []).length === 0 ? (
                    <p className="text-[10px] text-slate-500 dark:text-gdc-muted" data-testid="route-classification-rules-empty">
                      No route rules yet — floor-only override still persists through governance.
                    </p>
                  ) : (
                    (draft.overrides?.classification?.rules ?? []).map((rule) => (
                      <div
                        key={rule.key}
                        className="grid gap-2 rounded-md border border-slate-200/80 bg-white p-2 dark:border-gdc-border dark:bg-gdc-card sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                        data-testid={`route-classification-rule-row-${rule.key}`}
                      >
                        <label className="grid gap-0.5 text-[10px]">
                          <span className="font-semibold text-slate-600 dark:text-slate-300">Sensitivity class</span>
                          <select
                            value={rule.sensitivityClass}
                            className={cn(inputCls, 'appearance-none pr-8')}
                            data-testid="route-classification-rule-class"
                            onChange={(e) => {
                              const sensitivityClass = e.target.value as WizardSensitivityClass
                              patchRoute({
                                overrides: {
                                  ...draft.overrides,
                                  classification: {
                                    rules: (draft.overrides?.classification?.rules ?? []).map((item) =>
                                      item.key === rule.key ? { ...item, sensitivityClass } : item,
                                    ),
                                  },
                                },
                              })
                            }}
                          >
                            <option value="pii">pii</option>
                            <option value="secret">secret</option>
                            <option value="security_metadata">security_metadata</option>
                          </select>
                        </label>
                        <label className="grid gap-0.5 text-[10px]">
                          <span className="font-semibold text-slate-600 dark:text-slate-300">Level</span>
                          <select
                            value={rule.classificationLevel}
                            className={cn(inputCls, 'appearance-none pr-8')}
                            data-testid="route-classification-rule-level"
                            onChange={(e) => {
                              const classificationLevel = normalizeWizardClassificationLevel(e.target.value)
                              patchRoute({
                                overrides: {
                                  ...draft.overrides,
                                  classification: {
                                    rules: (draft.overrides?.classification?.rules ?? []).map((item) =>
                                      item.key === rule.key ? { ...item, classificationLevel } : item,
                                    ),
                                  },
                                },
                              })
                            }}
                          >
                            {(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const).map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="h-8 self-end rounded-md border border-slate-200/90 px-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-300"
                          data-testid="route-classification-rule-remove"
                          onClick={() => {
                            patchRoute({
                              overrides: {
                                ...draft.overrides,
                                classification: {
                                  rules: (draft.overrides?.classification?.rules ?? []).filter((item) => item.key !== rule.key),
                                },
                              },
                            })
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}

        {tab === 'policy' ? (
          <div className="space-y-4" data-testid="route-detail-policy">
            <RouteProcessingInheritToggle
              checked={draft.inherit.policy}
              onChange={(checked) => patchInherit('policy', checked)}
              concernLabel="Policy"
              processingStatus={processingStatuses.policy}
              data-testid="route-inherit-policy"
            />
            {draft.inherit.policy ? (
              <WizardSharedPolicySection
                dataPolicy={state.dataPolicy}
                dataProtection={state.dataProtection}
                readOnly
              />
            ) : (
              <section data-testid="route-policy-override-section">
                <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Route policy override</p>
                <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
                  Unchanged levels stay inherited from Shared Policy. Only levels you change are persisted as route
                  overrides.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-[11px]">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">When RESTRICTED</span>
                    <select
                      value={
                        draft.overrides?.policy?.restrictedResponse ?? state.dataPolicy.restrictedResponse
                      }
                      onChange={(e) =>
                        patchRoute({
                          overrides: {
                            ...draft.overrides,
                            policy: {
                              deliveryBehavior: draft.overrides?.policy?.deliveryBehavior ?? 'continue',
                              restrictedResponse: e.target.value as WizardDataPolicyState['restrictedResponse'],
                              confidentialResponse: draft.overrides?.policy?.confidentialResponse,
                            },
                          },
                        })
                      }
                      className={cn(inputCls, 'appearance-none pr-8')}
                      data-testid="route-policy-restricted-response"
                    >
                      {RESPONSE_RESTRICTED_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px]">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">When CONFIDENTIAL</span>
                    <select
                      value={
                        draft.overrides?.policy?.confidentialResponse ?? state.dataPolicy.confidentialResponse
                      }
                      onChange={(e) =>
                        patchRoute({
                          overrides: {
                            ...draft.overrides,
                            policy: {
                              deliveryBehavior: draft.overrides?.policy?.deliveryBehavior ?? 'continue',
                              restrictedResponse: draft.overrides?.policy?.restrictedResponse,
                              confidentialResponse: e.target
                                .value as WizardDataPolicyState['confidentialResponse'],
                            },
                          },
                        })
                      }
                      className={cn(inputCls, 'appearance-none pr-8')}
                      data-testid="route-policy-confidential-response"
                    >
                      {RESPONSE_CONFIDENTIAL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="mt-3 grid max-w-xs gap-1 text-[11px]">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">Route-wide delivery behavior</span>
                  <select
                    value={draft.overrides?.policy?.deliveryBehavior ?? 'continue'}
                    onChange={(e) =>
                      patchRoute({
                        overrides: {
                          ...draft.overrides,
                          policy: {
                            ...draft.overrides?.policy,
                            deliveryBehavior: normalizeWizardPolicyDeliveryBehavior(e.target.value),
                          },
                        },
                      })
                    }
                    className={cn(inputCls, 'appearance-none pr-8')}
                    data-testid="route-policy-delivery-behavior"
                  >
                    {POLICY_DELIVERY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-[10px] text-slate-500 dark:text-gdc-muted">
                    Use Continue when overriding individual classification levels. Quarantine, Block, and Require
                    Review apply to every event on this route.
                  </span>
                </label>
              </section>
            )}
          </div>
        ) : null}

        {tab === 'delivery' ? (
          <div className="space-y-3" data-testid="route-detail-delivery">
            <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
              Delivery settings are always route-specific — no shared inheritance.
            </p>
            <label className="flex items-center gap-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => patchRoute({ enabled: e.target.checked })}
                className="accent-violet-600"
                data-testid={`route-processing-enabled-${draft.key}`}
              />
              Enabled
            </label>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Failure policy</label>
              <div className="relative max-w-md">
                <select
                  value={draft.failurePolicy}
                  onChange={(e) => patchRoute({ failurePolicy: e.target.value as WizardRouteDraft['failurePolicy'] })}
                  className={cn(inputCls, 'appearance-none pr-8')}
                  data-testid={`route-processing-failure-policy-${draft.key}`}
                >
                  <option value="LOG_AND_CONTINUE">LOG_AND_CONTINUE</option>
                  <option value="RETRY_AND_BACKOFF">RETRY_AND_BACKOFF</option>
                  <option value="PAUSE_STREAM_ON_FAILURE">PAUSE_STREAM_ON_FAILURE</option>
                  <option value="DISABLE_ROUTE_ON_FAILURE">DISABLE_ROUTE_ON_FAILURE</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
              </div>
              <p className="text-[10px] text-slate-500">{failurePolicyBehaviorLabel(draft.failurePolicy)}</p>
            </div>
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Rate limit</p>
              <p className="text-[11px] text-slate-600 dark:text-gdc-muted">{formatWizardRateLimitDraft(draft.rateLimitJson)}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-500">EPS (optional)</label>
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    placeholder="Destination default"
                    value={epsVal}
                    onChange={(e) => {
                      const v = e.target.value
                      const next = { ...draft.rateLimitJson }
                      if (v === '') delete next.per_second
                      else next.per_second = Number(v)
                      patchRoute({ rateLimitJson: next })
                    }}
                    data-testid={`route-processing-eps-${draft.key}`}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-500">Burst (optional)</label>
                  <input
                    type="number"
                    min={0}
                    className={inputCls}
                    placeholder="Destination default"
                    value={burstVal}
                    onChange={(e) => {
                      const v = e.target.value
                      const next = { ...draft.rateLimitJson }
                      if (v === '') delete next.burst_size
                      else next.burst_size = Number(v)
                      patchRoute({ rateLimitJson: next })
                    }}
                    data-testid={`route-processing-burst-${draft.key}`}
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2" data-testid="route-failover-configuration">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Failover configuration
              </p>
              <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
                When the active destination cannot receive events, delivery continues to the standby destination.
              </p>
              <label className="flex items-center gap-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={failoverEnabled}
                  onChange={(e) => patchFailover({ enabled: e.target.checked })}
                  className="accent-violet-600"
                  data-testid="route-failover-enabled"
                />
                Enable failover
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-500">Active destination</label>
                  <p
                    className="rounded-md border border-slate-200/90 bg-slate-50 px-2 py-1.5 text-[12px] text-slate-800 dark:border-gdc-border dark:bg-gdc-rowHover dark:text-slate-100"
                    data-testid="route-failover-primary"
                  >
                    {routeLabel}
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-500" htmlFor="route-failover-standby">
                    Standby destination
                  </label>
                  <div className="relative">
                    <select
                      id="route-failover-standby"
                      value={standbyDestinationId > 0 ? String(standbyDestinationId) : ''}
                      disabled={!failoverEnabled}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        patchFailover({
                          enabled: true,
                          secondaryDestinationId: Number.isFinite(next) && next > 0 ? next : null,
                        })
                      }}
                      className={cn(inputCls, 'appearance-none pr-8 disabled:opacity-60')}
                      data-testid="route-failover-standby"
                    >
                      <option value="">Select standby destination</option>
                      {standbyOptions.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name?.trim() || `Destination #${row.id}`}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                      aria-hidden
                    />
                  </div>
                </div>
              </div>
              {failoverEnabled && standbyOptions.length === 0 ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  Create another destination to use as standby. Standby is not added as a separate delivery path.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
