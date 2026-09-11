import { fetchConnectorById } from '../../../api/gdcConnectors'
import { fetchDestinationsList } from '../../../api/gdcDestinations'
import { fetchRoutesList, type RouteRead } from '../../../api/gdcRoutes'
import { fetchStreamMappingUiConfig } from '../../../api/gdcRuntime'
import { fetchStreamById } from '../../../api/gdcStreams'
import type { MappingUIConfigResponse, MappingUIConfigRouteItem, StreamRead } from '../../../api/types/gdcApi'
import { resolveStreamEndpointPath } from '../../../utils/streamHttpConfigFromStreamRead'
import { UNMAPPED_FIELDS_POLICY_KEY } from '../../../utils/advancedTransformConfig'
import type { MappingMode } from '../../../types/advancedTransform'
import { DEFAULT_MESSAGE_PREFIX_TEMPLATE, defaultMessagePrefixEnabled } from '../../../utils/messagePrefixDefaults'
import { normalizeWizardEnrichmentRules } from './enrichment-rules-model'
import {
  readAdvancedStreamConfigFromPersisted,
} from './wizard-stream-config-sync'
import { loadWizardPolicyFromRuntime } from './wizard-policy-persist'
import { loadWizardRouteTransforms } from './wizard-transform-persist'
import { loadWizardRouteProtection } from './wizard-route-protection-persist'
import { loadWizardRouteClassification } from './wizard-classification-persist'
import { loadWizardFailover } from './wizard-failover-persist'
import { unionSchemaFromStreamConfig } from '../../../utils/unionSchema'
import {
  buildInitialState,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  newWizardRouteClassificationOverrideKey,
  newWizardRouteProtectionOverrideKey,
  normalizeWizardClassificationLevel,
  normalizeWizardDestinations,
  normalizeWizardPolicyDeliveryBehavior,
  normalizeWizardProtectionAction,
  wizardConnectorPatchFromApi,
  type StreamConfigHeaderRow,
  type WizardDataProtectionState,
  type WizardMappingRow,
  type WizardRouteDraft,
  type WizardState,
} from './wizard-state'

function kvRowsFromRecord(raw: Record<string, unknown> | undefined, prefix: string): StreamConfigHeaderRow[] {
  if (!raw || typeof raw !== 'object') return []
  return Object.entries(raw).map(([key, value], index) => ({
    id: `${prefix}-${index}`,
    key,
    value: String(value ?? ''),
  }))
}

function stripJsonPathPrefix(path: string | null | undefined): string {
  const trimmed = String(path ?? '').trim()
  if (!trimmed) return ''
  return trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed
}

function mappingRowsFromFieldMappings(fieldMappings: Record<string, unknown>): WizardMappingRow[] {
  const rows: WizardMappingRow[] = []
  let index = 0
  for (const [outputField, sourcePath] of Object.entries(fieldMappings)) {
    if (outputField === 'transform_rules' || outputField === 'mapping_mode' || outputField === UNMAPPED_FIELDS_POLICY_KEY) {
      continue
    }
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) continue
    rows.push({
      id: `map-${index++}`,
      outputField,
      sourceJsonPath: sourcePath.trim(),
      origin: 'manual',
    })
  }
  return rows
}

function mappingModeFromFieldMappings(fieldMappings: Record<string, unknown>): MappingMode {
  const mode = fieldMappings.mapping_mode
  if (mode === 'full_event_jsonata') return 'full_event_jsonata'
  if (mode === 'full_event_regex') return 'full_event_regex'
  return 'basic_jsonpath'
}

/** Read persisted full-event JSONata expression (`jsonata_expression`; legacy `expression` fallback). */
export function fullEventJsonataExpressionFromFieldMappings(fieldMappings: Record<string, unknown>): string {
  if (mappingModeFromFieldMappings(fieldMappings) !== 'full_event_jsonata') return ''
  const raw = fieldMappings.jsonata_expression ?? fieldMappings.expression
  return typeof raw === 'string' ? raw : ''
}

