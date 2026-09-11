import { Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { fetchDestinationsList, type DestinationListItem } from '../../../api/gdcDestinations'
import {
  WizardSharedProcessingSection,
  type SharedProcessingTab,
} from '../route-processing/wizard-global-processing-section'
import { WizardRouteProcessingDetailPanel } from '../route-processing/wizard-route-processing-detail-panel'
import { WizardRouteProcessingList } from '../route-processing/wizard-route-processing-list'
import { ROUTE_PROCESSING_COPY } from '../route-processing/route-processing-labels'
import { StepDataProtection } from './step-data-protection'
import { StepMappingCombined } from './step-mapping-combined'
import type { WizardEnrichmentRule } from './enrichment-rules-model'
import { WizardDataProtectionDrawer } from './wizard-data-protection-drawer'
import { WizardMappingOutputAside } from './wizard-mapping-output-aside'
import { computeRouteDeployReadiness } from './wizard-deploy-readiness'
import { wizardTransformSampleReady } from './wizard-transform-sample'
import { WizardSharedClassificationSection } from './wizard-shared-classification-section'
import { WizardSharedPolicySection } from './wizard-shared-policy-section'
import type {
  WizardDataPolicyState,
  WizardDataProtectionState,
  WizardDestinationsState,
  WizardMappingRow,
  WizardRouteDraft,
  WizardState,
} from './wizard-state'
import { buildRouteTransformOverrideFromGlobal } from './wizard-state'

export type StepRouteProcessingProps = {
  state: WizardState
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

export function StepRouteProcessing({
  state,
  onChangeMapping,
  onChangeMappingMode,
  onChangeFullEventJsonata,
  onChangeFullEventRegexConfigJson,
  onChangeEnrichment,
  onChangeUnmappedFieldsPolicy,
  onChangeDataProtection,
  onChangeDataPolicy,
  onChangeDestinations,
  dataProtectionDrawerOpen,
  onDataProtectionDrawerOpenChange,
}: StepRouteProcessingProps) {
  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
  const [sharedTab, setSharedTab] = useState<SharedProcessingTab>('transform')
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null)
  const [protectionDrawerOpen, setProtectionDrawerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = await fetchDestinationsList()
      if (!cancelled) setDestinations(rows)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const destById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])
  const routeDrafts = state.destinations.routeDrafts

  useEffect(() => {
    if (routeDrafts.length === 0) {
      setSelectedRouteKey(null)
      return
    }
    setSelectedRouteKey((prev) => {
      if (prev != null && routeDrafts.some((d) => d.key === prev)) return prev
      return routeDrafts[0]?.key ?? null
    })
  }, [routeDrafts])

  const selectedDraft = routeDrafts.find((d) => d.key === selectedRouteKey) ?? null
  const drawerOpen = dataProtectionDrawerOpen ?? protectionDrawerOpen
  const setDrawerOpen = onDataProtectionDrawerOpenChange ?? setProtectionDrawerOpen

  const routeDeployReadiness = useMemo(
    () =>
      computeRouteDeployReadiness(
        state,
        destinations.map((d) => ({ id: d.id, name: d.name })),
      ),
    [destinations, state],
  )

  const selectedRouteDeploy = selectedDraft
    ? routeDeployReadiness.routes.find((r) => r.routeKey === selectedDraft.key)
    : undefined

  const outputState = useMemo(() => {
    if (selectedDraft && !selectedDraft.inherit.transform) {
      return buildRouteScopedState(state, selectedDraft)
    }
    return state
  }, [selectedDraft, state])

  const patchRouteUnmappedPolicy = (policy: WizardState['unmappedFieldsPolicy']) => {
    if (!selectedDraft) {
      onChangeUnmappedFieldsPolicy?.(policy)
      return
    }
    if (selectedDraft.inherit.transform) {
      onChangeUnmappedFieldsPolicy?.(policy)
      return
    }
    const current = selectedDraft.overrides?.transform ?? buildRouteTransformOverrideFromGlobal(state)
    onChangeDestinations({
      routeDrafts: state.destinations.routeDrafts.map((draft) =>
        draft.key === selectedDraft.key
          ? {
              ...draft,
              overrides: {
                ...draft.overrides,
                transform: { ...current, unmappedFieldsPolicy: policy },
              },
            }
          : draft,
      ),
    })
  }

  return (
    <div className="space-y-5" data-testid="wizard-step-route-processing">
      <header className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
          <Route className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">Route Processing</h3>
          <p className="max-w-3xl text-[13px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            Configure shared defaults first, then choose per route whether to inherit or override Transform, Protection,
            Classification, and Policy.
          </p>
        </div>
      </header>

      <WizardSharedProcessingSection
        state={state}
        activeTab={sharedTab}
        onTabChange={setSharedTab}
        routeCount={routeDrafts.length}
      >
        {sharedTab === 'transform' ? (
          <div className="space-y-4" data-testid="route-processing-shared-transform">
            <StepMappingCombined
              state={state}
              onChangeMapping={onChangeMapping}
              onChangeMappingMode={onChangeMappingMode}
              onChangeFullEventJsonata={onChangeFullEventJsonata}
              onChangeFullEventRegexConfigJson={onChangeFullEventRegexConfigJson}
              onChangeEnrichment={onChangeEnrichment}
              onChangeUnmappedFieldsPolicy={onChangeUnmappedFieldsPolicy}
              onChangeDataProtection={onChangeDataProtection}
              dataProtectionDrawerOpen={drawerOpen}
              onDataProtectionDrawerOpenChange={setDrawerOpen}
            />
          </div>
        ) : null}

        {sharedTab === 'data_protection' ? (
          <StepDataProtection state={state} onChange={onChangeDataProtection} section="full" />
        ) : null}

        {sharedTab === 'classification' ? (
          <WizardSharedClassificationSection
            dataPolicy={state.dataPolicy}
            dataProtection={state.dataProtection}
            onChangeDataPolicy={onChangeDataPolicy}
          />
        ) : null}

        {sharedTab === 'policy' ? (
          <WizardSharedPolicySection
            dataPolicy={state.dataPolicy}
            dataProtection={state.dataProtection}
            onChangeDataPolicy={onChangeDataPolicy}
          />
        ) : null}
      </WizardSharedProcessingSection>

      <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.55fr)]" data-testid="route-processing-split-layout">
        <WizardRouteProcessingList
          routeDrafts={routeDrafts}
          destinations={destinations}
          dataProtection={state.dataProtection}
          dataPolicy={state.dataPolicy}
          selectedKey={selectedRouteKey}
          onSelect={setSelectedRouteKey}
        />

        <div className="min-w-0 space-y-0" data-testid="route-processing-workspace">
          {selectedDraft ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
              <WizardRouteProcessingDetailPanel
                state={state}
                draft={selectedDraft}
                destination={destById.get(selectedDraft.destinationId)}
                destinations={destinations}
                onChangeMapping={onChangeMapping}
                onChangeMappingMode={onChangeMappingMode}
                onChangeFullEventJsonata={onChangeFullEventJsonata}
                onChangeFullEventRegexConfigJson={onChangeFullEventRegexConfigJson}
                onChangeEnrichment={onChangeEnrichment}
                onChangeUnmappedFieldsPolicy={onChangeUnmappedFieldsPolicy}
                onChangeDataProtection={onChangeDataProtection}
                onChangeDataPolicy={onChangeDataPolicy}
                onChangeDestinations={onChangeDestinations}
                dataProtectionDrawerOpen={drawerOpen}
                onDataProtectionDrawerOpenChange={setDrawerOpen}
                showOutputAside={false}
                deployStatus={selectedRouteDeploy?.status}
                deployStatusLabel={selectedRouteDeploy?.statusLabel}
              />

              {wizardTransformSampleReady(state) ? (
                <WizardMappingOutputAside
                  state={outputState}
                  onChangeUnmappedFieldsPolicy={patchRouteUnmappedPolicy}
                />
              ) : (
                <aside
                  className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-slate-200/90 p-4 text-center dark:border-gdc-border"
                  data-testid="route-processing-output-workspace"
                >
                  <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
                    Complete Sample &amp; Record Selection to preview mapped output.
                  </p>
                </aside>
              )}
            </div>
          ) : (
            <section
              className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-slate-200/90 p-6 text-center dark:border-gdc-border"
              data-testid="route-processing-detail-empty"
            >
              <p className="text-[12px] text-slate-500 dark:text-gdc-muted">{ROUTE_PROCESSING_COPY.selectRouteConfigure}</p>
            </section>
          )}
        </div>
      </div>

      <WizardDataProtectionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        state={state}
        onChange={onChangeDataProtection}
      />
    </div>
  )
}
