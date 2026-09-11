import { describe, expect, it } from 'vitest'
import {
  applyGovernanceRouteOverridesToWizard,
  buildWizardDestinationsFromRouteSources,
  fullEventJsonataExpressionFromFieldMappings,
  governanceRouteOverridesFromStreamConfig,
  preserveWizardRouteProcessingDrafts,
  streamConfigPatchFromRead,
} from './wizard-stream-hydrate'
import type { StreamRead } from '../../../api/types/gdcApi'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'
import type { MappingUIConfigRouteItem } from '../../../api/types/gdcApi'
import type { RouteRead } from '../../../api/gdcRoutes'

describe('streamConfigPatchFromRead DATABASE_QUERY', () => {
  it('hydrates sqlQuery and query timeout from persisted stream_config.query', () => {
    const found = {
      id: 8,
      name: 'Orders DB stream',
      polling_interval: 90,
      config_json: {
        query: 'SELECT id, email, created_at FROM users',
        query_timeout_seconds: 25,
      },
      rate_limit_json: { per_minute: 30, burst: 5 },
    } as StreamRead
    const patch = streamConfigPatchFromRead(found, null)
    expect(patch.sqlQuery).toBe('SELECT id, email, created_at FROM users')
    expect(patch.timeoutSec).toBe(25)
    expect(patch.name).toBe('Orders DB stream')
    expect(patch.pollingIntervalSec).toBe(90)
  })
})

describe('fullEventJsonataExpressionFromFieldMappings', () => {
  it('reads jsonata_expression for full_event_jsonata mappings', () => {
    expect(
      fullEventJsonataExpressionFromFieldMappings({
        mapping_mode: 'full_event_jsonata',
        jsonata_expression: '$merge([$, { "host": hostname }])',
      }),
    ).toBe('$merge([$, { "host": hostname }])')
  })

  it('falls back to legacy expression key when jsonata_expression is absent', () => {
    expect(
      fullEventJsonataExpressionFromFieldMappings({
        mapping_mode: 'full_event_jsonata',
        expression: '{ "id": id }',
      }),
    ).toBe('{ "id": id }')
  })

  it('returns empty string for non-jsonata mapping modes', () => {
    expect(
      fullEventJsonataExpressionFromFieldMappings({
        mapping_mode: 'basic_jsonpath',
        jsonata_expression: 'ignored',
      }),
    ).toBe('')
  })
})

describe('buildWizardDestinationsFromRouteSources', () => {
  it('prefers mapping-ui routes when both sources include the same route', () => {
    const mappingRoutes: MappingUIConfigRouteItem[] = [
      {
        route_id: 42,
        destination_id: 7,
        destination_name: 'Webhook A',
        destination_type: 'WEBHOOK_POST',
        route_enabled: true,
        destination_enabled: true,
        formatter_config: { message_prefix_enabled: true, message_prefix_template: 'custom-prefix' },
        route_rate_limit: { per_minute: 30 },
        failure_policy: 'RETRY_AND_BACKOFF',
      },
    ]
    const catalogRoutes: RouteRead[] = [
      {
        id: 42,
        stream_id: 10,
        destination_id: 7,
        enabled: false,
        failure_policy: 'LOG_AND_CONTINUE',
      },
    ]

    const result = buildWizardDestinationsFromRouteSources(mappingRoutes, catalogRoutes, [
      { id: 7, destination_type: 'WEBHOOK_POST' },
    ])

    expect(result.routeDrafts).toHaveLength(1)
    expect(result.routeDrafts[0]).toMatchObject({
      key: 'route-42',
      destinationId: 7,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
    })
    expect(result.messagePrefixTemplate).toBe('custom-prefix')
  })

  it('falls back to catalog routes when mapping-ui routes are empty', () => {
    const catalogRoutes: RouteRead[] = [
      {
        id: 99,
        stream_id: 10,
        destination_id: 3,
        enabled: true,
        failure_policy: 'LOG_AND_CONTINUE',
        formatter_config_json: {
          message_prefix_enabled: false,
          message_prefix_template: 'from-catalog',
        },
      },
    ]

    const result = buildWizardDestinationsFromRouteSources([], catalogRoutes, [
      { id: 3, destination_type: 'SYSLOG_UDP' },
    ])

    expect(result.routeDrafts).toEqual([
      expect.objectContaining({
        key: 'route-99',
        destinationId: 3,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
      }),
    ])
    expect(result.destinationKindsById[3]).toBe('SYSLOG_UDP')
    expect(result.messagePrefixEnabledByDestinationId[3]).toBe(false)
    expect(result.messagePrefixTemplate).toBe('from-catalog')
  })

  it('merges mapping-ui and catalog-only routes without duplicates', () => {
    const mappingRoutes: MappingUIConfigRouteItem[] = [
      {
        route_id: 1,
        destination_id: 5,
        destination_name: 'A',
        destination_type: 'WEBHOOK_POST',
        route_enabled: true,
        destination_enabled: true,
        formatter_config: {},
        route_rate_limit: {},
        failure_policy: 'LOG_AND_CONTINUE',
      },
    ]
    const catalogRoutes: RouteRead[] = [
      { id: 1, stream_id: 10, destination_id: 5, enabled: true },
      { id: 2, stream_id: 10, destination_id: 6, enabled: true, failure_policy: 'DISABLE_ROUTE_ON_FAILURE' },
    ]

    const result = buildWizardDestinationsFromRouteSources(mappingRoutes, catalogRoutes, [
      { id: 5, destination_type: 'WEBHOOK_POST' },
      { id: 6, destination_type: 'SYSLOG_TCP' },
    ])

    expect(result.routeDrafts.map((draft) => draft.key)).toEqual(['route-1', 'route-2'])
    expect(result.routeDrafts[1]?.failurePolicy).toBe('DISABLE_ROUTE_ON_FAILURE')
  })
})

