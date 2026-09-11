import { describe, expect, it } from 'vitest'
import {
  buildSourceAuthPayload,
  buildInitialState,
  buildSourceConfig,
  buildStreamConfigPayload,
  buildStreamCreatePayload,
  buildRouteCreatePayloads,
  computeLegacySubstepCompletion,
  WIZARD_STEPS,
  buildWizardFieldMappingsPayload,
  enrichmentDictFromRows,
  fieldMappingsFromRows,
  wizardConnectorPatchFromApi,
  wizardFieldMappingsReady,
} from './wizard-state'
import type { ConnectorRead } from '../../../api/gdcConnectors'

function withConfirmedSample(state: ReturnType<typeof buildInitialState>) {
  const finishedAt = Date.now()
  state.apiTest.ok = true
  state.apiTest.parsedJson = state.apiTest.parsedJson ?? { id: 'evt-1' }
  state.apiTest.finishedAt = finishedAt
  if (!state.stream.checkpointSourcePath.trim()) {
    state.stream.checkpointSourcePath = '$.timestamp'
  }
  state.stream.recordPathConfirmedForApiTestAt = finishedAt
  state.stream.checkpointConfirmedForApiTestAt = finishedAt
  return state
}

describe('wizard-state computeLegacySubstepCompletion', () => {
  it('flags connector step incomplete until connector + source are selected', () => {
    const state = buildInitialState()
    const out = computeLegacySubstepCompletion(state)
    expect(out.connector).toBe('in_progress')
    expect(out.stream).toBe('incomplete')
    expect(out.api_test).toBe('incomplete')
    expect(out.done).toBe('incomplete')
  })

  it('marks connector complete and stream complete with defaults', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    const out = computeLegacySubstepCompletion(state)
    expect(out.connector).toBe('complete')
    expect(out.stream).toBe('complete')
    expect(out.api_test).toBe('in_progress')
  })

  it('marks stream complete for S3 without HTTP endpoint', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    state.stream.name = 'S3 stream'
    state.stream.endpoint = ''
    state.stream.maxObjectsPerRun = 5
    const out = computeLegacySubstepCompletion(state)
    expect(out.stream).toBe('complete')
  })

  it('marks stream incomplete for REMOTE without remote directory', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'REMOTE_FILE_POLLING'
    state.stream.name = 'RF'
    state.stream.remoteDirectory = ''
    expect(computeLegacySubstepCompletion(state).stream).toBe('in_progress')
  })

  it('marks stream complete for REMOTE with remote directory and no HTTP endpoint', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'REMOTE_FILE_POLLING'
    state.stream.name = 'RF'
    state.stream.endpoint = ''
    state.stream.remoteDirectory = '/data'
    expect(computeLegacySubstepCompletion(state).stream).toBe('complete')
  })

  it('requires s3ConnectivityPassed before api_test completes for S3 connectors', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    state.stream.name = 'S3 stream'
    state.stream.maxObjectsPerRun = 5
    state.apiTest.status = 'success'
    state.apiTest.s3ConnectivityPassed = false
    expect(computeLegacySubstepCompletion(state).api_test).toBe('in_progress')
    state.apiTest.s3ConnectivityPassed = true
    expect(computeLegacySubstepCompletion(state).api_test).toBe('complete')
  })

  it('marks stream incomplete for DATABASE_QUERY without SQL query', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.name = 'DB stream'
    state.stream.endpoint = ''
    state.stream.sqlQuery = ''
    expect(computeLegacySubstepCompletion(state).stream).toBe('in_progress')
  })

  it('marks stream complete for DATABASE_QUERY with SQL query and no HTTP endpoint', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.name = 'DB stream'
    state.stream.endpoint = ''
    state.stream.sqlQuery = 'SELECT id, email, created_at FROM users'
    expect(computeLegacySubstepCompletion(state).stream).toBe('complete')
  })

  it('requires dbConnectivityPassed before api_test completes for DATABASE_QUERY connectors', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.name = 'DB stream'
    state.stream.sqlQuery = 'SELECT id FROM users'
    state.apiTest.status = 'success'
    state.apiTest.dbConnectivityPassed = false
    expect(computeLegacySubstepCompletion(state).api_test).toBe('in_progress')
    state.apiTest.dbConnectivityPassed = true
    expect(computeLegacySubstepCompletion(state).api_test).toBe('complete')
  })

  it('requires remoteProbe.ok before api_test completes for REMOTE_FILE_POLLING connectors', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.connector.sourceType = 'REMOTE_FILE_POLLING'
    state.stream.name = 'RF'
    state.stream.remoteDirectory = '/data'
    state.apiTest.status = 'success'
    state.apiTest.eventCount = 1
    state.apiTest.remoteProbe = { ok: false, auth_type: 'REMOTE_FILE_POLLING' }
    expect(computeLegacySubstepCompletion(state).api_test).toBe('in_progress')
    state.apiTest.remoteProbe = { ok: true, auth_type: 'REMOTE_FILE_POLLING' }
    expect(computeLegacySubstepCompletion(state).api_test).toBe('complete')
  })

  it('marks api_test complete after success and preview in_progress until events', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.apiTest.eventCount = 0
    const out = computeLegacySubstepCompletion(state)
    expect(out.api_test).toBe('complete')
    expect(out.preview).toBe('in_progress')
  })

  it('blocks preview completion when analysis.previewError is set', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.apiTest.eventCount = 3
    state.stream.eventArrayPath = '$.items'
    state.apiTest.analysis = {
      responseSummary: {
        root_type: 'null',
        approx_size_bytes: 0,
        top_level_keys: [],
        item_count_root: null,
        truncation: null,
      },
      detectedArrays: [],
      detectedCheckpointCandidates: [],
      sampleEvent: null,
      selectedEventArrayDefault: null,
      flatPreviewFields: [],
      previewError: 'invalid_json_response',
    }
    expect(computeLegacySubstepCompletion(state).preview).toBe('in_progress')
  })

  it('marks mapping complete when full-event JSONata expression is set', () => {
    const state = withConfirmedSample(buildInitialState())
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.apiTest.eventCount = 1
    state.stream.useWholeResponseAsEvent = true
    state.mappingMode = 'full_event_jsonata'
    state.fullEventJsonataExpression = '{ "user": username }'
    expect(computeLegacySubstepCompletion(state).mapping).toBe('complete')
  })

  it('marks mapping complete when transform rules define output fields', () => {
    const state = withConfirmedSample(buildInitialState())
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.apiTest.eventCount = 1
    state.stream.useWholeResponseAsEvent = true
    state.transformRules = [
      {
        id: 'at-1',
        uiMode: 'advanced',
        outputField: 'derived_field',
        mode: 'jsonata',
        expression: '$.message',
        sourcePath: '$.message',
        pattern: '',
        group: 1,
        defaultValue: '',
        ruleId: '',
      },
    ]
    expect(computeLegacySubstepCompletion(state).mapping).toBe('complete')
  })

  it('marks preview complete when user chose whole response as single event', () => {
    const state = withConfirmedSample(buildInitialState())
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.apiTest.eventCount = 1
    state.stream.useWholeResponseAsEvent = true
    state.stream.eventArrayPath = ''
    expect(computeLegacySubstepCompletion(state).preview).toBe('complete')
  })

  it('keeps analysis on apiTest slice for JSON preview persistence', () => {
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.parsedJson = { a: 1 }
    state.apiTest.analysis = {
      responseSummary: {
        root_type: 'object',
        approx_size_bytes: 10,
        top_level_keys: ['a'],
        item_count_root: null,
        truncation: null,
      },
      detectedArrays: [],
      detectedCheckpointCandidates: [],
      sampleEvent: null,
      selectedEventArrayDefault: null,
      flatPreviewFields: [],
      previewError: null,
    }
    expect(state.apiTest.analysis?.responseSummary.top_level_keys).toContain('a')
  })

  it('keeps connector incomplete without catalog selection', () => {
    const state = buildInitialState()
    const out = computeLegacySubstepCompletion(state)
    expect(out.connector).toBe('in_progress')
  })

  it('marks done as complete only after stream creation outcome.streamId', () => {
    const state = withConfirmedSample(buildInitialState())
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.apiTest.eventCount = 1
    state.stream.useWholeResponseAsEvent = true
    state.mapping = [{ id: 'm1', outputField: 'event_id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      { key: 't1', destinationId: 1, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]
    state.outcome = {
      streamId: 7,
      routeId: 5,
      routeIds: [5],
      mappingSaved: true,
      enrichmentSaved: false,
      dataProtectionSaved: false,
      governanceSaved: false,
      schemaDriftPolicySaved: false,
      schemaDriftPolicyWarnings: [],
      dataProtectionEnforcementIncomplete: false,
      dataProtectionWarnings: [],
      errors: [],
      apiBacked: true,
      createdAt: null,
      materializedStreamIds: [],
    }
    expect(computeLegacySubstepCompletion(state).done).toBe('complete')
  })

  it('keeps done incomplete when mapping/destination are missing', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.outcome = {
      streamId: 9,
      routeId: null,
      mappingSaved: false,
      enrichmentSaved: false,
      errors: [],
      apiBacked: true,
    }
    const out = computeLegacySubstepCompletion(state)
    expect(out.api_test).toBe('complete')
    expect(out.done).toBe('incomplete')
  })

  it('keeps done incomplete when outcome.streamId is null', () => {
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.mapping = [{ id: 'm1', outputField: 'event_id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      { key: 't1', destinationId: 1, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]
    state.outcome = {
      streamId: null,
      routeId: 3,
      mappingSaved: true,
      enrichmentSaved: true,
      errors: [],
      apiBacked: true,
    }
    expect(computeLegacySubstepCompletion(state).done).toBe('incomplete')
  })
})

describe('wizard-state buildStreamConfigPayload', () => {
  it('serializes headers/params and includes event_array_path when provided', () => {
    const state = buildInitialState()
    state.stream.headers = [
      { id: 'h1', key: 'Authorization', value: 'Bearer X' },
      { id: 'h2', key: '', value: 'ignored' },
    ]
    state.stream.params = [{ id: 'p1', key: 'limit', value: '50' }]
    state.stream.eventArrayPath = '$.items'
    state.stream.eventRootPath = '$.payload'
    const payload = buildStreamConfigPayload(state) as Record<string, unknown>
    expect(payload.headers).toEqual({ Authorization: 'Bearer X' })
    expect(payload.params).toEqual({ limit: '50' })
    expect(payload.method).toBe('GET')
    expect(payload.event_array_path).toBe('$.items')
    expect(payload.event_root_path).toBe('$.payload')
  })

  it('serializes S3 max_objects_per_run without HTTP endpoint fields', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    state.stream.maxObjectsPerRun = 12
    state.stream.endpoint = '/v1/events'
    const payload = buildStreamConfigPayload(state) as Record<string, unknown>
    expect(payload).toEqual({ max_objects_per_run: 12 })
  })

  it('serializes DATABASE_QUERY query without HTTP endpoint fields', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.sqlQuery = 'SELECT id, email, created_at FROM users'
    state.stream.timeoutSec = 20
    state.stream.endpoint = '/v1/events'
    const payload = buildStreamConfigPayload(state) as Record<string, unknown>
    expect(payload).toEqual({
      query: 'SELECT id, email, created_at FROM users',
      query_timeout_seconds: 20,
    })
  })

  it('omits event_array_path when useWholeResponseAsEvent is true', () => {
    const state = buildInitialState()
    state.stream.eventArrayPath = '$.items'
    state.stream.useWholeResponseAsEvent = true
    const payload = buildStreamConfigPayload(state) as Record<string, unknown>
    expect(payload).not.toHaveProperty('event_array_path')
  })
})

