import { Loader2, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  activateGovernancePolicy,
  createGovernancePolicy,
  fetchPolicyAssignments,
  fetchPolicyPreview,
  previewPolicyImpact,
  previewPolicyJson,
  retireGovernancePolicy,
  submitPolicyForReview,
  updateGovernancePolicy,
  updatePolicyAssignments,
  type GovernancePolicyEntry,
  type GovernancePolicyImpactResponse,
  type GovernancePolicyPreviewResponse,
  type PolicyActionType,
  type PolicyCategory,
  type PolicyCondition,
  type PolicyJsonBody,
  type PolicyStatus,
  type StreamAssignmentEntry,
} from '../../api/gdcGovernancePolicies'
import { fetchStreamsList } from '../../api/gdcStreams'
import type { StreamRead } from '../../api/types/gdcApi'
import { cn } from '../../lib/utils'
import { PolicyImpactPanel } from './policy-impact-panel'
import {
  policyCanEdit,
  policyLifecycleAction,
  policyLifecycleActionLabel,
  policyStatusBadgeClass,
  policyStatusLabel,
} from './policy-lifecycle'
import { PolicyRuntimeNotice } from './policy-runtime-notice'
import { PolicySimulationPanel } from './policy-simulation-panel'

const CATEGORIES: { value: PolicyCategory; label: string }[] = [
  { value: 'DATA_PROTECTION', label: 'Data Protection' },
  { value: 'COMPLIANCE', label: 'Compliance' },
  { value: 'CUSTOM', label: 'Custom' },
]

const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
] as const

const ACTION_TYPES: { value: PolicyActionType; label: string }[] = [
  { value: 'quarantine', label: 'Quarantine' },
  { value: 'tokenize', label: 'Tokenize' },
  { value: 'mask', label: 'Mask' },
  { value: 'audit_only', label: 'Audit only' },
]

const CONDITION_FIELDS = [
  { value: 'classification', label: 'Classification level' },
  { value: 'sensitivity', label: 'Sensitivity' },
  { value: 'field', label: 'Field path' },
]

const DEFAULT_POLICY_JSON: PolicyJsonBody = {
  conditions: [{ field: 'classification', operator: 'equals', value: 'RESTRICTED' }],
  actions: [{ type: 'quarantine' }],
}

export type PolicyEditorDrawerProps = {
  open: boolean
  policy: GovernancePolicyEntry | null
  readOnly?: boolean
  onClose: () => void
  onSaved: () => void
}

function inputClass() {
  return 'w-full rounded-md border border-slate-200/90 bg-white px-2.5 py-1.5 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'
}

function labelClass() {
  return 'text-[11px] font-semibold text-slate-700 dark:text-slate-200'
}

