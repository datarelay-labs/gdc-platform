import { AlertCircle, CheckCircle2, Loader2, Play } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { runHttpApiTest, runConnectorAuthTest, type ConnectorAuthTestResponse, type HttpApiTestAnalysisPayload } from '../../../api/gdcRuntimePreview'
import { WIZARD_LABEL } from '../../../lib/operator-vocabulary'
import { cn } from '../../../lib/utils'
import { validateJsonBodyForApi } from '../../../utils/jsonBodySyntax'
import {
  buildSourceAuthPayload,
  buildSourceConfig,
  buildStreamConfigPayload,
  type WizardApiTestStep,
  type WizardApiTestState,
  type WizardConfigState,
  type WizardHttpApiAnalysis,
  type WizardState,
} from './wizard-state'
import { detectEventRootCandidates } from './wizard-json-extract'
import {
  analysisFromParsedRecordArray,
  buildApiTestSuccessPatch,
  parsedRecordEvents,
} from '../../../utils/wizardUnionSchema'
import { resolveHttpApiTestResult, wizardCanRunLiveSampleTest } from './wizard-step-gates'
import type { OperationalSampleId } from './wizard-operational-samples'
import { resolveSourceTypePresentation } from '../../../utils/sourceTypePresentation'
type StepApiTestProps = {
  state: WizardState
  onChange: (next: WizardApiTestState) => void
  /** Suggested paths only — never persisted without explicit user confirmation (Charter v3). */
  onStreamPatch?: (patch: Partial<WizardConfigState>) => void
  onLoadOperationalSample?: (id: OperationalSampleId) => void
  activeOperationalSampleId?: OperationalSampleId | null
  /** Jump to Record Selection after a successful run test. */
  onAdvanceToRecordSelection?: () => void
}

function mapApiAnalysis(a: HttpApiTestAnalysisPayload): WizardHttpApiAnalysis {
  return {
    responseSummary: {
      root_type: a.response_summary.root_type,
      approx_size_bytes: a.response_summary.approx_size_bytes,
      top_level_keys: a.response_summary.top_level_keys ?? [],
      item_count_root: a.response_summary.item_count_root ?? null,
      truncation: a.response_summary.truncation ?? null,
    },
    detectedArrays: (a.detected_arrays ?? []).map((x) => ({
      path: x.path,
      count: x.count,
      confidence: x.confidence,
      reason: x.reason,
      sample_item_preview: x.sample_item_preview,
    })),
    detectedCheckpointCandidates: (a.detected_checkpoint_candidates ?? []).map((x) => ({
      path: x.field_path,
      checkpoint_type: x.checkpoint_type,
      confidence: x.confidence,
      sample_value: x.sample_value,
      reason: x.reason ?? '',
    })),
    sampleEvent: a.sample_event,
    selectedEventArrayDefault: a.selected_event_array_default ?? null,
    flatPreviewFields: a.flat_preview_fields ?? [],
    eventRootCandidates: detectEventRootCandidates(a.sample_event),
    previewError: a.preview_error ?? null,
  }
}

function mapApiSteps(
  steps: Array<{ name: string; success: boolean; status_code?: number | null; message?: string }> | undefined,
): WizardApiTestStep[] {
  if (!steps?.length) return []
  return steps.map((s) => ({
    name: s.name,
    success: s.success,
    status_code: s.status_code ?? null,
    message: s.message ?? '',
  }))
}