describe('wizard-state buildStreamCreatePayload', () => {
  it('returns null when connector or source is missing', () => {
    const state = buildInitialState()
    expect(buildStreamCreatePayload(state)).toBeNull()
  })

  it('returns DATABASE_QUERY stream_type and query stream_config when connector is DATABASE_QUERY', () => {
    const state = buildInitialState()
    state.connector.connectorId = 11
    state.connector.sourceId = 22
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.name = 'DB stream'
    state.stream.sqlQuery = 'SELECT id, email FROM users'
    state.stream.timeoutSec = 15
    const payload = buildStreamCreatePayload(state)
    expect(payload?.stream_type).toBe('DATABASE_QUERY')
    expect(payload?.config_json).toMatchObject({
      query: 'SELECT id, email FROM users',
      query_timeout_seconds: 15,
    })
    expect(payload?.config_json).not.toHaveProperty('endpoint')
    expect(payload?.config_json).not.toHaveProperty('method')
  })

  it('returns REMOTE_FILE_POLLING stream_type and remote stream_config when connector is REMOTE_FILE_POLLING', () => {
    const state = buildInitialState()
    state.connector.connectorId = 11
    state.connector.sourceId = 22
    state.connector.sourceType = 'REMOTE_FILE_POLLING'
    state.stream.name = 'RF stream'
    state.stream.remoteDirectory = '/data/logs'
    state.stream.filePattern = '*.ndjson'
    state.stream.parserType = 'NDJSON'
    state.stream.maxFilesPerRun = 3
    state.stream.maxFileSizeMb = 2
    const payload = buildStreamCreatePayload(state)
    expect(payload?.stream_type).toBe('REMOTE_FILE_POLLING')
    expect(payload?.config_json).toMatchObject({
      remote_directory: '/data/logs',
      file_pattern: '*.ndjson',
      parser_type: 'NDJSON',
      max_files_per_run: 3,
      max_file_size_mb: 2,
    })
  })
})