export function PolicyEditorDrawer({ open, policy, readOnly = false, onClose, onSaved }: PolicyEditorDrawerProps) {
  const isEdit = policy != null
  const [mode, setMode] = useState<'guided' | 'advanced'>('guided')
  const [saving, setSaving] = useState(false)
  const [lifecycleLoading, setLifecycleLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<PolicyCategory>('DATA_PROTECTION')
  const [status, setStatus] = useState<PolicyStatus>('DRAFT')
  const [policyJson, setPolicyJson] = useState<PolicyJsonBody>(DEFAULT_POLICY_JSON)
  const [preview, setPreview] = useState<GovernancePolicyPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [impact, setImpact] = useState<GovernancePolicyImpactResponse | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [selectedStreamIds, setSelectedStreamIds] = useState<number[]>([])

  const resetForm = useCallback((entry: GovernancePolicyEntry | null) => {
    if (entry) {
      setName(entry.name)
      setDescription(entry.description ?? '')
      setCategory(entry.category)
      setStatus(entry.status)
      setPolicyJson(entry.policy_json)
      setSelectedStreamIds(entry.assigned_stream_ids)
    } else {
      setName('')
      setDescription('')
      setCategory('DATA_PROTECTION')
      setStatus('DRAFT')
      setPolicyJson(DEFAULT_POLICY_JSON)
      setSelectedStreamIds([])
    }
    setMode('guided')
    setError(null)
    setPreview(null)
    setImpact(null)
  }, [])

  useEffect(() => {
    if (open) resetForm(policy)
  }, [open, policy, resetForm])

  useEffect(() => {
    if (!open) return
    void fetchStreamsList().then((rows) => setStreams(rows ?? []))
    if (policy?.id) {
      void fetchPolicyAssignments(policy.id).then((res) => {
        if (res?.assignments) {
          setSelectedStreamIds(res.assignments.filter((a) => a.enabled).map((a) => a.stream_id))
        }
      })
    }
  }, [open, policy?.id])

  const refreshPreview = useCallback(async (json: PolicyJsonBody) => {
    setPreviewLoading(true)
    try {
      const result = await previewPolicyJson(json)
      setPreview(result)
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const refreshImpact = useCallback(
    async (json: PolicyJsonBody, streamIds: number[]) => {
      setImpactLoading(true)
      try {
        const result = await previewPolicyImpact({
          policy_json: json,
          policy_id: policy?.id ?? null,
          stream_ids: streamIds.length > 0 ? streamIds : undefined,
        })
        setImpact(result)
      } catch {
        setImpact(null)
      } finally {
        setImpactLoading(false)
      }
    },
    [policy?.id],
  )

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void refreshPreview(policyJson), 300)
    return () => window.clearTimeout(timer)
  }, [open, policyJson, refreshPreview])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void refreshImpact(policyJson, selectedStreamIds), 400)
    return () => window.clearTimeout(timer)
  }, [open, policyJson, selectedStreamIds, refreshImpact])

  const updateCondition = (index: number, patch: Partial<PolicyCondition>) => {
    setPolicyJson((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }))
  }

  const addCondition = () => {
    setPolicyJson((prev) => ({
      ...prev,
      conditions: [...prev.conditions, { field: 'classification', operator: 'equals', value: '' }],
    }))
  }

  const removeCondition = (index: number) => {
    setPolicyJson((prev) => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
    }))
  }

  const updateAction = (index: number, type: PolicyActionType) => {
    setPolicyJson((prev) => ({
      ...prev,
      actions: prev.actions.map((a, i) => (i === index ? { type } : a)),
    }))
  }

  const addAction = () => {
    setPolicyJson((prev) => ({
      ...prev,
      actions: [...prev.actions, { type: 'audit_only' }],
    }))
  }

  const removeAction = (index: number) => {
    setPolicyJson((prev) => ({
      ...prev,
      actions: prev.actions.filter((_, i) => i !== index),
    }))
  }

  const toggleStream = (streamId: number) => {
    setSelectedStreamIds((prev) =>
      prev.includes(streamId) ? prev.filter((id) => id !== streamId) : [...prev, streamId],
    )
  }

  const assignmentsPayload: StreamAssignmentEntry[] = useMemo(
    () => selectedStreamIds.map((stream_id) => ({ stream_id, enabled: true })),
    [selectedStreamIds],
  )

  const editable = !readOnly && policyCanEdit(status)
  const lifecycleAction = policyLifecycleAction(status)

  const handleLifecycle = async () => {
    if (!isEdit || !policy || readOnly || lifecycleAction == null) return
    setLifecycleLoading(true)
    setError(null)
    try {
      let result: { policy: GovernancePolicyEntry } | null = null
      if (lifecycleAction === 'submit-review') {
        result = await submitPolicyForReview(policy.id)
      } else if (lifecycleAction === 'activate') {
        result = await activateGovernancePolicy(policy.id)
      } else if (lifecycleAction === 'retire') {
        if (!window.confirm(`Retire policy "${policy.name}"?`)) return
        result = await retireGovernancePolicy(policy.id)
      }
      if (!result?.policy) throw new Error('Lifecycle action failed.')
      setStatus(result.policy.status)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLifecycleLoading(false)
    }
  }

  const handleSave = async () => {
    if (!editable) return
    setSaving(true)
    setError(null)
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        category,
        policy_json: policyJson,
      }
      let savedId = policy?.id
      if (isEdit && policy) {
        const updated = await updateGovernancePolicy(policy.id, body)
        if (!updated?.policy) throw new Error('Failed to update policy.')
        savedId = updated.policy.id
      } else {
        const created = await createGovernancePolicy(body)
        if (!created?.policy) throw new Error('Failed to create policy.')
        savedId = created.policy.id
      }
      if (savedId != null) {
        await updatePolicyAssignments(savedId, assignmentsPayload)
        await fetchPolicyPreview(savedId)
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="policy-editor-drawer">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 dark:bg-black/50"
        aria-label="Close policy editor"
        onClick={onClose}
      />
      <aside
        className="relative flex h-full w-full max-w-lg flex-col border-l border-slate-200/90 bg-white shadow-xl dark:border-gdc-border dark:bg-gdc-card"
        role="dialog"
        aria-modal="true"
        aria-label={readOnly ? 'View policy' : isEdit ? 'Edit policy' : 'New policy'}
      >
        <header className="flex items-center justify-between gap-2 border-b border-slate-200/90 px-4 py-3 dark:border-gdc-border">
          <div>
            <p className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">
              {readOnly ? 'View policy' : isEdit ? 'Edit policy' : 'New policy'}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
              Guided Policy Builder (M18.1){readOnly ? ' — read-only' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="flex gap-1 border-b border-slate-200/90 px-4 py-2 dark:border-gdc-border">
          <button
            type="button"
            onClick={() => setMode('guided')}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] font-semibold',
              mode === 'guided'
                ? 'bg-violet-600 text-white dark:bg-violet-500'
                : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
            )}
          >
            Guided
          </button>
          <button
            type="button"
            onClick={() => setMode('advanced')}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] font-semibold',
              mode === 'advanced'
                ? 'bg-violet-600 text-white dark:bg-violet-500'
                : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
            )}
          >
            Advanced
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <PolicyRuntimeNotice compact />

          {isEdit ? (
            <section
              className="rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-card/50"
              aria-label="Policy lifecycle"
              data-testid="policy-editor-lifecycle"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">Current status</p>
                  <span
                    className={cn(
                      'mt-1 inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase',
                      policyStatusBadgeClass(status),
                    )}
                    data-testid="policy-editor-status-badge"
                  >
                    {policyStatusLabel(status)}
                  </span>
                </div>
                {!readOnly && lifecycleAction ? (
                  <button
                    type="button"
                    disabled={lifecycleLoading}
                    onClick={() => void handleLifecycle()}
                    className="inline-flex items-center gap-1 rounded-md border border-violet-300/80 bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200"
                    data-testid={`policy-lifecycle-${lifecycleAction}`}
                  >
                    {lifecycleLoading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                    {policyLifecycleActionLabel(lifecycleAction)}
                  </button>
                ) : null}
              </div>
              {status === 'RETIRED' ? (
                <p className="mt-2 text-[10px] text-slate-500 dark:text-gdc-muted">Retired policies are view-only.</p>
              ) : null}
            </section>
          ) : null}

          {error ? (
            <p className="text-[11px] text-red-700 dark:text-red-300" role="alert">
              {error}
            </p>
          ) : null}

          {mode === 'advanced' ? (
            <div
              className="rounded-lg border border-dashed border-slate-300/80 bg-slate-50/60 p-4 text-center dark:border-gdc-border dark:bg-gdc-card/40"
              data-testid="policy-editor-advanced-placeholder"
            >
              <p className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">Advanced mode</p>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">
                Direct rule table editing arrives in a later milestone. Use Guided mode for IF/THEN rules.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className={labelClass()} htmlFor="policy-name">
                  Name
                </label>
                <input
                  id="policy-name"
                  className={inputClass()}
                  value={name}
                  disabled={!editable}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Customer Data Protection"
                  data-testid="policy-editor-name"
                />
              </div>

              <div className="space-y-1.5">
                <label className={labelClass()} htmlFor="policy-description">
                  Description
                </label>
                <textarea
                  id="policy-description"
                  className={cn(inputClass(), 'min-h-[4rem] resize-y')}
                  value={description}
                  disabled={!editable}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this policy protects"
                  data-testid="policy-editor-description"
                />
              </div>

              <div className="space-y-1.5">
                <label className={labelClass()} htmlFor="policy-category">
                  Category
                </label>
                <select
                  id="policy-category"
                  className={inputClass()}
                  value={category}
                  disabled={!editable}
                  onChange={(e) => setCategory(e.target.value as PolicyCategory)}
                  data-testid="policy-editor-category"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              <section aria-label="Conditions">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">WHEN (conditions)</p>
                  {editable ? (
                    <button
                      type="button"
                      onClick={addCondition}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 dark:text-violet-300"
                    >
                      <Plus className="h-3 w-3" aria-hidden />
                      Add
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 space-y-2">
                  {policyJson.conditions.map((cond, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
                      <select
                        className={inputClass()}
                        value={cond.field}
                        disabled={!editable}
                        onChange={(e) => updateCondition(idx, { field: e.target.value })}
                        aria-label={`Condition ${idx + 1} field`}
                      >
                        {CONDITION_FIELDS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className={inputClass()}
                        value={cond.operator}
                        disabled={!editable}
                        onChange={(e) =>
                          updateCondition(idx, { operator: e.target.value as PolicyCondition['operator'] })
                        }
                        aria-label={`Condition ${idx + 1} operator`}
                      >
                        {OPERATORS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <input
                        className={inputClass()}
                        value={cond.value}
                        disabled={!editable}
                        onChange={(e) => updateCondition(idx, { value: e.target.value })}
                        placeholder="RESTRICTED"
                        aria-label={`Condition ${idx + 1} value`}
                      />
                      {editable ? (
                        <button
                          type="button"
                          disabled={policyJson.conditions.length <= 1}
                          onClick={() => removeCondition(idx)}
                          className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                          aria-label={`Remove condition ${idx + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : (
                        <span aria-hidden />
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section aria-label="Actions">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">THEN (actions)</p>
                  {editable ? (
                    <button
                      type="button"
                      onClick={addAction}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 dark:text-violet-300"
                    >
                      <Plus className="h-3 w-3" aria-hidden />
                      Add
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 space-y-2">
                  {policyJson.actions.map((action, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        className={cn(inputClass(), 'flex-1')}
                        value={action.type}
                        disabled={!editable}
                        onChange={(e) => updateAction(idx, e.target.value as PolicyActionType)}
                        aria-label={`Action ${idx + 1}`}
                      >
                        {ACTION_TYPES.map((a) => (
                          <option key={a.value} value={a.value}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                      {editable ? (
                        <button
                          type="button"
                          disabled={policyJson.actions.length <= 1}
                          onClick={() => removeAction(idx)}
                          className="rounded p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                          aria-label={`Remove action ${idx + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>

              <section aria-label="Stream assignment">
                <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Assign streams</p>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">
                  Select streams where this named policy applies.
                </p>
                <div
                  className="mt-2 max-h-36 overflow-y-auto rounded-md border border-slate-200/90 p-2 dark:border-gdc-border"
                  data-testid="policy-editor-stream-assignments"
                >
                  {streams.length === 0 ? (
                    <p className="text-[11px] text-slate-500 dark:text-gdc-muted">No streams available.</p>
                  ) : (
                    streams.map((stream) => (
                      <label
                        key={stream.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] hover:bg-slate-50 dark:hover:bg-gdc-rowHover"
                      >
                        <input
                          type="checkbox"
                          checked={selectedStreamIds.includes(stream.id)}
                          disabled={!editable}
                          onChange={() => toggleStream(stream.id)}
                        />
                        <span>
                          {stream.name} <span className="text-slate-400">#{stream.id}</span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </section>
            </>
          )}

          <section
            className="rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-card/50"
            aria-label="Policy preview"
            data-testid="policy-editor-preview"
          >
            <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Preview</p>
            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted">
              Preview only — runtime enforcement not enabled.
            </p>
            {previewLoading ? (
              <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Building preview…
              </p>
            ) : preview?.rules?.length ? (
              <ul className="mt-2 space-y-1">
                {preview.rules.map((rule, idx) => (
                  <li key={idx} className="font-mono text-[11px] text-violet-800 dark:text-violet-200">
                    {rule.combined}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500 dark:text-gdc-muted">Add conditions and actions to preview.</p>
            )}
          </section>

          <PolicyImpactPanel impact={impact} loading={impactLoading} />

          <PolicySimulationPanel
            policyJson={policyJson}
            policyId={policy?.id ?? null}
            streamIds={selectedStreamIds}
            runtimeDataAvailable={impact?.data_available ?? false}
          />
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200/90 px-4 py-3 dark:border-gdc-border">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200/90 px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:border-gdc-border dark:text-slate-200"
          >
            Cancel
          </button>
          {editable ? (
            <button
              type="button"
              disabled={saving || !name.trim()}
              onClick={() => void handleSave()}
              className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50 dark:bg-violet-500"
              data-testid="policy-editor-save"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Save policy
            </button>
          ) : null}
        </footer>
      </aside>
    </div>
  )
}
