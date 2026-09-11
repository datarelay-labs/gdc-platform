import type { LucideIcon } from 'lucide-react'
import { Cloud, Database, FolderSync, Globe2, RadioTower } from 'lucide-react'
import type { WizardStepDef } from '../components/streams/wizard/wizard-state'

export const GDC_STREAM_SOURCE_TYPES = [
  'HTTP_API_POLLING',
  'S3_OBJECT_POLLING',
  'DATABASE_QUERY',
  'REMOTE_FILE_POLLING',
  'WEBHOOK_RECEIVER',
] as const

export type GdcStreamSourceTypeKey = (typeof GDC_STREAM_SOURCE_TYPES)[number]

/** Standalone Stream Test classifier — never falls unknown types back to HTTP. */
export type StandaloneStreamSourceKind = GdcStreamSourceTypeKey | 'AI_PROXY_RECEIVER' | 'UNSUPPORTED'

function normalizeSourceTypeToken(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
}

/** First non-empty source-type token. Empty strings must not win over stream.stream_type. */
export function firstNonEmptySourceType(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const token = String(value ?? '').trim()
    if (token) return token
  }
  return null
}

/** Normalize UI / API stream or source type strings to a known presentation key. */
export function normalizeGdcStreamSourceType(raw: string | null | undefined): GdcStreamSourceTypeKey {
  const u = normalizeSourceTypeToken(raw)
  if (u === 'S3_OBJECT_POLLING' || u === 'S3') return 'S3_OBJECT_POLLING'
  if (u === 'DATABASE_QUERY') return 'DATABASE_QUERY'
  if (u === 'REMOTE_FILE_POLLING' || u === 'REMOTE_FILE') return 'REMOTE_FILE_POLLING'
  if (u === 'WEBHOOK_RECEIVER' || u === 'WEBHOOK' || u === 'WEBHOOK_PUSH') return 'WEBHOOK_RECEIVER'
  return 'HTTP_API_POLLING'
}

/**
 * Classify source type for standalone Stream Test routing.
 * Unlike {@link normalizeGdcStreamSourceType}, unknown / AI Proxy types are not treated as HTTP.
 */
export function classifyStandaloneStreamSourceType(raw: string | null | undefined): StandaloneStreamSourceKind {
  const u = normalizeSourceTypeToken(raw)
  if (!u) return 'UNSUPPORTED'
  if (u === 'AI_PROXY_RECEIVER' || u === 'AI_PROXY') return 'AI_PROXY_RECEIVER'
  if (u === 'S3_OBJECT_POLLING' || u === 'S3') return 'S3_OBJECT_POLLING'
  if (u === 'DATABASE_QUERY') return 'DATABASE_QUERY'
  if (u === 'REMOTE_FILE_POLLING' || u === 'REMOTE_FILE') return 'REMOTE_FILE_POLLING'
  if (u === 'WEBHOOK_RECEIVER' || u === 'WEBHOOK' || u === 'WEBHOOK_PUSH') return 'WEBHOOK_RECEIVER'
  if (u === 'HTTP_API_POLLING' || u === 'HTTP' || u === 'HTTP_API' || u === 'HTTP_POLLING') return 'HTTP_API_POLLING'
  return 'UNSUPPORTED'
}

export function isAiProxyReceiverSourceType(raw: string | null | undefined): boolean {
  return classifyStandaloneStreamSourceType(raw) === 'AI_PROXY_RECEIVER'
}

export type SourceTypeWorkflowLabels = {
  /** Checklist short label (was "API Test") */
  apiTestShortLabel: string
  /** Long completion label for the apiTest workflow step */
  apiTestStepDoneLabel: string
  /** CTA e.g. Run API Test / Run remote probe */
  apiTestNextAction: string
  /** Pending detail under next-step when api test not done */
  apiTestDetailPending: string
}

export type SourceTypeStreamEditLabels = {
  primaryNavTestButton: string
  primaryNavTestTitle: string
  /** Second line under buttons (HTML-free; compose in UI) */
  helpBoldConnection: string
  helpBoldSample: string
  helpSampleSuffix: string
}