describe('wizardConnectorPatchFromApi', () => {
  it('maps DATABASE_QUERY source type instead of falling back to HTTP', () => {
    const row = {
      id: 9,
      name: 'Orders DB',
      description: null,
      status: 'active',
      connector_type: 'relational_database',
      source_type: 'DATABASE_QUERY',
      source_id: 3,
      stream_count: 0,
      host: 'db.internal',
      base_url: null,
      verify_ssl: true,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: {},
    } as ConnectorRead
    expect(wizardConnectorPatchFromApi(row).sourceType).toBe('DATABASE_QUERY')
  })
})

describe('wizard-state buildSourceConfig', () => {
  it('captures base_url and timeout_seconds', () => {
    const state = buildInitialState()
    state.connector.hostBaseUrl = '  https://api.foo.com  '
    state.stream.timeoutSec = 45
    expect(buildSourceConfig(state)).toMatchObject({ base_url: 'https://api.foo.com', timeout_seconds: 45 })
  })

  it('starts with no default query parameter rows', () => {
    const state = buildInitialState()
    expect(state.stream.params).toEqual([])
  })

  it('starts with empty additional stream headers (connector may supply Accept / Content-Type)', () => {
    const state = buildInitialState()
    expect(state.stream.headers.length).toBe(0)
  })

  it('keeps connector config separated from stream request payload', () => {
    const state = buildInitialState()
    state.connector.hostBaseUrl = 'https://api.example.com'
    state.connector.authType = 'BEARER'
    state.connector.bearerToken = 'secret-token'
    const sourceConfig = buildSourceConfig(state) as Record<string, unknown>
    const sourceAuth = buildSourceAuthPayload(state) as Record<string, unknown>
    const streamConfig = buildStreamConfigPayload(state) as Record<string, unknown>
    expect(sourceConfig.base_url).toBeTruthy()
    expect(sourceConfig).not.toHaveProperty('endpoint')
    expect(streamConfig.endpoint).toBeTruthy()
    expect(streamConfig).not.toHaveProperty('base_url')
    expect(sourceAuth.auth_type).toBe('BEARER')
  })
})

