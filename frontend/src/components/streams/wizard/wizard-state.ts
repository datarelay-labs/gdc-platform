/**
 * State model for the multi-step Stream Onboarding Wizard.
 *
 * Wizard flow (Stream Wizard UX Charter v5.2 — P1 structure MVP):
 *
 *   0. connect            — Connector · auth · request · test connection
 *   1. sample             — Sample response · record path · event root · checkpoint
 *   2. destinations       — Destination selection · route drafts
 *   3. route_processing   — Shared stream transform · data protection · route cards
 *   4. deploy             — Deployment decision center · create · start
 *
 * Legacy sub-steps (connector, stream, api_test, …) remain for internal completion
 * tracking, edit shortcuts, and draft migration — not shown in the stepper.
 */

import type { AdvancedTransformRuleDraft, MappingMode } from '../../../types/advancedTransform'
import { buildFieldMappingsWithTransformRules } from '../../../utils/advancedTransformConfig'
import type { UnionSchema } from '../../../utils/unionSchema'
import { buildWizardJsonataPreviewFieldMappings } from './wizard-full-event-preview'
import {
  buildFieldMappingsFromFullEventRegexConfigJson,
  hasValidFullEventRegexConfigJson,
} from './wizard-full-event-regex-config'
import type { ConnectorRead } from '../../../api/gdcConnectors'
import type { CatalogConnector, CatalogSource } from '../../../api/gdcCatalog'
import type { ConnectorAuthTestResponse } from '../../../api/gdcRuntimePreview'
import {
  DEFAULT_MESSAGE_PREFIX_TEMPLATE,
  defaultMessagePrefixEnabled,
} from '../../../utils/messagePrefixDefaults'
import {
  applyIncrementalRequestTemplate,
  type IncrementalRequestPattern,
} from './wizard-incremental-request'
import {
  buildAdvancedStreamConfigJsonPatch,
  mergeStreamConfigJson,
} from './wizard-stream-config-sync'

/** Top-level wizard steps (Stream Wizard UX Charter v5.2 — P1 structure MVP). */
export const WIZARD_STEP_KEYS = [
  'connect',
  'sample',
  'destinations',
  'route_processing',
  'deploy',
] as const

export type WizardStepKey = (typeof WIZARD_STEP_KEYS)[number]

/** Internal legacy sub-steps — hidden from the v3 stepper; used for completion + edit shortcuts. */
export const WIZARD_LEGACY_SUBSTEP_KEYS = [
  'connector',
  'stream',
  'api_test',
  'preview',
  'mapping',
  'enrichment',
  'data_protection',
  'destinations',
  'review',
  'done',
] as const

export type WizardLegacySubstepKey = (typeof WIZARD_LEGACY_SUBSTEP_KEYS)[number]

export type WizardStepDef = {
  key: WizardStepKey
  title: string
  subtitle: string
}

export const WIZARD_STEPS: ReadonlyArray<WizardStepDef> = [
  { key: 'connect', title: 'Connect', subtitle: 'Connector · auth · request · advanced' },
  { key: 'sample', title: 'Sample & Record Selection', subtitle: 'Test · response · records' },
  { key: 'destinations', title: 'Destinations', subtitle: 'Route to destinations' },
  { key: 'route_processing', title: 'Route Processing', subtitle: 'Transform · protection · routes' },
  { key: 'deploy', title: 'Deploy', subtitle: 'Decision center · create · start' },
]

/** Map a legacy sub-step key to its v3 wizard step (for edit shortcuts and draft migration). */
export function legacySubstepToWizardStep(key: WizardLegacySubstepKey): WizardStepKey {
  switch (key) {
    case 'connector':
    case 'stream':
    case 'api_test':
      return 'connect'
    case 'preview':
      return 'sample'
    case 'mapping':
    case 'enrichment':
    case 'data_protection':
      return 'route_processing'
    case 'destinations':
      return 'destinations'
    case 'review':
    case 'done':
      return 'deploy'
    default:
      return 'connect'
  }
}

/** Map a legacy 9-step stepper index to the v5.2 5-step index. */
export function migrateLegacyStepIndex(legacyIndex: number): number {
  if (legacyIndex <= 2) return 0
  if (legacyIndex === 3) return 1
  if (legacyIndex === 7) return 2
  if (legacyIndex <= 6) return 3
  return 4
}

export type WizardDataPolicyPreset = 'minimal' | 'standard' | 'strict'

export type WizardDataPolicyState = {
  preset: WizardDataPolicyPreset
  sensitiveAutoDetect: boolean
  dataShapeAlert: boolean
  maskPii: boolean
  defaultMaskMode: 'partial' | 'full' | 'tokenize'
  defaultClassification: string
  /** Policy / delivery control — never Protection actions (mask/tokenize/hash/remove). */
  restrictedResponse: WizardPolicyDeliveryBehavior
  confidentialResponse: WizardPolicyDeliveryBehavior
}

export const INITIAL_DATA_POLICY: WizardDataPolicyState = {
  preset: 'standard',
  sensitiveAutoDetect: true,
  dataShapeAlert: true,
  maskPii: true,
  defaultMaskMode: 'partial',
  defaultClassification: 'INTERNAL',
  restrictedResponse: 'quarantine',
  confidentialResponse: 'continue',
}

export function dataPolicyPresetPatch(preset: WizardDataPolicyPreset): Partial<WizardDataPolicyState> {
  if (preset === 'minimal') {
    return {
      preset,
      sensitiveAutoDetect: true,
      dataShapeAlert: false,
      maskPii: false,
      defaultMaskMode: 'partial',
      restrictedResponse: 'continue',
      confidentialResponse: 'continue',
    }
  }
  if (preset === 'strict') {
    return {
      preset,
      sensitiveAutoDetect: true,
      dataShapeAlert: true,
      maskPii: true,
      defaultMaskMode: 'full',
      restrictedResponse: 'quarantine',
      confidentialResponse: 'quarantine',
    }
  }
  return {
    preset: 'standard',
    sensitiveAutoDetect: true,
    dataShapeAlert: true,
    maskPii: true,
    defaultMaskMode: 'partial',
    restrictedResponse: 'quarantine',
    confidentialResponse: 'continue',
  }
}

/** Operator-facing protection action (wizard intent only — no engine names). */
export type WizardProtectionAction =
  | 'audit'
  | 'mask_partial'
  | 'mask_full'
  | 'tokenize'
  | 'hash'
  | 'drop_field'

/** Legacy draft values map to partial mask unless explicitly drop_field. */
export function normalizeWizardProtectionAction(action: unknown): WizardProtectionAction {
  if (
    action === 'audit' ||
    action === 'mask_partial' ||
    action === 'mask_full' ||
    action === 'tokenize' ||
    action === 'hash' ||
    action === 'drop_field'
  ) {
    return action
  }
  if (action === 'remove') return 'mask_partial'
  return 'audit'
}

/** Operator-facing delivery behavior when sensitive data is present. */
export type WizardDeliveryBehavior = 'continue' | 'quarantine' | 'block'

/** Route policy override — includes Require Review from the existing governance contract. */
export type WizardPolicyDeliveryBehavior = WizardDeliveryBehavior | 'require_review'

export function normalizeWizardPolicyDeliveryBehavior(value: unknown): WizardPolicyDeliveryBehavior {
  if (value === 'quarantine' || value === 'block' || value === 'require_review') return value
  // Legacy Policy UI "audit" meant Continue delivery (not a Protection action).
  if (value === 'audit' || value === 'continue') return 'continue'
  // Legacy "mask" meant "mask and deliver" — delivery Continues; Mask belongs to Protection.
  if (value === 'mask') return 'continue'
  return 'continue'
}

/** Normalize Shared/Route Policy level responses; never maps Protection actions into Policy silently as audit. */
export function normalizeWizardPolicyLevelResponse(value: unknown): WizardPolicyDeliveryBehavior {
  return normalizeWizardPolicyDeliveryBehavior(value)
}

export type WizardSensitivityClass = 'pii' | 'secret' | 'security_metadata'

export type WizardDataProtectionIntent = {
  /** Stable React/client key (not sent to API). */
  key: string
  detectedField: string
  protectionAction: WizardProtectionAction
  deliveryBehavior: WizardDeliveryBehavior
}

/** Per-route protection override draft (wizard intent; persisted via Contract v1 PUT governance). */
export type WizardRouteProtectionOverride = {
  /** Stable React/client key (not sent to API). */
  key: string
  fieldPath: string
  /** Links to `WizardRouteDraft.key` until deploy maps to route_id. */
  routeDraftKey: string
  protectionAction: WizardProtectionAction
  deliveryBehavior: WizardDeliveryBehavior
  enabled: boolean
}

/** Per-route classification floor override (route-level; persisted via Contract v1 PUT governance). */
export type WizardClassificationLevel = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'

export type WizardRouteClassificationOverride = {
  /** Stable React/client key (not sent to API). */
  key: string
  /** Links to `WizardRouteDraft.key` until deploy maps to route_id. */
  routeDraftKey: string
  classificationLevel: WizardClassificationLevel
  enabled: boolean
}

/** How to handle newly appearing non-sensitive fields (wizard intent only). */
export type WizardUnknownNormalFieldPolicy =
  | 'pass_through'
  | 'require_review'
  | 'drop_field'
  | 'quarantine'