describe('applyGovernanceRouteOverridesToWizard', () => {
  it('reads route_overrides from stream config_json.governance', () => {
    expect(
      governanceRouteOverridesFromStreamConfig({
        governance: {
          route_overrides: [
            { route_id: 42, classification_level: 'RESTRICTED', delivery_behavior: 'quarantine', enabled: true },
          ],
        },
      }),
    ).toEqual([
      { route_id: 42, classification_level: 'RESTRICTED', delivery_behavior: 'quarantine', enabled: true },
    ])
  })

  it('restores policy-only override without marking classification overridden', () => {
    const destinations = buildWizardDestinationsFromRouteSources(
      [],
      [{ id: 42, stream_id: 10, destination_id: 5, enabled: true, failure_policy: 'LOG_AND_CONTINUE' }],
      [{ id: 5, destination_type: 'WEBHOOK_POST' }],
    )
    const applied = applyGovernanceRouteOverridesToWizard(destinations, buildInitialState().dataProtection, [
      { route_id: 42, delivery_behavior: 'quarantine', enabled: true },
    ])
    const route = applied.destinations.routeDrafts.find((d) => d.key === 'route-42')
    expect(route?.inherit).toMatchObject({ classification: true, policy: false, protection: true })
    expect(route?.overrides?.policy?.deliveryBehavior).toBe('quarantine')
    expect(applied.dataProtection.routeClassificationOverrides).toEqual([])
  })

  it('restores classification floor and policy override onto matching route drafts', () => {
    const destinations = buildWizardDestinationsFromRouteSources(
      [],
      [
        { id: 42, stream_id: 10, destination_id: 5, enabled: true, failure_policy: 'LOG_AND_CONTINUE' },
        { id: 43, stream_id: 10, destination_id: 6, enabled: true, failure_policy: 'LOG_AND_CONTINUE' },
      ],
      [
        { id: 5, destination_type: 'WEBHOOK_POST' },
        { id: 6, destination_type: 'SYSLOG_UDP' },
      ],
    )
    const applied = applyGovernanceRouteOverridesToWizard(destinations, buildInitialState().dataProtection, [
      {
        route_id: 42,
        classification_level: 'RESTRICTED',
        delivery_behavior: 'quarantine',
        enabled: true,
      },
    ])
    const routeA = applied.destinations.routeDrafts.find((d) => d.key === 'route-42')
    const routeB = applied.destinations.routeDrafts.find((d) => d.key === 'route-43')
    expect(routeA?.inherit).toMatchObject({ classification: false, policy: false })
    expect(routeA?.overrides?.policy?.deliveryBehavior).toBe('quarantine')
    expect(routeB?.inherit).toEqual(DEFAULT_ROUTE_PROCESSING_INHERIT)
    expect(applied.dataProtection.routeClassificationOverrides).toEqual([
      expect.objectContaining({
        routeDraftKey: 'route-42',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      }),
    ])
  })

  it('preserves inherit and policy override when destination rows refresh', () => {
    const prior = buildWizardDestinationsFromRouteSources(
      [],
      [{ id: 42, stream_id: 10, destination_id: 5, enabled: true }],
      [{ id: 5, destination_type: 'WEBHOOK_POST' }],
    )
    prior.routeDrafts[0] = {
      ...prior.routeDrafts[0]!,
      inherit: { transform: true, protection: true, classification: false, policy: false },
      overrides: { policy: { deliveryBehavior: 'block' } },
    }
    const next = buildWizardDestinationsFromRouteSources(
      [],
      [{ id: 42, stream_id: 10, destination_id: 5, enabled: false, failure_policy: 'RETRY_AND_BACKOFF' }],
      [{ id: 5, destination_type: 'WEBHOOK_POST' }],
    )
    const merged = preserveWizardRouteProcessingDrafts(next, prior)
    expect(merged.routeDrafts[0]?.enabled).toBe(false)
    expect(merged.routeDrafts[0]?.failurePolicy).toBe('RETRY_AND_BACKOFF')
    expect(merged.routeDrafts[0]?.inherit).toMatchObject({ classification: false, policy: false })
    expect(merged.routeDrafts[0]?.overrides?.policy?.deliveryBehavior).toBe('block')
  })

  it('preserves failover draft when destination rows refresh', () => {
    const prior = buildWizardDestinationsFromRouteSources(
      [],
      [{ id: 42, stream_id: 10, destination_id: 5, enabled: true }],
      [{ id: 5, destination_type: 'WEBHOOK_POST' }],
    )
    prior.routeDrafts[0] = {
      ...prior.routeDrafts[0]!,
      failover: { id: 9, enabled: true, secondaryDestinationId: 77 },
    }
    const next = buildWizardDestinationsFromRouteSources(
      [],
      [{ id: 42, stream_id: 10, destination_id: 5, enabled: true }],
      [{ id: 5, destination_type: 'WEBHOOK_POST' }],
    )
    const merged = preserveWizardRouteProcessingDrafts(next, prior)
    expect(merged.routeDrafts[0]?.failover).toEqual({
      id: 9,
      enabled: true,
      secondaryDestinationId: 77,
    })
  })
})
