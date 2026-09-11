import { describe, expect, it } from 'vitest'
import {
  computeDeployReadiness,
  buildRouteProcessingSummary,
  computeRouteDeployReadiness,
  routeProcessingStatusToDeployMode,
} from './wizard-deploy-readiness'
import { buildInitialState } from './wizard-state'

function readyState() {
  const state = buildInitialState()
  const finishedAt = Date.now()
  state.connector.connectorId = 1
  state.connector.sourceId = 1
  state.connector.connectorName = 'Test Connector'
  state.stream.name = 'Test Stream'
  state.stream.endpoint = '/events'
  state.stream.eventArrayPath = '$.events'
  state.stream.checkpointSourcePath = '$.timestamp'
  state.stream.checkpointFieldType = 'datetime'
  state.stream.recordPathConfirmedForApiTestAt = finishedAt
  state.stream.checkpointConfirmedForApiTestAt = finishedAt
  state.apiTest.status = 'success'
  state.apiTest.ok = true
  state.apiTest.statusCode = 200
  state.apiTest.parsedJson = { events: [{ id: '1' }] }
  state.apiTest.finishedAt = finishedAt
  state.apiTest.eventCount = 20
  state.apiTest.unionSchema = {
    total_events: 20,
    fields: [{ field_path: '$.id', field_type: 'string', occurrence_count: 20, sample_values: ['1'] }],
  }
  state.apiTest.extractedEvents = [{ id: '1' }]
  state.mapping = [{ id: 'm1', outputField: 'event_id', sourceJsonPath: '$.id' }]
  state.destinations.routeDrafts = [
    {
      key: 'r1',
      destinationId: 10,
      enabled: true,
      failurePolicy: 'RETRY_THEN_DLQ',
      rateLimitJson: '{}',
    },
  ]
  return state
}