function normalizeFailurePolicy(raw: string): WizardRouteDraft['failurePolicy'] {
  const upper = raw.toUpperCase()
  if (upper === 'PAUSE_STREAM_ON_FAILURE') return 'PAUSE_STREAM_ON_FAILURE'
  if (upper === 'RETRY_AND_BACKOFF') return 'RETRY_AND_BACKOFF'
  if (upper === 'DISABLE_ROUTE_ON_FAILURE') return 'DISABLE_ROUTE_ON_FAILURE'
  return 'LOG_AND_CONTINUE'
}

function routeDraftFromMappingItem(route: MappingUIConfigRouteItem): WizardRouteDraft {
  return {
    key: `route-${route.route_id}`,
    destinationId: route.destination_id,
    enabled: route.route_enabled,
    failurePolicy: normalizeFailurePolicy(route.failure_policy),
    rateLimitJson:
      route.route_rate_limit && typeof route.route_rate_limit === 'object'
        ? { ...(route.route_rate_limit as Record<string, unknown>) }
        : {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
  }
}

function routeDraftFromCatalogRoute(route: RouteRead): WizardRouteDraft {
  return {
    key: `route-${route.id}`,
    destinationId: route.destination_id ?? 0,
    enabled: route.enabled !== false,
    failurePolicy: normalizeFailurePolicy(route.failure_policy ?? 'LOG_AND_CONTINUE'),
    rateLimitJson:
      route.rate_limit_json && typeof route.rate_limit_json === 'object'
        ? { ...route.rate_limit_json }
        : {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    overrides: undefined,
  }
}

/** Merge mapping-ui routes with catalog routes so edit wizard shows persisted delivery paths. */
export function buildWizardDestinationsFromRouteSources(
  mappingRoutes: readonly MappingUIConfigRouteItem[],
  catalogRoutes: readonly RouteRead[],
  destinations: ReadonlyArray<{ id: number; destination_type?: string | null }>,
): WizardState['destinations'] {
  const destinationKindsById: Record<number, string> = {}
  const messagePrefixEnabledByDestinationId: Record<number, boolean> = {}
  const destById = new Map(destinations.map((d) => [d.id, d]))
  const seenRouteIds = new Set<number>()
  const routeDrafts: WizardRouteDraft[] = []
  let messagePrefixTemplate = DEFAULT_MESSAGE_PREFIX_TEMPLATE

  for (const route of mappingRoutes) {
    seenRouteIds.add(route.route_id)
    const destinationType = route.destination_type ?? destById.get(route.destination_id)?.destination_type ?? ''
    destinationKindsById[route.destination_id] = destinationType
    const fc = route.formatter_config ?? {}
    messagePrefixEnabledByDestinationId[route.destination_id] =
      typeof fc.message_prefix_enabled === 'boolean'
        ? fc.message_prefix_enabled
        : defaultMessagePrefixEnabled(destinationType)
    const prefixTemplate = fc.message_prefix_template
    if (typeof prefixTemplate === 'string' && prefixTemplate.trim()) {
      messagePrefixTemplate = prefixTemplate.trim()
    }
    routeDrafts.push(routeDraftFromMappingItem(route))
  }

  for (const route of catalogRoutes) {
    if (seenRouteIds.has(route.id)) continue
    const destinationId = route.destination_id ?? 0
    if (destinationId <= 0) continue
    const destinationType = destById.get(destinationId)?.destination_type ?? ''
    destinationKindsById[destinationId] = destinationType
    const formatter = route.formatter_config_json ?? {}
    if (messagePrefixEnabledByDestinationId[destinationId] === undefined) {
      messagePrefixEnabledByDestinationId[destinationId] =
        typeof formatter.message_prefix_enabled === 'boolean'
          ? formatter.message_prefix_enabled
          : defaultMessagePrefixEnabled(destinationType)
    }
    const prefixTemplate = formatter.message_prefix_template
    if (
      messagePrefixTemplate === DEFAULT_MESSAGE_PREFIX_TEMPLATE &&
      typeof prefixTemplate === 'string' &&
      prefixTemplate.trim()
    ) {
      messagePrefixTemplate = prefixTemplate.trim()
    }
    routeDrafts.push(routeDraftFromCatalogRoute(route))
  }

  routeDrafts.sort((a, b) => {
    const aId = Number(/^route-(\d+)$/.exec(a.key)?.[1] ?? 0)
    const bId = Number(/^route-(\d+)$/.exec(b.key)?.[1] ?? 0)
    return aId - bId
  })

  return normalizeWizardDestinations({
    routeDrafts,
    destinationKindsById,
    messagePrefixEnabledByDestinationId,
    messagePrefixTemplate,
    destinationApiBacked: true,
  })
}

type GovernanceRouteOverrideLike = {
  route_id?: number
  enabled?: boolean
  classification_level?: string | null
  delivery_behavior?: string | null
  protection_action?: string | null
  field_path?: string | null
}

export function governanceRouteOverridesFromStreamConfig(configJson: unknown): GovernanceRouteOverrideLike[] {
  if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) return []
  const governance = (configJson as { governance?: unknown }).governance
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) return []
  const raw = (governance as { route_overrides?: unknown }).route_overrides
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is GovernanceRouteOverrideLike => !!item && typeof item === 'object')
}