export type SourceTypeRuntimeLabels = {
  /** Card heading in streams console detail / replace "Source Endpoint" */
  sourceSectionTitle: string
  /** Incident chip going to stream API test route */
  incidentRetryLabel: string
  /** Streams console quick action link text */
  quickActionsTestLabel: string
  /** Table row title for workflow shortcut column */
  operationsWorkflowTooltip: string
  /** Icon button tooltip near workflow badge */
  operationsTestIconTitle: string
  /** aria-label suffix for test icon link */
  operationsTestIconAriaLabelPrefix: string
  /** When true, runtime detail uses push-ingest copy instead of polling interval. */
  usesPushIngest: boolean
  /** When false, hide checkpoint KPI/trace/history tab for this source (webhooks do not advance checkpoints). */
  showCheckpointObservability: boolean
}

export type SourceTypeSummaryHints = {
  /** Stream Summary: show Endpoint + HTTP method rows */
  showHttpEndpointRows: boolean
  /** Stream Summary: show "Request Preview" block */
  showRequestPreview: boolean
  /** Step checklist in Stream Summary sidebar (e.g. API Test → Mapping …) */
  workflowStepLabels: readonly string[]
}

export type SourceTypeWizardLabels = {
  streamStepTitle: string
  streamStepSubtitle: string
  apiTestStepTitle: string
  apiTestStepSubtitle: string
  previewStepTitle: string
  previewStepSubtitle: string
}

/** Copy for wizard StepApiTest (intro + idle hints). */
export type SourceTypeWizardApiTestCopy = {
  /** Primary helper paragraph under the step title */
  leadParagraph: string
  /** Shown when idle and prerequisites are not met (after the “Select a connector first” lead-in). */
  idleBlockedTail: string
  /** Shown when idle and the live action is available */
  idleReady: string
}

export type SourceTypeUiPresentation = {
  key: GdcStreamSourceTypeKey
  displayName: string
  icon: LucideIcon
  /** App shell breadcrumb (last segment), top header title, stream API test `<h2>` when type is known */
  appShellSourceTestTitle: string
  /** Standalone stream-api-test page subtitle under `<h2>` */
  streamApiTestPageIntro: string
  workflow: SourceTypeWorkflowLabels
  streamEdit: SourceTypeStreamEditLabels
  runtime: SourceTypeRuntimeLabels
  summary: SourceTypeSummaryHints
  wizard: SourceTypeWizardLabels
  wizardApiTest: SourceTypeWizardApiTestCopy
}

const HTTP: SourceTypeUiPresentation = {
  key: 'HTTP_API_POLLING',
  displayName: 'HTTP API Polling',
  icon: Globe2,
  appShellSourceTestTitle: 'API Test & Preview',
  streamApiTestPageIntro:
    'Runs the saved HTTP request with connector-side auth, previews the response body, and lets you validate JSON paths and event extraction before mapping.',
  workflow: {
    apiTestShortLabel: 'API Test',
    apiTestStepDoneLabel: 'API Test & preview done',
    apiTestNextAction: 'Run API Test',
    apiTestDetailPending: 'No API test or live data yet.',
  },
  streamEdit: {
    primaryNavTestButton: 'Run API Test',
    primaryNavTestTitle: 'Open API Test & JSON Preview — inspect response shape for mapping paths',
    helpBoldConnection: 'Test Connection',
    helpBoldSample: 'Run API Test',
    helpSampleSuffix: ' — full JSON preview & mapping helpers.',
  },
  runtime: {
    sourceSectionTitle: 'HTTP source',
    incidentRetryLabel: 'Retry API Test',
    quickActionsTestLabel: 'API test & preview',
    operationsWorkflowTooltip: 'API Test → Mapping → Enrichment → Runtime (delivery: Edit stream)',
    operationsTestIconTitle: 'API Test',
    operationsTestIconAriaLabelPrefix: 'API test & preview',
    usesPushIngest: false,
    showCheckpointObservability: true,
  },
  summary: {
    showHttpEndpointRows: true,
    showRequestPreview: true,
    workflowStepLabels: ['API Test', 'Mapping', 'Enrichment', 'Route delivery'],
  },
  wizard: {
    streamStepTitle: 'HTTP Request',
    streamStepSubtitle: 'Method · endpoint · polling',
    apiTestStepTitle: 'API Test',
    apiTestStepSubtitle: 'Auth · sample response',
    previewStepTitle: 'JSON Preview',
    previewStepSubtitle: 'Inspect the raw response',
  },
  wizardApiTest: {
    leadParagraph:
      'Authenticate with the connector (including session cookies when configured), execute the configured HTTP request, and preview the live response. Use JSON Preview to inspect the tree, pick paths, and extract event-shaped records for mapping. Malformed JSON in the request body is blocked before any network call.',
    idleBlockedTail: 'complete the HTTP endpoint path on the Stream Configuration step',
    idleReady:
      'Click the primary action for a live request using connector auth and the HTTP Request step as configured (query, body, and headers). Use "Use placeholder data" if the upstream is unreachable from this environment.',
  },
}