describe('computeDeployReadiness', () => {
  it('returns READY when all checklist categories pass', () => {
    const snapshot = computeDeployReadiness(readyState(), { ok: true, failed: false, unknown: false })
    expect(snapshot.status).toBe('ready')
    expect(snapshot.statusLabel).toBe('READY')
    expect(snapshot.canCreate).toBe(true)
    expect(snapshot.categories.map((c) => c.key)).toEqual([
      'connection',
      'data',
      'records',
      'transform',
      'protection',
      'route_processing',
      'delivery',
    ])
    expect(snapshot.categories.every((c) => c.tone === 'ok')).toBe(true)
  })

  it('buildRouteProcessingSummary reports shared defaults and override counts', () => {
    const state = readyState()
    expect(buildRouteProcessingSummary(state)).toEqual({
      enabledRoutes: 1,
      totalRoutes: 1,
      transformLabel: 'Shared default',
      protectionLabel: 'Shared default',
      overrideRouteCount: 0,
      overrideCounts: {
        transform: 0,
        protection: 0,
        classification: 0,
        policy: 0,
      },
      projectedCounts: {
        transform: { override: 0, mixed: 0 },
        protection: { override: 0, mixed: 0 },
        classification: { override: 0, mixed: 0 },
        policy: { override: 0, mixed: 0 },
      },
    })
  })

  it('buildRouteProcessingSummary splits override and mixed projected counts', () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: false, protection: true, classification: true, policy: false },
    }
    const summary = buildRouteProcessingSummary(state)
    expect(summary.projectedCounts.transform).toEqual({ override: 1, mixed: 0 })
    expect(summary.projectedCounts.policy).toEqual({ override: 1, mixed: 0 })
    expect(summary.overrideCounts).toEqual({
      transform: 1,
      protection: 0,
      classification: 0,
      policy: 1,
    })
    expect(summary.overrideRouteCount).toBe(1)
    expect(summary.transformLabel).toBe('Override: 1')
  })

  it('returns NEEDS ATTENTION when required steps are incomplete', () => {
    const state = buildInitialState()
    const snapshot = computeDeployReadiness(state)
    expect(snapshot.status).toBe('needs_attention')
    expect(snapshot.statusLabel).toBe('NEEDS ATTENTION')
    expect(snapshot.canCreate).toBe(false)
    expect(snapshot.categories.some((c) => c.tone === 'err')).toBe(true)
  })

  it('returns ok protection tone when field-level protection is configured', () => {
    const state = readyState()
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' } }]
    state.mapping = [{ id: 'm1', outputField: 'email', sourceJsonPath: '$.user.email' }]
    state.dataProtection.intents = [
      {
        key: 'dp1',
        detectedField: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
      },
    ]
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: false })
    expect(snapshot.categories.find((c) => c.key === 'protection')?.tone).toBe('ok')
    expect(snapshot.canCreate).toBe(true)
  })

  it('returns NEEDS ATTENTION when delivery paths are disabled', () => {
    const state = readyState()
    state.destinations.routeDrafts[0]!.enabled = false
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: true })
    expect(snapshot.status).toBe('needs_attention')
    expect(snapshot.canCreate).toBe(false)
    expect(snapshot.categories.find((c) => c.key === 'delivery')?.tone).toBe('err')
  })

  it('returns NEEDS ATTENTION when sync position is missing', () => {
    const state = readyState()
    state.stream.checkpointSourcePath = ''
    state.stream.checkpointConfirmedForApiTestAt = null
    const snapshot = computeDeployReadiness(state)
    expect(snapshot.status).toBe('needs_attention')
    expect(snapshot.canCreate).toBe(false)
    expect(snapshot.categories.find((c) => c.key === 'records')?.tone).toBe('err')
  })

  it('blocks DATABASE_QUERY deploy when query sample has no records', () => {
    const state = readyState()
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.sqlQuery = 'SELECT id, email, created_at FROM users'
    state.stream.endpoint = ''
    state.apiTest.ok = false
    state.apiTest.eventCount = 0
    state.apiTest.extractedEvents = []
    state.apiTest.parsedJson = []
    state.apiTest.unionSchema = null
    state.apiTest.dbConnectivityPassed = true
    state.apiTest.errorMessage =
      'Connection succeeded. Query succeeded. Sample data is not available (no records). Union Schema was not generated.'
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: false })
    const data = snapshot.categories.find((c) => c.key === 'data')
    expect(data?.tone).toBe('err')
    expect(data?.summary).toMatch(/no records/i)
    expect(snapshot.canCreate).toBe(false)
  })

  it('returns NEEDS ATTENTION when sample fetch has no records', () => {
    const state = readyState()
    state.apiTest.ok = false
    state.apiTest.eventCount = 0
    state.apiTest.extractedEvents = []
    state.apiTest.parsedJson = []
    state.apiTest.unionSchema = null
    state.apiTest.errorMessage =
      'Connection succeeded. Sample data is not available (no records). Union Schema was not generated.'
    const snapshot = computeDeployReadiness(state)
    const data = snapshot.categories.find((c) => c.key === 'data')
    expect(data?.tone).toBe('err')
    expect(data?.summary).toMatch(/no records/i)
    expect(snapshot.canCreate).toBe(false)
    expect(snapshot.status).toBe('needs_attention')
  })

  it('returns NEEDS ATTENTION when latest API test failed', () => {
    const state = readyState()
    state.apiTest.status = 'error'
    state.apiTest.ok = false
    const snapshot = computeDeployReadiness(state)
    expect(snapshot.canCreate).toBe(false)
    expect(snapshot.categories.find((c) => c.key === 'data')?.tone).toBe('err')
  })

  it('shows needs-attention sample policy on data when sample_count < 10 without blocking deploy', () => {
    const state = readyState()
    state.apiTest.eventCount = 3
    state.apiTest.unionSchema = {
      total_events: 3,
      fields: [{ field_path: '$.id', field_type: 'string', occurrence_count: 3, sample_values: ['1'] }],
    }
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: false })
    const data = snapshot.categories.find((c) => c.key === 'data')
    expect(data?.tone).toBe('warn')
    expect(data?.detail).toContain('fewer than 10 events')
    expect(snapshot.canCreate).toBe(true)
    expect(snapshot.status).toBe('ready_with_warnings')
  })

  it('shows recommended sample warning on data when sample_count is 10–19', () => {
    const state = readyState()
    state.apiTest.eventCount = 15
    state.apiTest.unionSchema = {
      total_events: 15,
      fields: [{ field_path: '$.id', field_type: 'string', occurrence_count: 15, sample_values: ['1'] }],
    }
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: false })
    const data = snapshot.categories.find((c) => c.key === 'data')
    expect(data?.tone).toBe('warn')
    expect(data?.detail).toContain('fewer than 20 events')
    expect(snapshot.canCreate).toBe(true)
    expect(snapshot.status).toBe('ready_with_warnings')
  })
})

