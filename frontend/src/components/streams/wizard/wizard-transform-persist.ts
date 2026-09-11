import {
  fetchRouteEnrichmentUiConfig,
  fetchRouteMappingUiConfig,
  saveRouteEnrichmentUiConfig,
  saveRouteMappingUiConfig,
} from '../../../api/gdcRouteTransform'
import {
  parseTransformRulesFromFieldMappings,
  UNMAPPED_FIELDS_POLICY_KEY,
} from '../../../utils/advancedTransformConfig'
import {
  newConditionId,
  newEnrichmentRuleId,
  normalizeWizardEnrichmentRules,
  type EnrichmentRuleType,
  type WizardEnrichmentRule,
} from './enrichment-rules-model'
import {
  buildWizardFieldMappingsPayload,
  enrichmentDictFromRows,
  wizardFieldMappingsReady,
  type WizardRouteDraft,
  type WizardRouteTransformOverride,
  type WizardState,
  type WizardUnmappedFieldsPolicy,
} from './wizard-state'

export type TransformPersistResult = {
  saved: boolean
  routesUpdated: number
  errors: string[]
}

function mappingModeFromFieldMappings(fieldMappings: Record<string, unknown>): WizardRouteTransformOverride['mappingMode'] {
  const mode = fieldMappings.mapping_mode
  if (mode === 'full_event_jsonata') return 'full_event_jsonata'
  if (mode === 'full_event_regex') return 'full_event_regex'
  return 'basic_jsonpath'
}

function fullEventJsonataExpressionFromFieldMappings(fieldMappings: Record<string, unknown>): string {
  if (mappingModeFromFieldMappings(fieldMappings) !== 'full_event_jsonata') return ''
  const raw = fieldMappings.jsonata_expression ?? fieldMappings.expression
  return typeof raw === 'string' ? raw : ''
}

