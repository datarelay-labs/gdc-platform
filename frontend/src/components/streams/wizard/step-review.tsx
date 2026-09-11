import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock,
  Copy,
  Globe,
  Loader2,
  Plug,
  Radio,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { fetchDestinationsList, type DestinationListItem } from '../../../api/gdcDestinations'
import { runEnrichmentExecPreview } from '../../../api/gdcRuntimePreview'
import { isDestinationConnectivityVerified } from '../../../utils/destination-connectivity-health'
import { enrichmentDictFromRules } from './enrichment-rules-model'
import { NAV_PATH } from '../../../config/nav-paths'
import { cn } from '../../../lib/utils'
import {
  deliveryModeFromFailurePolicy,
  failurePolicyBehaviorLabel,
  formatWizardRateLimitDraft,
  formatWizardSyslogLabel,
} from './wizard-delivery-helpers'
import {
  buildMappedBaseFromState,
  countDuplicateEnrichmentKeys,
  enrichmentValueKind,
} from './wizard-review-preview'
import { DataProtectionReviewSummary } from './data-protection-review-summary'
import { incrementalRequestTestWarning } from './wizard-incremental-request'
import {
  buildFullRequestUrl,
  computeLegacySubstepCompletion,
  effectiveRequestHeaders,
  type AuthType,
  type WizardLegacySubstepKey,
  type WizardState,
} from './wizard-state'

export type StepReviewProps = {
  state: WizardState
  busy?: boolean
  governanceEnabled?: boolean
  /** Jump to a wizard step when the user clicks an Edit shortcut */
  onNavigateToStep: (stepKey: WizardLegacySubstepKey) => void
  onEditDataPolicy?: () => void
}

function formatScheduleHuman(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec % 3600 === 0) return `Every ${sec / 3600} hour${sec === 3600 ? '' : 's'}`
  if (sec % 60 === 0) {
    const m = sec / 60
    return `Every ${m} minute${m === 1 ? '' : 's'}`
  }
  return `Every ${sec} seconds`
}

function formatTimestamp(ms: number | null): string {
  if (ms == null) return '—'
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return '—'
  }
}

function authProfileLabel(authType: AuthType, connector: WizardState['connector']): string {
  switch (authType) {
    case 'NO_AUTH':
      return 'None'
    case 'BASIC':
      return connector.basicUsername.trim() ? connector.basicUsername.trim() : 'Basic'
    case 'BEARER':
      return 'Bearer token'
    case 'API_KEY':
      return connector.apiKeyName.trim() || 'API key'
    case 'OAUTH2_CLIENT_CREDENTIALS':
      return 'OAuth2 client credentials'
    case 'SESSION_LOGIN':
      return 'Session login'
    case 'JWT_REFRESH_TOKEN':
      return 'JWT refresh'
    default:
      return String(authType)
  }
}

function authTypeLabel(authType: AuthType): string {
  switch (authType) {
    case 'NO_AUTH':
      return 'No auth'
    case 'API_KEY':
      return 'API Key'
    case 'OAUTH2_CLIENT_CREDENTIALS':
      return 'OAuth2'
    case 'JWT_REFRESH_TOKEN':
      return 'JWT refresh'
    case 'SESSION_LOGIN':
      return 'Session login'
    default:
      return authType.replace(/_/g, ' ')
  }
}

function paginationSummary(state: WizardState): string {
  const hasParams = state.stream.params.some((p) => p.key.trim())
  const hasBody = state.stream.requestBody.trim().length > 0
  if (hasParams && hasBody) return 'Query + body'
  if (hasParams) return 'Query parameters'
  if (hasBody) return 'Request body'
  return 'None (single request)'
}

function headersSummary(headers: Record<string, string>): string {
  const keys = Object.keys(headers)
  if (keys.length === 0) return 'None'
  const preview = keys.slice(0, 4).join(', ')
  return keys.length > 4 ? `${preview}, +${keys.length - 4} more` : preview
}

function destinationEndpointShort(dest: DestinationListItem | undefined): string {
  if (!dest) return '—'
  const cfg = dest.config_json ?? {}
  if (dest.destination_type === 'WEBHOOK_POST') {
    const u = typeof cfg.url === 'string' ? cfg.url.trim() : ''
    return u || '—'
  }
  const host = typeof cfg.host === 'string' ? cfg.host : '—'
  const port = cfg.port != null ? String(cfg.port) : '514'
  return `${host}:${port}`
}

const EditLink = memo(function EditLink({
  stepKey,
  label,
  onNavigateToStep,
}: {
  stepKey: WizardLegacySubstepKey
  label?: string
  onNavigateToStep: (k: WizardLegacySubstepKey) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigateToStep(stepKey)}
      className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
    >
      {label ?? 'Edit'}
      <ChevronRight className="h-3 w-3" aria-hidden />
    </button>
  )
})

