import { cn } from '../../../lib/utils'
import type { WizardClassificationLevel, WizardDataPolicyState } from './wizard-state'
import { normalizeWizardClassificationLevel, wizardDataProtectionIntentReady } from './wizard-state'
import type { WizardDataProtectionState } from './wizard-state'

const CLASSIFICATION_LEVELS: ReadonlyArray<{ value: WizardClassificationLevel; label: string }> = [
  { value: 'PUBLIC', label: 'PUBLIC' },
  { value: 'INTERNAL', label: 'INTERNAL' },
  { value: 'CONFIDENTIAL', label: 'CONFIDENTIAL' },
  { value: 'RESTRICTED', label: 'RESTRICTED' },
]

const inputCls =
  'h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

export function WizardSharedClassificationSection({
  dataPolicy,
  dataProtection,
  onChangeDataPolicy,
  readOnly = false,
}: {
  dataPolicy: Pick<WizardDataPolicyState, 'defaultClassification'>
  dataProtection: Pick<WizardDataProtectionState, 'intents'>
  onChangeDataPolicy?: (patch: Partial<WizardDataPolicyState>) => void
  readOnly?: boolean
}) {
  const ruleCount = dataProtection.intents.filter(wizardDataProtectionIntentReady).length
  const level = normalizeWizardClassificationLevel(dataPolicy.defaultClassification)

  return (
    <div className="space-y-3" data-testid="shared-classification-editor">
      <p className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
        Shared classification is the stream default. Every route inherits this level unless it sets a route floor.
        A route floor never downgrades the shared result.
      </p>
      <label className="grid max-w-xs gap-1 text-[11px]">
        <span className="font-semibold text-slate-700 dark:text-slate-200">Default classification</span>
        <select
          value={level}
          disabled={readOnly || !onChangeDataPolicy}
          onChange={(e) =>
            onChangeDataPolicy?.({
              defaultClassification: normalizeWizardClassificationLevel(e.target.value),
            })
          }
          className={cn(inputCls, 'appearance-none pr-8')}
          data-testid="shared-classification-default-level"
        >
          {CLASSIFICATION_LEVELS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] text-slate-500 dark:text-gdc-muted" data-testid="shared-classification-rules-hint">
        {ruleCount > 0
          ? `${ruleCount} Data Protection field${ruleCount === 1 ? '' : 's'} will also create stream classification rules on deploy.`
          : 'No field rules yet — deploy uses this default plus sensitive findings unless a route sets a floor.'}
      </p>
    </div>
  )
}
