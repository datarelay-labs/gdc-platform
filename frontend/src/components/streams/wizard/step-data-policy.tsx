import { ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import {
  dataPolicyPresetPatch,
  type WizardDataPolicyPreset,
  type WizardDataPolicyState,
} from './wizard-state'

type StepDataPolicyProps = {
  state: WizardDataPolicyState
  onChange: (patch: Partial<WizardDataPolicyState>) => void
}

const PRESETS: ReadonlyArray<{ key: WizardDataPolicyPreset; title: string; description: string }> = [
  { key: 'minimal', title: 'Minimal', description: 'Detect sensitive data only — no blocking or masking defaults.' },
  { key: 'standard', title: 'Standard', description: 'Mask PII, classify events, and audit confidential data.' },
  { key: 'strict', title: 'Strict', description: 'Mask PII and quarantine RESTRICTED classifications before delivery.' },
]

export function StepDataPolicy({ state, onChange }: StepDataPolicyProps) {
  const applyPreset = (preset: WizardDataPolicyPreset) => {
    onChange(dataPolicyPresetPatch(preset))
  }

  return (
    <div className="space-y-4" data-testid="wizard-step-data-policy">
      <header className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">Data Policy</h3>
          <p className="max-w-3xl text-[13px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            Configure how this stream handles sensitive data before delivery. Fine-tune rules after creation from Stream →
            Data Policy.
          </p>
        </div>
      </header>

      <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Preset</p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {PRESETS.map((preset) => (
            <label
              key={preset.key}
              className={cn(
                'flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors',
                state.preset === preset.key
                  ? 'border-violet-400/70 bg-violet-500/[0.06] dark:border-violet-500/50'
                  : 'border-slate-200/90 hover:bg-slate-50/80 dark:border-gdc-border dark:hover:bg-gdc-rowHover',
              )}
            >
              <input
                type="radio"
                name="data-policy-preset"
                className="mt-1"
                checked={state.preset === preset.key}
                onChange={() => applyPreset(preset.key)}
              />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">{preset.title}</p>
                <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">{preset.description}</p>
              </div>
            </label>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <PolicyCard title="Sensitive Data">
          <ToggleRow
            label="Auto-detect on ingest"
            checked={state.sensitiveAutoDetect}
            onChange={(v) => onChange({ sensitiveAutoDetect: v })}
          />
          <ToggleRow
            label="Alert on new fields (data shape)"
            checked={state.dataShapeAlert}
            onChange={(v) => onChange({ dataShapeAlert: v })}
          />
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">Open findings during wizard: 0 (configure after create)</p>
        </PolicyCard>

        <PolicyCard title="Protection">
          <ToggleRow label="Mask PII fields" checked={state.maskPii} onChange={(v) => onChange({ maskPii: v })} />
          <SelectRow
            label="Default mask mode"
            value={state.defaultMaskMode}
            options={[
              { value: 'partial', label: 'Partial' },
              { value: 'full', label: 'Full' },
              { value: 'tokenize', label: 'Tokenize' },
            ]}
            onChange={(v) => onChange({ defaultMaskMode: v as WizardDataPolicyState['defaultMaskMode'] })}
          />
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">Token store: summary only (configured in Protection)</p>
        </PolicyCard>

        <PolicyCard title="Classification">
          <SelectRow
            label="Default level"
            value={state.defaultClassification}
            options={[
              { value: 'PUBLIC', label: 'PUBLIC' },
              { value: 'INTERNAL', label: 'INTERNAL' },
              { value: 'CONFIDENTIAL', label: 'CONFIDENTIAL' },
              { value: 'RESTRICTED', label: 'RESTRICTED' },
            ]}
            onChange={(v) => onChange({ defaultClassification: v })}
          />
        </PolicyCard>

        <PolicyCard title="Response Action">
          <SelectRow
            label="On RESTRICTED"
            value={state.restrictedResponse}
            options={[
              { value: 'continue', label: 'Continue' },
              { value: 'require_review', label: 'Require Review' },
              { value: 'quarantine', label: 'Quarantine' },
              { value: 'block', label: 'Block delivery' },
            ]}
            onChange={(v) => onChange({ restrictedResponse: v as WizardDataPolicyState['restrictedResponse'] })}
          />
          <SelectRow
            label="On CONFIDENTIAL"
            value={state.confidentialResponse}
            options={[
              { value: 'continue', label: 'Continue' },
              { value: 'require_review', label: 'Require Review' },
              { value: 'quarantine', label: 'Quarantine' },
              { value: 'block', label: 'Block delivery' },
            ]}
            onChange={(v) => onChange({ confidentialResponse: v as WizardDataPolicyState['confidentialResponse'] })}
          />
        </PolicyCard>
      </div>
    </div>
  )
}

function PolicyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <h4 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">{title}</h4>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[12px]">
      <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded" />
    </label>
  )
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <label className="grid gap-1 text-[12px]">
      <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-slate-200/90 bg-white px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  )
}
