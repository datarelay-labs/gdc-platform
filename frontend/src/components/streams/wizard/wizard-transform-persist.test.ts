import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRouteTransformOverrideFromFieldMappings,
  buildRouteTransformPersistPayloads,
  loadWizardRouteTransforms,
  persistWizardRouteTransforms,
} from './wizard-transform-persist'
import { buildInitialState, buildRouteTransformOverrideFromGlobal, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'
import { projectRouteProcessingStatusFromDeployIntent } from './wizard-deploy-projection'

vi.mock('../../../api/gdcRouteTransform', () => ({
  saveRouteMappingUiConfig: vi.fn(async () => ({
    route_id: 1,
    stream_id: 1,
    mapping_saved: true,
    inherit_stream_mapping: false,
    message: 'ok',
  })),
  saveRouteEnrichmentUiConfig: vi.fn(async () => ({
    route_id: 1,
    stream_id: 1,
    enrichment_saved: true,
    inherit_stream_enrichment: false,
    message: 'ok',
  })),
  fetchRouteMappingUiConfig: vi.fn(async () => ({
    route_id: 1,
    stream_id: 1,
    inherit_stream_mapping: true,
    mapping: { exists: false, event_array_path: null, event_root_path: null, field_mappings: {}, raw_payload_mode: null },
    stream_mapping: { exists: false, event_array_path: null, event_root_path: null, field_mappings: {}, raw_payload_mode: null },
    message: 'ok',
  })),
  fetchRouteEnrichmentUiConfig: vi.fn(async () => ({
    route_id: 1,
    stream_id: 1,
    inherit_stream_enrichment: true,
    enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
    stream_enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
    message: 'ok',
  })),
}))

import {
  fetchRouteEnrichmentUiConfig,
  fetchRouteMappingUiConfig,
  saveRouteEnrichmentUiConfig,
  saveRouteMappingUiConfig,
} from '../../../api/gdcRouteTransform'

describe('wizard route transform source of truth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds route transform persist payloads from override draft', () => {
    const state = buildInitialState()
    state.mapping = [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message', origin: 'manual' }]
    const override = buildRouteTransformOverrideFromGlobal(state)
    override.mapping = [{ id: 'm2', outputField: 'host', sourceJsonPath: '$.hostname', origin: 'manual' }]
    const payload = buildRouteTransformPersistPayloads(override)
    expect(payload.mappingReady).toBe(true)
    expect(payload.fieldMappings.host).toBe('$.hostname')
  })

  it('hydrates override from route field_mappings without inventing shared copy as SoT', () => {
    const override = buildRouteTransformOverrideFromFieldMappings(
      { host: '$.hostname', mapping_mode: 'basic_jsonpath' },
      { env: 'prod' },
    )
    expect(override.mapping).toEqual([
      expect.objectContaining({ outputField: 'host', sourceJsonPath: '$.hostname' }),
    ])
    expect(override.enrichment[0]?.fieldName).toBe('env')
  })

  it('persists Override routes to route mapping/enrichment APIs and clears Inherit', async () => {
    const state = buildInitialState()
    state.mapping = [{ id: 'm1', outputField: 'msg', sourceJsonPath: '$.message', origin: 'manual' }]
    state.destinations.routeDrafts = [
      {
        key: 'route-a',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
      {
        key: 'route-b',
        destinationId: 20,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: false, protection: true, classification: true, policy: true },
        overrides: {
          transform: {
            ...buildRouteTransformOverrideFromGlobal(state),
            mapping: [{ id: 'b1', outputField: 'dest', sourceJsonPath: '$.b', origin: 'manual' }],
          },
        },
      },
    ]

    const result = await persistWizardRouteTransforms(state, [101, 102])

    expect(result.saved).toBe(true)
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(101, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(101, { inherit: true })
    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(
      102,
      expect.objectContaining({
        inherit: false,
        mapping: expect.objectContaining({
          field_mappings: expect.objectContaining({ dest: '$.b' }),
        }),
      }),
    )
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(
      102,
      expect.objectContaining({ inherit: false }),
    )
  })

  it('clears persisted route transform when Override flips back to Inherit', async () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'route-b',
        destinationId: 20,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
        overrides: {
          transform: buildRouteTransformOverrideFromGlobal(state),
        },
      },
    ]

    await persistWizardRouteTransforms(state, [202])

    expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(202, { inherit: true })
    expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(202, { inherit: true })
  })

  it('reloads route transform override from persisted route mapping/enrichment', async () => {
    vi.mocked(fetchRouteMappingUiConfig).mockResolvedValueOnce({
      route_id: 55,
      stream_id: 7,
      inherit_stream_mapping: false,
      mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: { route_only: '$.route', mapping_mode: 'basic_jsonpath' },
        raw_payload_mode: null,
      },
      stream_mapping: {
        exists: true,
        event_array_path: null,
        event_root_path: null,
        field_mappings: { shared: '$.shared' },
        raw_payload_mode: null,
      },
      message: 'ok',
    })
    vi.mocked(fetchRouteEnrichmentUiConfig).mockResolvedValueOnce({
      route_id: 55,
      stream_id: 7,
      inherit_stream_enrichment: false,
      enrichment: {
        exists: true,
        enabled: true,
        enrichment: { tag: 'route-b' },
        override_policy: 'KEEP_EXISTING',
      },
      stream_enrichment: {
        exists: true,
        enabled: true,
        enrichment: {},
        override_policy: 'KEEP_EXISTING',
      },
      message: 'ok',
    })

    const drafts = await loadWizardRouteTransforms([
      {
        key: 'route-55',
        destinationId: 1,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
    ])

    expect(drafts[0]?.inherit.transform).toBe(false)
    expect(drafts[0]?.overrides?.transform?.mapping).toEqual([
      expect.objectContaining({ outputField: 'route_only', sourceJsonPath: '$.route' }),
    ])
  })

  it('projects transform override as route_transform, not intent_only', () => {
    const state = buildInitialState()
    const projection = projectRouteProcessingStatusFromDeployIntent(
      {
        key: 'route-b',
        destinationId: 20,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: false, protection: true, classification: true, policy: true },
        overrides: { transform: buildRouteTransformOverrideFromGlobal(state) },
      },
      state.dataProtection,
    )
    expect(projection.concerns.transform.persistKind).toBe('route_transform')
    expect(projection.concerns.transform.persistKind).not.toBe('intent_only')
  })
})