/** How to handle newly appearing sensitive fields (wizard intent only). */
export type WizardUnknownSensitiveFieldPolicy =
  | 'auto_protect'
  | 'require_review'
  | 'drop_field'
  | 'quarantine'

/** Unmapped source field handling for basic JSONPath mapping. */
export type WizardUnmappedFieldsPolicy = 'pass_through' | 'drop_unmapped'

export type WizardDataProtectionState = {
  intents: WizardDataProtectionIntent[]
  routeOverrides: WizardRouteProtectionOverride[]
  routeClassificationOverrides: WizardRouteClassificationOverride[]
  unknownNormalFieldPolicy: WizardUnknownNormalFieldPolicy
  unknownSensitiveFieldPolicy: WizardUnknownSensitiveFieldPolicy
}

export const INITIAL_DATA_PROTECTION: WizardDataProtectionState = {
  intents: [],
  routeOverrides: [],
  routeClassificationOverrides: [],
  unknownNormalFieldPolicy: 'pass_through',
  unknownSensitiveFieldPolicy: 'auto_protect',
}

export function normalizeUnknownNormalFieldPolicy(value: unknown): WizardUnknownNormalFieldPolicy {
  if (
    value === 'pass_through' ||
    value === 'require_review' ||
    value === 'drop_field' ||
    value === 'quarantine'
  ) {
    return value
  }
  return 'pass_through'
}

export function normalizeUnknownSensitiveFieldPolicy(value: unknown): WizardUnknownSensitiveFieldPolicy {
  if (
    value === 'auto_protect' ||
    value === 'require_review' ||
    value === 'drop_field' ||
    value === 'quarantine'
  ) {
    return value
  }
  return 'auto_protect'
}

export function normalizeUnmappedFieldsPolicy(value: unknown): WizardUnmappedFieldsPolicy {
  if (value === 'drop_unmapped') return 'drop_unmapped'
  return 'pass_through'
}