const REMOTE: SourceTypeUiPresentation = {
  key: 'REMOTE_FILE_POLLING',
  displayName: 'Remote File Polling',
  icon: FolderSync,
  appShellSourceTestTitle: 'Remote Probe & Preview',
  streamApiTestPageIntro:
    'Runs an SSH/SFTP-based probe for the saved directory and pattern, lists matched object keys, then shows a parser-backed sample so you can align mapping paths with file-shaped events.',
  workflow: {
    apiTestShortLabel: 'Remote probe',
    apiTestStepDoneLabel: 'Remote probe & sample done',
    apiTestNextAction: 'Run remote probe',
    apiTestDetailPending: 'No remote connectivity test or sample data yet.',
  },
  streamEdit: {
    primaryNavTestButton: 'Open sample preview',
    primaryNavTestTitle: 'Open JSON / mapping preview page for this stream',
    helpBoldConnection: 'Test Connection',
    helpBoldSample: 'Open sample preview',
    helpSampleSuffix: ' — same preview page used for mapping helpers.',
  },
  runtime: {
    sourceSectionTitle: 'Remote file source',
    incidentRetryLabel: 'Retry remote probe',
    quickActionsTestLabel: 'Remote probe & preview',
    operationsWorkflowTooltip: 'Remote probe → Mapping → Enrichment → Runtime (delivery: Edit stream)',
    operationsTestIconTitle: 'Remote probe',
    operationsTestIconAriaLabelPrefix: 'Remote probe & preview',
    usesPushIngest: false,
    showCheckpointObservability: true,
  },
  summary: {
    showHttpEndpointRows: false,
    showRequestPreview: false,
    workflowStepLabels: ['Remote probe', 'Mapping', 'Enrichment', 'Route delivery'],
  },
  wizard: {
    streamStepTitle: 'Remote files',
    streamStepSubtitle: 'Directory · pattern · parser',
    apiTestStepTitle: 'Remote probe',
    apiTestStepSubtitle: 'SSH · directory · sample paths',
    previewStepTitle: 'Sample preview',
    previewStepSubtitle: 'Inspect parsed file events',
  },
  wizardApiTest: {
    leadParagraph:
      'Runs a remote-file connectivity probe over SSH/SFTP-based access for the configured directory and pattern, lists matched files, then fetches a capped parser sample. JSON Preview shows how parsed rows surface as events for mapping.',
    idleBlockedTail: 'complete the remote directory on the Stream Configuration step',
    idleReady:
      'Click the primary action to run the probe and sample fetch using connector auth and your remote path settings. Use "Use placeholder data" only when you need a local placeholder response.',
  },
}