/** Restore inherit/override flags from persisted Contract v1 governance route_overrides. */
export function applyGovernanceRouteOverridesToWizard(
  destinations: WizardState['destinations'],
  dataProtection: WizardDataProtectionState,
  overrides: readonly GovernanceRouteOverrideLike[],
): { destinations: WizardState['destinations']; dataProtection: WizardDataProtectionState } {
  if (overrides.length === 0) {
    return { destinations, dataProtection }
  }

  const routeDrafts = destinations.routeDrafts.map((draft) => ({
    ...draft,
    inherit: { ...draft.inherit },
    overrides: draft.overrides ? { ...draft.overrides } : undefined,
  }))
  const classification = [...dataProtection.routeClassificationOverrides]
  const protection = [...dataProtection.routeOverrides]

  for (const override of overrides) {
    if (override.enabled === false) continue
    const routeId = Number(override.route_id)
    if (!Number.isFinite(routeId)) continue
    const draft = routeDrafts.find((item) => item.key === `route-${routeId}`)
    if (!draft) continue

    if (override.classification_level) {
      draft.inherit.classification = false
      if (!classification.some((row) => row.enabled && row.routeDraftKey === draft.key)) {
        classification.push({
          key: newWizardRouteClassificationOverrideKey(),
          routeDraftKey: draft.key,
          classificationLevel: normalizeWizardClassificationLevel(override.classification_level),
          enabled: true,
        })
      }
    }

    if (override.delivery_behavior) {
      draft.inherit.policy = false
      draft.overrides = {
        ...draft.overrides,
        policy: { deliveryBehavior: normalizeWizardPolicyDeliveryBehavior(override.delivery_behavior) },
      }
    }

    if (override.protection_action && override.field_path) {
      if (!protection.some((row) => row.enabled && row.routeDraftKey === draft.key && row.fieldPath === override.field_path)) {
        protection.push({
          key: newWizardRouteProtectionOverrideKey(),
          fieldPath: override.field_path,
          routeDraftKey: draft.key,
          protectionAction: normalizeWizardProtectionAction(override.protection_action),
          deliveryBehavior:
            override.delivery_behavior === 'quarantine' || override.delivery_behavior === 'block'
              ? override.delivery_behavior
              : 'continue',
          enabled: true,
        })
      }
    }
  }

  return {
    destinations: { ...destinations, routeDrafts },
    dataProtection: {
      ...dataProtection,
      routeClassificationOverrides: classification,
      routeOverrides: protection,
    },
  }
}