describe('wizard-state mapping/enrichment helpers', () => {
  it('builds full-event JSONata field_mappings payload', () => {
    const state = buildInitialState()
    state.mappingMode = 'full_event_jsonata'
    state.fullEventJsonataExpression = '{ "user": username }'
    expect(buildWizardFieldMappingsPayload(state)).toEqual({
      mapping_mode: 'full_event_jsonata',
      jsonata_expression: '{ "user": username }',
    })
    expect(wizardFieldMappingsReady(state)).toBe(true)
  })

  it('builds full-event regex field_mappings payload', () => {
    const state = buildInitialState()
    state.mappingMode = 'full_event_regex'
    state.fullEventRegexConfigJson = JSON.stringify({
      preserve_source: false,
      rules: [
        {
          output_field: 'user',
          source_path: '$.username',
          pattern: '^(.+)$',
          group: 1,
        },
      ],
    })
    const payload = buildWizardFieldMappingsPayload(state)
    expect(payload.mapping_mode).toBe('full_event_regex')
    expect(payload.preserve_source_fields).toBe(false)
    expect(Array.isArray(payload.regex_rules)).toBe(true)
    expect(wizardFieldMappingsReady(state)).toBe(true)
  })

  it('skips empty mapping rows', () => {
    expect(
      fieldMappingsFromRows([
        { id: '1', outputField: 'event_id', sourceJsonPath: '$.id' },
        { id: '2', outputField: '', sourceJsonPath: '$.skipped' },
        { id: '3', outputField: 'severity', sourceJsonPath: '   ' },
      ]),
    ).toEqual({ event_id: '$.id' })
  })

  it('skips empty enrichment rows', () => {
    expect(
      enrichmentDictFromRows([
        {
          id: '1',
          label: 'Tenant',
          fieldName: 'tenant',
          type: 'static',
          enabled: true,
          staticValue: 'acme',
          expression: '',
          lookupTable: 'aws-regions',
          lookupKeyField: '',
          conditions: [],
          conditionalDefault: '',
          normalizeSourceField: '',
          normalizeFormat: 'iso8601',
        },
        {
          id: '2',
          label: 'Empty',
          fieldName: '   ',
          type: 'static',
          enabled: true,
          staticValue: 'ignored',
          expression: '',
          lookupTable: 'aws-regions',
          lookupKeyField: '',
          conditions: [],
          conditionalDefault: '',
          normalizeSourceField: '',
          normalizeFormat: 'iso8601',
        },
      ]),
    ).toEqual({ tenant: 'acme' })
  })

  it('serializes advanced enrichment rules under __rules', () => {
    const out = enrichmentDictFromRows([
      {
        id: 'c1',
        label: 'Severity',
        fieldName: 'metadata.severity',
        type: 'calculated',
        enabled: true,
        staticValue: '',
        expression: 'eventName.includes("Delete") ? 8 : 3',
        lookupTable: 'aws-regions',
        lookupKeyField: '',
        conditions: [],
        conditionalDefault: '',
        normalizeSourceField: '',
        normalizeFormat: 'iso8601',
      },
    ])
    expect(out.__rules).toBeDefined()
    expect((out.__rules as Record<string, unknown>)['metadata.severity']).toMatchObject({
      type: 'calculated',
    })
  })
})