const DATABASE: SourceTypeUiPresentation = {
  key: 'DATABASE_QUERY',
  displayName: 'Database Query',
  icon: Database,
  appShellSourceTestTitle: 'Query Test & Preview',
  streamApiTestPageIntro:
    'Runs a SELECT-only query test against the saved connection, surfaces sample rows, and helps validate checkpoint columns and ordering before you wire mapping paths.',
  workflow: {
    apiTestShortLabel: 'Query test',
    apiTestStepDoneLabel: 'Query test & sample done',
    apiTestNextAction: 'Run query test',
    apiTestDetailPending: 'No query test or sample rows yet.',
  },
  streamEdit: {
    primaryNavTestButton: 'Open query preview',
    primaryNavTestTitle: 'Open query / mapping preview page for this stream',
    helpBoldConnection: 'Test Connection',
    helpBoldSample: 'Open query preview',
    helpSampleSuffix: ' — preview SELECT results and mapping helpers.',
  },
  runtime: {
    sourceSectionTitle: 'Database source',
    incidentRetryLabel: 'Retry query test',
    quickActionsTestLabel: 'Query test & preview',
    operationsWorkflowTooltip: 'Query test → Mapping → Enrichment → Runtime (delivery: Edit stream)',
    operationsTestIconTitle: 'Query test',
    operationsTestIconAriaLabelPrefix: 'Query test & preview',
    usesPushIngest: false,
    showCheckpointObservability: true,
  },
  summary: {
    showHttpEndpointRows: false,
    showRequestPreview: false,
    workflowStepLabels: ['Query test', 'Mapping', 'Enrichment', 'Route delivery'],
  },
  wizard: {
    streamStepTitle: 'SQL query',
    streamStepSubtitle: 'Checkpoint · limits · polling',
    apiTestStepTitle: 'Query test',
    apiTestStepSubtitle: 'Connectivity · sample rows',
    previewStepTitle: 'Result preview',
    previewStepSubtitle: 'Inspect result rows',
  },
  wizardApiTest: {
    leadParagraph:
      'Runs a query test with SELECT-only safeguards, returns a bounded row sample, and previews how checkpoint fields line up with result columns. JSON Preview is used to inspect structured rows and tune event extraction for mapping.',
    idleBlockedTail: 'complete the SQL query and connection details on the Stream Configuration step',
    idleReady:
      'Click the primary action to execute the query test with connector-side credentials. Use "Use placeholder data" only when you need a local placeholder response.',
  },
}

const S3: SourceTypeUiPresentation = {
  key: 'S3_OBJECT_POLLING',
  displayName: 'S3 Object Polling',
  icon: Cloud,
  appShellSourceTestTitle: 'Object Preview',
  streamApiTestPageIntro:
    'Lists objects under the saved bucket and prefix, previews parser output from a small sample, and highlights how object ordering relates to the checkpoint so mapping paths stay stable across polls.',
  workflow: {
    apiTestShortLabel: 'Object preview',
    apiTestStepDoneLabel: 'Object list & preview done',
    apiTestNextAction: 'Run object preview',
    apiTestDetailPending: 'No S3 connectivity test or object preview yet.',
  },
  streamEdit: {
    primaryNavTestButton: 'Open object preview',
    primaryNavTestTitle: 'Open object / mapping preview page for this stream',
    helpBoldConnection: 'Test Connection',
    helpBoldSample: 'Open object preview',
    helpSampleSuffix: ' — list keys and mapping helpers.',
  },
  runtime: {
    sourceSectionTitle: 'S3 object source',
    incidentRetryLabel: 'Retry object preview',
    quickActionsTestLabel: 'Object preview',
    operationsWorkflowTooltip: 'Object preview → Mapping → Enrichment → Runtime (delivery: Edit stream)',
    operationsTestIconTitle: 'Object preview',
    operationsTestIconAriaLabelPrefix: 'Object preview',
    usesPushIngest: false,
    showCheckpointObservability: true,
  },
  summary: {
    showHttpEndpointRows: false,
    showRequestPreview: false,
    workflowStepLabels: ['Object preview', 'Mapping', 'Enrichment', 'Route delivery'],
  },
  wizard: {
    streamStepTitle: 'S3 objects',
    streamStepSubtitle: 'Bucket · prefix · caps',
    apiTestStepTitle: 'Object preview',
    apiTestStepSubtitle: 'List · sample keys',
    previewStepTitle: 'Object preview',
    previewStepSubtitle: 'Inspect listed objects / events',
  },
  wizardApiTest: {
    leadParagraph:
      'Verifies S3 connectivity for the configured bucket and prefix, then fetches actual objects and parses them into sample events. Union Schema is generated only from those parsed events — never from a placeholder preview.',
    idleBlockedTail: 'complete bucket and prefix settings on the Stream Configuration step',
    idleReady:
      'Click the primary action to run connectivity check and actual object sample fetch with connector credentials. Use "Use placeholder data" only when you need a local placeholder response.',
  },
}