export function newWizardDataProtectionIntentKey(): string {
  return `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newWizardRouteProtectionOverrideKey(): string {
  return `ro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newWizardRouteClassificationOverrideKey(): string {
  return `rco-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function newWizardRouteClassificationRuleKey(): string {
  return `rcr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const WIZARD_CLASSIFICATION_LEVELS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const

export function normalizeWizardClassificationLevel(value: unknown): WizardClassificationLevel {
  const raw = String(value ?? '').trim().toUpperCase()
  if ((WIZARD_CLASSIFICATION_LEVELS as readonly string[]).includes(raw)) {
    return raw as WizardClassificationLevel
  }
  return 'INTERNAL'
}

export function normalizeWizardRouteClassificationOverride(
  raw: Partial<WizardRouteClassificationOverride>,
): WizardRouteClassificationOverride {
  return {
    key: raw.key || newWizardRouteClassificationOverrideKey(),
    routeDraftKey: raw.routeDraftKey ?? '',
    classificationLevel: normalizeWizardClassificationLevel(raw.classificationLevel),
    enabled: raw.enabled !== false,
  }
}

export function normalizeWizardSensitivityClass(value: unknown): WizardSensitivityClass {
  if (value === 'secret' || value === 'pii' || value === 'security_metadata') return value
  return 'pii'
}

export function normalizeWizardRouteClassificationRuleDraft(
  raw: Partial<WizardRouteClassificationRuleDraft>,
): WizardRouteClassificationRuleDraft {
  const sensitivityClass = normalizeWizardSensitivityClass(raw.sensitivityClass)
  const name = String(raw.name ?? '').trim()
  return {
    key: raw.key || newWizardRouteClassificationRuleKey(),
    name: name || `Wizard: ${sensitivityClass} classification`,
    sensitivityClass,
    classificationLevel: normalizeWizardClassificationLevel(raw.classificationLevel),
    enabled: raw.enabled !== false,
  }
}

export function normalizeWizardRouteClassificationOverrideState(
  raw: Partial<WizardRouteClassificationOverrideState> | undefined,
): WizardRouteClassificationOverrideState {
  const rules = Array.isArray(raw?.rules) ? raw.rules : []
  return { rules: rules.map((rule) => normalizeWizardRouteClassificationRuleDraft(rule)) }
}

export function normalizeWizardRouteProtectionOverride(
  raw: Partial<WizardRouteProtectionOverride>,
): WizardRouteProtectionOverride {
  return {
    key: raw.key || newWizardRouteProtectionOverrideKey(),
    fieldPath: raw.fieldPath ?? '',
    routeDraftKey: raw.routeDraftKey ?? '',
    protectionAction: normalizeWizardProtectionAction(raw.protectionAction),
    deliveryBehavior:
      raw.deliveryBehavior === 'quarantine' || raw.deliveryBehavior === 'block'
        ? raw.deliveryBehavior
        : 'continue',
    enabled: raw.enabled !== false,
  }
}

export function wizardDataProtectionIntentReady(intent: WizardDataProtectionIntent): boolean {
  const field = intent.detectedField.trim()
  return field.length > 0 && field.startsWith('$')
}

export function wizardDataProtectionStepComplete(state: WizardDataProtectionState): boolean {
  if (state.intents.length === 0) return true
  return state.intents.every(wizardDataProtectionIntentReady)
}

export type AuthType =
  | 'NO_AUTH'
  | 'BASIC'
  | 'BEARER'
  | 'API_KEY'
  | 'OAUTH2_CLIENT_CREDENTIALS'
  | 'SESSION_LOGIN'
  | 'JWT_REFRESH_TOKEN'
export type ApiKeyLocation = 'headers' | 'query_params'

export type WizardConnectorState = {
  connectorId: number | null
  sourceId: number | null
  templateId: string | null
  /** Connector Registry module id (schema-driven Connect path). */
  registryModuleId: string | null
  /** Values collected from SchemaFormRenderer (not persisted until materialization). */
  schemaFormValues: Record<string, string | boolean | number>
  /** Selected Connector Module stream template ids for materialization. */
  selectedTemplateIds: string[]
  apiBacked: boolean
  candidates: { connectors: CatalogConnector[]; sources: CatalogSource[] }
  connectorName: string
  description: string
  hostBaseUrl: string
  /** Mirrors backend Source.source_type for the selected connector. */
  sourceType: 'HTTP_API_POLLING' | 'S3_OBJECT_POLLING' | 'DATABASE_QUERY' | 'REMOTE_FILE_POLLING' | 'WEBHOOK_RECEIVER'
  authType: AuthType
  verifySsl: boolean
  httpProxy: string
  commonHeaders: StreamConfigHeaderRow[]
  basicUsername: string
  basicPassword: string
  bearerToken: string
  apiKeyName: string
  apiKeyValue: string
  apiKeyLocation: ApiKeyLocation
  oauthClientId: string
  oauthClientSecret: string
  oauthTokenUrl: string
  oauthScope: string
  loginUrl: string
  loginPath: string
  loginMethod: 'POST' | 'PUT' | 'PATCH'
  loginUsername: string
  loginPassword: string
  loginHeaders: Record<string, string>
  loginBodyTemplate: Record<string, unknown>
  refreshToken: string
  tokenUrl: string
  tokenPath: string
  tokenHttpMethod: 'POST' | 'PUT' | 'PATCH'
  refreshTokenHeaderName: string
  refreshTokenHeaderPrefix: string
  accessTokenJsonPath: string
  accessTokenHeaderName: string
  accessTokenHeaderPrefix: string
  tokenTtlSeconds: number
}

export type StreamConfigHeaderRow = { id: string; key: string; value: string }
export type StreamConfigParamRow = { id: string; key: string; value: string }

export type WizardCheckpointFieldType = '' | 'TIMESTAMP' | 'EVENT_ID' | 'CURSOR' | 'OFFSET'
export type WizardRecordSelectionMode = 'basic' | 'advanced'

export type WizardHttpApiAnalysis = {
  responseSummary: {
    root_type: string
    approx_size_bytes: number
    top_level_keys: string[]
    item_count_root: number | null
    truncation: string | null
  }
  detectedArrays: Array<{
    path: string
    count: number
    confidence: number
    reason: string
    sample_item_preview?: unknown
  }>
  detectedCheckpointCandidates: Array<{
    path: string
    checkpoint_type: WizardCheckpointFieldType
    confidence: number
    sample_value: unknown
    reason: string
  }>
  sampleEvent: Record<string, unknown> | null
  selectedEventArrayDefault: string | null
  flatPreviewFields: string[]
  eventRootCandidates?: string[]
  /** Backend `preview_error` when body is not parseable JSON, oversized, or non-JSON. */
  previewError: string | null
}

export type WizardConfigState = {
  name: string
  httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  endpoint: string
  headers: StreamConfigHeaderRow[]
  params: StreamConfigParamRow[]
  requestBody: string
  pollingIntervalSec: number
  timeoutSec: number
  eventArrayPath: string
  eventRootPath: string
  /** True when user chose “entire response as single event” (empty event_array_path semantics). */
  useWholeResponseAsEvent: boolean
  /** JSONPath into a single event for checkpoint templates (e.g. $.creationTime). */
  checkpointFieldType: WizardCheckpointFieldType
  checkpointSourcePath: string
  /** Persisted checkpoint mode label (Cursor, Timestamp, Event ID, …). */
  checkpointMode: string
  /** Optional tie-breaker checkpoint path relative to each record. */
  checkpointSecondaryPath: string
  /** Optional schema root path stored on stream config_json.schema.root_path. */
  schemaRootPath: string
  initialDelaySec: number
  paginationType: string
  paginationCursorParam: string
  paginationPageSize: number
  paginationMaxPages: number
  rateLimitPerMinute: number
  rateLimitBurst: number
  /** S3_OBJECT_POLLING stream: objects fetched per StreamRunner execution (default 20). */
  maxObjectsPerRun: number
  /** REMOTE_FILE_POLLING: remote directory (required for sample fetch). */
  remoteDirectory: string
  filePattern: string
  /** DATABASE_QUERY: SELECT-only SQL persisted as stream_config.query. */
  sqlQuery: string
  remoteRecursive: boolean
  parserType: string
  maxFilesPerRun: number
  maxFileSizeMb: number
  encoding: string
  csvDelimiter: string
  lineEventField: string
  includeFileMetadata: boolean
  /**
   * Incremental request template selected on the JSON Preview step.
   * This is used for incremental-request test previews only and must never
   * overwrite the operator's saved Connect-step request body.
   */
  incrementalRequestPattern: IncrementalRequestPattern
  /** Editable preview text for the selected incremental pattern (JSON body or `key=value` lines). */
  incrementalRequestDraft: string
  /** Last successful incremental request test signature (body + checkpoint + event source). */
  incrementalRequestTestSignature: string | null
  /** Epoch ms when incremental request test last succeeded. */
  incrementalRequestTestedAt: number | null
  /** Inline incremental request test outcome from JSON Preview (not persisted on stream). */
  incrementalRequestTestResult: WizardIncrementalRequestTestResult | null
  /** apiTest.finishedAt when the operator last confirmed record path for the current sample. */
  recordPathConfirmedForApiTestAt: number | null
  /** apiTest.finishedAt when the operator last confirmed event root for the current sample. */
  eventRootConfirmedForApiTestAt: number | null
  /** apiTest.finishedAt when the operator last confirmed sync position for the current sample. */
  checkpointConfirmedForApiTestAt: number | null
  /** Record Selection UX mode: tree-first basic mode or custom JSONPath mode. */
  recordSelectionMode: WizardRecordSelectionMode
  /** apiTest.finishedAt when custom extraction paths were last validated successfully. */
  customExtractionValidatedForApiTestAt: number | null
  /** Latest custom extraction validation status for the current sample. */
  customExtractionValidationOk: boolean
}

export type WizardIncrementalRequestTestResult = {
  status: 'success' | 'error'
  httpStatus: number | null
  durationMs: number | null
  returnedRecordCount: number
  testedCheckpointDisplay: string
  substitutedRequestBody: string
  sampleRecords: Array<Record<string, unknown>>
  rawResponseBody: string | null
  message: string
  testedAt: number
  signature: string
}

export type WizardApiTestStatus = 'idle' | 'running' | 'success' | 'error'

export type WizardApiTestStep = {
  name: string
  success: boolean
  status_code?: number | null
  message?: string
}

export type WizardApiTestState = {
  status: WizardApiTestStatus
  ok: boolean
  requestUrl: string | null
  method: string | null
  statusCode: number | null
  responseHeaders: Record<string, string>
  rawBody: string | null
  parsedJson: unknown
  rawResponse: unknown
  extractedEvents: Array<Record<string, unknown>>
  eventCount: number
  /** Union schema across all extracted events (Record Selection → Transform). */
  unionSchema: UnionSchema | null
  startedAt: number | null
  finishedAt: number | null
  errorCode: string | null
  errorType: string | null
  errorMessage: string | null
  targetStatusCode: number | null
  targetResponseBody: string | null
  hint: string | null
  /** Whether this preview came from real API (true) or local mock (false). */
  apiBacked: boolean
  /** Auth / HTTP steps from Stream API Test (masked headers; no plaintext secrets). */
  steps: WizardApiTestStep[]
  responseSample: unknown
  effectiveHeadersMasked: Record<string, string> | null
  actualRequestSent: {
    method: string
    url: string
    endpoint: string | null
    queryParams: Record<string, unknown>
    headersMasked: Record<string, string>
    jsonBodyMasked: unknown | null
    timeoutSeconds: number
  } | null
  /** Structured response analysis from backend (persists across wizard navigation). */
  analysis: WizardHttpApiAnalysis | null
  /** S3_OBJECT_POLLING: connectivity probe succeeded via connector-auth (replaces HTTP sample fetch). */
  s3ConnectivityPassed: boolean
  /** REMOTE_FILE_POLLING: last connector-auth probe (SSH/SFTP listing) before sample fetch. */
  remoteProbe?: ConnectorAuthTestResponse | null
  /** DATABASE_QUERY: connectivity probe succeeded via connector-auth before query sample fetch. */
  dbConnectivityPassed?: boolean
}

/**
 * Origin of a mapping row. Defaults to undefined (= manual). Rows produced by
 * the "Stellar Cyber Metadata Mapping" suggestion menu are tagged with
 * `'stellar'` so the UI can render an inline `STELLAR` badge to differentiate
 * auto-applied suggestions from operator-authored mappings. Persisted as part
 * of the wizard draft only; backend payload does not need this field (the
 * runtime save path uses `output_field` / `source_json_path` exclusively).
 */
export type WizardMappingRowOrigin = 'manual' | 'stellar' | 'auto'

export type WizardMappingRow = {
  id: string
  outputField: string
  sourceJsonPath: string
  origin?: WizardMappingRowOrigin
}

import type { WizardEnrichmentRule } from './enrichment-rules-model'
export type { WizardEnrichmentRule as WizardEnrichmentRow } from './enrichment-rules-model'
export {
  enrichmentDictFromRules as enrichmentDictFromRows,
  normalizeWizardEnrichmentRules,
} from './enrichment-rules-model'

/** Per-concern inherit flags — default all true (Route Processing UX v2). */
export type WizardRouteProcessingInherit = {
  transform: boolean
  protection: boolean
  classification: boolean
  policy: boolean
}

export const DEFAULT_ROUTE_PROCESSING_INHERIT: WizardRouteProcessingInherit = {
  transform: true,
  protection: true,
  classification: true,
  policy: true,
}

/** Route-level transform override draft (wizard intent only). */
export type WizardRouteTransformOverride = {
  mapping: WizardMappingRow[]
  mappingMode: MappingMode
  fullEventJsonataExpression: string
  fullEventRegexConfigJson: string
  transformRules: AdvancedTransformRuleDraft[]
  enrichment: WizardEnrichmentRule[]
  unmappedFieldsPolicy: WizardUnmappedFieldsPolicy
}

/** Route-level protection override draft (wizard intent only). */
export type WizardRouteProtectionOverrideState = Pick<
  WizardDataProtectionState,
  'intents' | 'unknownNormalFieldPolicy' | 'unknownSensitiveFieldPolicy'
>

/** Route-level policy override draft. Per-level fields overlay shared dataPolicy; deliveryBehavior is the blanket governance override. */
export type WizardRoutePolicyOverride = {
  deliveryBehavior: WizardPolicyDeliveryBehavior
  restrictedResponse?: WizardDataPolicyState['restrictedResponse']
  confidentialResponse?: WizardDataPolicyState['confidentialResponse']
}

export function buildRoutePolicyOverrideFromGlobal(
  dataPolicy?: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
): WizardRoutePolicyOverride {
  const restrictedResponse = dataPolicy?.restrictedResponse
  const confidentialResponse = dataPolicy?.confidentialResponse
  let deliveryBehavior: WizardPolicyDeliveryBehavior = 'continue'
  if (restrictedResponse === 'block') deliveryBehavior = 'block'
  else if (restrictedResponse === 'quarantine') deliveryBehavior = 'quarantine'
  return {
    deliveryBehavior,
    ...(restrictedResponse ? { restrictedResponse } : {}),
    ...(confidentialResponse ? { confidentialResponse } : {}),
  }
}

export function wizardRoutePolicyLevelDiffs(
  shared: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
  override: WizardRoutePolicyOverride | undefined,
): Array<'restricted' | 'confidential'> {
  if (!override) return []
  const diffs: Array<'restricted' | 'confidential'> = []
  if (override.restrictedResponse && override.restrictedResponse !== shared.restrictedResponse) {
    diffs.push('restricted')
  }
  if (override.confidentialResponse && override.confidentialResponse !== shared.confidentialResponse) {
    diffs.push('confidential')
  }
  return diffs
}

export function mergeEffectiveWizardPolicy(
  shared: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
  override: WizardRoutePolicyOverride | undefined,
): Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'> {
  return {
    restrictedResponse: override?.restrictedResponse ?? shared.restrictedResponse,
    confidentialResponse: override?.confidentialResponse ?? shared.confidentialResponse,
  }
}

/** Route-level classification rule bundle (persisted via existing route classification-rules API). */
export type WizardRouteClassificationRuleDraft = {
  key: string
  name: string
  sensitivityClass: WizardSensitivityClass
  classificationLevel: WizardClassificationLevel
  enabled: boolean
}

export type WizardRouteClassificationOverrideState = {
  rules: WizardRouteClassificationRuleDraft[]
}

export type WizardRouteProcessingOverrides = {
  transform?: WizardRouteTransformOverride
  protection?: WizardRouteProtectionOverrideState
  classification?: WizardRouteClassificationOverrideState
  policy?: WizardRoutePolicyOverride
}

export type RouteProcessingStatus = 'Inherited' | 'Overridden' | 'Mixed'

/** StreamFailoverRoute draft keyed by this route's primary destination. */
export type WizardRouteFailoverDraft = {
  /** Persisted `stream_failover_routes.id` when loaded from the API. */
  id?: number
  enabled: boolean
  secondaryDestinationId: number | null
}

/** Per-route draft for wizard Destinations step (persists to POST /routes/ on create). */
export type WizardRouteDraft = {
  /** Stable React/client key (not sent to API). */
  key: string
  destinationId: number
  enabled: boolean
  failurePolicy:
    | 'LOG_AND_CONTINUE'
    | 'PAUSE_STREAM_ON_FAILURE'
    | 'RETRY_AND_BACKOFF'
    | 'DISABLE_ROUTE_ON_FAILURE'
  /** Route-level rate limits (optional); merged with destination at runtime when empty. */
  rateLimitJson: Record<string, unknown>
  /** Inherit global processing per concern (default all true). */
  inherit: WizardRouteProcessingInherit
  /** Route-specific processing when inherit is unchecked for a concern. */
  overrides?: WizardRouteProcessingOverrides
  /** Active/Standby failover for this route's destination (existing failover-routes API). */
  failover?: WizardRouteFailoverDraft
}

export type WizardDestinationsState = {
  /** Ordered route plans — one POST /routes/ row per entry after stream creation. */
  routeDrafts: WizardRouteDraft[]
  /** destination_type per id — used for message-prefix defaults when creating routes */
  destinationKindsById: Record<number, string>
  /** Applied to every route created from this wizard step */
  messagePrefixTemplate: string
  /** Explicit per-destination override; omit key → use default by destination type at save */
  messagePrefixEnabledByDestinationId: Record<number, boolean | undefined>
  destinationApiBacked: boolean
}

export type WizardCreateOutcome = {
  streamId: number | null
  routeId: number | null
  /** All route ids returned from POST /routes/ during this creation (last id duplicated in routeId for backward compat). */
  routeIds: number[]
  mappingSaved: boolean
  enrichmentSaved: boolean
  dataProtectionSaved: boolean
  /** True when Contract v1 governance (rules + route_overrides) was persisted. */
  governanceSaved: boolean
  /** True when schema drift policy was persisted to streams.config_json.governance. */
  schemaDriftPolicySaved: boolean
  /** Phase 1 caveats for schema drift policy (e.g. Auto Protect not masking yet). */
  schemaDriftPolicyWarnings: string[]
  /** True when field-level masking could not be enforced until runtime findings exist. */
  dataProtectionEnforcementIncomplete: boolean
  dataProtectionWarnings: string[]
  errors: string[]
  apiBacked: boolean
  /** ISO timestamp from POST /streams/ response when available. */
  createdAt: string | null
  /** Stream ids created via template materialization (M17.5.4). */
  materializedStreamIds?: number[]
}

export type WizardState = {
  connector: WizardConnectorState
  stream: WizardConfigState
  apiTest: WizardApiTestState
  mapping: WizardMappingRow[]
  /** Mapping mode: Basic JSONPath vs Full Event JSONata / Regex (wizard UI draft). */
  mappingMode: MappingMode
  /** Full-event JSONata expression (Advanced tab). */
  fullEventJsonataExpression: string
  /** Full Event Regex Transform JSON config (Expert tab). */
  fullEventRegexConfigJson: string
  /** Per-field Advanced / Expert transform rules (persisted via field_mappings.transform_rules). */
  transformRules: AdvancedTransformRuleDraft[]
  /** Unmapped source fields: pass through (default) or drop at mapping. */
  unmappedFieldsPolicy: WizardUnmappedFieldsPolicy
  enrichment: WizardEnrichmentRule[]
  destinations: WizardDestinationsState
  /** Wizard-only data policy draft (legacy governance modal; superseded by dataProtection in v3). */
  dataPolicy: WizardDataPolicyState
  /** Data Protection step — operator intent persisted at deploy via governance APIs. */
  dataProtection: WizardDataProtectionState
  outcome: WizardCreateOutcome | null
  startMessage: string | null
}

export const INITIAL_CONFIG: WizardConfigState = {
  name: 'Generic HTTP Events',
  httpMethod: 'GET',
  endpoint: '/v1/events',
  headers: [],
  params: [],
  requestBody: '',
  pollingIntervalSec: 60,
  timeoutSec: 30,
  eventArrayPath: '',
  eventRootPath: '',
  useWholeResponseAsEvent: false,
  checkpointFieldType: '',
  checkpointSourcePath: '',
  checkpointMode: 'Cursor',
  checkpointSecondaryPath: '',
  schemaRootPath: '',
  initialDelaySec: 0,
  paginationType: 'None',
  paginationCursorParam: '',
  paginationPageSize: 0,
  paginationMaxPages: 0,
  rateLimitPerMinute: 60,
  rateLimitBurst: 10,
  maxObjectsPerRun: 20,
  remoteDirectory: '',
  filePattern: '*',
  sqlQuery: '',
  remoteRecursive: false,
  parserType: 'NDJSON',
  maxFilesPerRun: 10,
  maxFileSizeMb: 5,
  encoding: 'utf-8',
  csvDelimiter: ',',
  lineEventField: 'line',
  includeFileMetadata: false,
  incrementalRequestPattern: 'json_body',
  incrementalRequestDraft: '',
  incrementalRequestTestSignature: null,
  incrementalRequestTestedAt: null,
  incrementalRequestTestResult: null,
  recordPathConfirmedForApiTestAt: null,
  eventRootConfirmedForApiTestAt: null,
  checkpointConfirmedForApiTestAt: null,
  recordSelectionMode: 'basic',
  customExtractionValidatedForApiTestAt: null,
  customExtractionValidationOk: false,
}

export const INITIAL_API_TEST: WizardApiTestState = {
  status: 'idle',
  ok: false,
  requestUrl: null,
  method: null,
  statusCode: null,
  responseHeaders: {},
  rawBody: null,
  parsedJson: null,
  rawResponse: null,
  extractedEvents: [],
  eventCount: 0,
  unionSchema: null,
  startedAt: null,
  finishedAt: null,
  errorCode: null,
  errorType: null,
  errorMessage: null,
  targetStatusCode: null,
  targetResponseBody: null,
  hint: null,
  apiBacked: false,
  steps: [],
  responseSample: null,
  effectiveHeadersMasked: null,
  actualRequestSent: null,
  analysis: null,
  s3ConnectivityPassed: false,
  remoteProbe: null,
  dbConnectivityPassed: false,
}

export const INITIAL_DESTINATIONS: WizardDestinationsState = {
  routeDrafts: [],
  destinationKindsById: {},
  messagePrefixTemplate: DEFAULT_MESSAGE_PREFIX_TEMPLATE,
  messagePrefixEnabledByDestinationId: {},
  destinationApiBacked: false,
}

export function newWizardRouteDraftKey(): string {
  return `wr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function normalizeWizardRouteProcessingInherit(
  raw: Partial<WizardRouteProcessingInherit> | undefined,
): WizardRouteProcessingInherit {
  return {
    transform: raw?.transform !== false,
    protection: raw?.protection !== false,
    classification: raw?.classification !== false,
    policy: raw?.policy !== false,
  }
}

export function buildRouteTransformOverrideFromGlobal(
  state: Pick<
    WizardState,
    | 'mapping'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'transformRules'
    | 'enrichment'
    | 'unmappedFieldsPolicy'
  >,
): WizardRouteTransformOverride {
  return {
    mapping: state.mapping.map((row) => ({ ...row })),
    mappingMode: state.mappingMode,
    fullEventJsonataExpression: state.fullEventJsonataExpression,
    fullEventRegexConfigJson: state.fullEventRegexConfigJson,
    transformRules: state.transformRules.map((rule) => ({ ...rule })),
    enrichment: state.enrichment.map((rule) => ({ ...rule })),
    unmappedFieldsPolicy: state.unmappedFieldsPolicy,
  }
}

export function buildRouteProtectionOverrideFromGlobal(
  dataProtection: WizardDataProtectionState,
): WizardRouteProtectionOverrideState {
  return {
    intents: dataProtection.intents.map((intent) => ({ ...intent })),
    unknownNormalFieldPolicy: dataProtection.unknownNormalFieldPolicy,
    unknownSensitiveFieldPolicy: dataProtection.unknownSensitiveFieldPolicy,
  }
}

export function normalizeWizardRouteFailover(raw: unknown): WizardRouteFailoverDraft | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as { id?: unknown; enabled?: unknown; secondaryDestinationId?: unknown }
  const secondaryRaw = row.secondaryDestinationId
  const secondaryDestinationId =
    typeof secondaryRaw === 'number' && Number.isFinite(secondaryRaw) && secondaryRaw > 0
      ? secondaryRaw
      : null
  const idRaw = row.id
  const id = typeof idRaw === 'number' && Number.isFinite(idRaw) && idRaw > 0 ? idRaw : undefined
  return {
    ...(id != null ? { id } : {}),
    enabled: row.enabled === true,
    secondaryDestinationId,
  }
}

export function normalizeWizardRouteDraft(
  raw: Partial<WizardRouteDraft>,
  globalState?: Pick<
    WizardState,
    | 'mapping'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'transformRules'
    | 'enrichment'
    | 'unmappedFieldsPolicy'
    | 'dataProtection'
    | 'dataPolicy'
  >,
): WizardRouteDraft {
  const inherit = normalizeWizardRouteProcessingInherit(raw.inherit)
  let overrides = raw.overrides
  if (overrides?.classification) {
    overrides = {
      ...overrides,
      classification: normalizeWizardRouteClassificationOverrideState(overrides.classification),
    }
  }
  if (overrides?.policy) {
    overrides = {
      ...overrides,
      policy: {
        deliveryBehavior: normalizeWizardPolicyDeliveryBehavior(overrides.policy.deliveryBehavior),
        ...(overrides.policy.restrictedResponse !== undefined
          ? { restrictedResponse: normalizeWizardPolicyLevelResponse(overrides.policy.restrictedResponse) }
          : {}),
        ...(overrides.policy.confidentialResponse !== undefined
          ? { confidentialResponse: normalizeWizardPolicyLevelResponse(overrides.policy.confidentialResponse) }
          : {}),
      },
    }
  }
  const failover = normalizeWizardRouteFailover(raw.failover)
  const draft: WizardRouteDraft = {
    key: raw.key || newWizardRouteDraftKey(),
    destinationId: raw.destinationId ?? 0,
    enabled: raw.enabled !== false,
    failurePolicy: raw.failurePolicy ?? 'LOG_AND_CONTINUE',
    rateLimitJson:
      typeof raw.rateLimitJson === 'object' && raw.rateLimitJson && !Array.isArray(raw.rateLimitJson)
        ? { ...raw.rateLimitJson }
        : {},
    inherit,
    overrides,
    ...(failover ? { failover } : {}),
  }
  if (!inherit.transform && !draft.overrides?.transform && globalState) {
    draft.overrides = {
      ...draft.overrides,
      transform: buildRouteTransformOverrideFromGlobal(globalState),
    }
  }
  if (!inherit.protection && !draft.overrides?.protection && globalState) {
    draft.overrides = {
      ...draft.overrides,
      protection: buildRouteProtectionOverrideFromGlobal(globalState.dataProtection),
    }
  }
  if (!inherit.policy && !draft.overrides?.policy) {
    draft.overrides = {
      ...draft.overrides,
      policy: buildRoutePolicyOverrideFromGlobal(globalState?.dataPolicy),
    }
  }
  return draft
}

export type WizardRouteProcessingStatuses = {
  transform: RouteProcessingStatus
  protection: RouteProcessingStatus
  classification: RouteProcessingStatus
  policy: RouteProcessingStatus
}

function routeHasProtectionFieldOverrides(
  dataProtection: Pick<WizardDataProtectionState, 'routeOverrides'>,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeOverrides.some((o) => o.enabled && o.routeDraftKey === routeDraftKey)
}

function routeHasClassificationOverride(
  dataProtection: Pick<WizardDataProtectionState, 'routeClassificationOverrides'>,
  routeDraftKey: string,
): boolean {
  return dataProtection.routeClassificationOverrides.some(
    (o) => o.enabled && o.routeDraftKey === routeDraftKey,
  )
}

export function computeWizardRouteProcessingStatuses(
  draft: WizardRouteDraft,
  dataProtection: WizardDataProtectionState,
  dataPolicy?: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
): WizardRouteProcessingStatuses {
  const inherit = normalizeWizardRouteProcessingInherit(draft.inherit)
  const protectionFieldOverrides = routeHasProtectionFieldOverrides(dataProtection, draft.key)
  const classificationOverride = routeHasClassificationOverride(dataProtection, draft.key)

  const transform: RouteProcessingStatus = inherit.transform ? 'Inherited' : 'Overridden'

  let protection: RouteProcessingStatus
  if (!inherit.protection) {
    protection = protectionFieldOverrides ? 'Mixed' : 'Overridden'
  } else if (protectionFieldOverrides) {
    protection = 'Overridden'
  } else {
    protection = 'Inherited'
  }

  let classification: RouteProcessingStatus
  if (!inherit.classification) {
    classification = classificationOverride ? 'Mixed' : 'Overridden'
  } else if (classificationOverride) {
    classification = 'Overridden'
  } else {
    classification = 'Inherited'
  }

  let policy: RouteProcessingStatus
  if (inherit.policy) {
    policy = 'Inherited'
  } else if (dataPolicy) {
    const levelDiffs = wizardRoutePolicyLevelDiffs(dataPolicy, draft.overrides?.policy)
    policy = levelDiffs.length === 1 ? 'Mixed' : 'Overridden'
  } else {
    policy = 'Overridden'
  }

  return { transform, protection, classification, policy }
}

export function globalTransformConfigured(
  state: Pick<WizardState, 'mapping' | 'transformRules' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson'>,
): boolean {
  if (wizardMappingContentReady(state as WizardState)) return true
  return state.transformRules.some((rule) => rule.outputField.trim().length > 0)
}

export function globalProtectionConfigured(dataProtection: WizardDataProtectionState): boolean {
  return (
    dataProtection.intents.some(wizardDataProtectionIntentReady) ||
    dataProtection.unknownNormalFieldPolicy !== 'pass_through' ||
    dataProtection.unknownSensitiveFieldPolicy !== 'auto_protect'
  )
}

export function globalClassificationConfigured(
  dataPolicy: Pick<WizardDataPolicyState, 'defaultClassification'>,
  dataProtection: Pick<WizardDataProtectionState, 'intents' | 'routeClassificationOverrides'>,
): boolean {
  const level = String(dataPolicy.defaultClassification || '').trim().toUpperCase()
  return (
    (level.length > 0 && level !== 'INTERNAL') ||
    dataProtection.intents.some(wizardDataProtectionIntentReady) ||
    dataProtection.routeClassificationOverrides.some((o) => o.enabled)
  )
}

export function globalPolicyConfigured(
  dataPolicy: Pick<WizardDataPolicyState, 'restrictedResponse' | 'confidentialResponse'>,
  dataProtection: Pick<WizardDataProtectionState, 'intents'>,
): boolean {
  return (
    dataPolicy.restrictedResponse !== 'quarantine' ||
    dataPolicy.confidentialResponse !== 'continue' ||
    dataProtection.intents.some(
      (intent) => wizardDataProtectionIntentReady(intent) && intent.deliveryBehavior !== 'continue',
    )
  )
}

/** Normalize persisted wizard JSON / legacy shapes into `routeDrafts`. */
export function normalizeWizardDestinations(destinations: Partial<WizardDestinationsState> | undefined): WizardDestinationsState {
  if (!destinations) return INITIAL_DESTINATIONS
  const merged: WizardDestinationsState = {
    ...INITIAL_DESTINATIONS,
    ...destinations,
    destinationKindsById: {
      ...INITIAL_DESTINATIONS.destinationKindsById,
      ...destinations.destinationKindsById,
    },
    messagePrefixEnabledByDestinationId: {
      ...INITIAL_DESTINATIONS.messagePrefixEnabledByDestinationId,
      ...destinations.messagePrefixEnabledByDestinationId,
    },
    routeDrafts: Array.isArray(destinations.routeDrafts) ? destinations.routeDrafts : INITIAL_DESTINATIONS.routeDrafts,
  }
  const drafts = merged.routeDrafts
  if (Array.isArray(drafts) && drafts.length > 0) {
    merged.routeDrafts = drafts.map((d) => normalizeWizardRouteDraft(d))
    return merged
  }
  const legacyIds = (destinations as { selectedDestinationIds?: number[] } | undefined)?.selectedDestinationIds
  const legacyPolicy = (destinations as { failurePolicy?: WizardRouteDraft['failurePolicy'] } | undefined)?.failurePolicy
  const legacyEnabled = (destinations as { routeEnabled?: boolean } | undefined)?.routeEnabled
  if (Array.isArray(legacyIds) && legacyIds.length > 0) {
    merged.routeDrafts = legacyIds.map((destinationId, idx) =>
      normalizeWizardRouteDraft({
        key: `legacy-${destinationId}-${idx}`,
        destinationId,
        enabled: legacyEnabled !== false,
        failurePolicy: legacyPolicy ?? 'LOG_AND_CONTINUE',
        rateLimitJson: {},
      }),
    )
  }
  return merged
}

export function buildInitialState(): WizardState {
  return {
    connector: {
      connectorId: null,
      sourceId: null,
      templateId: null,
      registryModuleId: null,
      schemaFormValues: {},
      selectedTemplateIds: [],
      apiBacked: false,
      candidates: { connectors: [], sources: [] },
      connectorName: '',
      description: '',
      hostBaseUrl: '',
      authType: 'NO_AUTH',
      verifySsl: true,
      httpProxy: '',
      commonHeaders: [],
      basicUsername: '',
      basicPassword: '',
      bearerToken: '',
      apiKeyName: '',
      apiKeyValue: '',
      apiKeyLocation: 'headers',
      oauthClientId: '',
      oauthClientSecret: '',
      oauthTokenUrl: '',
      oauthScope: '',
      loginUrl: '',
      loginPath: '',
      loginMethod: 'POST',
      loginUsername: '',
      loginPassword: '',
      loginHeaders: {},
      loginBodyTemplate: {},
      refreshToken: '',
      tokenUrl: '',
      tokenPath: '',
      tokenHttpMethod: 'POST',
      refreshTokenHeaderName: 'Authorization',
      refreshTokenHeaderPrefix: 'Bearer',
      accessTokenJsonPath: '$.access_token',
      accessTokenHeaderName: 'Authorization',
      accessTokenHeaderPrefix: 'Bearer',
      tokenTtlSeconds: 600,
      sourceType: 'HTTP_API_POLLING',
    },
    stream: {
      ...INITIAL_CONFIG,
      headers: [],
      params: [...INITIAL_CONFIG.params],
    },
    apiTest: { ...INITIAL_API_TEST },
    mapping: [],
    mappingMode: 'basic_jsonpath',
    fullEventJsonataExpression: '',
    fullEventRegexConfigJson: '',
    transformRules: [],
    unmappedFieldsPolicy: 'pass_through',
    enrichment: [],
    destinations: normalizeWizardDestinations(INITIAL_DESTINATIONS),
    dataPolicy: { ...INITIAL_DATA_POLICY },
    dataProtection: { ...INITIAL_DATA_PROTECTION },
    outcome: null,
    startMessage: null,
  }
}

export type StepCompletion = 'incomplete' | 'in_progress' | 'complete'

/** Pure status calculator — does not perform network calls. */
export function buildFullRequestUrl(hostBaseUrl: string, endpointPath: string): string {
  const base = hostBaseUrl.trim().replace(/\/$/, '')
  const ep = endpointPath.trim()
  if (!base || !ep) return ''
  return `${base}${ep.startsWith('/') ? ep : `/${ep}`}`
}

/** Merge connector common headers with stream headers (stream wins on key clash). */
export function effectiveRequestHeaders(
  connector: WizardConnectorState,
  stream: WizardConfigState,
): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const row of connector.commonHeaders) {
    const k = row.key.trim()
    if (k) inherited[k] = row.value
  }
  const extra: Record<string, string> = {}
  for (const row of stream.headers) {
    const k = row.key.trim()
    if (k) extra[k] = row.value
  }
  return { ...inherited, ...extra }
}

export function mapConnectorApiAuthType(raw: string): AuthType {
  const x = raw.toLowerCase().replace(/-/g, '_')
  const table: Record<string, AuthType> = {
    no_auth: 'NO_AUTH',
    basic: 'BASIC',
    bearer: 'BEARER',
    api_key: 'API_KEY',
    oauth2_client_credentials: 'OAUTH2_CLIENT_CREDENTIALS',
    session_login: 'SESSION_LOGIN',
    jwt_refresh_token: 'JWT_REFRESH_TOKEN',
  }
  return table[x] ?? 'NO_AUTH'
}

/** Hydrate wizard connector slice from GET /connectors/:id (masked secrets OK — API Test uses connector_id server-side). */
/** Reset fields mirrored from API when user clears connector selection. */
export function resetInheritedConnectorFields(): Partial<WizardConnectorState> {
  return {
    registryModuleId: null,
    schemaFormValues: {},
    selectedTemplateIds: [],
    connectorName: '',
    description: '',
    hostBaseUrl: '',
    authType: 'NO_AUTH',
    verifySsl: true,
    httpProxy: '',
    commonHeaders: [],
    basicUsername: '',
    basicPassword: '',
    bearerToken: '',
    apiKeyName: '',
    apiKeyValue: '',
    apiKeyLocation: 'headers',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthTokenUrl: '',
    oauthScope: '',
    loginUrl: '',
    loginPath: '',
    loginMethod: 'POST',
    loginUsername: '',
    loginPassword: '',
    loginHeaders: {},
    loginBodyTemplate: {},
    refreshToken: '',
    tokenUrl: '',
    tokenPath: '',
    tokenHttpMethod: 'POST',
    refreshTokenHeaderName: 'Authorization',
    refreshTokenHeaderPrefix: 'Bearer',
    accessTokenJsonPath: '$.access_token',
    accessTokenHeaderName: 'Authorization',
    accessTokenHeaderPrefix: 'Bearer',
    tokenTtlSeconds: 600,
    sourceType: 'HTTP_API_POLLING',
  }
}

export function wizardConnectorPatchFromApi(row: ConnectorRead): Partial<WizardConnectorState> {
  const auth = (row.auth ?? {}) as Record<string, unknown>
  const authType = mapConnectorApiAuthType(String(auth.auth_type ?? row.auth_type ?? 'no_auth'))
  const commonHeaders = Object.entries(row.common_headers ?? {}).map(([key, value], idx) => ({
    id: `ch-${row.id}-${idx}`,
    key,
    value: String(value ?? ''),
  }))
  const lhRaw = auth.login_headers
  const loginHeaders =
    lhRaw && typeof lhRaw === 'object' && !Array.isArray(lhRaw)
      ? Object.fromEntries(
          Object.entries(lhRaw as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
        )
      : {}
  const lbRaw = auth.login_body_template
  const loginBodyTemplate =
    lbRaw && typeof lbRaw === 'object' && !Array.isArray(lbRaw)
      ? { ...(lbRaw as Record<string, unknown>) }
      : {}

  const stRaw = String(row.source_type ?? 'HTTP_API_POLLING').toUpperCase().replace(/\s+/g, '_')
  const st: WizardConnectorState['sourceType'] =
    stRaw === 'S3_OBJECT_POLLING' || stRaw === 'S3'
      ? 'S3_OBJECT_POLLING'
      : stRaw === 'DATABASE_QUERY'
        ? 'DATABASE_QUERY'
        : stRaw === 'REMOTE_FILE_POLLING' || stRaw === 'REMOTE_FILE'
          ? 'REMOTE_FILE_POLLING'
          : stRaw === 'WEBHOOK_RECEIVER' || stRaw === 'WEBHOOK' || stRaw === 'WEBHOOK_PUSH'
            ? 'WEBHOOK_RECEIVER'
            : 'HTTP_API_POLLING'
  const baseUrl =
    st === 'S3_OBJECT_POLLING'
      ? String(row.endpoint_url ?? row.base_url ?? row.host ?? '').trim()
      : String(row.base_url ?? row.endpoint_url ?? row.host ?? '').trim()

  return {
    connectorName: row.name ?? '',
    description: row.description ?? '',
    hostBaseUrl: baseUrl,
    sourceType: st,
    verifySsl: row.verify_ssl,
    httpProxy: row.http_proxy ?? '',
    commonHeaders,
    authType,
    basicUsername: String(auth.basic_username ?? ''),
    basicPassword: String(auth.basic_password ?? ''),
    bearerToken: String(auth.bearer_token ?? ''),
    apiKeyName: String(auth.api_key_name ?? ''),
    apiKeyValue: String(auth.api_key_value ?? ''),
    apiKeyLocation: (String(auth.api_key_location ?? 'headers').toLowerCase() as ApiKeyLocation),
    oauthClientId: String(auth.oauth2_client_id ?? ''),
    oauthClientSecret: String(auth.oauth2_client_secret ?? ''),
    oauthTokenUrl: String(auth.oauth2_token_url ?? ''),
    oauthScope: String(auth.oauth2_scope ?? ''),
    loginUrl: String(auth.login_url ?? ''),
    loginPath: String(auth.login_path ?? ''),
    loginMethod: (String(auth.login_method ?? 'POST').toUpperCase() as 'POST' | 'PUT' | 'PATCH'),
    loginUsername: String(auth.login_username ?? ''),
    loginPassword: String(auth.login_password ?? ''),
    loginHeaders,
    loginBodyTemplate,
    refreshToken: String(auth.refresh_token ?? ''),
    tokenUrl: String(auth.token_url ?? ''),
    tokenPath: String(auth.token_path ?? ''),
    tokenHttpMethod: (String(auth.token_http_method ?? 'POST').toUpperCase() as 'POST' | 'PUT' | 'PATCH'),
    refreshTokenHeaderName: String(auth.refresh_token_header_name ?? 'Authorization'),
    refreshTokenHeaderPrefix: String(auth.refresh_token_header_prefix ?? 'Bearer'),
    accessTokenJsonPath: String(auth.access_token_json_path ?? '$.access_token'),
    accessTokenHeaderName: String(auth.access_token_header_name ?? 'Authorization'),
    accessTokenHeaderPrefix: String(auth.access_token_header_prefix ?? 'Bearer'),
    tokenTtlSeconds: Number(auth.token_ttl_seconds ?? 600),
  }
}

export type WizardLegacySubstepCompletion = Record<WizardLegacySubstepKey, StepCompletion>

/** True when the wizard has mappable output (basic rows, JSONata, or full-event regex). */
export function wizardMappingContentReady(
  state: Pick<
    WizardState,
    'mapping' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson'
  >,
): boolean {
  return (
    state.mapping.filter((m) => m.outputField.trim() && m.sourceJsonPath.trim()).length > 0 ||
    (state.mappingMode === 'full_event_jsonata' && state.fullEventJsonataExpression.trim().length > 0) ||
    (state.mappingMode === 'full_event_regex' &&
      hasValidFullEventRegexConfigJson(state.fullEventRegexConfigJson))
  )
}

/** Display count for Review: basic field rows, or 1 for full-event transform modes. */
export function wizardEffectiveMappedFieldCount(
  state: Pick<
    WizardState,
    'mapping' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson'
  >,
): number {
  const basic = state.mapping.filter((m) => m.outputField.trim() && m.sourceJsonPath.trim()).length
  if (basic > 0) return basic
  if (state.mappingMode === 'full_event_jsonata' && state.fullEventJsonataExpression.trim()) return 1
  if (
    state.mappingMode === 'full_event_regex' &&
    hasValidFullEventRegexConfigJson(state.fullEventRegexConfigJson)
  ) {
    return 1
  }
  return 0
}

export type WizardStepCompletion = Record<WizardStepKey, StepCompletion>

function worstCompletion(a: StepCompletion, b: StepCompletion): StepCompletion {
  if (a === 'incomplete' || b === 'incomplete') return 'incomplete'
  if (a === 'in_progress' || b === 'in_progress') return 'in_progress'
  return 'complete'
}

function aggregateCompletion(statuses: StepCompletion[]): StepCompletion {
  if (statuses.length === 0) return 'incomplete'
  return statuses.reduce(worstCompletion, 'complete')
}

/** Per legacy sub-step completion (internal; review/deploy edit shortcuts). */
export function computeLegacySubstepCompletion(state: WizardState): WizardLegacySubstepCompletion {
  const connectorReady = state.connector.connectorId != null && state.connector.sourceId != null
  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isDb = state.connector.sourceType === 'DATABASE_QUERY'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  const streamReady =
    state.stream.name.trim().length > 0 &&
    (isS3 ||
      isRemote ||
      isDb ||
      isWebhook ||
      (!isS3 && !isRemote && !isDb && !isWebhook && state.stream.endpoint.trim().length > 0)) &&
    (!isS3 || (Number.isFinite(state.stream.maxObjectsPerRun) && state.stream.maxObjectsPerRun >= 1)) &&
    (!isRemote || state.stream.remoteDirectory.trim().length > 0) &&
    (!isDb || state.stream.sqlQuery.trim().length > 0)
  const apiTestRan =
    state.apiTest.status === 'success' &&
    (!isS3 || state.apiTest.s3ConnectivityPassed) &&
    (!isRemote || state.apiTest.remoteProbe?.ok === true) &&
    (!isDb || state.apiTest.dbConnectivityPassed)
  const previewErr = state.apiTest.analysis?.previewError
  const recordsGateReady =
    state.apiTest.status === 'success' &&
    state.apiTest.ok &&
    (state.apiTest.parsedJson ?? state.apiTest.rawResponse) != null &&
    (state.apiTest.statusCode == null || state.apiTest.statusCode < 400) &&
    state.apiTest.finishedAt != null &&
    state.stream.recordPathConfirmedForApiTestAt === state.apiTest.finishedAt &&
    state.stream.checkpointConfirmedForApiTestAt === state.apiTest.finishedAt &&
    (state.stream.useWholeResponseAsEvent || state.stream.eventArrayPath.trim().length > 0) &&
    state.stream.checkpointSourcePath.trim().length > 0
  const previewReady = recordsGateReady && !previewErr
  const mappingReady =
    wizardMappingContentReady(state) || state.transformRules.some((r) => r.outputField.trim())
  const enrichmentReady = state.enrichment.length === 0 || state.enrichment.every((e) => e.fieldName.trim().length > 0)
  const enrichmentHasRows = state.enrichment.length > 0
  const destinationsReady = state.destinations.routeDrafts.some((r) => r.enabled)
  const dataProtectionReady = wizardDataProtectionStepComplete(state.dataProtection)
  const reviewReady =
    connectorReady &&
    streamReady &&
    apiTestRan &&
    previewReady &&
    recordsGateReady &&
    mappingReady &&
    destinationsReady &&
    dataProtectionReady
  const created = state.outcome?.streamId != null && reviewReady

  return {
    connector: connectorReady ? 'complete' : 'in_progress',
    stream: !connectorReady ? 'incomplete' : streamReady ? 'complete' : 'in_progress',
    api_test: !connectorReady || !streamReady ? 'incomplete' : apiTestRan ? 'complete' : 'in_progress',
    preview: !connectorReady || !streamReady || !apiTestRan ? 'incomplete' : previewReady ? 'complete' : 'in_progress',
    mapping: !previewReady ? 'incomplete' : mappingReady ? 'complete' : 'in_progress',
    enrichment: !mappingReady ? 'incomplete' : enrichmentReady && enrichmentHasRows ? 'complete' : 'in_progress',
    data_protection: !mappingReady ? 'incomplete' : dataProtectionReady ? 'complete' : 'in_progress',
    destinations: !mappingReady ? 'incomplete' : destinationsReady ? 'complete' : 'in_progress',
    review: created ? 'complete' : reviewReady ? 'in_progress' : 'incomplete',
    done: created ? 'complete' : 'incomplete',
  }
}

/** Stepper completion — aggregates legacy sub-step signals into five top-level steps. */
export function computeStepCompletion(state: WizardState): WizardStepCompletion {
  const legacy = computeLegacySubstepCompletion(state)

  const connect = aggregateCompletion([legacy.connector, legacy.stream, legacy.api_test])
  const sample = legacy.preview
  const destinations = legacy.destinations
  const route_processing = aggregateCompletion([legacy.mapping, legacy.enrichment, legacy.data_protection])
  const deploy = aggregateCompletion([legacy.review, legacy.done])

  return {
    connect,
    sample,
    destinations,
    route_processing,
    deploy,
  }
}

function buildAuthConfig(state: WizardState): Record<string, unknown> {
  const authType = state.connector.authType
  if (authType === 'BASIC') {
    return {
      type: authType,
      username: state.connector.basicUsername,
      password: state.connector.basicPassword,
    }
  }
  if (authType === 'BEARER') {
    return {
      type: authType,
      token: state.connector.bearerToken,
    }
  }
  if (authType === 'API_KEY') {
    return {
      type: authType,
      key_name: state.connector.apiKeyName,
      key_value: state.connector.apiKeyValue,
      location: state.connector.apiKeyLocation,
    }
  }
  if (authType === 'OAUTH2_CLIENT_CREDENTIALS') {
    return {
      type: authType,
      client_id: state.connector.oauthClientId,
      client_secret: state.connector.oauthClientSecret,
      token_url: state.connector.oauthTokenUrl,
      scope: state.connector.oauthScope,
    }
  }
  if (authType === 'SESSION_LOGIN') {
    const lh = state.connector.loginHeaders
    const login_headers =
      lh && Object.keys(lh).length > 0 ? { ...lh } : { 'Content-Type': 'application/json' }
    const tmpl = state.connector.loginBodyTemplate
    const login_body_template =
      tmpl && Object.keys(tmpl).length > 0
        ? tmpl
        : { username: '{{username}}', password: '{{password}}' }
    return {
      type: authType,
      login_url: state.connector.loginUrl || undefined,
      login_path: state.connector.loginPath || undefined,
      login_method: state.connector.loginMethod,
      login_headers,
      login_body_template,
      login_username: state.connector.loginUsername,
      login_password: state.connector.loginPassword,
    }
  }
  if (authType === 'JWT_REFRESH_TOKEN') {
    return {
      type: authType,
      refresh_token: state.connector.refreshToken,
      token_url: state.connector.tokenUrl || undefined,
      token_path: state.connector.tokenPath || undefined,
      token_http_method: state.connector.tokenHttpMethod,
      refresh_token_header_name: state.connector.refreshTokenHeaderName,
      refresh_token_header_prefix: state.connector.refreshTokenHeaderPrefix,
      access_token_json_path: state.connector.accessTokenJsonPath,
      access_token_header_name: state.connector.accessTokenHeaderName,
      access_token_header_prefix: state.connector.accessTokenHeaderPrefix,
      token_ttl_seconds: state.connector.tokenTtlSeconds,
    }
  }
  return { type: 'NO_AUTH' }
}

export function buildSourceConfig(state: WizardState): Record<string, unknown> {
  const commonHeaders: Record<string, string> = {}
  for (const row of state.connector.commonHeaders) {
    if (row.key.trim()) commonHeaders[row.key.trim()] = row.value
  }
  const endpointRaw = state.stream.endpoint.trim()
  let baseUrl = state.connector.hostBaseUrl.trim()
  if (!baseUrl && /^https?:\/\//i.test(endpointRaw)) {
    try {
      baseUrl = new URL(endpointRaw).origin
    } catch {
      // Keep empty base_url and let backend return a precise validation error.
    }
  }
  return {
    base_url: baseUrl,
    timeout_seconds: state.stream.timeoutSec,
    verify_ssl: state.connector.verifySsl,
    http_proxy: state.connector.httpProxy.trim() || null,
    headers: commonHeaders,
  }
}

export function buildSourceAuthPayload(state: WizardState): Record<string, unknown> {
  const auth = buildAuthConfig(state)
  return {
    auth_type: auth.type,
    ...auth,
  }
}

export function buildStreamConfigPayload(state: WizardState): Record<string, unknown> {
  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isDb = state.connector.sourceType === 'DATABASE_QUERY'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  if (isS3) {
    return {
      max_objects_per_run: Math.max(1, Math.floor(Number(state.stream.maxObjectsPerRun) || 20)),
    }
  }
  if (isDb) {
    const out: Record<string, unknown> = {
      query: state.stream.sqlQuery.trim(),
    }
    const timeout = Math.max(1, Math.floor(Number(state.stream.timeoutSec) || 30))
    out.query_timeout_seconds = timeout
    return out
  }
  if (isRemote) {
    return {
      remote_directory: state.stream.remoteDirectory.trim(),
      file_pattern: (state.stream.filePattern.trim() || '*') as string,
      recursive: state.stream.remoteRecursive,
      parser_type: state.stream.parserType,
      max_files_per_run: Math.max(1, Math.floor(Number(state.stream.maxFilesPerRun) || 10)),
      max_file_size_mb: Math.max(1, Math.floor(Number(state.stream.maxFileSizeMb) || 5)),
      encoding: state.stream.encoding.trim() || 'utf-8',
      csv_delimiter: state.stream.csvDelimiter || ',',
      line_event_field: state.stream.lineEventField.trim() || 'line',
      include_file_metadata: state.stream.includeFileMetadata,
    }
  }
  if (isWebhook) {
    const out: Record<string, unknown> = {
      timeout_seconds: state.stream.timeoutSec,
    }
    if (!state.stream.useWholeResponseAsEvent) {
      const eap = state.stream.eventArrayPath.trim()
      if (eap) out.event_array_path = eap.startsWith('$') ? eap : `$.${eap}`
    }
    const erp = state.stream.eventRootPath.trim()
    if (erp) out.event_root_path = erp.startsWith('$') ? erp : `$.${erp}`
    return out
  }
  const headers: Record<string, string> = {}
  for (const row of state.stream.headers) {
    if (row.key.trim()) headers[row.key.trim()] = row.value
  }
  const baseParams: Record<string, string> = {}
  for (const row of state.stream.params) {
    if (row.key.trim()) baseParams[row.key.trim()] = row.value
  }
  const rawEndpoint = state.stream.endpoint.trim()
  let endpoint = rawEndpoint
  if (/^https?:\/\//i.test(rawEndpoint)) {
    try {
      const parsed = new URL(rawEndpoint)
      endpoint = `${parsed.pathname || '/'}${parsed.search || ''}`
    } catch {
      endpoint = rawEndpoint
    }
  }
  const out: Record<string, unknown> = {
    method: state.stream.httpMethod,
    endpoint,
    headers,
    params: baseParams,
    body: state.stream.requestBody.trim() || undefined,
    timeout_seconds: state.stream.timeoutSec,
  }
  if (!state.stream.useWholeResponseAsEvent) {
    const eap = state.stream.eventArrayPath.trim()
    if (eap) {
      out.event_array_path = eap.startsWith('$') ? eap : `$.${eap}`
    }
  }
  const erp = state.stream.eventRootPath.trim()
  if (erp) {
    out.event_root_path = erp.startsWith('$') ? erp : `$.${erp}`
  }
  return out
}

/**
 * Build stream_config for incremental-request Test only.
 * This applies incremental templates at request time without mutating persisted
 * Connect-step request body/params.
 */
export function buildIncrementalTestStreamConfigPayload(state: WizardState): Record<string, unknown> {
  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isDb = state.connector.sourceType === 'DATABASE_QUERY'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  if (isS3 || isRemote || isDb || isWebhook) {
    return buildStreamConfigPayload(state)
  }
  const base = buildStreamConfigPayload(state)
  const merged = applyIncrementalRequestTemplate(
    {
      method: String(base.method ?? state.stream.httpMethod),
      params: ((base.params as Record<string, string> | undefined) ?? {}) as Record<string, string>,
      body: typeof base.body === 'string' ? base.body : undefined,
    },
    state.stream.incrementalRequestPattern,
    state.stream.incrementalRequestDraft,
  )
  return {
    ...base,
    method: merged.method,
    params: merged.params,
    body: merged.body,
  }
}

export function buildStreamCreatePayload(state: WizardState): {
  name: string
  connector_id: number
  source_id: number
  stream_type: string
  polling_interval: number
  enabled: boolean
  status: string
  config_json: Record<string, unknown>
  rate_limit_json: Record<string, unknown>
} | null {
  if (state.connector.connectorId == null || state.connector.sourceId == null) return null
  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isDb = state.connector.sourceType === 'DATABASE_QUERY'
  const isWebhook = state.connector.sourceType === 'WEBHOOK_RECEIVER'
  const maxOb = Math.max(1, Math.floor(Number(state.stream.maxObjectsPerRun) || 20))
  let stream_type = 'HTTP_API_POLLING'
  if (isS3) stream_type = 'S3_OBJECT_POLLING'
  else if (isRemote) stream_type = 'REMOTE_FILE_POLLING'
  else if (isDb) stream_type = 'DATABASE_QUERY'
  else if (isWebhook) stream_type = 'WEBHOOK_RECEIVER'
  const config_json: Record<string, unknown> = isS3
    ? { max_objects_per_run: maxOb }
    : mergeStreamConfigJson(
        {},
        buildStreamConfigPayload(state),
        buildAdvancedStreamConfigJsonPatch(state.stream),
      )
  return {
    name: state.stream.name.trim() || 'Untitled Stream',
    connector_id: state.connector.connectorId,
    source_id: state.connector.sourceId,
    stream_type,
    polling_interval: state.stream.pollingIntervalSec,
    enabled: true,
    status: 'STOPPED',
    config_json,
    rate_limit_json: {
      per_minute: state.stream.rateLimitPerMinute,
      burst: state.stream.rateLimitBurst,
    },
  }
}

export function fieldMappingsFromRows(rows: WizardMappingRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    if (row.outputField.trim() && row.sourceJsonPath.trim()) {
      out[row.outputField.trim()] = row.sourceJsonPath.trim()
    }
  }
  return out
}

/** Persisted field_mappings_json for the active wizard mapping mode. */
export function buildWizardFieldMappingsPayload(
  state: Pick<
    WizardState,
    | 'mapping'
    | 'mappingMode'
    | 'fullEventJsonataExpression'
    | 'fullEventRegexConfigJson'
    | 'transformRules'
    | 'unmappedFieldsPolicy'
  >,
): Record<string, unknown> {
  if (state.mappingMode === 'full_event_jsonata') {
    const expr = state.fullEventJsonataExpression.trim()
    if (!expr) return {}
    return buildWizardJsonataPreviewFieldMappings(expr)
  }
  if (state.mappingMode === 'full_event_regex') {
    const built = buildFieldMappingsFromFullEventRegexConfigJson(state.fullEventRegexConfigJson)
    if (!built.ok) return {}
    return built.fieldMappings
  }
  return buildFieldMappingsWithTransformRules(
    fieldMappingsFromRows(state.mapping),
    state.transformRules,
    state.unmappedFieldsPolicy,
  )
}

export function wizardFieldMappingsReady(
  state: Pick<
    WizardState,
    'mapping' | 'mappingMode' | 'fullEventJsonataExpression' | 'fullEventRegexConfigJson' | 'transformRules'
  >,
): boolean {
  if (state.mappingMode === 'full_event_jsonata') {
    return state.fullEventJsonataExpression.trim().length > 0
  }
  if (state.mappingMode === 'full_event_regex') {
    return hasValidFullEventRegexConfigJson(state.fullEventRegexConfigJson)
  }
  return (
    Object.keys(fieldMappingsFromRows(state.mapping)).length > 0 ||
    state.transformRules.some((r) => r.outputField.trim())
  )
}

export function buildRouteCreatePayloads(streamId: number, destinations: WizardDestinationsState): Array<{
  stream_id: number
  destination_id: number
  enabled: boolean
  failure_policy: WizardRouteDraft['failurePolicy']
  status: 'ENABLED' | 'DISABLED'
  formatter_config_json: Record<string, unknown>
  rate_limit_json: Record<string, unknown>
}> {
  const tmpl =
    destinations.messagePrefixTemplate.trim().length > 0
      ? destinations.messagePrefixTemplate.trim()
      : DEFAULT_MESSAGE_PREFIX_TEMPLATE
  return destinations.routeDrafts.map((draft) => {
    const destinationId = draft.destinationId
    const kind = destinations.destinationKindsById[destinationId]
    const explicit = destinations.messagePrefixEnabledByDestinationId[destinationId]
    const prefixEnabled = explicit !== undefined ? explicit : defaultMessagePrefixEnabled(kind ?? '')
    const rl = draft.rateLimitJson && typeof draft.rateLimitJson === 'object' ? { ...draft.rateLimitJson } : {}
    return {
      stream_id: streamId,
      destination_id: destinationId,
      enabled: draft.enabled,
      failure_policy: draft.failurePolicy,
      status: draft.enabled ? 'ENABLED' : 'DISABLED',
      formatter_config_json: {
        message_prefix_enabled: prefixEnabled,
        message_prefix_template: tmpl,
      },
      rate_limit_json: rl,
    }
  })
}