function dataPolicySummaryLabel(state: WizardState): string {
  const p = state.dataPolicy
  const preset = p.preset.charAt(0).toUpperCase() + p.preset.slice(1)
  const mask = p.maskPii ? 'Mask PII' : 'No mask'
  const restricted =
    p.restrictedResponse === 'quarantine'
      ? 'Quarantine on RESTRICTED'
      : p.restrictedResponse === 'block'
        ? 'Block on RESTRICTED'
        : p.restrictedResponse === 'require_review'
          ? 'Review on RESTRICTED'
          : 'Continue on RESTRICTED'
  return `${preset} preset · ${mask} · ${restricted}`
}

export function StepReview({
  state,
  busy = false,
  governanceEnabled = false,
  onNavigateToStep,
  onEditDataPolicy,
}: StepReviewProps) {
  const completion = useMemo(() => computeLegacySubstepCompletion(state), [state])
  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isDb = state.connector.sourceType === 'DATABASE_QUERY'
  const fullUrl = buildFullRequestUrl(state.connector.hostBaseUrl, state.stream.endpoint)
  const mergedHeaders = effectiveRequestHeaders(state.connector, state.stream)

  const mappedRows = useMemo(
    () => state.mapping.filter((m) => m.outputField.trim() && m.sourceJsonPath.trim()),
    [state.mapping],
  )
  const mappedCount = mappedRows.length
  const enrichmentRows = useMemo(
    () => state.enrichment.filter((e) => e.fieldName.trim()),
    [state.enrichment],
  )
  const enrichmentDupes = useMemo(() => countDuplicateEnrichmentKeys(state.enrichment), [state.enrichment])

  const staticEnrichmentCount = useMemo(
    () => enrichmentRows.filter((e) => e.type === 'static' && enrichmentValueKind(e) === 'static').length,
    [enrichmentRows],
  )
  const autoEnrichmentCount = useMemo(
    () => enrichmentRows.filter((e) => e.type === 'static' && enrichmentValueKind(e) === 'auto').length,
    [enrichmentRows],
  )
  const advancedEnrichmentCount = enrichmentRows.length - staticEnrichmentCount - autoEnrichmentCount

  const sampleEvent = state.apiTest.extractedEvents[0] ?? null
  const mappedBase = useMemo(() => buildMappedBaseFromState(sampleEvent, state.mapping), [sampleEvent, state.mapping])
  const enrichmentPayload = useMemo(
    () => enrichmentDictFromRules(state.enrichment),
    [state.enrichment],
  )
  const [finalEvent, setFinalEvent] = useState<Record<string, unknown>>(() => ({ ...mappedBase }))
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await runEnrichmentExecPreview({
          mapped_event: mappedBase,
          enrichment: enrichmentPayload,
          override_policy: 'KEEP_EXISTING',
        })
        if (!cancelled) setFinalEvent(res.final_event)
      } catch {
        if (!cancelled) setFinalEvent({ ...mappedBase })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mappedBase, enrichmentPayload])
  const totalOutputKeys = useMemo(() => Object.keys(finalEvent).length, [finalEvent])

  const rawSampleJson = useMemo(() => {
    if (!sampleEvent) return ''
    try {
      return JSON.stringify(sampleEvent, null, 2)
    } catch {
      return ''
    }
  }, [sampleEvent])

  const finalJson = useMemo(() => {
    try {
      return JSON.stringify(finalEvent, null, 2)
    } catch {
      return '{}'
    }
  }, [finalEvent])

  const [previewTab, setPreviewTab] = useState<'preview' | 'raw_final'>('preview')
  const [copyFlash, setCopyFlash] = useState(false)

  const handleCopyFinal = async () => {
    const text =
      previewTab === 'preview'
        ? finalJson
        : `--- Raw sample ---\n${rawSampleJson}\n\n--- Final event ---\n${finalJson}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        setCopyFlash(true)
        window.setTimeout(() => setCopyFlash(false), 1600)
      }
    } catch {
      /* ignore */
    }
  }

  const previewLive = sampleEvent != null && Object.keys(finalEvent).length > 0

  const mappedFieldChips = useMemo(() => mappedRows.slice(0, 3).map((r) => r.outputField.trim()), [mappedRows])
  const moreMapped = Math.max(0, mappedCount - mappedFieldChips.length)

  const enrichmentChips = useMemo(() => enrichmentRows.slice(0, 3).map((r) => r.fieldName.trim()), [enrichmentRows])
  const moreEnrichment = Math.max(0, enrichmentRows.length - enrichmentChips.length)

  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
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
  const enabledRoutes = routeDrafts.filter((r) => r.enabled).length
  const uniqueDestIds = useMemo(() => new Set(routeDrafts.map((r) => r.destinationId)), [routeDrafts])

  const connectivityForRoutes = useMemo(() => {
    if (routeDrafts.length === 0) return { ok: true, failed: false, unknown: false }
    let failed = false
    let unknown = false
    for (const r of routeDrafts) {
      const meta = destById.get(r.destinationId)
      if (!meta) {
        unknown = true
        continue
      }
      if (meta.last_connectivity_test_success === false) failed = true
      else if (!isDestinationConnectivityVerified(meta)) unknown = true
    }
    const ok = !failed && !unknown
    return { ok, failed, unknown }
  }, [routeDrafts, destById])

  const enrichmentValid =
    state.enrichment.length === 0 || state.enrichment.every((e) => e.fieldName.trim().length > 0)
  const enrichmentOk = enrichmentValid && enrichmentDupes === 0

  const previewErr = state.apiTest.analysis?.previewError
  const eventPathOk =
    completion.preview === 'complete' && !previewErr && (state.stream.useWholeResponseAsEvent || state.stream.eventArrayPath.trim().length > 0)

  const incrementalTestWarn = useMemo(
    () =>
      incrementalRequestTestWarning({
        pattern: state.stream.incrementalRequestPattern,
        draft: state.stream.incrementalRequestDraft,
        checkpointSourcePath: state.stream.checkpointSourcePath,
        eventArrayPath: state.stream.eventArrayPath,
        lastSuccessSignature: state.stream.incrementalRequestTestSignature,
        lastSuccessAt: state.stream.incrementalRequestTestedAt,
      }),
    [
      state.stream.checkpointSourcePath,
      state.stream.eventArrayPath,
      state.stream.incrementalRequestDraft,
      state.stream.incrementalRequestPattern,
      state.stream.incrementalRequestTestSignature,
      state.stream.incrementalRequestTestedAt,
    ],
  )

  const checklist = useMemo(
    () => [
      {
        id: 'connector',
        label: 'Source connection configured and tested',
        ok: completion.connector === 'complete' && completion.api_test === 'complete',
        warn: false,
        detail: undefined as string | undefined,
      },
      {
        id: 'http',
        label: 'HTTP request valid',
        ok: completion.stream === 'complete',
        warn: false,
      },
      {
        id: 'path',
        label: 'Event array path valid',
        ok: eventPathOk,
        warn: previewErr != null && previewErr.length > 0,
        detail: previewErr ?? undefined,
      },
      {
        id: 'mapping',
        label: 'At least one mapped field',
        ok: mappedCount > 0,
        warn: false,
      },
      {
        id: 'enrichment',
        label: 'Enrichment fields valid',
        ok: enrichmentOk,
        warn: enrichmentDupes > 0,
        detail: enrichmentDupes > 0 ? 'Duplicate enrichment field names' : undefined,
      },
      {
        id: 'routes',
        label: 'At least one route enabled',
        ok: routeDrafts.some((r) => r.enabled),
        warn: routeDrafts.length > 0 && !routeDrafts.some((r) => r.enabled),
      },
      {
        id: 'dest_test',
        label: 'Destination reachable (last connectivity test)',
        ok: connectivityForRoutes.ok,
        warn: connectivityForRoutes.unknown && !connectivityForRoutes.failed,
        detail: connectivityForRoutes.failed
          ? 'One or more destinations reported a failed connectivity test.'
          : connectivityForRoutes.unknown
            ? 'Run Test from the Destinations step to verify connectivity.'
            : undefined,
      },
      {
        id: 'checkpoint',
        label: 'Sync position configuration valid',
        ok: true,
        warn: false,
      },
      {
        id: 'incremental_test',
        label: 'Incremental request tested (JSON Preview)',
        ok:
          incrementalTestWarn.level === 'none' ||
          (state.stream.incrementalRequestPattern === 'none' && !state.stream.incrementalRequestDraft.trim()),
        warn: incrementalTestWarn.level === 'warning',
        detail: incrementalTestWarn.level === 'warning' ? incrementalTestWarn.message : undefined,
      },
    ],
    [
      completion.api_test,
      completion.connector,
      completion.stream,
      connectivityForRoutes.failed,
      connectivityForRoutes.ok,
      connectivityForRoutes.unknown,
      enrichmentOk,
      enrichmentDupes,
      eventPathOk,
      incrementalTestWarn,
      mappedCount,
      previewErr,
      routeDrafts,
      state.stream.checkpointFieldType,
      state.stream.checkpointSourcePath,
      state.stream.incrementalRequestDraft,
      state.stream.incrementalRequestPattern,
    ],
  )

  const checklistHasError = checklist.some((c) => !c.ok && !c.warn)
  const checklistHasWarn = checklist.some((c) => c.warn || (!c.ok && c.id === 'incremental_test'))

  const reviewReady = completion.review === 'in_progress'

  const connectionBadge = useMemo(() => {
    if (state.apiTest.status === 'running') {
      return { tone: 'warn' as const, label: 'Testing…' }
    }
    if (state.apiTest.status === 'success' && state.apiTest.ok) {
      return { tone: 'ok' as const, label: 'Connected' }
    }
    if (state.apiTest.status === 'error') {
      return { tone: 'err' as const, label: 'Error' }
    }
    if (state.connector.connectorId != null) {
      return { tone: 'warn' as const, label: 'Not tested' }
    }
    return { tone: 'warn' as const, label: '—' }
  }, [state.apiTest.ok, state.apiTest.status, state.connector.connectorId])

  const eventArrayDisplay = state.stream.useWholeResponseAsEvent
    ? '(whole document)'
    : state.stream.eventArrayPath.trim()
      ? state.stream.eventArrayPath.trim().startsWith('$')
        ? state.stream.eventArrayPath.trim()
        : `$.${state.stream.eventArrayPath.trim()}`
      : '—'

  const queryParamsDisplay = useMemo(() => {
    const parts = state.stream.params.filter((p) => p.key.trim())
    if (parts.length === 0) return 'None'
    return parts.map((p) => `${p.key}=${p.value}`).join('& ')
  }, [state.stream.params])

  const templateMaterializationActive =
    state.connector.registryModuleId != null && state.connector.selectedTemplateIds.length > 0

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-[2] space-y-4">
        {incrementalTestWarn.level === 'warning' ? (
          <p
            className="flex items-start gap-2 rounded-md border border-amber-200/80 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/35 dark:text-amber-100"
            data-testid="incremental-request-review-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{incrementalTestWarn.message} You can still create the stream, but incremental polling may fail until you fix and re-test the request body on JSON Preview.</span>
          </p>
        ) : null}
        <header className="space-y-1">
          <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">Review</h3>
          <p className="max-w-3xl text-[13px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            Review your stream configuration before creation. After a successful save, start the stream from this step.
          </p>
        </header>

        {templateMaterializationActive ? (
          <section
            className="rounded-xl border border-violet-200/80 bg-violet-50/50 p-4 shadow-sm dark:border-violet-500/30 dark:bg-violet-500/5"
            data-testid="review-template-materialization"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Template Materialization</h4>
                <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
                  The following streams will be created from module{' '}
                  <span className="font-mono text-violet-700 dark:text-violet-300">{state.connector.registryModuleId}</span>{' '}
                  with default mapping, enrichment, checkpoint, and rate limits preloaded.
                </p>
              </div>
              <EditLink stepKey="connector" label="Edit templates" onNavigateToStep={onNavigateToStep} />
            </div>
            <ul className="mt-3 space-y-2">
              {state.connector.selectedTemplateIds.map((templateId) => (
                <li
                  key={templateId}
                  className="flex items-center justify-between rounded-md border border-slate-200/80 bg-white px-3 py-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                  data-testid={`review-template-row-${templateId}`}
                >
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{templateId}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-muted">
                    STOPPED · disabled
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Top summary cards */}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          <SummaryMiniCard
            title="Stream Name"
            value={state.stream.name.trim() || '—'}
            icon={<Radio className="h-3.5 w-3.5" />}
            edit={<EditLink stepKey="stream" onNavigateToStep={onNavigateToStep} />}
          />
          <SummaryMiniCard
            title="Source Type"
            value="HTTP API Polling"
            icon={<Globe className="h-3.5 w-3.5" />}
            edit={<EditLink stepKey="stream" onNavigateToStep={onNavigateToStep} />}
          />
          <SummaryMiniCard
            title="Schedule"
            value={formatScheduleHuman(state.stream.pollingIntervalSec)}
            icon={<Clock className="h-3.5 w-3.5" />}
            edit={<EditLink stepKey="stream" onNavigateToStep={onNavigateToStep} />}
          />
          <SummaryMiniCard
            title="Status After Create"
            value={
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:border-emerald-500/35 dark:text-emerald-200">
                Enabled
              </span>
            }
            icon={<CircleDot className="h-3.5 w-3.5" />}
            edit={<EditLink stepKey="stream" onNavigateToStep={onNavigateToStep} />}
          />
          <SummaryMiniCard
            title="Last Sample Fetched"
            value={state.apiTest.status === 'success' ? formatTimestamp(state.apiTest.finishedAt) : '—'}
            icon={<Plug className="h-3.5 w-3.5" />}
            edit={<EditLink stepKey="api_test" label="Edit fetch" onNavigateToStep={onNavigateToStep} />}
          />
        </div>

        {/* Connector */}
        <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
                <Plug className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Connector & Authentication</p>
                <p className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                  {state.connector.connectorName.trim() || '—'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ConnectionBadge tone={connectionBadge.tone} label={connectionBadge.label} />
              <EditLink stepKey="connector" onNavigateToStep={onNavigateToStep} />
            </div>
          </div>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            <ReviewDlRow
              label={isRemote ? 'SSH host' : 'Base URL'}
              mono
              value={state.connector.hostBaseUrl.trim() || '—'}
            />
            <ReviewDlRow label="Auth Type" value={authTypeLabel(state.connector.authType)} />
            <ReviewDlRow label="Auth profile" value={authProfileLabel(state.connector.authType, state.connector)} />
            <ReviewDlRow
              label="Last tested"
              value={
                state.apiTest.status === 'success' && state.apiTest.finishedAt ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    {formatTimestamp(state.apiTest.finishedAt)}
                  </span>
                ) : (
                  '—'
                )
              }
            />
          </dl>
        </section>

        {/* HTTP or remote stream shape */}
        <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {isRemote ? 'Remote files' : isDb ? 'Database query' : 'HTTP Request'}
            </p>
            <EditLink stepKey="stream" onNavigateToStep={onNavigateToStep} />
          </div>
          {isRemote ? (
            <dl className="mt-3 space-y-2 text-[12px]">
              <ReviewDlRow label="Remote directory" mono value={state.stream.remoteDirectory.trim() || '—'} />
              <ReviewDlRow label="File pattern" mono value={state.stream.filePattern.trim() || '*'} />
              <ReviewDlRow label="Parser" value={state.stream.parserType} />
              <ReviewDlRow label="Recursive" value={state.stream.remoteRecursive ? 'yes' : 'no'} />
              <ReviewDlRow label="Max files / max MB" value={`${state.stream.maxFilesPerRun} / ${state.stream.maxFileSizeMb}`} />
              <ReviewDlRow label="Encoding" value={state.stream.encoding.trim() || 'utf-8'} />
              <ReviewDlRow label="Event array path" mono value={eventArrayDisplay} />
            </dl>
          ) : isDb ? (
            <dl className="mt-3 space-y-2 text-[12px]">
              <ReviewDlRow label="SQL query" mono value={state.stream.sqlQuery.trim() || '—'} />
              <ReviewDlRow label="Query timeout" value={`${state.stream.timeoutSec}s`} />
              <ReviewDlRow label="Event array path" mono value={eventArrayDisplay} />
            </dl>
          ) : (
            <dl className="mt-3 space-y-2 text-[12px]">
              <ReviewDlRow label="Method" value={state.stream.httpMethod} />
              <div className="grid gap-1">
                <dt className="text-[11px] font-medium text-slate-500">URL</dt>
                <dd className="break-all font-mono text-[11px] text-slate-800 dark:text-slate-200">{fullUrl || '—'}</dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-[11px] font-medium text-slate-500">Query parameters</dt>
                <dd className="break-all font-mono text-[11px] text-slate-800 dark:text-slate-200">{queryParamsDisplay}</dd>
              </div>
              <ReviewDlRow label="Pagination" value={paginationSummary(state)} />
              <div className="grid gap-1">
                <dt className="text-[11px] font-medium text-slate-500">Headers</dt>
                <dd className="font-mono text-[11px] text-slate-700 dark:text-gdc-mutedStrong">{headersSummary(mergedHeaders)}</dd>
              </div>
              <ReviewDlRow label="Event array path" mono value={eventArrayDisplay} />
            </dl>
          )}
          {isS3 ? (
            <p className="mt-3 text-[11px] text-slate-600 dark:text-gdc-muted">
              S3 streams use connector bucket settings; HTTP request fields above do not apply.
            </p>
          ) : null}
        </section>

        {/* Mapping */}
        <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Mapping</p>
            <EditLink stepKey="mapping" onNavigateToStep={onNavigateToStep} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <MetricPill label="Mapped" value={mappedCount} accent />
            <MetricPill label="Static" value={0} />
            <MetricPill label="Enriched" value={enrichmentRows.length} />
            <MetricPill label="Total output" value={totalOutputKeys} accent />
          </div>
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Sample output fields</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {mappedFieldChips.map((name) => (
                <span
                  key={name}
                  className="rounded-md border border-slate-200/90 bg-slate-50 px-2 py-0.5 font-mono text-[10px] text-slate-800 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200"
                >
                  {name}
                </span>
              ))}
              {moreMapped > 0 ? (
                <span className="rounded-md border border-dashed border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:border-gdc-borderStrong">
                  +{moreMapped} more
                </span>
              ) : null}
              {mappedCount === 0 ? <span className="text-[11px] text-slate-500">No mapped fields yet.</span> : null}
            </div>
          </div>
        </section>

        {/* Enrichment */}
        <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Enrichment</p>
            <EditLink stepKey="enrichment" onNavigateToStep={onNavigateToStep} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <MetricPill label="Static rules" value={staticEnrichmentCount} />
            <MetricPill label="Advanced rules" value={advancedEnrichmentCount} />
            <MetricPill label="Total" value={enrichmentRows.length} accent />
          </div>
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Top enrichment fields</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {enrichmentChips.map((name) => (
                <span
                  key={name}
                  className="rounded-md border border-violet-200/80 bg-violet-500/[0.06] px-2 py-0.5 font-mono text-[10px] text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100"
                >
                  {name}
                </span>
              ))}
              {moreEnrichment > 0 ? (
                <span className="rounded-md border border-dashed border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:border-gdc-borderStrong">
                  +{moreEnrichment} more
                </span>
              ) : null}
              {enrichmentRows.length === 0 ? <span className="text-[11px] text-slate-500">No enrichment rows.</span> : null}
            </div>
          </div>
        </section>

        <section
          className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
          data-testid="review-data-protection"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <DataProtectionReviewSummary dataProtection={state.dataProtection} />
            <EditLink stepKey="mapping" label="Edit" onNavigateToStep={onNavigateToStep} />
          </div>
        </section>

        {governanceEnabled ? (
          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Data Policy</p>
                  <p className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                    {dataPolicySummaryLabel(state)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onEditDataPolicy?.()}
                className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                Edit policy
              </button>
            </div>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2 text-[12px]">
              <ReviewDlRow label="Sensitive data" value={state.dataPolicy.sensitiveAutoDetect ? 'Auto-detect on' : 'Off'} />
              <ReviewDlRow label="Protection" value={state.dataPolicy.maskPii ? `Mask (${state.dataPolicy.defaultMaskMode})` : 'None'} />
              <ReviewDlRow label="Classification" value={state.dataPolicy.defaultClassification} />
              <ReviewDlRow
                label="Response"
                value={`RESTRICTED → ${state.dataPolicy.restrictedResponse} · CONFIDENTIAL → ${state.dataPolicy.confidentialResponse}`}
              />
            </dl>
          </section>
        ) : null}

        {/* Destinations table */}
        <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Destinations & delivery paths</p>
              <p className="text-[11px] text-slate-500">
                {routeDrafts.length} route{routeDrafts.length === 1 ? '' : 's'} · {enabledRoutes} enabled
              </p>
            </div>
            <EditLink stepKey="destinations" label="Add route" onNavigateToStep={onNavigateToStep} />
          </div>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200/80 dark:border-gdc-border">
            <table className="w-full min-w-[640px] border-collapse text-left text-[11px]">
              <thead className="bg-slate-50/90 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-gdc-card dark:text-gdc-muted">
                <tr>
                  <th className="px-2 py-2">Destination</th>
                  <th className="px-2 py-2">Protocol</th>
                  <th className="px-2 py-2">Delivery mode</th>
                  <th className="px-2 py-2">Failure policy</th>
                  <th className="px-2 py-2">Rate limit</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {routeDrafts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-slate-500">
                      No routes configured.{' '}
                      <button
                        type="button"
                        className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                        onClick={() => onNavigateToStep('destinations')}
                      >
                        Add a route
                      </button>
                    </td>
                  </tr>
                ) : (
                  routeDrafts.map((r) => {
                    const dest = destById.get(r.destinationId)
                    const dt = dest?.destination_type ?? state.destinations.destinationKindsById[r.destinationId] ?? ''
                    const mode = deliveryModeFromFailurePolicy(r.failurePolicy)
                    return (
                      <tr key={r.key} className="border-t border-slate-100 dark:border-gdc-border">
                        <td className="px-2 py-2 font-medium text-slate-800 dark:text-slate-100">
                          {dest?.name?.trim() || `Destination #${r.destinationId}`}
                          <div className="font-mono text-[10px] font-normal text-slate-500 dark:text-slate-400">
                            {destinationEndpointShort(dest)}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-slate-700 dark:text-slate-200">{formatWizardSyslogLabel(dt)}</td>
                        <td className="px-2 py-2">
                          <span
                            className={cn(
                              'inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold',
                              mode === 'Reliable'
                                ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                                : 'bg-sky-500/15 text-sky-800 dark:text-sky-200',
                            )}
                          >
                            {mode}
                          </span>
                        </td>
                        <td className="px-2 py-2 font-medium text-slate-700 dark:text-slate-100">
                          {failurePolicyBehaviorLabel(r.failurePolicy)}
                        </td>
                        <td className="px-2 py-2 font-mono text-[10px] text-slate-600 dark:text-slate-200">
                          {formatWizardRateLimitDraft(r.rateLimitJson)}
                        </td>
                        <td className="px-2 py-2">
                          {r.enabled ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:border-emerald-500/35 dark:text-emerald-200">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                              Enabled
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong">
                              Disabled
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">
            Manage delivery endpoints under{' '}
            <Link to={NAV_PATH.destinations} className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
              Destinations
            </Link>
            .
          </p>
        </section>

        {/* Checkpoint */}
        <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sync position & state</p>
            <EditLink stepKey="preview" label="Edit sync position" onNavigateToStep={onNavigateToStep} />
          </div>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <dl className="space-y-2 text-[12px]">
              <ReviewDlRow
                label="Sync position field"
                mono
                value={
                  state.stream.checkpointSourcePath.trim()
                    ? state.stream.checkpointSourcePath.trim()
                    : 'Not set'
                }
              />
              <ReviewDlRow
                label="Sync position type"
                value={state.stream.checkpointFieldType ? state.stream.checkpointFieldType : '—'}
              />
              <ReviewDlRow label="Initial state" value="Latest successful fetch sample (wizard)" />
              <ReviewDlRow label="State storage" value="Platform-managed sync position (PostgreSQL)" />
            </dl>
            <dl className="space-y-2 text-[12px]">
              <ReviewDlRow label="On start" value="Use configured sync position template / latest sample where applicable" />
              <ReviewDlRow label="On error" value="Keep last committed sync position (no advance)" />
              <ReviewDlRow label="On success" value="Update after all delivery paths succeed (platform default)" />
            </dl>
          </div>
        </section>
      </div>

      {/* Right column */}
      <aside className="w-full shrink-0 space-y-4 lg:sticky lg:top-4 lg:w-[min(100%,380px)] lg:self-start">
        <section className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-gdc-border">
            <div className="flex items-center gap-2">
              <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Final Event Preview</p>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                  previewLive
                    ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                    : 'bg-slate-200/80 text-slate-600 dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
                )}
              >
                {previewLive ? 'Live' : 'Stale'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleCopyFinal()}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {copyFlash ? 'Copied' : 'Copy JSON'}
            </button>
          </div>
          <div className="flex border-b border-slate-100 px-2 py-2 dark:border-gdc-border">
            <div className="inline-flex rounded-md border border-slate-200/90 p-0.5 dark:border-gdc-border">
              <button
                type="button"
                onClick={() => setPreviewTab('preview')}
                className={cn(
                  'rounded px-2.5 py-1 text-[11px] font-semibold',
                  previewTab === 'preview' ? 'bg-violet-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
                )}
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => setPreviewTab('raw_final')}
                className={cn(
                  'rounded px-2.5 py-1 text-[11px] font-semibold',
                  previewTab === 'raw_final'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
                )}
              >
                Raw vs Final
              </button>
            </div>
          </div>
          <div className="max-h-[min(52vh,420px)] overflow-auto p-3">
            {previewTab === 'preview' ? (
              <pre className="overflow-x-auto rounded-lg border border-slate-200/80 bg-slate-950 p-2.5 text-[10px] leading-snug text-emerald-100 dark:border-gdc-border">
                {finalJson || '{}'}
              </pre>
            ) : (
              <div className="grid gap-3">
                <div>
                  <p className="mb-1 text-[10px] font-semibold text-slate-500">Raw sample (first event)</p>
                  <pre className="max-h-[36vh] overflow-auto rounded-lg border border-slate-200/80 bg-slate-900 p-2 text-[9px] leading-snug text-slate-200 dark:border-gdc-border">
                    {rawSampleJson || '—'}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-[10px] font-semibold text-slate-500">Final event</p>
                  <pre className="max-h-[36vh] overflow-auto rounded-lg border border-slate-200/80 bg-slate-950 p-2 text-[9px] leading-snug text-emerald-100 dark:border-gdc-border">
                    {finalJson || '{}'}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
            <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Validation Checklist</p>
          </div>
          <ul className="mt-3 space-y-2">
            {checklist.map((c) => {
              const tone =
                c.ok ? 'ok' : c.warn ? 'warn' : 'err'
              return (
                <li key={c.id} className="flex gap-2 text-[11px]">
                  <span className="mt-0.5 shrink-0" aria-hidden>
                    {tone === 'ok' ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    ) : tone === 'warn' ? (
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{c.label}</span>
                    {c.detail ? <span className="mt-0.5 block text-[10px] text-slate-500">{c.detail}</span> : null}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-gdc-border dark:bg-gdc-section">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-slate-600 dark:text-gdc-muted" aria-hidden />
            <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Summary</p>
          </div>
          <ul className="mt-2 space-y-1.5 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
            <SummaryLine label="Total mapped fields" value={mappedCount} />
            <SummaryLine label="Total enrichment fields" value={enrichmentRows.length} />
            <SummaryLine label="Total output fields" value={totalOutputKeys} />
            <SummaryLine label="Total routes" value={routeDrafts.length} />
            <SummaryLine label="Enabled routes" value={enabledRoutes} />
            <SummaryLine label="Destinations used" value={uniqueDestIds.size} />
          </ul>
        </section>

        <section
          className={cn(
            'rounded-xl border p-4 shadow-sm',
            reviewReady && !checklistHasError
              ? 'border-emerald-200/80 bg-emerald-500/[0.07] dark:border-emerald-500/30 dark:bg-emerald-500/10'
              : checklistHasError
                ? 'border-red-200/80 bg-red-500/[0.06] dark:border-red-500/35 dark:bg-red-500/10'
                : 'border-amber-200/80 bg-amber-500/[0.06] dark:border-amber-500/35 dark:bg-amber-500/10',
          )}
        >
          <div className="flex gap-2">
            {busy ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-violet-600" aria-hidden /> : null}
            {reviewReady && !checklistHasError && !busy ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : null}
            {!reviewReady || checklistHasError ? (
              <AlertTriangle
                className={cn(
                  'h-5 w-5 shrink-0',
                  checklistHasError ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400',
                )}
                aria-hidden
              />
            ) : null}
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">
                {busy
                  ? 'Creating stream…'
                  : reviewReady && !checklistHasError
                    ? 'Ready to Create'
                    : checklistHasError
                      ? 'Blocked'
                      : 'Not ready'}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-700 dark:text-gdc-mutedStrong">
                {busy
                  ? 'Persisting your stream through the API. Please wait…'
                  : reviewReady && !checklistHasError && !checklistHasWarn
                    ? 'Your stream configuration is valid. You can now create the stream and start collecting events.'
                    : reviewReady && !checklistHasError && checklistHasWarn
                      ? 'Configuration meets minimum requirements, but some checks need attention (see checklist). You may still create the stream.'
                      : checklistHasError
                        ? 'Fix the items marked in red on the checklist before creating this stream.'
                        : 'Complete the required wizard steps (mapping, destinations, and successful sample fetch) before creating this stream.'}
              </p>
            </div>
          </div>
        </section>
      </aside>
    </div>
  )
}

function SummaryMiniCard({
  title,
  value,
  icon,
  edit,
}: {
  title: string
  value: ReactNode
  icon: ReactNode
  edit: ReactNode
}) {
  return (
    <div className="flex min-h-[92px] flex-col rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <div className="flex items-start justify-between gap-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
        {edit}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12px] font-semibold text-slate-900 dark:text-slate-100">
        <span className="text-slate-400 dark:text-gdc-muted">{icon}</span>
        <span className="min-w-0 break-words">{value}</span>
      </div>
    </div>
  )
}

function ConnectionBadge({ tone, label }: { tone: 'ok' | 'warn' | 'err'; label: string }) {
  const cls =
    tone === 'ok'
      ? 'border-emerald-200 bg-emerald-500/10 text-emerald-800 dark:border-emerald-500/35 dark:text-emerald-200'
      : tone === 'err'
        ? 'border-red-200 bg-red-500/10 text-red-800 dark:border-red-500/35 dark:text-red-200'
        : 'border-amber-200 bg-amber-500/10 text-amber-900 dark:border-amber-500/35 dark:text-amber-100'
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold', cls)}>{label}</span>
  )
}

function ReviewDlRow({
  label,
  value,
  mono,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[11px] font-medium text-slate-500">{label}</dt>
      <dd className={cn('text-[12px] text-slate-800 dark:text-slate-200', mono && 'break-all font-mono text-[11px]')}>{value}</dd>
    </div>
  )
}

function MetricPill({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-medium',
        accent
          ? 'border-violet-200 bg-violet-500/[0.08] text-violet-900 dark:border-violet-500/40 dark:text-violet-100'
          : 'border-slate-200/90 bg-slate-50 text-slate-800 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200',
      )}
    >
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  )
}

function SummaryLine({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex justify-between gap-3">
      <span className="text-slate-600 dark:text-gdc-muted">{label}</span>
      <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</span>
    </li>
  )
}