const WEBHOOK_RECEIVER: SourceTypeUiPresentation = {
  key: 'WEBHOOK_RECEIVER',
  displayName: 'Webhook Receiver',
  icon: RadioTower,
  appShellSourceTestTitle: 'Webhook Payload Preview',
  streamApiTestPageIntro:
    'Uses an operator-provided webhook sample payload to validate event extraction, mapping, and enrichment before external systems POST to the generated receiver URL.',
  workflow: {
    apiTestShortLabel: 'Payload preview',
    apiTestStepDoneLabel: 'Payload preview done',
    apiTestNextAction: 'Open payload preview',
    apiTestDetailPending: 'No webhook payload preview yet.',
  },
  streamEdit: {
    primaryNavTestButton: 'Open payload preview',
    primaryNavTestTitle: 'Open webhook payload preview and mapping helpers',
    helpBoldConnection: 'Receiver URL',
    helpBoldSample: 'Open payload preview',
    helpSampleSuffix: ' — inspect webhook-shaped events for mapping.',
  },
  runtime: {
    sourceSectionTitle: 'Webhook receiver source',
    incidentRetryLabel: 'Review payload preview',
    quickActionsTestLabel: 'Payload preview',
    operationsWorkflowTooltip: 'Webhook payload preview → Mapping → Enrichment → Runtime delivery',
    operationsTestIconTitle: 'Payload preview',
    operationsTestIconAriaLabelPrefix: 'Webhook payload preview',
    usesPushIngest: true,
    showCheckpointObservability: false,
  },
  summary: {
    showHttpEndpointRows: false,
    showRequestPreview: false,
    workflowStepLabels: ['Payload preview', 'Mapping', 'Enrichment', 'Route delivery'],
  },
  wizard: {
    streamStepTitle: 'Webhook receiver',
    streamStepSubtitle: 'Receiver URL · payload shape',
    apiTestStepTitle: 'Payload preview',
    apiTestStepSubtitle: 'Sample · extraction',
    previewStepTitle: 'Webhook preview',
    previewStepSubtitle: 'Inspect received event shape',
  },
  wizardApiTest: {
    leadParagraph:
      'Webhook receivers accept JSON object, JSON array, and NDJSON payloads through the generated receiver endpoint. Use a sample payload to validate extraction and mapping before producers send live events.',
    idleBlockedTail: 'select a webhook receiver connector first',
    idleReady:
      'Open the preview with a representative webhook payload, then configure mapping and delivery routes. Live ingest uses the same runtime pipeline.',
  },
}

const BY_KEY: Record<GdcStreamSourceTypeKey, SourceTypeUiPresentation> = {
  HTTP_API_POLLING: HTTP,
  REMOTE_FILE_POLLING: REMOTE,
  DATABASE_QUERY: DATABASE,
  S3_OBJECT_POLLING: S3,
  WEBHOOK_RECEIVER,
}

export function resolveSourceTypePresentation(raw: string | null | undefined): SourceTypeUiPresentation {
  return BY_KEY[normalizeGdcStreamSourceType(raw)]
}