/** Keep inherit/override drafts when destination rows are refreshed from the API. */
export function preserveWizardRouteProcessingDrafts(
  next: WizardState['destinations'],
  prior: WizardState['destinations'] | undefined,
): WizardState['destinations'] {
  if (!prior?.routeDrafts.length) return next
  const priorByKey = new Map(prior.routeDrafts.map((draft) => [draft.key, draft]))
  const priorByDestination = new Map(prior.routeDrafts.map((draft) => [draft.destinationId, draft]))
  return {
    ...next,
    routeDrafts: next.routeDrafts.map((draft) => {
      const previous = priorByKey.get(draft.key) ?? priorByDestination.get(draft.destinationId)
      if (!previous) return draft
      return {
        ...draft,
        inherit: { ...previous.inherit },
        overrides: previous.overrides,
        failover: previous.failover,
      }
    }),
  }
}

export type WizardDestinationsRefresh = {
  destinations: WizardState['destinations']
  routeIds: number[]
}

export async function refreshWizardDestinationsFromStream(streamId: number): Promise<WizardDestinationsRefresh | null> {
  const [mapping, allRoutes, destinations] = await Promise.all([
    fetchStreamMappingUiConfig(streamId, { fresh: true }),
    fetchRoutesList(),
    fetchDestinationsList(),
  ])
  const streamRoutes = (allRoutes ?? []).filter((route) => route.stream_id === streamId)
  const merged = buildWizardDestinationsFromRouteSources(
    mapping?.routes ?? [],
    streamRoutes,
    destinations ?? [],
  )
  let routeDrafts = merged.routeDrafts
  try {
    routeDrafts = await loadWizardFailover(streamId, routeDrafts)
  } catch {
    // Keep route drafts when failover-routes fetch is unavailable.
  }
  const destinationsState = { ...merged, routeDrafts }
  const routeIds = destinationsState.routeDrafts
    .map((draft) => Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN))
    .filter((id): id is number => Number.isFinite(id))
  return { destinations: destinationsState, routeIds }
}

export function streamConfigPatchFromRead(
  found: StreamRead,
  mapping: MappingUIConfigResponse | null,
): Partial<WizardState['stream']> {
  const cfg = (found.config_json ?? {}) as Record<string, unknown>
  const sourceConfig = mapping?.source_config ?? {}
  const methodRaw = String(cfg.method ?? cfg.http_method ?? 'GET').toUpperCase()
  const httpMethod =
    methodRaw === 'POST' ||
    methodRaw === 'PUT' ||
    methodRaw === 'PATCH' ||
    methodRaw === 'DELETE'
      ? methodRaw
      : 'GET'
  const endpoint = resolveStreamEndpointPath(cfg, sourceConfig)
  const sqlQuery = String(cfg.query ?? (sourceConfig as { query?: unknown }).query ?? '').trim()
  const queryTimeoutRaw = cfg.query_timeout_seconds ?? (sourceConfig as { query_timeout_seconds?: unknown }).query_timeout_seconds
  const body = cfg.body ?? cfg.request_body
  let requestBody = ''
  if (typeof body === 'string') requestBody = body
  else if (body != null) {
    try {
      requestBody = JSON.stringify(body, null, 2)
    } catch {
      requestBody = ''
    }
  }

  const eventArrayPath = stripJsonPathPrefix(mapping?.mapping?.event_array_path)
  const eventRootPath = stripJsonPathPrefix(mapping?.mapping?.event_root_path)
  const advanced = readAdvancedStreamConfigFromPersisted(cfg, mapping?.mapping ?? null)
  const useWholeResponseAsEvent =
    advanced.useWholeResponseAsEvent ??
    (!eventArrayPath && !mapping?.mapping?.event_array_path)

  const rl = found.rate_limit_json ?? {}
  const confirmedAt = Date.now()
  const checkpointSourcePath = advanced.checkpointSourcePath ?? ''
  const checkpointFieldType = advanced.checkpointFieldType ?? ''
  const recordSelectionMode = advanced.recordSelectionMode ?? 'basic'

  return {
    name: (found.name ?? '').trim() || `Stream ${found.id}`,
    httpMethod,
    endpoint,
    headers: kvRowsFromRecord((cfg.headers ?? {}) as Record<string, unknown>, 'hdr'),
    params: kvRowsFromRecord((cfg.params ?? {}) as Record<string, unknown>, 'prm'),
    requestBody,
    pollingIntervalSec:
      typeof found.polling_interval === 'number' && found.polling_interval > 0 ? found.polling_interval : 60,
    timeoutSec:
      typeof queryTimeoutRaw === 'number' && Number.isFinite(queryTimeoutRaw)
        ? queryTimeoutRaw
        : typeof cfg.timeout_seconds === 'number'
          ? cfg.timeout_seconds
          : typeof cfg.timeout_sec === 'number'
            ? cfg.timeout_sec
            : 30,
    sqlQuery,
    eventArrayPath: advanced.eventArrayPath ?? eventArrayPath,
    eventRootPath: advanced.eventRootPath ?? eventRootPath,
    useWholeResponseAsEvent,
    checkpointSourcePath,
    checkpointFieldType,
    checkpointMode: advanced.checkpointMode ?? 'Cursor',
    checkpointSecondaryPath: advanced.checkpointSecondaryPath ?? '',
    recordSelectionMode,
    customExtractionValidatedForApiTestAt: recordSelectionMode === 'advanced' ? confirmedAt : null,
    customExtractionValidationOk: recordSelectionMode !== 'advanced' ? false : true,
    schemaRootPath: advanced.schemaRootPath ?? '',
    initialDelaySec: advanced.initialDelaySec ?? 0,
    paginationType: advanced.paginationType ?? 'None',
    paginationCursorParam: advanced.paginationCursorParam ?? '',
    paginationPageSize: advanced.paginationPageSize ?? 0,
    paginationMaxPages: advanced.paginationMaxPages ?? 0,
    rateLimitPerMinute: typeof rl.per_minute === 'number' ? rl.per_minute : 60,
    rateLimitBurst: typeof rl.burst === 'number' ? rl.burst : 10,
    recordPathConfirmedForApiTestAt:
      (advanced.eventArrayPath ?? eventArrayPath) || useWholeResponseAsEvent ? confirmedAt : null,
    eventRootConfirmedForApiTestAt: (advanced.eventRootPath ?? eventRootPath) ? confirmedAt : null,
    checkpointConfirmedForApiTestAt: checkpointSourcePath ? confirmedAt : null,
  }
}

