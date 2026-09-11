import { ChevronLeft, ChevronRight, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { NAV_PATH, runtimeOverviewPath } from '../../config/nav-paths'
import { WIZARD_LABEL } from '../../lib/operator-vocabulary'
import { createStream } from '../../api/gdcStreams'
import { materializeConnectorTemplates } from '../../api/gdcConnectorTemplates'
import { saveStreamMappingUiConfigStrict } from '../../api/gdcRuntimeUi'
import { createRoute } from '../../api/gdcRoutes'
import { startRuntimeStream } from '../../api/gdcRuntime'
import { StepConnect } from './wizard/step-connect'
import { StepSample } from './wizard/step-sample'
import { StepDelivery } from './wizard/step-delivery'
import { StepRouteProcessing } from './wizard/step-route-processing'
import { StepDeploy } from './wizard/step-deploy'
import { WizardStepper } from './wizard/wizard-stepper'
import { computeDeployReadiness } from './wizard/wizard-deploy-readiness'
import {
  WIZARD_STEPS,
  buildSourceAuthPayload,
  buildInitialState,
  buildSourceConfig,
  buildStreamCreatePayload,
  buildRouteCreatePayloads,
  computeStepCompletion,
  enrichmentDictFromRows,
  buildWizardFieldMappingsPayload,
  wizardFieldMappingsReady,
  legacySubstepToWizardStep,
  type WizardConfigState,
  type WizardCreateOutcome,
  type WizardLegacySubstepKey,
  type WizardState,
  type WizardStepKey,
} from './wizard/wizard-state'
import {
  loadWizardDraft,
  saveWizardDraft,
  clearWizardDraft,
  wizardStepIndexForKey,
  type WizardDraftEnvelopeV2,
} from './wizard/wizard-draft-migration'
import {
  applySampleConfirmationToWizardState,
  canAdvanceFromWizardStep,
  mergeStreamSampleConfirmations,
  wizardSampleStepBlockReason,
  wizardRouteProcessingStepBlockReason,
  wizardStepReachable,
} from './wizard/wizard-step-gates'
import { wizardStepsWithSourcePresentation } from '../../utils/sourceTypePresentation'
import { wizardExtractEvents } from './wizard/wizard-json-extract'
import { buildApiTestExtractedEventsPatch, buildApiTestSuccessPatch } from '../../utils/wizardUnionSchema'
import {
  buildAnalysisForSample,
  getOperationalSample,
  type OperationalSampleId,
} from './wizard/wizard-operational-samples'
import { applyHttpImportToWizardState, type HttpImportWizardLocationState } from '../../utils/httpImportDraft'
import { persistWizardDataProtectionIntents } from './wizard/wizard-data-protection-persist'
import { persistWizardSharedAndRoutePolicy } from './wizard/wizard-policy-persist'
import { persistWizardStreamGovernance } from './wizard/wizard-governance-persist'
import { persistWizardRouteTransforms } from './wizard/wizard-transform-persist'
import { persistWizardRouteProtection } from './wizard/wizard-route-protection-persist'
import { persistWizardRouteClassification } from './wizard/wizard-classification-persist'
import { persistWizardFailover } from './wizard/wizard-failover-persist'
import {
  mergeSchemaDriftPolicyIntoConfigJson,
  persistWizardSchemaDriftPolicy,
} from './wizard/wizard-schema-drift-policy-persist'
import { persistWizardUnionSchema } from './wizard/wizard-union-schema-persist'
import { useUnionSchemaSensitiveEnrichment } from './wizard/use-union-schema-sensitive-enrichment'
import type { UnionSchema } from '../../utils/unionSchema'
import {
  checkpointPathFromClick,
  eventRootPathFromClick,
  normalizeEventArrayPath,
  normalizeEventRootPath,
} from '../../utils/eventExtractionPaths'
import { normalizeCheckpointRelativePath } from '../../utils/recordSelectionPaths'

const NEXT_STEP_LABEL: Partial<Record<WizardStepKey, string>> = {
  connect: 'Sample & Record Selection',
  sample: 'Destinations',
  destinations: 'Route Processing',
  route_processing: 'Deploy',
}

export function NewStreamWizardPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const importHydratedRef = useRef(false)
  const draftHydratedRef = useRef(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [state, setState] = useState<WizardState>(() => buildInitialState())
  const [pendingDraft, setPendingDraft] = useState<WizardDraftEnvelopeV2 | null>(null)
  const [draftBannerVisible, setDraftBannerVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const [operationalSampleId, setOperationalSampleId] = useState<OperationalSampleId | null>(null)
  const [dataProtectionDrawerOpen, setDataProtectionDrawerOpen] = useState(false)

  const wizardSteps = useMemo(
    () => wizardStepsWithSourcePresentation(WIZARD_STEPS, state.connector.sourceType),
    [state.connector.sourceType],
  )

  const currentStepKey = wizardSteps[stepIndex]?.key ?? 'connect'
  const completion = useMemo(() => computeStepCompletion(state), [state])

  useEffect(() => {
    if (draftHydratedRef.current) return
    draftHydratedRef.current = true
    const draft = loadWizardDraft()
    if (!draft) return
    setPendingDraft(draft)
    setDraftBannerVisible(true)
  }, [])

  const handleResumeDraft = useCallback(() => {
    if (!pendingDraft) return
    setState(applySampleConfirmationToWizardState(pendingDraft.state))
    setStepIndex(wizardStepIndexForKey(wizardSteps, pendingDraft.stepKey))
    setPendingDraft(null)
    setDraftBannerVisible(false)
    setDraftNotice('Draft restored from local storage.')
    window.setTimeout(() => setDraftNotice(null), 4000)
  }, [pendingDraft, wizardSteps])

  const handleStartFresh = useCallback(() => {
    clearWizardDraft()
    setState(buildInitialState())
    setStepIndex(0)
    setPendingDraft(null)
    setDraftBannerVisible(false)
    setOperationalSampleId(null)
  }, [])

  useEffect(() => {
    if (importHydratedRef.current) return
    const routeState = (location.state ?? {}) as HttpImportWizardLocationState
    const connectorId = routeState.connectorId
    if (connectorId == null) return
    importHydratedRef.current = true
    setState((prev) => applyHttpImportToWizardState(prev, { connectorId, streamDraft: routeState.streamDraft }))
    setDraftNotice('Stream fields prefilled from import. Review polling and mapping before creating.')
    setStepIndex(wizardStepIndexForKey(wizardSteps, 'connect'))
  }, [location.state, wizardSteps])

  const navigateToWizardStep = useCallback(
    (key: WizardStepKey) => {
      const idx = wizardSteps.findIndex((s) => s.key === key)
      if (idx >= 0) setStepIndex(idx)
    },
    [wizardSteps],
  )

  const navigateToLegacySubstep = useCallback(
    (legacyKey: WizardLegacySubstepKey) => {
      if (legacyKey === 'data_protection') {
        setDataProtectionDrawerOpen(true)
      }
      navigateToWizardStep(legacySubstepToWizardStep(legacyKey))
    },
    [navigateToWizardStep],
  )

  const updateConnector = useCallback((patch: Partial<WizardState['connector']>) => {
    setState((s) => ({ ...s, connector: { ...s.connector, ...patch } }))
  }, [])
  const updateStream = useCallback((patch: Partial<WizardState['stream']>) => {
    setState((s) => ({ ...s, stream: { ...s.stream, ...patch } }))
  }, [])
  const updateApiTest = useCallback(
    (next: WizardState['apiTest']) => {
      setState((s) => ({
        ...s,
        apiTest: next,
        stream: mergeStreamSampleConfirmations(s.stream, next),
      }))
    },
    [],
  )
  const applyEnrichedUnionSchema = useCallback((schema: UnionSchema) => {
    setState((s) => {
      if (!s.apiTest.unionSchema || s.apiTest.unionSchema.sensitive_suggestions_applied) return s
      return { ...s, apiTest: { ...s.apiTest, unionSchema: schema } }
    })
  }, [])
  useUnionSchemaSensitiveEnrichment(
    state.apiTest.unionSchema,
    state.apiTest.extractedEvents,
    applyEnrichedUnionSchema,
  )
  const patchStream = useCallback((patch: Partial<WizardConfigState>) => {
    setState((s) => ({ ...s, stream: { ...s.stream, ...patch } }))
  }, [])
  const setEventArrayPath = useCallback((path: string) => {
    setState((s) => {
      const raw = s.apiTest.parsedJson ?? s.apiTest.rawResponse
      const rawObj = raw !== null && typeof raw === 'object' ? raw : null
      const normalized = normalizeEventArrayPath(path) || (Array.isArray(rawObj) ? '$' : '')
      const useWhole = normalized.length === 0
      const nextStream = {
        ...s.stream,
        eventArrayPath: normalized,
        useWholeResponseAsEvent: useWhole,
        eventRootPath: '',
        eventRootConfirmedForApiTestAt: null,
        customExtractionValidatedForApiTestAt: null,
        customExtractionValidationOk: false,
      }
      const extracted = wizardExtractEvents(rawObj, normalized, '')
      const mergedStream = mergeStreamSampleConfirmations(nextStream, s.apiTest)
      const gateState = { stream: mergedStream, apiTest: s.apiTest }
      return {
        ...s,
        stream: mergedStream,
        apiTest: {
          ...s.apiTest,
          ...buildApiTestExtractedEventsPatch(extracted, s.apiTest.analysis, gateState),
        },
      }
    })
  }, [])
  const setEventRootPath = useCallback((path: string) => {
    setState((s) => {
      const raw = s.apiTest.parsedJson ?? s.apiTest.rawResponse
      const rawObj = raw !== null && typeof raw === 'object' ? raw : null
      const arrayPath = s.stream.eventArrayPath.trim() || '$'
      const normalizedInputRoot = normalizeEventRootPath(path)
      const normalizedRoot =
        normalizedInputRoot && normalizedInputRoot.startsWith('$')
          ? eventRootPathFromClick(normalizedInputRoot, arrayPath) || normalizedInputRoot
          : normalizedInputRoot
      let eventArrayPath = s.stream.eventArrayPath
      let useWholeResponseAsEvent = s.stream.useWholeResponseAsEvent
      if (!useWholeResponseAsEvent && !eventArrayPath.trim()) {
        if (Array.isArray(rawObj)) {
          eventArrayPath = '$'
        } else if (rawObj != null) {
          useWholeResponseAsEvent = true
        }
      }
      const extractArrayPath = useWholeResponseAsEvent
        ? ''
        : eventArrayPath.trim() || (Array.isArray(rawObj) ? '$' : '')
      const extracted = wizardExtractEvents(rawObj, extractArrayPath, normalizedRoot)
      const eventRootConfirmedForApiTestAt =
        s.apiTest.status === 'success' && s.apiTest.ok && s.apiTest.finishedAt != null
          ? s.apiTest.finishedAt
          : null
      const nextStream = {
        ...s.stream,
        eventRootPath: normalizedRoot,
        eventArrayPath: useWholeResponseAsEvent ? '' : eventArrayPath.trim() || (Array.isArray(rawObj) ? '$' : ''),
        useWholeResponseAsEvent,
        eventRootConfirmedForApiTestAt,
        customExtractionValidatedForApiTestAt: null,
        customExtractionValidationOk: false,
      }
      const mergedStream = mergeStreamSampleConfirmations(nextStream, s.apiTest)
      const gateState = { stream: mergedStream, apiTest: s.apiTest }
      return {
        ...s,
        stream: mergedStream,
        apiTest: {
          ...s.apiTest,
          ...buildApiTestExtractedEventsPatch(extracted, s.apiTest.analysis, gateState),
        },
      }
    })
  }, [])
  const setCheckpoint = useCallback((patch: Partial<Pick<WizardConfigState, 'checkpointFieldType' | 'checkpointSourcePath'>>) => {
    setState((s) => {
      let checkpointSourcePath = patch.checkpointSourcePath ?? s.stream.checkpointSourcePath
      if (patch.checkpointSourcePath !== undefined && checkpointSourcePath.trim()) {
        const rawPath = checkpointSourcePath.trim()
        const arrayPath = s.stream.eventArrayPath.trim() || '$'
        if (rawPath.startsWith('$') && /\[\d+\]/.test(rawPath)) {
          checkpointSourcePath = checkpointPathFromClick(rawPath, arrayPath, 0)
        } else {
          checkpointSourcePath = normalizeCheckpointRelativePath(rawPath)
        }
      }
      return {
        ...s,
        stream: mergeStreamSampleConfirmations(s.stream, s.apiTest, {
          ...patch,
          ...(patch.checkpointSourcePath !== undefined ? { checkpointSourcePath } : {}),
          customExtractionValidatedForApiTestAt: null,
          customExtractionValidationOk: false,
        }),
      }
    })
  }, [])

  const loadOperationalSample = useCallback((id: OperationalSampleId) => {
    const sample = getOperationalSample(id)
    const startedAt = Date.now()
    const analysis = buildAnalysisForSample(sample, '', '')
    const samplePatch = buildApiTestSuccessPatch(sample.payload, analysis)
    setOperationalSampleId(id)
    setState((s) => ({
      ...s,
      stream: {
        ...s.stream,
        eventArrayPath: '',
        eventRootPath: '',
        useWholeResponseAsEvent: false,
        checkpointSourcePath: '',
        checkpointFieldType: '',
        recordSelectionMode: 'basic',
        customExtractionValidatedForApiTestAt: null,
        customExtractionValidationOk: false,
        recordPathConfirmedForApiTestAt: null,
        eventRootConfirmedForApiTestAt: null,
        checkpointConfirmedForApiTestAt: null,
      },
      apiTest: {
        ...s.apiTest,
        status: 'success',
        ok: true,
        requestUrl: `local://operational-sample/${id}`,
        method: s.stream.httpMethod,
        statusCode: 200,
        responseHeaders: { 'x-operational-sample': id },
        rawBody: JSON.stringify(sample.payload),
        parsedJson: sample.payload,
        rawResponse: sample.payload,
        ...samplePatch,
        analysis,
        startedAt,
        finishedAt: startedAt + 1,
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
        s3ConnectivityPassed: false,
        remoteProbe: null,
        dbConnectivityPassed: false,
      },
    }))
  }, [])
  const setMapping = useCallback((rows: WizardState['mapping']) => {
    setState((s) => ({ ...s, mapping: rows }))
  }, [])
  const setMappingMode = useCallback((mappingMode: WizardState['mappingMode']) => {
    setState((s) => ({ ...s, mappingMode }))
  }, [])
  const setFullEventJsonata = useCallback((fullEventJsonataExpression: string) => {
    setState((s) => ({ ...s, fullEventJsonataExpression }))
  }, [])
  const setFullEventRegexConfigJson = useCallback((fullEventRegexConfigJson: string) => {
    setState((s) => ({ ...s, fullEventRegexConfigJson }))
  }, [])
  const setEnrichment = useCallback((enrichment: WizardState['enrichment']) => {
    setState((s) => ({ ...s, enrichment }))
  }, [])
  const setUnmappedFieldsPolicy = useCallback((unmappedFieldsPolicy: WizardState['unmappedFieldsPolicy']) => {
    setState((s) => ({ ...s, unmappedFieldsPolicy }))
  }, [])
  const setDestinations = useCallback((patch: Partial<WizardState['destinations']>) => {
    setState((s) => ({ ...s, destinations: { ...s.destinations, ...patch } }))
  }, [])
  const setDataProtection = useCallback((patch: Partial<WizardState['dataProtection']>) => {
    setState((s) => ({ ...s, dataProtection: { ...s.dataProtection, ...patch } }))
  }, [])
  const setDataPolicy = useCallback((patch: Partial<WizardState['dataPolicy']>) => {
    setState((s) => ({ ...s, dataPolicy: { ...s.dataPolicy, ...patch } }))
  }, [])

  const handleCreate = useCallback(async (options?: { startAfter?: boolean }) => {
    if (busy) return
    setBusy(true)
    setCreationError(null)
    const startAfter = options?.startAfter === true

    const workingState: WizardState = {
      ...state,
      connector: { ...state.connector },
      stream: { ...state.stream },
    }
    const outcome: WizardCreateOutcome = {
      streamId: null,
      routeId: null,
      routeIds: [],
      mappingSaved: false,
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

    const useTemplateMaterialization =
      workingState.connector.registryModuleId != null &&
      workingState.connector.selectedTemplateIds.length > 0

    let streamConfigJson: Record<string, unknown> | undefined

    try {
      if (useTemplateMaterialization) {
        if (workingState.connector.connectorId == null) {
          throw new Error('Select a saved connector before materializing stream templates.')
        }
        const materialized = await materializeConnectorTemplates({
          connector_id: workingState.connector.connectorId,
          module_id: workingState.connector.registryModuleId!,
          templates: workingState.connector.selectedTemplateIds,
        })
        const createdStreams = materialized.created_streams
        if (createdStreams.length === 0) {
          throw new Error('Materialization returned no streams.')
        }
        outcome.materializedStreamIds = createdStreams.map((row) => row.stream_id)
        outcome.streamId = createdStreams[0]?.stream_id ?? null
        streamConfigJson =
          createdStreams[0]?.config_json && typeof createdStreams[0].config_json === 'object'
            ? { ...(createdStreams[0].config_json as Record<string, unknown>) }
            : undefined
        outcome.mappingSaved = true
        outcome.enrichmentSaved = true
        outcome.apiBacked = true
      } else {
        if (workingState.connector.connectorId == null || workingState.connector.sourceId == null) {
          throw new Error('Select a saved connector and its linked source before creating a stream.')
        }
        void buildSourceConfig(workingState)
        void buildSourceAuthPayload(workingState)
        const payload = buildStreamCreatePayload(workingState)
        if (payload == null) {
          throw new Error('connector/source rows are required before stream creation')
        }
        const created = await createStream(payload)
        outcome.streamId = created.id
        outcome.apiBacked = true
        outcome.createdAt = created.created_at ?? null
        streamConfigJson =
          created.config_json && typeof created.config_json === 'object' && !Array.isArray(created.config_json)
            ? { ...(created.config_json as Record<string, unknown>) }
            : { ...payload.config_json }

        const fieldMappings = buildWizardFieldMappingsPayload(workingState)
        const enrichmentDict = enrichmentDictFromRows(workingState.enrichment)
        const hasMapping = wizardFieldMappingsReady(workingState)
        const hasEnrichment = Object.keys(enrichmentDict).length > 0

        if (hasMapping || hasEnrichment) {
          try {
            await saveStreamMappingUiConfigStrict(created.id, {
              mapping: hasMapping
                ? {
                    field_mappings: fieldMappings,
                    event_array_path:
                      workingState.stream.useWholeResponseAsEvent || !workingState.stream.eventArrayPath.trim()
                        ? null
                        : workingState.stream.eventArrayPath.trim().startsWith('$')
                          ? workingState.stream.eventArrayPath.trim()
                          : `$.${workingState.stream.eventArrayPath.trim()}`,
                    event_root_path: workingState.stream.eventRootPath.trim()
                      ? workingState.stream.eventRootPath.trim().startsWith('$')
                        ? workingState.stream.eventRootPath.trim()
                        : `$.${workingState.stream.eventRootPath.trim()}`
                      : null,
                  }
                : null,
              enrichment: hasEnrichment
                ? {
                    enabled: true,
                    enrichment: enrichmentDict,
                    override_policy: 'KEEP_EXISTING',
                  }
                : null,
            })
            outcome.mappingSaved = hasMapping
            outcome.enrichmentSaved = hasEnrichment
          } catch (err) {
            outcome.errors.push(
              `mapping-ui/save failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }

      if (outcome.streamId != null && workingState.dataProtection.intents.length > 0) {
        try {
          const protectionResult = await persistWizardDataProtectionIntents(
            outcome.streamId,
            workingState,
          )
          outcome.dataProtectionSaved = protectionResult.saved
          outcome.dataProtectionEnforcementIncomplete = protectionResult.enforcementIncomplete
          outcome.dataProtectionWarnings = protectionResult.warnings
          if (protectionResult.errors.length > 0) {
            outcome.errors.push(...protectionResult.errors.map((err) => `data-protection: ${err}`))
          }
        } catch (err) {
          outcome.errors.push(
            `data-protection persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      if (outcome.streamId != null) {
        try {
          const driftPolicyResult = await persistWizardSchemaDriftPolicy(
            outcome.streamId,
            workingState.dataProtection,
            { existingConfigJson: streamConfigJson },
          )
          outcome.schemaDriftPolicySaved = driftPolicyResult.saved
          if (driftPolicyResult.saved && streamConfigJson) {
            streamConfigJson = mergeSchemaDriftPolicyIntoConfigJson(
              streamConfigJson,
              workingState.dataProtection,
            )
          }
          if (driftPolicyResult.errors.length > 0) {
            outcome.errors.push(...driftPolicyResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `schema-drift-policy persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      if (outcome.streamId != null && workingState.apiTest.unionSchema) {
        try {
          const unionSchemaResult = await persistWizardUnionSchema(
            outcome.streamId,
            workingState.apiTest.unionSchema,
            {
              existingConfigJson: streamConfigJson,
              events: workingState.apiTest.extractedEvents,
            },
          )
          if (unionSchemaResult.errors.length > 0) {
            outcome.errors.push(...unionSchemaResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `union-schema persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      if (
        outcome.streamId != null &&
        workingState.destinations.destinationApiBacked &&
        workingState.destinations.routeDrafts.length > 0
      ) {
        for (const routePayload of buildRouteCreatePayloads(outcome.streamId, workingState.destinations)) {
          try {
            const route = await createRoute(routePayload)
            outcome.routeId = route.id
            outcome.routeIds.push(route.id)
          } catch (err) {
            outcome.errors.push(
              `POST /routes/ failed (destination_id=${routePayload.destination_id}): ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }

      if (outcome.streamId != null) {
        try {
          const transformResult = await persistWizardRouteTransforms(workingState, outcome.routeIds)
          if (transformResult.errors.length > 0) {
            outcome.errors.push(...transformResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `route-transform persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        try {
          const routeProtectionResult = await persistWizardRouteProtection(workingState, outcome.routeIds)
          if (routeProtectionResult.errors.length > 0) {
            outcome.errors.push(...routeProtectionResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `route-protection persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        try {
          const routeClassificationResult = await persistWizardRouteClassification(workingState, outcome.routeIds)
          if (routeClassificationResult.errors.length > 0) {
            outcome.errors.push(...routeClassificationResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `route-classification persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        try {
          const failoverResult = await persistWizardFailover(outcome.streamId, workingState.destinations.routeDrafts)
          if (failoverResult.errors.length > 0) {
            outcome.errors.push(...failoverResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `failover persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        try {
          const governanceResult = await persistWizardStreamGovernance(
            outcome.streamId,
            workingState,
            outcome.routeIds,
          )
          outcome.governanceSaved = governanceResult.saved
          if (governanceResult.warnings.length > 0) {
            outcome.dataProtectionWarnings.push(...governanceResult.warnings)
          }
          if (governanceResult.errors.length > 0) {
            outcome.errors.push(...governanceResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `governance persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        try {
          const policyResult = await persistWizardSharedAndRoutePolicy(
            outcome.streamId,
            workingState,
            outcome.routeIds,
          )
          if (policyResult.errors.length > 0) {
            outcome.errors.push(...policyResult.errors)
          }
        } catch (err) {
          outcome.errors.push(
            `policy persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome.errors.push(
        useTemplateMaterialization ? `Template materialization failed: ${message}` : `POST /streams/ failed: ${message}`,
      )
      setCreationError(message)
    } finally {
      setState((s) => ({ ...s, outcome }))
      if (outcome.streamId != null) {
        clearWizardDraft()
      }
      navigateToWizardStep('deploy')
      setBusy(false)
    }

    if (startAfter && outcome.streamId != null) {
      setIsStarting(true)
      try {
        const res = await startRuntimeStream(outcome.streamId)
        setState((s) => ({ ...s, startMessage: res?.message ?? 'Runtime API unavailable.' }))
      } finally {
        setIsStarting(false)
      }
    }
  }, [busy, navigateToWizardStep, state])

  const handleStart = useCallback(async () => {
    const id = state.outcome?.streamId
    if (id == null || isStarting) return
    setIsStarting(true)
    const res = await startRuntimeStream(id)
    setState((s) => ({ ...s, startMessage: res?.message ?? 'Runtime API unavailable.' }))
    setIsStarting(false)
  }, [isStarting, state.outcome?.streamId])

  const saveDraft = useCallback(() => {
    try {
      saveWizardDraft(state, currentStepKey)
      setDraftNotice('Draft saved locally.')
      window.setTimeout(() => setDraftNotice(null), 4000)
    } catch {
      setDraftNotice('Unable to save draft.')
      window.setTimeout(() => setDraftNotice(null), 4000)
    }
  }, [currentStepKey, state])

  const handleCreateAnother = useCallback(() => {
    clearWizardDraft()
    setState(buildInitialState())
    setStepIndex(0)
    setCreationError(null)
    setOperationalSampleId(null)
    setPendingDraft(null)
    setDraftBannerVisible(false)
  }, [])

  const isDeployStep = currentStepKey === 'deploy'
  const streamCreated = state.outcome?.streamId != null
  const stepGateOpen = canAdvanceFromWizardStep(currentStepKey, state)
  const canAdvance = (!isDeployStep || !streamCreated) && stepGateOpen
  const nextStepBlockReason = useMemo(() => {
    if (stepGateOpen) return undefined
    if (currentStepKey === 'sample') return wizardSampleStepBlockReason(state)
    if (currentStepKey === 'route_processing') return wizardRouteProcessingStepBlockReason(state)
    return 'Complete required fields on this step before continuing.'
  }, [currentStepKey, state, stepGateOpen])
  const deployReadiness = useMemo(() => computeDeployReadiness(state), [state])

  const goToNextStep = useCallback(() => {
    setStepIndex((idx) => {
      const nextIdx = Math.min(wizardSteps.length - 1, idx + 1)
      const nextKey = wizardSteps[nextIdx]?.key
      if (nextKey && !wizardStepReachable(nextKey, state)) return idx
      return nextIdx
    })
  }, [state, wizardSteps])

  const persistenceLabel = state.connector.apiBacked
    ? 'API-backed catalog · creation will hit /api/v1/streams/'
    : 'Offline catalog · stream creation uses a local draft until the API is available'

  const nextLabel = NEXT_STEP_LABEL[currentStepKey]

  return (
    <div className="flex h-fit w-full min-w-0 grow-0 flex-col gap-4 pb-8">
      <nav className="flex flex-wrap items-center gap-1 text-[12px]" aria-label="Page breadcrumb">
        <Link to={NAV_PATH.streams} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
          Streams
        </Link>
        <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
          /
        </span>
        <span className="font-semibold text-slate-700 dark:text-slate-200">New Stream</span>
      </nav>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Stream Onboarding Wizard
          </h2>
          <p className="max-w-2xl text-[13px] text-slate-600 dark:text-gdc-muted">{wizardSteps.map((s) => s.title).join(' → ')}</p>
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">{persistenceLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(NAV_PATH.streams)}
            className="inline-flex h-9 items-center rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          >
            Cancel
          </button>
        </div>
      </header>

      {creationError ? (
        <p className="rounded-md border border-red-200/80 bg-red-500/[0.06] p-3 text-[12px] font-medium text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          API save failed: {creationError}
        </p>
      ) : null}

      <WizardStepper
        wizardSteps={wizardSteps}
        stepIndex={stepIndex}
        setStepIndex={setStepIndex}
        completion={completion}
        state={state}
      />

      {draftBannerVisible && pendingDraft ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200/80 bg-amber-500/[0.06] px-3 py-2.5 dark:border-amber-500/35 dark:bg-amber-500/10"
          data-testid="wizard-draft-banner"
        >
          <p className="text-[12px] font-medium text-amber-900 dark:text-amber-100">Saved draft found.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleResumeDraft}
              className="inline-flex h-8 items-center rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700"
              data-testid="wizard-draft-resume"
            >
              Resume draft
            </button>
            <button
              type="button"
              onClick={handleStartFresh}
              className="inline-flex h-8 items-center rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
              data-testid="wizard-draft-start-fresh"
            >
              Start fresh
            </button>
          </div>
        </div>
      ) : null}

      {draftNotice ? (
        <p className="rounded-md border border-emerald-200/80 bg-emerald-500/[0.06] px-3 py-2 text-[11px] font-medium text-emerald-800 dark:border-emerald-500/35 dark:bg-emerald-500/10 dark:text-emerald-200">
          {draftNotice}
        </p>
      ) : null}

      <main>
        {currentStepKey === 'connect' ? (
          <StepConnect state={state} onConnectorChange={updateConnector} onStreamChange={updateStream} />
        ) : null}
        {currentStepKey === 'sample' ? (
          <StepSample
            state={state}
            onApiTestChange={updateApiTest}
            onStreamPatch={patchStream}
            onSetEventArrayPath={setEventArrayPath}
            onSetEventRootPath={setEventRootPath}
            onSetCheckpoint={setCheckpoint}
            onLoadOperationalSample={loadOperationalSample}
            activeOperationalSampleId={operationalSampleId}
          />
        ) : null}
        {currentStepKey === 'destinations' ? <StepDelivery state={state} onChange={setDestinations} /> : null}
        {currentStepKey === 'route_processing' ? (
          <StepRouteProcessing
            state={state}
            onChangeMapping={setMapping}
            onChangeMappingMode={setMappingMode}
            onChangeFullEventJsonata={setFullEventJsonata}
            onChangeFullEventRegexConfigJson={setFullEventRegexConfigJson}
            onChangeEnrichment={setEnrichment}
            onChangeUnmappedFieldsPolicy={setUnmappedFieldsPolicy}
            onChangeDataProtection={setDataProtection}
            onChangeDataPolicy={setDataPolicy}
            onChangeDestinations={setDestinations}
            dataProtectionDrawerOpen={dataProtectionDrawerOpen}
            onDataProtectionDrawerOpenChange={setDataProtectionDrawerOpen}
          />
        ) : null}
        {currentStepKey === 'deploy' ? (
          <StepDeploy
            state={state}
            busy={busy}
            isStarting={isStarting}
            onStart={() => void handleStart()}
            onNavigateToLegacySubstep={navigateToLegacySubstep}
          />
        ) : null}
      </main>

      <nav
        className="sticky bottom-0 z-20 mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 bg-white/95 py-3 backdrop-blur-sm dark:border-gdc-border dark:bg-gdc-section"
        aria-label="Wizard navigation"
      >
        {isDeployStep && streamCreated ? (
          <button
            type="button"
            onClick={() => navigate(NAV_PATH.streams)}
            className="inline-flex h-9 items-center rounded-md border border-transparent px-1 text-[12px] font-semibold text-slate-600 hover:text-slate-900 dark:text-gdc-muted dark:hover:text-slate-100"
          >
            Exit Wizard
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStepIndex((idx) => Math.max(0, idx - 1))}
            disabled={stepIndex === 0}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            Back
          </button>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isDeployStep && streamCreated ? (
            <>
              <button
                type="button"
                onClick={() => handleCreateAnother()}
                className="inline-flex h-9 items-center rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-800 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
              >
                Create Another Stream
              </button>
              <Link
                to={
                  state.outcome?.streamId != null
                    ? runtimeOverviewPath({ stream_id: state.outcome.streamId })
                    : NAV_PATH.runtime
                }
                className="inline-flex h-9 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700"
              >
                {WIZARD_LABEL.goToOperations}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </>
          ) : (
            <>
              {currentStepKey === 'route_processing' || currentStepKey === 'deploy' ? (
                <button
                  type="button"
                  onClick={() => saveDraft()}
                  className="inline-flex h-9 items-center rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                >
                  Save as Draft
                </button>
              ) : null}
              {isDeployStep && !streamCreated ? (
                <button
                  type="button"
                  onClick={() => void handleCreate({ startAfter: true })}
                  disabled={busy || isStarting || !deployReadiness.canCreate}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="deploy-create-and-start"
                >
                  {busy || isStarting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {busy || isStarting ? 'Creating & Starting…' : 'Create & Start Stream'}
                </button>
              ) : null}
              {!isDeployStep ? (
                <button
                  type="button"
                  onClick={goToNextStep}
                  disabled={!canAdvance}
                  title={nextStepBlockReason}
                  className="inline-flex h-9 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {nextLabel ? (
                    <>
                      Next: {nextLabel}
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </>
                  ) : (
                    <>
                      Next
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </>
                  )}
                </button>
              ) : null}
              {!isDeployStep ? (
                <a
                  href="https://example.com/docs/streams/onboarding"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-1 text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                >
                  View onboarding docs
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : null}
            </>
          )}
        </div>
      </nav>
    </div>
  )
}