describe('wizard-state WIZARD_STEPS', () => {
  it('exposes 5 v5.2 visible stepper keys', () => {
    expect(WIZARD_STEPS.map((s) => s.key)).toEqual([
      'connect',
      'sample',
      'destinations',
      'route_processing',
      'deploy',
    ])
  })
})

describe('wizard-state buildRouteCreatePayloads', () => {
  it('builds one route payload per route draft', () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      { key: 'a', destinationId: 11, enabled: true, failurePolicy: 'RETRY_AND_BACKOFF', rateLimitJson: {} },
      { key: 'b', destinationId: 22, enabled: true, failurePolicy: 'RETRY_AND_BACKOFF', rateLimitJson: {} },
    ]
    state.destinations.destinationKindsById = { 11: 'SYSLOG_UDP', 22: 'WEBHOOK_POST' }
    const out = buildRouteCreatePayloads(7, state.destinations)
    expect(out).toEqual([
      {
        stream_id: 7,
        destination_id: 11,
        enabled: true,
        failure_policy: 'RETRY_AND_BACKOFF',
        formatter_config_json: {
          message_prefix_enabled: true,
          message_prefix_template: '<134> gdc generic-connector event:',
        },
        status: 'ENABLED',
        rate_limit_json: {},
      },
      {
        stream_id: 7,
        destination_id: 22,
        enabled: true,
        failure_policy: 'RETRY_AND_BACKOFF',
        formatter_config_json: {
          message_prefix_enabled: false,
          message_prefix_template: '<134> gdc generic-connector event:',
        },
        status: 'ENABLED',
        rate_limit_json: {},
      },
    ])
  })
})