export async function hydrateWizardStateFromStream(streamId: number): Promise<WizardState | null> {
  const [found, mapping, allRoutes, destinations] = await Promise.all([
    fetchStreamById(streamId),
    fetchStreamMappingUiConfig(streamId, { fresh: true }),
    fetchRoutesList(),
    fetchDestinationsList(),
  ])
  if (!found) return null

  const streamRoutes = (allRoutes ?? []).filter((route) => route.stream_id === streamId)
  const baseDestinations = buildWizardDestinationsFromRouteSources(
    mapping?.routes ?? [],
    streamRoutes,
    destinations ?? [],
  )
  const appliedGovernance = applyGovernanceRouteOverridesToWizard(
    baseDestinations,
    buildInitialState().dataProtection,
    governanceRouteOverridesFromStreamConfig(found.config_json),
  )
  const hydratedDestinations = appliedGovernance.destinations
  const hydratedRouteIds = hydratedDestinations.routeDrafts
    .map((draft) => Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN))
    .filter((id): id is number => Number.isFinite(id))

  const base = buildInitialState()
  const connectorId = typeof found.connector_id === 'number' ? found.connector_id : null
  let connectorPatch: Partial<WizardState['connector']> = {
    connectorId,
    sourceId: mapping?.source_id ?? null,
    apiBacked: true,
  }

  if (connectorId != null) {
    const connector = await fetchConnectorById(connectorId)
    if (connector) {
      connectorPatch = {
        ...connectorPatch,
        ...wizardConnectorPatchFromApi(connector),
        connectorId,
        sourceId: connector.source_id ?? mapping?.source_id ?? null,
      }
    }
  }

  const fieldMappings = (mapping?.mapping?.field_mappings ?? {}) as Record<string, unknown>
  const mappingMode = mappingModeFromFieldMappings(fieldMappings)
  const fullEventJsonataExpression = fullEventJsonataExpressionFromFieldMappings(fieldMappings)
  const fullEventRegexConfigJson =
    mappingMode === 'full_event_regex' && fieldMappings.regex_config != null
      ? JSON.stringify(fieldMappings.regex_config, null, 2)
      : ''

  const unmappedPolicyRaw = fieldMappings[UNMAPPED_FIELDS_POLICY_KEY]
  const unmappedFieldsPolicy = unmappedPolicyRaw === 'drop_unmapped' ? 'drop_unmapped' : 'pass_through'

  let hydratedRouteDestinations = hydratedDestinations
  let dataPolicy = base.dataPolicy
  try {
    const loadedPolicy = await loadWizardPolicyFromRuntime(
      streamId,
      hydratedRouteDestinations.routeDrafts,
      dataPolicy,
    )
    dataPolicy = loadedPolicy.dataPolicy
    hydratedRouteDestinations = { ...hydratedRouteDestinations, routeDrafts: loadedPolicy.routeDrafts }
  } catch {
    // Keep governance-hydrated drafts when policy-rule fetch is unavailable.
  }

  try {
    const loadedTransforms = await loadWizardRouteTransforms(hydratedRouteDestinations.routeDrafts)
    hydratedRouteDestinations = { ...hydratedRouteDestinations, routeDrafts: loadedTransforms }
  } catch {
    // Keep drafts when route transform fetch is unavailable.
  }

  try {
    const loadedProtection = await loadWizardRouteProtection(hydratedRouteDestinations.routeDrafts)
    hydratedRouteDestinations = { ...hydratedRouteDestinations, routeDrafts: loadedProtection }
  } catch {
    // Keep drafts when route protection fetch is unavailable.
  }

  try {
    const loadedClassification = await loadWizardRouteClassification(hydratedRouteDestinations.routeDrafts)
    hydratedRouteDestinations = { ...hydratedRouteDestinations, routeDrafts: loadedClassification }
  } catch {
    // Keep drafts when route classification fetch is unavailable.
  }

  try {
    const loadedFailover = await loadWizardFailover(streamId, hydratedRouteDestinations.routeDrafts)
    hydratedRouteDestinations = { ...hydratedRouteDestinations, routeDrafts: loadedFailover }
  } catch {
    // Keep drafts when failover-routes fetch is unavailable.
  }

  return {
    ...base,
    connector: {
      ...base.connector,
      ...connectorPatch,
      sourceType:
        (mapping?.source_type as WizardState['connector']['sourceType']) ??
        (found.stream_type as WizardState['connector']['sourceType']) ??
        connectorPatch.sourceType ??
        base.connector.sourceType,
    },
    stream: {
      ...base.stream,
      ...streamConfigPatchFromRead(found, mapping),
    },
    mapping: mappingRowsFromFieldMappings(fieldMappings),
    mappingMode,
    fullEventJsonataExpression,
    fullEventRegexConfigJson,
    unmappedFieldsPolicy,
    enrichment: normalizeWizardEnrichmentRules(mapping?.enrichment?.enrichment),
    destinations: hydratedRouteDestinations,
    dataPolicy,
    dataProtection: appliedGovernance.dataProtection,
    apiTest: {
      ...base.apiTest,
      unionSchema: unionSchemaFromStreamConfig(
        found.config_json && typeof found.config_json === 'object' && !Array.isArray(found.config_json)
          ? (found.config_json as Record<string, unknown>)
          : null,
      ),
    },
    outcome: {
      streamId: found.id,
      routeId: hydratedRouteIds[0] ?? null,
      routeIds: hydratedRouteIds,
      mappingSaved: mapping?.mapping?.exists ?? false,
      enrichmentSaved: mapping?.enrichment?.exists ?? false,
      dataProtectionSaved: false,
      governanceSaved: false,
      schemaDriftPolicySaved: false,
      schemaDriftPolicyWarnings: [],
      dataProtectionEnforcementIncomplete: false,
      dataProtectionWarnings: [],
      errors: [],
      apiBacked: true,
      createdAt: found.created_at ?? null,
      materializedStreamIds: [],
    },
  }
}
