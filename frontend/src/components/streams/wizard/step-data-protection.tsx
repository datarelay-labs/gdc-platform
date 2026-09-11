import { Plus, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { cn } from '../../../lib/utils'
import { computeRouteProtectionEffectivePreview } from '../../../lib/route-protection-effective-preview'
import {
  collectWizardDetectedFieldCandidates,
  inferWizardSensitivityClass,
  normalizeWizardDetectedField,
  sensitivityClassLabel,
  suggestLikelySensitiveFieldsFromState,
} from './wizard-data-protection-fields'
import { buildDataProtectionPersistPreview } from './wizard-data-protection-persist'
import { isDuplicateRouteOverride } from './wizard-governance-persist'
import { protectionActionLabel } from './wizard-data-protection-summary'
import {
  newWizardDataProtectionIntentKey,
  newWizardRouteProtectionOverrideKey,
  type WizardDataProtectionIntent,
  type WizardDataProtectionState,
  type WizardDeliveryBehavior,
  type WizardProtectionAction,
  type WizardRouteProtectionOverride,
  type WizardState,
  type WizardUnknownNormalFieldPolicy,
  type WizardUnknownSensitiveFieldPolicy,
} from './wizard-state'

export type StepDataProtectionProps = {
  state: WizardState
  onChange: (patch: Partial<WizardDataProtectionState>) => void
  section?: 'full' | 'schema-drift'
}

const PROTECTION_ACTIONS: ReadonlyArray<{ value: WizardProtectionAction; label: string }> = [
  { value: 'audit', label: 'Audit only' },
  { value: 'mask_partial', label: 'Mask (partial)' },
  { value: 'mask_full', label: 'Mask (full)' },
  { value: 'tokenize', label: 'Tokenize' },
  { value: 'hash', label: 'Hash' },
  { value: 'drop_field', label: 'Drop' },
]

const DELIVERY_BEHAVIORS: ReadonlyArray<{ value: WizardDeliveryBehavior; label: string }> = [
  { value: 'continue', label: 'Continue delivery' },
  { value: 'quarantine', label: 'Quarantine' },
  { value: 'block', label: 'Block delivery' },
]

const UNKNOWN_NORMAL_FIELD_POLICIES: ReadonlyArray<{ value: WizardUnknownNormalFieldPolicy; label: string }> = [
  { value: 'pass_through', label: 'Pass Through' },
  { value: 'require_review', label: 'Require Review' },
  { value: 'drop_field', label: 'Drop' },
  { value: 'quarantine', label: 'Quarantine' },
]

const UNKNOWN_SENSITIVE_FIELD_POLICIES: ReadonlyArray<{ value: WizardUnknownSensitiveFieldPolicy; label: string }> = [
  { value: 'auto_protect', label: 'Auto Protect' },
  { value: 'require_review', label: 'Require Review' },
  { value: 'drop_field', label: 'Drop' },
  { value: 'quarantine', label: 'Quarantine' },
]

function defaultRouteOverride(fieldPath: string): WizardRouteProtectionOverride {
  return {
    key: newWizardRouteProtectionOverrideKey(),
    fieldPath,
    routeDraftKey: '',
    protectionAction: 'tokenize',
    deliveryBehavior: 'continue',
    enabled: true,
  }
}

function RouteOverridesSection({
  intent,
  state,
  onChange,
}: {
  intent: WizardDataProtectionIntent
  state: WizardState
  onChange: (patch: Partial<WizardDataProtectionState>) => void
}) {
  const fieldPath = normalizeWizardDetectedField(intent.detectedField)
  const routeDrafts = state.destinations.routeDrafts
  const overrides = state.dataProtection.routeOverrides.filter(
    (o) => normalizeWizardDetectedField(o.fieldPath) === fieldPath,
  )

  const routeLabels = useMemo(() => {
    const labels = new Map<string, string>()
    routeDrafts.forEach((draft, index) => {
      labels.set(draft.key, `Route ${index + 1} (dest #${draft.destinationId})`)
    })
    return labels
  }, [routeDrafts])

  const previewRoutes = useMemo(
    () =>
      routeDrafts.map((draft, index) => ({
        routeDraftKey: draft.key,
        label: routeLabels.get(draft.key) ?? `Route ${index + 1}`,
      })),
    [routeDrafts, routeLabels],
  )

  const effectivePreview = useMemo(() => {
    if (!fieldPath || previewRoutes.length === 0) return null
    return computeRouteProtectionEffectivePreview({
      fieldPath,
      defaultAction: intent.protectionAction,
      routeOverrides: state.dataProtection.routeOverrides,
      routes: previewRoutes,
    })
  }, [fieldPath, previewRoutes, intent.protectionAction, state.dataProtection.routeOverrides])

  const updateOverrides = (next: WizardRouteProtectionOverride[]) => {
    const other = state.dataProtection.routeOverrides.filter(
      (o) => normalizeWizardDetectedField(o.fieldPath) !== fieldPath,
    )
    onChange({ routeOverrides: [...other, ...next] })
  }

  const updateOverride = (key: string, patch: Partial<WizardRouteProtectionOverride>) => {
    updateOverrides(
      overrides.map((o) => (o.key === key ? { ...o, ...patch } : o)),
    )
  }

  const removeOverride = (key: string) => {
    onChange({
      routeOverrides: state.dataProtection.routeOverrides.filter((o) => o.key !== key),
    })
  }

  const addOverride = () => {
    const availableDraft = routeDrafts.find(
      (draft) => !isDuplicateRouteOverride(state.dataProtection.routeOverrides, fieldPath, draft.key),
    )
    const next = defaultRouteOverride(fieldPath)
    if (availableDraft) next.routeDraftKey = availableDraft.key
    onChange({
      routeOverrides: [...state.dataProtection.routeOverrides, next],
    })
  }

  if (!fieldPath) return null

  return (
    <div
      className="mt-2 space-y-2 rounded-md border border-slate-200/80 bg-slate-50/60 p-3 dark:border-gdc-border dark:bg-gdc-section/60 md:col-span-4"
      data-testid={`route-overrides-${intent.key}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Route Overrides</p>
          <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
            Default: {protectionActionLabel(intent.protectionAction)}
          </p>
        </div>
        <button
          type="button"
          onClick={addOverride}
          disabled={routeDrafts.length === 0}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 text-[10px] font-semibold text-violet-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-violet-300"
          data-testid={`route-override-add-${intent.key}`}
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add Override
        </button>
      </div>

      {routeDrafts.length === 0 ? (
        <p className="text-[10px] text-amber-700 dark:text-amber-200">
          Add destinations in the Destinations step before configuring per-route overrides.
        </p>
      ) : null}

      {overrides.length === 0 ? (
        <p className="text-[10px] text-slate-500 dark:text-gdc-muted">All routes use the default protection action.</p>
      ) : (
        <div className="space-y-2">
          {overrides.map((override) => {
            const duplicate =
              override.routeDraftKey &&
              isDuplicateRouteOverride(
                state.dataProtection.routeOverrides,
                fieldPath,
                override.routeDraftKey,
                override.key,
              )
            return (
              <div
                key={override.key}
                className="grid gap-2 rounded-md border border-slate-200/80 bg-white p-2 dark:border-gdc-border dark:bg-gdc-card sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                data-testid={`route-override-row-${override.key}`}
              >
                <label className="grid gap-0.5 text-[10px]">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Route</span>
                  <select
                    value={override.routeDraftKey}
                    onChange={(e) => updateOverride(override.key, { routeDraftKey: e.target.value })}
                    className="h-8 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                  >
                    <option value="">Select route…</option>
                    {routeDrafts.map((draft) => (
                      <option key={draft.key} value={draft.key}>
                        {routeLabels.get(draft.key) ?? draft.key}
                      </option>
                    ))}
                  </select>
                  {duplicate ? (
                    <span className="text-[10px] text-red-600 dark:text-red-300">
                      Duplicate override for this field and route.
                    </span>
                  ) : null}
                </label>
                <label className="grid gap-0.5 text-[10px]">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Action</span>
                  <select
                    value={override.protectionAction}
                    onChange={(e) =>
                      updateOverride(override.key, {
                        protectionAction: e.target.value as WizardProtectionAction,
                      })
                    }
                    className="h-8 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                  >
                    {PROTECTION_ACTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-0.5 text-[10px]">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Delivery</span>
                  <select
                    value={override.deliveryBehavior}
                    onChange={(e) =>
                      updateOverride(override.key, {
                        deliveryBehavior: e.target.value as WizardDeliveryBehavior,
                      })
                    }
                    className="h-8 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                  >
                    {DELIVERY_BEHAVIORS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-end justify-end">
                  <button
                    type="button"
                    onClick={() => removeOverride(override.key)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[10px] font-semibold text-red-700 hover:bg-red-50 dark:border-gdc-border dark:text-red-300"
                    aria-label="Remove route override"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {effectivePreview && effectivePreview.perRoute.length > 0 ? (
        <div
          className="rounded border border-dashed border-slate-200/80 px-2 py-1.5 dark:border-gdc-border"
          data-testid={`route-override-effective-preview-${intent.key}`}
        >
          <p className="text-[10px] font-semibold text-slate-600 dark:text-slate-300">Effective preview</p>
          <ul className="mt-1 space-y-0.5 text-[10px] text-slate-600 dark:text-gdc-muted">
            {effectivePreview.perRoute.map((entry) => (
              <li key={entry.routeDraftKey}>
                {entry.routeLabel}: {protectionActionLabel(entry.protectionAction)}
                {entry.source === 'override' ? ' (override)' : ' (default)'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function defaultIntent(): WizardDataProtectionIntent {
  return {
    key: newWizardDataProtectionIntentKey(),
    detectedField: '',
    protectionAction: 'mask_partial',
    deliveryBehavior: 'continue',
  }
}

function SchemaDriftPolicyOptionGroup<T extends string>({
  name,
  legend,
  description,
  value,
  options,
  onChange,
  testIdPrefix,
}: {
  name: string
  legend: string
  description: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (next: T) => void
  testIdPrefix: string
}) {
  return (
    <fieldset className="space-y-2" data-testid={`${testIdPrefix}-group`}>
      <legend className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">{legend}</legend>
      <p className="text-[10px] font-normal text-slate-500 dark:text-gdc-muted">{description}</p>
      <div className="space-y-1.5">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[12px] transition-colors',
              value === opt.value
                ? 'border-violet-300/80 bg-violet-500/[0.06] font-semibold text-violet-900 dark:border-violet-500/40 dark:text-violet-100'
                : 'border-slate-200/90 text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover',
            )}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className="h-3.5 w-3.5 shrink-0 accent-violet-600"
              data-testid={`${testIdPrefix}-${opt.value}`}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function StepDataProtection({ state, onChange, section = 'full' }: StepDataProtectionProps) {
  const candidates = useMemo(() => collectWizardDetectedFieldCandidates(state), [state])
  const likelySensitive = useMemo(() => suggestLikelySensitiveFieldsFromState(state), [state])
  const preview = useMemo(
    () => buildDataProtectionPersistPreview(state.dataProtection, state.apiTest.unionSchema),
    [state.dataProtection, state.apiTest.unionSchema],
  )

  const updateIntent = (key: string, patch: Partial<WizardDataProtectionIntent>) => {
    onChange({
      intents: state.dataProtection.intents.map((intent) =>
        intent.key === key ? { ...intent, ...patch } : intent,
      ),
    })
  }

  const removeIntent = (key: string) => {
    onChange({
      intents: state.dataProtection.intents.filter((intent) => intent.key !== key),
    })
  }

  const addIntent = (fieldPath?: string) => {
    const next = defaultIntent()
    if (fieldPath) next.detectedField = fieldPath
    onChange({
      intents: [...state.dataProtection.intents, next],
    })
  }

  const schemaDriftSection = (
    <section
      className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="schema-drift-policy-section"
    >
      <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Schema Drift Policy</p>
      <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
        Shared classification defaults for fields that appear in future events but are not in your current sample.
      </p>
      <div className="mt-4 space-y-4">
        <SchemaDriftPolicyOptionGroup
          name="unknown-normal-field-policy"
          legend="Unknown Normal Field"
          description="When a new non-sensitive field appears"
          value={state.dataProtection.unknownNormalFieldPolicy}
          options={UNKNOWN_NORMAL_FIELD_POLICIES}
          onChange={(next) => onChange({ unknownNormalFieldPolicy: next })}
          testIdPrefix="schema-drift-unknown-normal-field-policy"
        />
        <div className="border-t border-slate-200/80 dark:border-gdc-border" role="separator" />
        <SchemaDriftPolicyOptionGroup
          name="unknown-sensitive-field-policy"
          legend="Unknown Sensitive Field"
          description="When a new field is judged sensitive"
          value={state.dataProtection.unknownSensitiveFieldPolicy}
          options={UNKNOWN_SENSITIVE_FIELD_POLICIES}
          onChange={(next) => onChange({ unknownSensitiveFieldPolicy: next })}
          testIdPrefix="schema-drift-unknown-sensitive-field-policy"
        />
      </div>
    </section>
  )

  if (section === 'schema-drift') {
    return (
      <div className="space-y-4" data-testid="wizard-step-data-protection-schema-drift">
        {schemaDriftSection}
      </div>
    )
  }

  return (
    <div className="space-y-6" data-testid="wizard-step-data-protection">
      <p className="text-[13px] leading-relaxed text-slate-600 dark:text-gdc-muted">
        First choose how <span className="font-semibold text-slate-800 dark:text-slate-100">new fields</span> should be
        handled when they appear. Then define protection for{' '}
        <span className="font-semibold text-slate-800 dark:text-slate-100">fields you already know</span> from your
        sample and transform output.
      </p>

      {schemaDriftSection}

      <section
        className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
        data-testid="protection-rules-section"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Protection Rules</p>
            <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
              Rules for detected fields from your current sample — field, protection action, and delivery behavior.
            </p>
          </div>
          <button
            type="button"
            onClick={() => addIntent()}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2.5 text-[11px] font-semibold text-violet-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-violet-300"
            data-testid="data-protection-add-row"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add field
          </button>
        </div>

        {candidates.length === 0 ? (
          <section className="mt-4 rounded-lg border border-amber-200/80 bg-amber-500/[0.06] p-3 dark:border-amber-500/35 dark:bg-amber-500/10">
            <p className="text-[12px] font-semibold text-amber-900 dark:text-amber-100">No sample fields yet</p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-100/90">
              Complete Sample and Transform first so detected fields appear here. You can still continue without
              protection rules.
            </p>
          </section>
        ) : null}

        {likelySensitive.length > 0 && state.dataProtection.intents.length === 0 ? (
          <section
            className="mt-4 rounded-lg border border-violet-200/70 bg-violet-500/[0.05] p-3 dark:border-violet-500/30 dark:bg-violet-500/10"
            data-testid="data-protection-suggestions"
          >
            <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Likely sensitive fields</p>
            <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">
              Based on your sample and transform output. Add a protection rule for any field you want governed at
              delivery.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {likelySensitive.slice(0, 8).map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => addIntent(path)}
                  className="rounded-md border border-violet-300/70 bg-white px-2.5 py-1 font-mono text-[11px] font-semibold text-violet-800 hover:bg-violet-50 dark:border-violet-500/40 dark:bg-gdc-card dark:text-violet-200 dark:hover:bg-violet-500/10"
                >
                  {path}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {state.dataProtection.intents.length === 0 ? (
          <p className="mt-4 text-[12px] text-slate-600 dark:text-gdc-muted">
            No protection rules configured. Delivery will proceed without stream-scoped data protection intent.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <div
              className="hidden gap-3 rounded-lg border border-dashed border-slate-200/90 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-gdc-border md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
              aria-hidden
            >
              <span>Detected Fields</span>
              <span>Protection Action</span>
              <span>Delivery Behavior</span>
              <span className="sr-only">Actions</span>
            </div>
            {state.dataProtection.intents.map((intent) => {
              const sensitivityClass = intent.detectedField.trim()
                ? inferWizardSensitivityClass(intent.detectedField, state.apiTest.unionSchema)
                : null
              const normalizedField = normalizeWizardDetectedField(intent.detectedField)
              const pathKnown =
                !normalizedField || candidates.includes(normalizedField)
              return (
                <div
                  key={intent.key}
                  className="grid gap-3 rounded-lg border border-slate-200/90 p-3 dark:border-gdc-border md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                  data-testid={`data-protection-row-${intent.key}`}
                >
                  <label className="grid gap-1 text-[11px]">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">Detected Fields</span>
                    <input
                      list="wizard-detected-field-candidates"
                      value={intent.detectedField}
                      onChange={(e) => updateIntent(intent.key, { detectedField: e.target.value })}
                      placeholder="$.email"
                      className="h-9 rounded-md border border-slate-200/90 bg-white px-2 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                    />
                    {!pathKnown ? (
                      <span className="text-[10px] text-amber-700 dark:text-amber-200">
                        Choose a field from the runtime event list — this path is not on the final event.
                      </span>
                    ) : null}
                  </label>
                  <label className="grid gap-1 text-[11px]">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">Protection Action</span>
                    <select
                      value={intent.protectionAction}
                      onChange={(e) =>
                        updateIntent(intent.key, {
                          protectionAction: e.target.value as WizardProtectionAction,
                        })
                      }
                      className="h-9 rounded-md border border-slate-200/90 bg-white px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                    >
                      {PROTECTION_ACTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px]">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">Delivery Behavior</span>
                    <select
                      value={intent.deliveryBehavior}
                      onChange={(e) =>
                        updateIntent(intent.key, {
                          deliveryBehavior: e.target.value as WizardDeliveryBehavior,
                        })
                      }
                      className="h-9 rounded-md border border-slate-200/90 bg-white px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                    >
                      {DELIVERY_BEHAVIORS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex items-end justify-end">
                    <button
                      type="button"
                      onClick={() => removeIntent(intent.key)}
                      className="inline-flex h-9 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[11px] font-semibold text-red-700 hover:bg-red-50 dark:border-gdc-border dark:text-red-300 dark:hover:bg-red-500/10"
                      aria-label="Remove protection rule"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Remove
                    </button>
                  </div>
                  {sensitivityClass ? (
                    <p className="text-[10px] text-slate-500 dark:text-gdc-muted md:col-span-4">
                      Category: {sensitivityClassLabel(sensitivityClass)}
                    </p>
                  ) : null}
                  <RouteOverridesSection intent={intent} state={state} onChange={onChange} />
                </div>
              )
            })}
          </div>
        )}

        <datalist id="wizard-detected-field-candidates">
          {candidates.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
      </section>

      {preview.warnings.length > 0 ? (
        <section
          className={cn(
            'rounded-xl border p-4',
            'border-slate-200/90 bg-slate-50/80 dark:border-gdc-border dark:bg-gdc-section',
          )}
          data-testid="data-protection-deploy-preview"
        >
          <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Deploy note</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