describe('computeRouteDeployReadiness', () => {
  const destinations = [
    { id: 10, name: 'MSS Syslog', last_connectivity_test_success: true },
    { id: 11, name: 'Stellar Cyber', last_connectivity_test_success: true },
    { id: 12, name: 'Data Lake', last_connectivity_test_success: true },
  ]

  function multiRouteState() {
    const state = readyState()
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'RETRY_THEN_DLQ',
        rateLimitJson: '{}',
      },
      {
        key: 'r2',
        destinationId: 11,
        enabled: true,
        failurePolicy: 'RETRY_THEN_DLQ',
        rateLimitJson: '{}',
        inherit: { transform: false, protection: true, classification: true, policy: true },
      },
      {
        key: 'r3',
        destinationId: 12,
        enabled: true,
        failurePolicy: 'RETRY_THEN_DLQ',
        rateLimitJson: '{}',
      },
    ]
    return state
  }

  it('computes ready, warning, and error route counts', () => {
    const state = multiRouteState()
    const snapshot = computeRouteDeployReadiness(state, destinations)
    expect(snapshot.totalRoutes).toBe(3)
    expect(snapshot.readyCount).toBe(3)
    expect(snapshot.warningCount).toBe(0)
    expect(snapshot.errorCount).toBe(0)
    expect(snapshot.routes.map((route) => route.label)).toEqual(['MSS Syslog', 'Stellar Cyber', 'Data Lake'])
  })

  it('marks enabled routes without destinations as error', () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      destinationId: 0,
    }
    const snapshot = computeRouteDeployReadiness(state, destinations)
    expect(snapshot.errorCount).toBe(1)
    expect(snapshot.routes[0]?.status).toBe('error')
    expect(snapshot.routes[0]?.errorReasons).toContain('No destination configured')
  })

  it('lists override routes with projected concern summaries', () => {
    const state = multiRouteState()
    const snapshot = computeRouteDeployReadiness(state, destinations)
    expect(snapshot.overrideRoutes).toEqual([
      {
        routeKey: 'r2',
        label: 'Stellar Cyber',
        concerns: [
          {
            concern: 'transform',
            status: 'Overridden',
            persistKind: 'route_transform',
          },
        ],
      },
    ])
    expect(snapshot.routes[1]?.processing.transform).toBe('Overridden')
    expect(snapshot.routes[1]?.intentOnlyConcerns).not.toContain('transform')
  })

  it('reports shared processing applied to all routes', () => {
    const state = multiRouteState()
    const snapshot = computeRouteDeployReadiness(state, destinations)
    expect(snapshot.sharedProcessing.appliedToRouteCount).toBe(3)
    expect(snapshot.sharedProcessing.concerns).toContain('transform')
    expect(snapshot.sharedProcessing.concerns).toContain('policy')
  })

  it('preserves Mixed on route health processing projection', () => {
    const state = multiRouteState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        routeDraftKey: 'r2',
        fieldPath: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    state.destinations.routeDrafts[1] = {
      ...state.destinations.routeDrafts[1]!,
      inherit: { transform: false, protection: false, classification: true, policy: true },
    }
    const snapshot = computeRouteDeployReadiness(state, destinations)
    const route = snapshot.routes.find((r) => r.routeKey === 'r2')
    expect(route?.processing.protection).toBe('Mixed')
    expect(route?.processing.transform).toBe('Overridden')
  })

  it('maps inherited processing to shared via deprecated deploy mode helper', () => {
    expect(routeProcessingStatusToDeployMode('Inherited')).toBe('shared')
    expect(routeProcessingStatusToDeployMode('Overridden')).toBe('override')
    expect(routeProcessingStatusToDeployMode('Mixed')).toBe('override')
  })

  it('blocks deploy when protection override has no persistable payload', () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: true, protection: false, classification: true, policy: true },
    }
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: false })
    expect(snapshot.canCreate).toBe(false)
    expect(snapshot.status).toBe('needs_attention')
    expect(snapshot.categories.find((c) => c.key === 'route_processing')?.tone).toBe('err')
    const routeHealth = computeRouteDeployReadiness(state, destinations)
    expect(routeHealth.routes[0]?.intentOnlyConcerns).toContain('protection')
    expect(routeHealth.routes[0]?.status).toBe('error')
  })

  it('blocks deploy when classification override has no persistable payload', () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: true, protection: true, classification: false, policy: true },
    }
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: false })
    expect(snapshot.canCreate).toBe(false)
    const routeHealth = computeRouteDeployReadiness(state, destinations)
    expect(routeHealth.routes[0]?.intentOnlyConcerns).toContain('classification')
    expect(routeHealth.routes[0]?.status).toBe('error')
  })

  it('allows deploy when protection override has route intents', () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: true, protection: false, classification: true, policy: true },
      overrides: {
        protection: {
          intents: [
            {
              key: 'i1',
              detectedField: '$.email',
              protectionAction: 'mask_full',
              deliveryBehavior: 'continue',
            },
          ],
          unknownNormalFieldPolicy: 'pass_through',
          unknownSensitiveFieldPolicy: 'auto_protect',
        },
      },
    }
    const snapshot = computeDeployReadiness(state, { ok: true, failed: false, unknown: false })
    expect(snapshot.canCreate).toBe(true)
    const routeHealth = computeRouteDeployReadiness(state, destinations)
    expect(routeHealth.routes[0]?.intentOnlyConcerns).not.toContain('protection')
    expect(routeHealth.routes[0]?.status).toBe('ready')
  })
})
