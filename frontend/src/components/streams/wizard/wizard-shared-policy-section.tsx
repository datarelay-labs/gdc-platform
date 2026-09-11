import { cn } from '../../../lib/utils'
import { deliveryBehaviorLabel } from './wizard-data-protection-summary'
import type { WizardDataPolicyState, WizardDataProtectionState, WizardPolicyDeliveryBehavior } from './wizard-state'
import { wizardDataProtectionIntentReady } from './wizard-state'

const inputCls =
  'h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

/** Shared + Route Policy actions only — Protection Mask/Tokenize/Hash/Remove are not Policy. */
export const POLICY_DELIVERY_OPTIONS: ReadonlyArray<{ value: WizardPolicyDeliveryBehavior; label: string }> = [
  { value: 'continue', label: 'Continue' },
  { value: 'require_review', label: 'Require Review' },
  { value: 'quarantine', label: 'Quarantine' },
  { value: 'block', label: 'Block' },
]

export const RESPONSE_RESTRICTED_OPTIONS = POLICY_DELIVERY_OPTIONS
export const RESPONSE_CONFIDENTIAL_OPTIONS = POLICY_DELIVERY_OPTIONS

export function WizardSharedPolicySection({
  dataPolicy,
  dataProtection,
  onChangeDataPolicy,
  readOnly = false,
}: {
  dataPolicy: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>
  dataProtection: Pick<WizardDataProtectionState, 'intents'>
  onChangeDataPolicy?: (patch: Partial<WizardDataPolicyState>) => void
  readOnly?: boolean
}) {
  const configuredIntents = dataProtection.intents.filter(wizardDataProtectionIntentReady)

  return (
    <div className="space-y-4" data-testid="shared-policy-editor">
      <p className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
        Shared policy controls delivery for classified events (Continue, Review, Quarantine, Block). Field masking and
        other Protection actions are configured under Data Protection — not here.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-[11px]">
          <span className="font-semibold text-slate-700 dark:text-slate-200">When RESTRICTED</span>
          <select
            value={dataPolicy.restrictedResponse}
            disabled={readOnly || !onChangeDataPolicy}
            onChange={(e) =>
              onChangeDataPolicy?.({
                restrictedResponse: e.target.value as WizardDataPolicyState['restrictedResponse'],
              })
            }
            className={cn(inputCls, 'appearance-none pr-8')}
            data-testid="shared-policy-restricted-response"
          >
            {POLICY_DELIVERY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px]">
          <span className="font-semibold text-slate-700 dark:text-slate-200">When CONFIDENTIAL</span>
          <select
            value={dataPolicy.confidentialResponse}
            disabled={readOnly || !onChangeDataPolicy}
            onChange={(e) =>
              onChangeDataPolicy?.({
                confidentialResponse: e.target.value as WizardDataPolicyState['confidentialResponse'],
              })
            }
            className={cn(inputCls, 'appearance-none pr-8')}
            data-testid="shared-policy-confidential-response"
          >
            {POLICY_DELIVERY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {configuredIntents.length > 0 ? (
        <div className="space-y-1.5" data-testid="shared-policy-field-rules">
          <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Field delivery rules</p>
          <ul className="space-y-1.5 text-[11px]">
            {configuredIntents.map((intent) => (
              <li
                key={intent.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200/90 bg-white px-2.5 py-1.5 dark:border-gdc-border dark:bg-gdc-card"
              >
                <span className="font-mono text-slate-800 dark:text-slate-100">{intent.detectedField}</span>
                <span className="font-semibold text-slate-600 dark:text-gdc-muted">
                  {deliveryBehaviorLabel(intent.deliveryBehavior)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
          No field delivery rules yet — add fields in Data Protection. Classification responses above still apply as
          the shared policy default.
        </p>
      )}
    </div>
  )
}