export function StepApiTest({
  state,
  onChange,
  onStreamPatch: _onStreamPatch,
  onAdvanceToRecordSelection,
}: StepApiTestProps) {
  const [busy, setBusy] = useState(false)

  const sourcePres = useMemo(
    () => resolveSourceTypePresentation(state.connector.sourceType),
    [state.connector.sourceType],
  )

  const isS3 = state.connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = state.connector.sourceType === 'REMOTE_FILE_POLLING'
  const isDb = state.connector.sourceType === 'DATABASE_QUERY'
  const canRunLiveApiTest = useMemo(
    () => wizardCanRunLiveSampleTest(state),
    [
      state.connector.connectorId,
      state.connector.sourceId,
      state.connector.sourceType,
      state.stream.endpoint,
      state.stream.remoteDirectory,
      state.stream.sqlQuery,
      isS3,
      isRemote,
      isDb,
    ],
  )

  const run = useCallback(async () => {
    if (busy || !canRunLiveApiTest) return

    if (state.connector.sourceType === 'S3_OBJECT_POLLING') {
      setBusy(true)
      const startedAt = Date.now()
      onChange({
        ...state.apiTest,
        status: 'running',
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
        s3ConnectivityPassed: false,
        extractedEvents: [],
        eventCount: 0,
        unionSchema: null,
        analysis: null,
      })
      let probeOk = false
      try {
        const res = await runConnectorAuthTest({
          connector_id: state.connector.connectorId ?? undefined,
          method: 'GET',
          test_path: '/',
        })
        if (!res.ok) {
          onChange({
            status: 'error',
            ok: false,
            requestUrl: null,
            method: 'GET',
            statusCode: null,
            responseHeaders: {},
            rawBody: JSON.stringify(res, null, 2),
            parsedJson: null,
            rawResponse: res,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: res.error_type ?? 's3_probe_failed',
            errorType: res.error_type ?? 's3_probe_failed',
            errorMessage: res.message ?? 'S3 connectivity probe failed',
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'Verify endpoint URL, bucket, credentials, and IAM (s3:ListBucket, s3:GetObject).',
            apiBacked: true,
            steps: [],
            responseSample: null,
            effectiveHeadersMasked: null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
          })
          return
        }
        probeOk = true
        const sampleRes = await runHttpApiTest({
          connector_id: state.connector.connectorId ?? undefined,
          source_config: { ...buildSourceConfig(state), ...buildSourceAuthPayload(state) },
          stream_config: buildStreamConfigPayload(state),
          checkpoint: null,
          fetch_sample: true,
        })
        const parsedBody = sampleRes.response?.parsed_json ?? null
        const records = parsedRecordEvents(parsedBody)
        const hasRecords = records.length > 0
        let analysisModel = sampleRes.analysis ? mapApiAnalysis(sampleRes.analysis) : analysisFromParsedRecordArray(parsedBody)
        if (!analysisModel && hasRecords) {
          analysisModel = analysisFromParsedRecordArray(records)
        }
        const samplePatch = buildApiTestSuccessPatch(hasRecords ? parsedBody : [], analysisModel)
        const probeSummary = {
          s3_bucket_exists: res.s3_bucket_exists,
          s3_object_count_preview: res.s3_object_count_preview,
          s3_sample_keys: res.s3_sample_keys,
          s3_endpoint_reachable: res.s3_endpoint_reachable,
          s3_auth_ok: res.s3_auth_ok,
          s3_event_count: sampleRes.s3_event_count ?? records.length,
          sample_object_keys: sampleRes.s3_sample_keys ?? [],
        }
        onChange({
          status: sampleRes.ok ? 'success' : 'error',
          ok: Boolean(sampleRes.ok && hasRecords),
          requestUrl: sampleRes.request?.url ?? state.connector.hostBaseUrl ?? null,
          method: sampleRes.request?.method ?? 'S3_OBJECT_POLLING',
          statusCode: sampleRes.response?.status_code ?? null,
          responseHeaders: sampleRes.response?.headers ?? {},
          rawBody: sampleRes.response?.raw_body ?? JSON.stringify(probeSummary, null, 2),
          parsedJson: parsedBody ?? [],
          rawResponse: parsedBody ?? sampleRes.response?.raw_body ?? probeSummary,
          ...samplePatch,
          startedAt,
          finishedAt: Date.now(),
          errorCode: sampleRes.ok ? (hasRecords ? null : 's3_sample_not_available') : sampleRes.error_type ?? 's3_sample_fetch_failed',
          errorType: sampleRes.ok ? (hasRecords ? null : 's3_sample_not_available') : sampleRes.error_type ?? 's3_sample_fetch_failed',
          errorMessage: sampleRes.ok
            ? hasRecords
              ? null
              : 'Connection succeeded. Sample data is not available (no records). Union Schema was not generated.'
            : sampleRes.message ?? 'S3 sample fetch failed',
          targetStatusCode: null,
          targetResponseBody: sampleRes.ok ? null : sampleRes.response?.raw_body ?? null,
          hint: sampleRes.ok
            ? hasRecords
              ? null
              : 'Upload at least one JSON/NDJSON object under the configured bucket and prefix, then retry sample fetch.'
            : 'Connectivity passed. Fix object access, parser format, or prefix, then retry sample fetch.',
          apiBacked: true,
          steps: mapApiSteps(sampleRes.steps),
          responseSample: hasRecords ? parsedBody : probeSummary,
          effectiveHeadersMasked: sampleRes.request?.headers_masked ?? null,
          actualRequestSent: sampleRes.actual_request_sent
            ? {
                method: sampleRes.actual_request_sent.method,
                url: sampleRes.actual_request_sent.url,
                endpoint: sampleRes.actual_request_sent.endpoint ?? null,
                queryParams: sampleRes.actual_request_sent.query_params ?? {},
                headersMasked: sampleRes.actual_request_sent.headers_masked ?? {},
                jsonBodyMasked: sampleRes.actual_request_sent.json_body_masked ?? null,
                timeoutSeconds: sampleRes.actual_request_sent.timeout_seconds,
              }
            : null,
          analysis: sampleRes.ok ? analysisModel : null,
          s3ConnectivityPassed: true,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : probeOk ? 'S3 sample fetch failed.' : 'S3 probe failed.'
        onChange({
          status: 'error',
          ok: false,
          requestUrl: null,
          method: probeOk ? 'S3_OBJECT_POLLING' : null,
          statusCode: null,
          responseHeaders: {},
          rawBody: null,
          parsedJson: null,
          rawResponse: null,
          extractedEvents: [],
          eventCount: 0,
          unionSchema: null,
          startedAt,
          finishedAt: Date.now(),
          errorCode: probeOk ? 's3_sample_fetch_exception' : 's3_probe_exception',
          errorType: probeOk ? 's3_sample_fetch_exception' : 's3_probe_exception',
          errorMessage: message,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: probeOk
            ? 'Connectivity passed. Fix object access, parser format, or prefix, then retry sample fetch.'
            : null,
          apiBacked: true,
          steps: [],
          responseSample: null,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          analysis: null,
          s3ConnectivityPassed: probeOk,
        })
      } finally {
        setBusy(false)
      }
      return
    }

    if (isRemote) {
      setBusy(true)
      const startedAt = Date.now()
      onChange({
        ...state.apiTest,
        status: 'running',
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
        targetStatusCode: null,
        targetResponseBody: null,
        hint: null,
        requestUrl: null,
        method: null,
        statusCode: null,
        responseHeaders: {},
        rawBody: null,
        parsedJson: null,
        steps: [],
        responseSample: null,
        effectiveHeadersMasked: null,
        analysis: null,
        actualRequestSent: null,
        s3ConnectivityPassed: false,
        remoteProbe: null,
      })
      let lastProbe: ConnectorAuthTestResponse | null = null
      try {
        const probe = await runConnectorAuthTest({
          connector_id: state.connector.connectorId ?? undefined,
          method: 'GET',
          test_path: '/',
          remote_file_stream_config: {
            remote_directory: state.stream.remoteDirectory.trim(),
            file_pattern: (state.stream.filePattern.trim() || '*') as string,
            recursive: state.stream.remoteRecursive,
          },
        })
        if (!probe.ok) {
          onChange({
            status: 'error',
            ok: false,
            requestUrl: null,
            method: 'REMOTE_FILE_POLLING',
            statusCode: null,
            responseHeaders: {},
            rawBody: null,
            parsedJson: null,
            rawResponse: probe,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: probe.error_type ?? 'remote_probe_failed',
            errorType: probe.error_type ?? 'remote_probe_failed',
            errorMessage: probe.message ?? 'Remote file connectivity probe failed',
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'Verify SSH host, credentials, known_hosts policy, and remote_directory.',
            apiBacked: true,
            steps: [],
            responseSample: null,
            effectiveHeadersMasked: null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
            remoteProbe: probe,
          })
          return
        }
        lastProbe = probe
        const res = await runHttpApiTest({
          connector_id: state.connector.connectorId ?? undefined,
          source_config: { ...buildSourceConfig(state), ...buildSourceAuthPayload(state) },
          stream_config: buildStreamConfigPayload(state),
          checkpoint: null,
          fetch_sample: true,
        })
        const parsedBody = res.response?.parsed_json ?? null
        let analysisModel = res.analysis ? mapApiAnalysis(res.analysis) : analysisFromParsedRecordArray(parsedBody)
        const statusCode = res.response?.status_code ?? null
        const hasPayload = parsedBody != null || (res.response?.raw_body ?? null) != null
        const outcome = resolveHttpApiTestResult(statusCode, hasPayload)
        const samplePatch = outcome.ok ? buildApiTestSuccessPatch(parsedBody, analysisModel) : buildApiTestSuccessPatch(null, null)
        onChange({
          status: outcome.status,
          ok: outcome.ok,
          requestUrl: res.request.url,
          method: res.request.method,
          statusCode,
          responseHeaders: res.response?.headers ?? {},
          rawBody: res.response?.raw_body ?? null,
          parsedJson: parsedBody,
          rawResponse: parsedBody ?? res.response?.raw_body ?? null,
          ...samplePatch,
          startedAt,
          finishedAt: Date.now(),
          errorCode: outcome.ok ? null : 'http_error',
          errorType: outcome.ok ? null : 'http_error',
          errorMessage: outcome.ok
            ? null
            : statusCode != null && statusCode >= 400
              ? `HTTP ${statusCode} response — sample fetch did not succeed.`
              : 'No response payload returned.',
          targetStatusCode: outcome.ok ? null : statusCode,
          targetResponseBody: outcome.ok ? null : res.response?.raw_body ?? null,
          hint: outcome.ok ? null : 'Fix upstream errors or adjust the request, then retry API Test.',
          apiBacked: true,
          steps: mapApiSteps(res.steps),
          responseSample: parsedBody,
          effectiveHeadersMasked: res.request.headers_masked ?? null,
          actualRequestSent: res.actual_request_sent
            ? {
                method: res.actual_request_sent.method,
                url: res.actual_request_sent.url,
                endpoint: res.actual_request_sent.endpoint ?? null,
                queryParams: res.actual_request_sent.query_params ?? {},
                headersMasked: res.actual_request_sent.headers_masked ?? {},
                jsonBodyMasked: res.actual_request_sent.json_body_masked ?? null,
                timeoutSeconds: res.actual_request_sent.timeout_seconds,
              }
            : null,
          analysis: outcome.ok ? analysisModel : state.apiTest.analysis,
          s3ConnectivityPassed: false,
          remoteProbe: probe,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Remote file sample fetch failed.'
        onChange({
          status: 'error',
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
          startedAt,
          finishedAt: Date.now(),
          errorCode: 'remote_file_fetch_exception',
          errorType: 'remote_file_fetch_exception',
          errorMessage: message,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: null,
          apiBacked: true,
          steps: [],
          responseSample: null,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          analysis: null,
          s3ConnectivityPassed: false,
          remoteProbe: lastProbe,
        })
      } finally {
        setBusy(false)
      }
      return
    }

    if (isDb) {
      setBusy(true)
      const startedAt = Date.now()
      onChange({
        ...state.apiTest,
        status: 'running',
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
        s3ConnectivityPassed: false,
        dbConnectivityPassed: false,
        extractedEvents: [],
        eventCount: 0,
        unionSchema: null,
        analysis: null,
      })
      let probeOk = false
      try {
        const res = await runConnectorAuthTest({
          connector_id: state.connector.connectorId ?? undefined,
          method: 'GET',
          test_path: '/',
        })
        if (!res.ok) {
          onChange({
            status: 'error',
            ok: false,
            requestUrl: null,
            method: 'DATABASE_QUERY',
            statusCode: null,
            responseHeaders: {},
            rawBody: JSON.stringify(res, null, 2),
            parsedJson: null,
            rawResponse: res,
            extractedEvents: [],
            eventCount: 0,
            unionSchema: null,
            startedAt,
            finishedAt: Date.now(),
            errorCode: res.error_type ?? 'database_probe_failed',
            errorType: res.error_type ?? 'database_probe_failed',
            errorMessage: res.message ?? 'Database connectivity probe failed',
            targetStatusCode: null,
            targetResponseBody: null,
            hint: 'Verify host, database name, credentials, and db_type (PostgreSQL).',
            apiBacked: true,
            steps: [],
            responseSample: null,
            effectiveHeadersMasked: null,
            actualRequestSent: null,
            analysis: null,
            s3ConnectivityPassed: false,
            dbConnectivityPassed: false,
          })
          return
        }
        probeOk = true
        const sampleRes = await runHttpApiTest({
          connector_id: state.connector.connectorId ?? undefined,
          source_config: { ...buildSourceConfig(state), ...buildSourceAuthPayload(state) },
          stream_config: buildStreamConfigPayload(state),
          checkpoint: null,
          fetch_sample: true,
        })
        const parsedBody = sampleRes.database_query_sample_rows ?? sampleRes.response?.parsed_json ?? null
        const records = parsedRecordEvents(parsedBody)
        const hasRecords = records.length > 0
        let analysisModel = sampleRes.analysis ? mapApiAnalysis(sampleRes.analysis) : analysisFromParsedRecordArray(parsedBody)
        if (!analysisModel && hasRecords) {
          analysisModel = analysisFromParsedRecordArray(records)
        }
        const samplePatch = buildApiTestSuccessPatch(hasRecords ? parsedBody : [], analysisModel)
        onChange({
          status: sampleRes.ok ? 'success' : 'error',
          ok: Boolean(sampleRes.ok && hasRecords),
          requestUrl: sampleRes.request?.url ?? null,
          method: sampleRes.request?.method ?? 'DATABASE_QUERY',
          statusCode: sampleRes.response?.status_code ?? (sampleRes.ok ? 200 : null),
          responseHeaders: sampleRes.response?.headers ?? {},
          rawBody: sampleRes.response?.raw_body ?? null,
          parsedJson: parsedBody,
          rawResponse: parsedBody ?? sampleRes.response?.raw_body ?? null,
          ...samplePatch,
          startedAt,
          finishedAt: Date.now(),
          errorCode: sampleRes.ok ? (hasRecords ? null : 'no_records') : sampleRes.error_type ?? 'database_query_failed',
          errorType: sampleRes.ok ? (hasRecords ? null : 'no_records') : sampleRes.error_type ?? 'database_query_failed',
          errorMessage: sampleRes.ok
            ? hasRecords
              ? null
              : 'Connection succeeded. Query succeeded. Sample data is not available (no records). Union Schema was not generated.'
            : sampleRes.message ?? 'Database query sample fetch failed',
          targetStatusCode: sampleRes.ok ? null : sampleRes.response?.status_code ?? null,
          targetResponseBody: sampleRes.ok ? null : sampleRes.response?.raw_body ?? null,
          hint: sampleRes.ok
            ? hasRecords
              ? null
              : 'The query ran successfully but returned no rows. Union Schema is generated only from actual sample rows.'
            : 'Verify the SQL query (SELECT-only) and that the connection can read the target tables.',
          apiBacked: true,
          steps: mapApiSteps(sampleRes.steps),
          responseSample: parsedBody,
          effectiveHeadersMasked: sampleRes.request?.headers_masked ?? null,
          actualRequestSent: sampleRes.actual_request_sent
            ? {
                method: sampleRes.actual_request_sent.method,
                url: sampleRes.actual_request_sent.url,
                endpoint: sampleRes.actual_request_sent.endpoint ?? null,
                queryParams: sampleRes.actual_request_sent.query_params ?? {},
                headersMasked: sampleRes.actual_request_sent.headers_masked ?? {},
                jsonBodyMasked: sampleRes.actual_request_sent.json_body_masked ?? null,
                timeoutSeconds: sampleRes.actual_request_sent.timeout_seconds,
              }
            : null,
          analysis: sampleRes.ok ? analysisModel : state.apiTest.analysis,
          s3ConnectivityPassed: false,
          dbConnectivityPassed: probeOk,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Database query sample fetch failed.'
        onChange({
          status: 'error',
          ok: false,
          requestUrl: null,
          method: 'DATABASE_QUERY',
          statusCode: null,
          responseHeaders: {},
          rawBody: null,
          parsedJson: null,
          rawResponse: null,
          extractedEvents: [],
          eventCount: 0,
          unionSchema: null,
          startedAt,
          finishedAt: Date.now(),
          errorCode: probeOk ? 'database_sample_fetch_exception' : 'database_probe_exception',
          errorType: probeOk ? 'database_sample_fetch_exception' : 'database_probe_exception',
          errorMessage: message,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: probeOk
            ? 'Connectivity passed. Fix the SQL query or table access, then retry sample fetch.'
            : 'Verify host, database name, credentials, and db_type (PostgreSQL).',
          apiBacked: true,
          steps: [],
          responseSample: null,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          analysis: null,
          s3ConnectivityPassed: false,
          dbConnectivityPassed: probeOk,
        })
      } finally {
        setBusy(false)
      }
      return
    }

    const syntax = validateJsonBodyForApi(state.stream.requestBody)
    if (syntax.ok === false) {
      const startedAt = Date.now()
      onChange({
        status: 'error',
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
        startedAt,
        finishedAt: startedAt,
        errorCode: 'invalid_json_body',
        errorType: 'invalid_json_body',
        errorMessage: syntax.message,
        targetStatusCode: null,
        targetResponseBody: null,
        hint: 'Fix JSON syntax on the HTTP Request step, then retry.',
        apiBacked: false,
        steps: [],
        responseSample: null,
        effectiveHeadersMasked: null,
        actualRequestSent: null,
        analysis: null,
        s3ConnectivityPassed: false,
      })
      return
    }
    setBusy(true)
    const startedAt = Date.now()
      onChange({
        ...state.apiTest,
        status: 'running',
        ok: false,
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorType: null,
        errorMessage: null,
        targetStatusCode: null,
        targetResponseBody: null,
        hint: null,
      })
    try {
      const res = await runHttpApiTest({
        connector_id: state.connector.connectorId ?? undefined,
        source_config: { ...buildSourceConfig(state), ...buildSourceAuthPayload(state) },
        stream_config: buildStreamConfigPayload(state),
        checkpoint: null,
        fetch_sample: true,
      })
      const parsedBody = res.response?.parsed_json ?? null
      const analysisModel = res.analysis ? mapApiAnalysis(res.analysis) : null
      const statusCode = res.response?.status_code ?? null
      const hasPayload = parsedBody != null || (res.response?.raw_body ?? null) != null
      const outcome = resolveHttpApiTestResult(statusCode, hasPayload)
      const samplePatch = outcome.ok ? buildApiTestSuccessPatch(parsedBody, analysisModel) : buildApiTestSuccessPatch(null, null)
      onChange({
        status: outcome.status,
        ok: outcome.ok,
        requestUrl: res.request.url,
        method: res.request.method,
        statusCode,
        responseHeaders: res.response?.headers ?? {},
        rawBody: res.response?.raw_body ?? null,
        parsedJson: parsedBody,
        rawResponse: parsedBody ?? res.response?.raw_body ?? null,
        ...samplePatch,
        startedAt,
        finishedAt: Date.now(),
        errorCode: outcome.ok ? null : 'http_error',
        errorType: outcome.ok ? null : 'http_error',
        errorMessage: outcome.ok
          ? null
          : statusCode != null && statusCode >= 400
            ? `HTTP ${statusCode} response — sample fetch did not succeed.`
            : 'No response payload returned.',
        targetStatusCode: outcome.ok ? null : statusCode,
        targetResponseBody: outcome.ok ? null : res.response?.raw_body ?? null,
        hint: outcome.ok ? null : 'Fix upstream errors or adjust the request, then retry API Test.',
        apiBacked: true,
        steps: mapApiSteps(res.steps),
        responseSample: parsedBody,
        effectiveHeadersMasked: res.request.headers_masked ?? null,
        actualRequestSent: res.actual_request_sent
          ? {
              method: res.actual_request_sent.method,
              url: res.actual_request_sent.url,
              endpoint: res.actual_request_sent.endpoint ?? null,
              queryParams: res.actual_request_sent.query_params ?? {},
              headersMasked: res.actual_request_sent.headers_masked ?? {},
              jsonBodyMasked: res.actual_request_sent.json_body_masked ?? null,
              timeoutSeconds: res.actual_request_sent.timeout_seconds,
            }
          : null,
        analysis: outcome.ok ? analysisModel : state.apiTest.analysis,
        s3ConnectivityPassed: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'API test failed.'
      type ErrDetail = {
        error_type?: string
        error_code?: string
        message?: string
        target_status_code?: number
        target_response_body?: string
        hint?: string
        json_line?: number
        json_column?: number
        steps?: Array<{ name: string; success: boolean; status_code?: number | null; message?: string }>
        response_sample?: unknown
        effective_request?: { headers?: Record<string, string> }
      }
      let code: string | null = null
      let errorType: string | null = null
      let detail: string = message
      let targetStatusCode: number | null = null
      let targetResponseBody: string | null = null
      let hint: string | null = null
      let errSteps: WizardApiTestStep[] = []
      let responseSample: unknown = null
      let effectiveHeadersMasked: Record<string, string> | null = null
      let actualRequestSent: WizardApiTestState['actualRequestSent'] = null
      try {
        const parsed = JSON.parse(message) as { detail?: ErrDetail }
        const d = parsed.detail
        errorType = d?.error_type ?? null
        detail = d?.message ?? message
        if (d?.json_line != null) {
          detail = `${detail} (line ${d.json_line}${d.json_column != null ? `, column ${d.json_column}` : ''})`
        }
        targetStatusCode = d?.target_status_code ?? null
        targetResponseBody = d?.target_response_body ?? null
        hint = d?.hint ?? null
        code = d?.error_code ?? d?.error_type ?? errorType
        errSteps = mapApiSteps(d?.steps)
        responseSample = d?.response_sample ?? null
        effectiveHeadersMasked = d?.effective_request?.headers ?? null
        const req = (d as { actual_request_sent?: Record<string, unknown> } | undefined)?.actual_request_sent
        if (req && typeof req === 'object') {
          actualRequestSent = {
            method: String(req.method ?? 'GET'),
            url: String(req.url ?? ''),
            endpoint: req.endpoint == null ? null : String(req.endpoint),
            queryParams:
              req.query_params && typeof req.query_params === 'object' && !Array.isArray(req.query_params)
                ? (req.query_params as Record<string, unknown>)
                : {},
            headersMasked:
              req.headers_masked && typeof req.headers_masked === 'object' && !Array.isArray(req.headers_masked)
                ? Object.fromEntries(
                    Object.entries(req.headers_masked as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
                  )
                : {},
            jsonBodyMasked: req.json_body_masked ?? null,
            timeoutSeconds: Number(req.timeout_seconds ?? 0),
          }
        }
      } catch {
        /* leave defaults */
      }
      onChange({
        status: 'error',
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
        startedAt,
        finishedAt: Date.now(),
        errorCode: code,
        errorType,
        errorMessage: detail,
        targetStatusCode,
        targetResponseBody,
        hint,
        apiBacked: true,
        steps: errSteps,
        responseSample,
        effectiveHeadersMasked,
        actualRequestSent,
        analysis: null,
        s3ConnectivityPassed: false,
      })
    } finally {
      setBusy(false)
    }
  }, [busy, canRunLiveApiTest, onChange, state])

  const t = state.apiTest
  const copy = sourcePres.wizardApiTest
  const elapsedMs = t.startedAt && t.finishedAt ? Math.max(0, t.finishedAt - t.startedAt) : null

  return (
    <section
      className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="wizard-run-test-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Run Test</h3>
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{copy.leadParagraph}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || !canRunLiveApiTest}
            title={
              !canRunLiveApiTest
                ? `Select a ${WIZARD_LABEL.sourceConnection.toLowerCase()} and complete the required fields on the Stream Configuration step before running a live preview.`
                : undefined
            }
            className="inline-flex h-8 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
            {busy ? 'Running…' : 'Run Test'}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || !canRunLiveApiTest}
            className="inline-flex h-8 items-center rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
          >
            Retry
          </button>
        </div>
      </div>

      <div className="mt-4">
        {t.status === 'idle' ? (
          <p className="rounded-md border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
            {canRunLiveApiTest
              ? copy.idleReady
              : `Select a ${WIZARD_LABEL.sourceConnection.toLowerCase()} first, then ${copy.idleBlockedTail}.`}
          </p>
        ) : null}
        {t.status === 'running' ? (
          <p className="rounded-md border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-mutedStrong">
            Calling source… this can take a few seconds depending on upstream latency.
          </p>
        ) : null}
        {t.status === 'error' ? (
          <ErrorPanel
            code={t.errorCode}
            errorType={t.errorType}
            message={t.errorMessage ?? 'Unknown error'}
            targetStatusCode={t.targetStatusCode ?? t.statusCode}
            hint={t.hint}
          />
        ) : null}
        {t.status === 'success' ? (
          <div className="space-y-3" data-testid="wizard-run-test-success">
            <SuccessPanel
              apiBacked={t.apiBacked}
              ok={t.ok}
              eventCount={t.eventCount}
              statusCode={t.statusCode}
              elapsedMs={elapsedMs}
            />
            {!t.ok || t.eventCount === 0 ? (
              <p
                data-testid="wizard-run-test-no-records"
                className="rounded-md border border-amber-200/80 bg-amber-500/[0.07] p-3 text-[12px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
              >
                {t.errorMessage ??
                  'Sample data is not available (no records). Union Schema was not generated.'}
              </p>
            ) : null}
            {onAdvanceToRecordSelection ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onAdvanceToRecordSelection}
                  data-testid="wizard-run-test-open-record-selection"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                >
                  Open Record Selection
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function SuccessPanel({
  apiBacked,
  ok,
  eventCount,
  statusCode,
  elapsedMs,
}: {
  apiBacked: boolean
  ok: boolean
  eventCount: number
  statusCode: number | null
  elapsedMs: number | null
}) {
  const statusLabel = ok
    ? apiBacked
      ? 'Success · API-backed'
      : 'Success · local preview'
    : eventCount === 0
      ? 'Connection succeeded · no records'
      : 'Completed with warnings'
  const httpLabel = statusCode != null ? String(statusCode) : '—'

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="wizard-run-test-metrics">
      <Stat
        tone={ok ? 'success' : 'warning'}
        label="Status"
        value={statusLabel}
        icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
      />
      <Stat label="HTTP Status" value={httpLabel} />
      <Stat
        tone={eventCount === 0 ? 'warning' : 'neutral'}
        label="Sample Data"
        value={eventCount === 0 ? 'Not available / no records' : `${eventCount} record(s)`}
      />
      <Stat label="Latency" value={elapsedMs != null ? `${elapsedMs} ms` : '—'} />
    </div>
  )
}

function ErrorPanel({
  code,
  errorType,
  message,
  targetStatusCode,
  hint,
}: {
  code: string | null
  errorType: string | null
  message: string
  targetStatusCode: number | null
  hint: string | null
}) {
  return (
    <div className="space-y-3" data-testid="wizard-run-test-error">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat tone="warning" label="Status" value="Error" icon={<AlertCircle className="h-3.5 w-3.5" aria-hidden />} />
        <Stat label="HTTP Status" value={targetStatusCode != null ? String(targetStatusCode) : '—'} />
        <Stat label="Records Detected" value="0" />
        <Stat label="Latency" value="—" />
      </div>
      <div className="rounded-md border border-red-200/80 bg-red-500/[0.06] p-4 text-[12px] dark:border-red-500/40 dark:bg-red-500/10">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-red-800 dark:text-red-200">{code ?? 'API_TEST_FAILED'}</p>
            <p className="mt-1 break-words text-red-700 dark:text-red-200">{message}</p>
            {errorType && errorType !== code ? (
              <p className="mt-2 text-[11px] text-red-700 dark:text-red-200">Type: {errorType}</p>
            ) : null}
            <p className="mt-2 text-[11px] text-red-600 dark:text-red-300/80">
              {hint ?? 'Check request URL, authentication, headers, and proxy settings.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string
  value: string
  tone?: 'success' | 'warning' | 'neutral'
  icon?: ReactNode
}) {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-200/80 bg-emerald-500/[0.07] text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
      : tone === 'warning'
        ? 'border-amber-200/80 bg-amber-500/[0.07] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
        : 'border-slate-200/80 bg-slate-50/70 text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200'
  return (
    <div className={cn('rounded-md border p-3', toneClass)}>
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-80">
        {icon ?? null}
        {label}
      </p>
      <p className="mt-1 text-[12px] font-semibold">{value}</p>
    </div>
  )
}
