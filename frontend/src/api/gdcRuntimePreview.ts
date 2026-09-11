import { requestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

/**
 * Runtime preview / API test wrappers.
 *
 * These hit backend endpoints (`/runtime/api-test/http`, `/runtime/api-test/connector-auth`,
 * `/runtime/preview/mapping-draft`).
 *
 * Stage purpose:
 *   - `runHttpApiTest`            : Fetch Sample Data step — real HTTP preview (`fetch_sample` flag only),
 *                                   no DB writes; query/body match wizard config (no auto `limit`).
 *   - `runMappingDraftPreview`    : Step 5 (Mapping)         — preview mapped
 *                                   events from JSONPath rules without saving.
 */

const RT = `${GDC_API_PREFIX}/runtime`

export type HttpApiTestRequest = {
  source_config: Record<string, unknown>
  stream_config: Record<string, unknown>
  checkpoint?: Record<string, unknown> | null
  /** Load credentials and shared HTTP settings from DB (wizard uses this so masked connector GET responses do not break login). */
  connector_id?: number | null
  /** When true, replace onboarding placeholders for sample fetch flow (no implicit limit injection). */
  fetch_sample?: boolean
}

export type HttpApiTestStep = {
  name: string
  success: boolean
  status_code?: number | null
  message?: string
}

export type HttpApiTestAnalysisPayload = {
  response_summary: {
    root_type: string
    approx_size_bytes: number
    top_level_keys: string[]
    item_count_root?: number | null
    truncation?: string | null
  }
  detected_arrays: Array<{
    path: string
    count: number
    confidence: number
    reason: string
    sample_item_preview?: unknown
  }>
  detected_checkpoint_candidates: Array<{
    field_path: string
    checkpoint_type: 'TIMESTAMP' | 'EVENT_ID' | 'CURSOR' | 'OFFSET'
    confidence: number
    sample_value?: unknown
    reason?: string
  }>
  sample_event: Record<string, unknown> | null
  selected_event_array_default: string | null
  flat_preview_fields: string[]
  preview_error?: string | null
}

export type HttpApiTestResponse = {
  ok: boolean
  request: { method: string; url: string; headers_masked: Record<string, string> }
  actual_request_sent?: {
    method: string
    url: string
    endpoint?: string | null
    query_params: Record<string, unknown>
    headers_masked: Record<string, string>
    json_body_masked?: unknown | null
    timeout_seconds: number
  } | null
  response: null | {
    status_code: number
    latency_ms: number
    headers: Record<string, string>
    raw_body: string
    parsed_json: unknown
    content_type: string | null
  }
  error_type?: string | null
  message?: string | null
  target_status_code?: number | null
  target_response_body?: string | null
  hint?: string | null
  error_code?: string | null
  steps?: HttpApiTestStep[]
  response_sample?: unknown
  analysis?: HttpApiTestAnalysisPayload | null
  database_query_row_count?: number | null
  database_query_sample_rows?: Array<Record<string, unknown>> | null
  remote_file_event_count?: number | null
  s3_event_count?: number | null
  s3_sample_keys?: string[] | null
}

/**
 * Strict variant: throws on HTTP error so the wizard can surface the precise
 * upstream reason (timeout / connection / invalid JSON / 4xx body).
 */
export async function runHttpApiTest(payload: HttpApiTestRequest): Promise<HttpApiTestResponse> {
  return requestJson<HttpApiTestResponse>(`${RT}/api-test/http`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type ConnectorAuthTestResponse = {
  ok: boolean
  auth_type: string
  message?: string | null
  error_type?: string | null
  phase?: string | null
  login_http_status?: number | null
  login_final_url?: string | null
  redirect_chain?: string[]
  session_login_body_mode?: string | null
  /** Masked diagnostic preview of login POST body (session_login). */
  session_login_body_preview?: string | null
  /** Resolved Content-Type on the login request. */
  session_login_content_type?: string | null
  /** httpx kw kind: json | data | content | none */
  session_login_request_encoding?: string | null
  session_login_follow_redirects?: boolean | null
  preflight_http_status?: number | null
  preflight_final_url?: string | null
  preflight_cookies?: Record<string, string>
  extracted_variables?: Record<string, string>
  template_render_preview?: string | null
  computed_login_request_url?: string | null
  login_url_resolution_warnings?: string[]
  login_failure_reason?: string | null
  login_http_reason?: string | null
  session_cookie_obtained?: boolean
  cookie_names?: string[]
  probe_http_status?: number | null
  probe_url?: string | null
  request_method?: string | null
  request_url?: string | null
  request_headers_masked?: Record<string, string>
  response_status_code?: number | null
  response_headers_masked?: Record<string, string>
  response_body?: string | null
  token_request_method?: string | null
  token_request_url?: string | null
  token_request_headers_masked?: Record<string, string>
  token_request_body_mode?: string | null
  token_response_status_code?: number | null
  token_response_headers_masked?: Record<string, string>
  token_response_body?: string | null
  token_response_body_masked?: string | null
  final_request_method?: string | null
  final_request_url?: string | null
  final_request_headers_masked?: Record<string, string>
  final_response_status_code?: number | null
  final_response_headers_masked?: Record<string, string>
  final_response_body?: string | null
  s3_endpoint_reachable?: boolean | null
  s3_auth_ok?: boolean | null
  s3_bucket_exists?: boolean | null
  s3_object_count_preview?: number | null
  s3_sample_keys?: string[] | null
  db_reachable?: boolean | null
  db_auth_ok?: boolean | null
  ssh_reachable?: boolean | null
  ssh_auth_ok?: boolean | null
  sftp_available?: boolean | null
  remote_directory_accessible?: boolean | null
  matched_file_count?: number | null
  sample_remote_paths?: string[] | null
  host_key_status?: string | null
}

export type ConnectorAuthTestRequestPayload = {
  connector_id?: number | null
  /** Unsaved connector: same shape as merged Source row (`inline_flat_source` on API). */
  inline_flat_source?: Record<string, unknown> | null
  method?: string
  test_path?: string | null
  test_url?: string | null
  extra_headers?: Record<string, string>
  query_params?: Record<string, unknown>
  json_body?: unknown | null
  remote_file_stream_config?: Record<string, unknown> | null
}

export async function runConnectorAuthTest(payload: ConnectorAuthTestRequestPayload): Promise<ConnectorAuthTestResponse> {
  return requestJson<ConnectorAuthTestResponse>(`${RT}/api-test/connector-auth`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type MappingDraftPreviewRequest = {
  payload: unknown
  event_array_path?: string | null
  event_root_path?: string | null
  field_mappings: Record<string, string>
  max_events?: number
}

export type MappingDraftPreviewResponse = {
  input_event_count: number
  preview_event_count: number
  mapped_events: Array<Record<string, unknown>>
  missing_fields: Array<{ output_field: string; json_path: string; event_index: number }>
  message: string
}

export async function runMappingDraftPreview(
  payload: MappingDraftPreviewRequest,
): Promise<MappingDraftPreviewResponse> {
  return requestJson<MappingDraftPreviewResponse>(`${RT}/preview/mapping-draft`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type MappingValidationWarning = {
  code: string
  severity: 'error' | 'warning'
  message: string
  output_field?: string | null
  json_path?: string | null
  event_index?: number | null
}

export type MappingValidateRequest = {
  payload?: unknown | null
  event_array_path?: string | null
  event_root_path?: string | null
  field_mappings?: Record<string, string>
}

export type MappingValidateResponse = {
  ok: boolean
  warnings: MappingValidationWarning[]
}

export async function runMappingValidate(payload: MappingValidateRequest): Promise<MappingValidateResponse> {
  return requestJson<MappingValidateResponse>(`${RT}/preview/mapping-validate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type ExtractionValidationIssue = {
  code: string
  severity: 'error' | 'warning'
  message: string
}

export type ExtractionValidateRequest = {
  payload: unknown
  event_array_path?: string | null
  event_root_path?: string | null
  checkpoint_path?: string | null
  max_preview_events?: number
}

export type ExtractionValidateResponse = {
  ok: boolean
  normalized_event_array_path?: string | null
  normalized_event_root_path?: string | null
  normalized_checkpoint_path?: string | null
  event_count: number
  preview_events: Array<Record<string, unknown>>
  checkpoint_values_preview: unknown[]
  warnings: ExtractionValidationIssue[]
  errors: ExtractionValidationIssue[]
}

export async function runExtractionValidate(payload: ExtractionValidateRequest): Promise<ExtractionValidateResponse> {
  return requestJson<ExtractionValidateResponse>(`${RT}/preview/extraction-validate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type FinalEventDraftPreviewRequest = {
  payload: unknown
  event_array_path?: string | null
  event_root_path?: string | null
  field_mappings: Record<string, string>
  enrichment: Record<string, unknown>
  override_policy?: 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  max_events?: number
}

export type FinalEventDraftPreviewResponse = {
  input_event_count: number
  preview_event_count: number
  mapped_events: Array<Record<string, unknown>>
  final_events: Array<Record<string, unknown>>
  missing_fields: Array<{ output_field: string; json_path: string; event_index: number }>
  message: string
}

export async function runFinalEventDraftPreview(
  payload: FinalEventDraftPreviewRequest,
): Promise<FinalEventDraftPreviewResponse> {
  return requestJson<FinalEventDraftPreviewResponse>(`${RT}/preview/final-event-draft`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type EnrichmentExecPreviewRequest = {
  mapped_event: Record<string, unknown>
  enrichment: Record<string, unknown>
  override_policy?: 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
}

export type EnrichmentExecPreviewWarning = {
  code: string
  message: string
  rule_type?: string | null
  target_field?: string | null
}

export type EnrichmentExecPreviewResponse = {
  final_event: Record<string, unknown>
  warnings: EnrichmentExecPreviewWarning[]
  duration_ms?: number
  message: string
}

export type EnrichmentValidationIssue = {
  code: string
  severity: 'error' | 'warning'
  message: string
  rule_type?: string | null
  target_field?: string | null
  field?: string | null
}

export type EnrichmentValidateRequest = {
  enrichment: Record<string, unknown>
}

export type EnrichmentValidateResponse = {
  ok: boolean
  issues: EnrichmentValidationIssue[]
}

export async function runEnrichmentValidate(
  payload: EnrichmentValidateRequest,
): Promise<EnrichmentValidateResponse> {
  return requestJson<EnrichmentValidateResponse>(`${RT}/preview/enrichment-validate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function runEnrichmentExecPreview(
  payload: EnrichmentExecPreviewRequest,
): Promise<EnrichmentExecPreviewResponse> {
  return requestJson<EnrichmentExecPreviewResponse>(`${RT}/preview/enrichment-exec`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type TransformPreviewSampleSummary = {
  is_object: boolean
  top_level_keys: string[]
  top_level_key_count: number
  keys_truncated?: boolean
  nested_key_estimate?: number
  value_preview?: Record<string, unknown>
}

export type TransformPreviewFieldResult = {
  success: boolean
  value: unknown
  error_code: string | null
  error_message: string | null
  rule_id: string | null
  output_field: string
  mode: string
  recovered_via_default: boolean
}

export type TransformPreviewIssue = {
  level?: 'field' | 'event'
  output_field?: string | null
  rule_id?: string | null
  code?: string | null
  message?: string
  error_code?: string | null
  error_message?: string | null
  sample_value?: string | null
  rule_type?: string | null
}

export type TransformPreviewRequest = {
  stage: 'mapping' | 'enrichment'
  sample_event: Record<string, unknown>
  rules?: Record<string, unknown>[]
  field_mappings?: Record<string, unknown> | null
  enrichment?: Record<string, unknown> | null
  override_policy?: 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
}

export type TransformPreviewResponse = {
  stage: 'mapping' | 'enrichment'
  input_sample_summary: TransformPreviewSampleSummary
  transformed_result: Record<string, unknown>
  field_results: TransformPreviewFieldResult[]
  errors: TransformPreviewIssue[]
  warnings: TransformPreviewIssue[]
  save_blocked: boolean
  duration_ms: number
  message: string
}

export async function runTransformPreview(payload: TransformPreviewRequest): Promise<TransformPreviewResponse> {
  return requestJson<TransformPreviewResponse>(`${RT}/preview/transform`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type SensitiveSuggestion = {
  field_path: string
  suggested_sensitive_type: string
  sensitivity_class: string
  detection_method: string
  matched_rule?: string | null
  detection_source: string
  confidence?: string | null
}

export type SensitiveDetectionPreviewRequest = {
  events: Array<Record<string, unknown>>
}

export type SensitiveDetectionPreviewResponse = {
  suggestions: SensitiveSuggestion[]
  suggestion_count: number
  auto_protection_applied: boolean
}

export async function runSensitiveDetectionPreview(
  payload: SensitiveDetectionPreviewRequest,
): Promise<SensitiveDetectionPreviewResponse> {
  return requestJson<SensitiveDetectionPreviewResponse>(`${RT}/preview/sensitive-detection`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export type DeliveryPrefixFormatPreviewRequest = {
  formatter_config: Record<string, unknown>
  sample_event: Record<string, unknown>
  destination_type: string
  stream: Record<string, unknown>
  destination: Record<string, unknown>
  route: Record<string, unknown>
  /** WEBHOOK_POST: matches destination ``config_json.payload_mode`` when set. */
  payload_mode?: 'SINGLE_EVENT_OBJECT' | 'BATCH_JSON_ARRAY'
}

export type DeliveryPrefixFormatPreviewResponse = {
  resolved_prefix: string
  final_payload: string
  message_prefix_enabled: boolean
}

export async function runDeliveryPrefixFormatPreview(
  payload: DeliveryPrefixFormatPreviewRequest,
): Promise<DeliveryPrefixFormatPreviewResponse> {
  return requestJson<DeliveryPrefixFormatPreviewResponse>(`${RT}/format-preview`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