function mappingRowsFromFieldMappings(fieldMappings: Record<string, unknown>): WizardRouteTransformOverride['mapping'] {
  const rows: WizardRouteTransformOverride['mapping'] = []
  let index = 0
  for (const [outputField, sourcePath] of Object.entries(fieldMappings)) {
    if (
      outputField === 'transform_rules' ||
      outputField === 'mapping_mode' ||
      outputField === UNMAPPED_FIELDS_POLICY_KEY ||
      outputField === 'jsonata_expression' ||
      outputField === 'expression' ||
      outputField === 'regex_config'
    ) {
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

/** Reverse of enrichmentDictFromRules for route enrichment_json hydrate. */
export function enrichmentRulesFromPersistedDict(raw: unknown): WizardEnrichmentRule[] {
  if (Array.isArray(raw)) return normalizeWizardEnrichmentRules(raw)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const dict = raw as Record<string, unknown>
  const advancedRaw = dict.__rules
  const advanced =
    advancedRaw && typeof advancedRaw === 'object' && !Array.isArray(advancedRaw)
      ? (advancedRaw as Record<string, unknown>)
      : {}
  const rules: WizardEnrichmentRule[] = []

  for (const [fieldName, value] of Object.entries(dict)) {
    if (fieldName === '__rules') continue
    if (Object.prototype.hasOwnProperty.call(advanced, fieldName)) continue
    rules.push({
      id: newEnrichmentRuleId(),
      label: fieldName,
      fieldName,
      type: 'static',
      enabled: true,
      staticValue: typeof value === 'string' ? value : JSON.stringify(value),
      expression: '',
      lookupTable: 'aws-regions',
      lookupKeyField: 'region',
      conditions: [{ id: newConditionId(), when: '', then: '' }],
      conditionalDefault: '',
      normalizeSourceField: 'timestamp',
      normalizeFormat: 'iso8601',
    })
  }

  for (const [fieldName, payload] of Object.entries(advanced)) {
    if (!payload || typeof payload !== 'object') continue
    const row = payload as Record<string, unknown>
    const type = (typeof row.type === 'string' ? row.type : 'static') as EnrichmentRuleType
    rules.push({
      id: newEnrichmentRuleId(),
      label: String(row.label ?? fieldName),
      fieldName,
      type: ['static', 'calculated', 'lookup', 'conditional', 'normalize'].includes(type) ? type : 'static',
      enabled: row.enabled !== false,
      staticValue: '',
      expression: String(row.expression ?? ''),
      lookupTable: String(row.lookup_table ?? 'aws-regions'),
      lookupKeyField: String(row.lookup_key_field ?? 'region'),
      conditions: Array.isArray(row.conditions)
        ? row.conditions.map((c) => {
            const cond = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
            return {
              id: newConditionId(),
              when: String(cond.when ?? ''),
              then: String(cond.then ?? ''),
            }
          })
        : [{ id: newConditionId(), when: '', then: '' }],
      conditionalDefault: String(row.default ?? ''),
      normalizeSourceField: String(row.source_field ?? 'timestamp'),
      normalizeFormat:
        row.format === 'lowercase' || row.format === 'uppercase' || row.format === 'trim'
          ? row.format
          : 'iso8601',
    })
  }

  return rules
}

export function buildRouteTransformOverrideFromFieldMappings(
  fieldMappings: Record<string, unknown>,
  enrichment: Record<string, unknown>,
): WizardRouteTransformOverride {
  const mappingMode = mappingModeFromFieldMappings(fieldMappings)
  const unmappedRaw = fieldMappings[UNMAPPED_FIELDS_POLICY_KEY]
  const unmappedFieldsPolicy: WizardUnmappedFieldsPolicy =
    unmappedRaw === 'drop_unmapped' ? 'drop_unmapped' : 'pass_through'
  return {
    mapping: mappingRowsFromFieldMappings(fieldMappings),
    mappingMode,
    fullEventJsonataExpression: fullEventJsonataExpressionFromFieldMappings(fieldMappings),
    fullEventRegexConfigJson:
      mappingMode === 'full_event_regex' && fieldMappings.regex_config != null
        ? JSON.stringify(fieldMappings.regex_config, null, 2)
        : '',
    transformRules: parseTransformRulesFromFieldMappings(fieldMappings),
    enrichment: enrichmentRulesFromPersistedDict(enrichment),
    unmappedFieldsPolicy,
  }
}

export function buildRouteTransformPersistPayloads(override: WizardRouteTransformOverride): {
  fieldMappings: Record<string, unknown>
  enrichment: Record<string, unknown>
  mappingReady: boolean
} {
  const fieldMappings = buildWizardFieldMappingsPayload(override)
  const enrichment = enrichmentDictFromRows(override.enrichment)
  return {
    fieldMappings,
    enrichment,
    mappingReady: wizardFieldMappingsReady(override),
  }
}

export async function persistWizardRouteTransforms(
  state: WizardState,
  routeIds: readonly (number | null | undefined)[],
): Promise<TransformPersistResult> {
  const result: TransformPersistResult = { saved: false, routesUpdated: 0, errors: [] }
  const drafts = state.destinations.routeDrafts

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]
    const routeId = routeIds[index]
    if (!draft || typeof routeId !== 'number' || !Number.isFinite(routeId)) continue

    try {
      if (draft.inherit?.transform !== false) {
        await saveRouteMappingUiConfig(routeId, { inherit: true })
        await saveRouteEnrichmentUiConfig(routeId, { inherit: true })
        result.routesUpdated += 1
        continue
      }

      const override = draft.overrides?.transform
      if (!override) {
        result.errors.push(`route-transform ${routeId}: override enabled but transform draft is missing`)
        continue
      }
      const payload = buildRouteTransformPersistPayloads(override)
      if (!payload.mappingReady && Object.keys(payload.fieldMappings).length === 0) {
        result.errors.push(`route-transform ${routeId}: add at least one mapping field before saving override`)
        continue
      }

      await saveRouteMappingUiConfig(routeId, {
        inherit: false,
        mapping: {
          field_mappings: payload.fieldMappings,
          event_array_path: null,
          event_root_path: null,
        },
      })
      await saveRouteEnrichmentUiConfig(routeId, {
        inherit: false,
        enrichment: {
          enabled: true,
          enrichment: payload.enrichment,
          override_policy: 'KEEP_EXISTING',
        },
      })
      result.routesUpdated += 1
    } catch (err) {
      result.errors.push(`route-transform ${routeId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.saved = result.errors.length === 0
  return result
}

export async function loadWizardRouteTransforms(
  routeDrafts: WizardRouteDraft[],
): Promise<WizardRouteDraft[]> {
  return Promise.all(
    routeDrafts.map(async (draft) => {
      const routeId = Number(/^route-(\d+)$/.exec(draft.key)?.[1] ?? NaN)
      if (!Number.isFinite(routeId)) return draft
      try {
        const [mappingCfg, enrichmentCfg] = await Promise.all([
          fetchRouteMappingUiConfig(routeId),
          fetchRouteEnrichmentUiConfig(routeId),
        ])
        const inheritMapping = mappingCfg?.inherit_stream_mapping ?? true
        const inheritEnrichment = enrichmentCfg?.inherit_stream_enrichment ?? true
        if (inheritMapping && inheritEnrichment) {
          return {
            ...draft,
            inherit: { ...draft.inherit, transform: true },
          }
        }
        const fieldMappings = (mappingCfg?.mapping?.field_mappings ?? {}) as Record<string, unknown>
        const enrichment = (enrichmentCfg?.enrichment?.enrichment ?? {}) as Record<string, unknown>
        return {
          ...draft,
          inherit: { ...draft.inherit, transform: false },
          overrides: {
            ...draft.overrides,
            transform: buildRouteTransformOverrideFromFieldMappings(fieldMappings, enrichment),
          },
        }
      } catch {
        return draft
      }
    }),
  )
}