/** Optional source-type subtitle tweak for Connect / Sample v3 steps. */
export function wizardStepsWithSourcePresentation(
  baseSteps: readonly WizardStepDef[],
  sourceTypeRaw: string | null | undefined,
): WizardStepDef[] {
  const p = resolveSourceTypePresentation(sourceTypeRaw)
  return baseSteps.map((step) => {
    if (step.key === 'connect') {
      return { ...step, subtitle: `${p.wizard.streamStepTitle} · auth · test` }
    }
    if (step.key === 'sample') {
      return { ...step, subtitle: `${p.wizard.apiTestStepTitle} · ${p.wizard.previewStepTitle.toLowerCase()}` }
    }
    return step
  })
}

export function workflowStepLabelsForSource(sourceTypeRaw: string | null | undefined): readonly string[] {
  return resolveSourceTypePresentation(sourceTypeRaw).summary.workflowStepLabels
}

/** App shell + stream page when source type cannot be resolved from API or slug hints. */
export const SOURCE_TEST_SHELL_NEUTRAL_TITLE = 'Source Test & Preview' as const

const NEUTRAL_STREAM_API_TEST_INTRO =
  'Load connector, source, and stream settings when a numeric stream id is available, then run a source test and preview structured output for mapping.' as const

const AI_PROXY_STREAM_API_TEST_INTRO =
  'AI Proxy receiver streams do not support standalone source test. Sample data is not available from this page.' as const

const UNSUPPORTED_STREAM_API_TEST_INTRO =
  'This source type is not supported on standalone Stream Test. Source type is not treated as HTTP, and no synthetic sample is generated.' as const

/**
 * Slug stream ids (fixtures, demo) where the shell can infer `source_type` without an API fetch.
 * Numeric ids rely on `useStreamSourceTypeForApiTestShell` + mapping UI config instead.
 */
export const STREAM_ID_SHELL_SOURCE_TYPE_HINT: Readonly<Partial<Record<string, GdcStreamSourceTypeKey>>> = {
  'malop-api': 'HTTP_API_POLLING',
  'fixture-remote-stream': 'REMOTE_FILE_POLLING',
  'fixture-db-stream': 'DATABASE_QUERY',
  'fixture-s3-stream': 'S3_OBJECT_POLLING',
}

export function resolveStreamSourceTestShellTitle(
  streamId: string | undefined,
  sourceTypeFromApi: string | null | undefined,
): string {
  const api = sourceTypeFromApi?.trim()
  if (api) {
    const kind = classifyStandaloneStreamSourceType(api)
    if (kind === 'AI_PROXY_RECEIVER' || kind === 'UNSUPPORTED') return SOURCE_TEST_SHELL_NEUTRAL_TITLE
    return resolveSourceTypePresentation(api).appShellSourceTestTitle
  }
  if (streamId) {
    const k = STREAM_ID_SHELL_SOURCE_TYPE_HINT[streamId]
    if (k) return resolveSourceTypePresentation(k).appShellSourceTestTitle
  }
  return SOURCE_TEST_SHELL_NEUTRAL_TITLE
}

export function resolveStreamSourceTestPageIntro(
  streamId: string | undefined,
  sourceTypeFromApi: string | null | undefined,
): string {
  const api = sourceTypeFromApi?.trim()
  if (api) {
    const kind = classifyStandaloneStreamSourceType(api)
    if (kind === 'AI_PROXY_RECEIVER') return AI_PROXY_STREAM_API_TEST_INTRO
    if (kind === 'UNSUPPORTED') return UNSUPPORTED_STREAM_API_TEST_INTRO
    return resolveSourceTypePresentation(api).streamApiTestPageIntro
  }
  if (streamId) {
    const k = STREAM_ID_SHELL_SOURCE_TYPE_HINT[streamId]
    if (k) return resolveSourceTypePresentation(k).streamApiTestPageIntro
  }
  return NEUTRAL_STREAM_API_TEST_INTRO
}
