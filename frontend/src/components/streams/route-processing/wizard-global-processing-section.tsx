import { CheckCircle2, Scale, ShieldCheck, Tags, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import type { WizardDataProtectionState, WizardState } from '../wizard/wizard-state'
import {
  globalClassificationConfigured,
  globalPolicyConfigured,
  globalProtectionConfigured,
  globalTransformConfigured,
} from '../wizard/wizard-state'

export type SharedProcessingTab = 'transform' | 'data_protection' | 'classification' | 'policy'

type SharedCard = {
  key: SharedProcessingTab
  title: string
  description: string
  configured: boolean
  icon: typeof Wand2
}

const SHARED_TAB_DEFS: ReadonlyArray<{ key: SharedProcessingTab; label: string }> = [
  { key: 'transform', label: 'Transform' },
  { key: 'data_protection', label: 'Data Protection' },
  { key: 'classification', label: 'Classification' },
  { key: 'policy', label: 'Policy' },
]

function buildSharedCards(
  state: Pick<
    WizardState,
    | 'mapping'
    | 'transformRules'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'dataProtection'
    | 'dataPolicy'
  >,
): SharedCard[] {
  const transformOk = globalTransformConfigured(state)
  const protectionOk = globalProtectionConfigured(state.dataProtection)
  const classificationOk = globalClassificationConfigured(state.dataPolicy, state.dataProtection)
  const policyOk = globalPolicyConfigured(state.dataPolicy, state.dataProtection)
  return [
    {
      key: 'transform',
      title: 'Transform',
      description: 'Mapping, transform rules, field operations.',
      configured: transformOk,
      icon: Wand2,
    },
    {
      key: 'data_protection',
      title: 'Data Protection',
      description: 'Schema drift policy and field protection rules.',
      configured: protectionOk,
      icon: ShieldCheck,
    },
    {
      key: 'classification',
      title: 'Classification',
      description: 'Shared default level inherited by every route.',
      configured: classificationOk,
      icon: Tags,
    },
    {
      key: 'policy',
      title: 'Policy',
      description: 'Shared delivery policy inherited by every route.',
      configured: policyOk,
      icon: Scale,
    },
  ]
}

/** @deprecated Use WizardSharedProcessingSection */
export const WizardGlobalProcessingSection = WizardSharedProcessingSection

export function WizardSharedProcessingSection({
  state,
  activeTab,
  onTabChange,
  children,
  routeCount = 0,
}: {
  state: Pick<
    WizardState,
    | 'mapping'
    | 'transformRules'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'dataProtection'
    | 'dataPolicy'
  >
  activeTab: SharedProcessingTab
  onTabChange: (tab: SharedProcessingTab) => void
  children?: ReactNode
  routeCount?: number
}) {
  const cards = buildSharedCards(state)
  const panelId = 'shared-processing-tabpanel'

  return (
    <section className="space-y-3" data-testid="shared-processing-section">
      <article className="rounded-lg border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[14px] font-semibold text-slate-900 dark:text-slate-50">Shared Processing</h4>
            <span className="rounded-full border border-violet-300/70 bg-violet-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-800 dark:border-violet-500/40 dark:text-violet-200">
              Baseline
            </span>
          </div>
          <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
            Configure shared defaults first — all routes inherit Transform, Data Protection, Classification, and Policy
            unless overridden individually.
          </p>
          {routeCount > 0 ? (
            <p
              className="mt-1 text-[10px] font-semibold text-violet-700 dark:text-violet-300"
              data-testid="shared-processing-route-count"
            >
              Applied to {routeCount} Route{routeCount === 1 ? '' : 's'}
            </p>
          ) : null}
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => {
            const Icon = card.icon
            const active = activeTab === card.key
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => onTabChange(card.key)}
                className={cn(
                  'rounded-lg border p-2.5 text-left transition-colors',
                  active
                    ? 'border-violet-400/80 bg-violet-500/[0.06] ring-1 ring-violet-400/40 dark:border-violet-500/50 dark:bg-violet-500/10'
                    : 'border-slate-200/90 bg-slate-50/50 hover:bg-slate-100/80 dark:border-gdc-border dark:bg-gdc-section/40 dark:hover:bg-gdc-rowHover',
                )}
                data-testid={`shared-processing-card-${card.key}`}
                aria-pressed={active}
              >
                <div className="flex items-start gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-700 dark:text-violet-300">
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">{card.title}</p>
                    <p className="mt-0.5 text-[9px] leading-snug text-slate-500 dark:text-gdc-muted">{card.description}</p>
                  </div>
                </div>
                <p
                  className={cn(
                    'mt-2 inline-flex items-center gap-1 text-[10px] font-semibold',
                    card.configured ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-gdc-muted',
                  )}
                >
                  {card.configured ? (
                    <>
                      <CheckCircle2 className="h-3 w-3" aria-hidden />
                      Configured
                    </>
                  ) : (
                    'Not configured'
                  )}
                </p>
              </button>
            )
          })}
        </div>

        <div
          className="mt-4 flex flex-wrap gap-1 border-b border-slate-100 dark:border-gdc-border"
          role="tablist"
          aria-label="Shared processing concerns"
          data-testid="shared-processing-tabs"
        >
          {SHARED_TAB_DEFS.map((tab) => {
            const active = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`shared-processing-tab-${tab.key}`}
                aria-selected={active}
                aria-controls={panelId}
                onClick={() => onTabChange(tab.key)}
                className={cn(
                  '-mb-px border-b-2 px-3 pb-2 text-[11px] font-semibold',
                  active
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
                data-testid={`shared-processing-tab-${tab.key}`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <div
          id={panelId}
          className="mt-4 space-y-4 rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section/40"
          data-testid="shared-processing-editor"
          data-shared-edit-mode="true"
          role="tabpanel"
          aria-labelledby={`shared-processing-tab-${activeTab}`}
        >
          {children}
        </div>
      </article>
    </section>
  )
}

export function summarizeSharedProtection(dataProtection: WizardDataProtectionState): string {
  const intentCount = dataProtection.intents.filter((i) => i.detectedField.trim()).length
  if (intentCount > 0) return `${intentCount} protection rule${intentCount === 1 ? '' : 's'}`
  return 'Default schema drift policy'
}

/** @deprecated Use summarizeSharedProtection */
export const summarizeGlobalProtection = summarizeSharedProtection
