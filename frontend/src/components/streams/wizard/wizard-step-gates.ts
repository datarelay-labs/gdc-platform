import type { WizardConfigState, WizardState, WizardStepKey } from './wizard-state'

type SampleConfirmationStream = Pick<
  WizardConfigState,
  | 'useWholeResponseAsEvent'
  | 'eventArrayPath'
  | 'eventRootPath'
  | 'checkpointSourcePath'
  | 'recordPathConfirmedForApiTestAt'
  | 'eventRootConfirmedForApiTestAt'
  | 'checkpointConfirmedForApiTestAt'
  | 'recordSelectionMode'
  | 'customExtractionValidatedForApiTestAt'
  | 'customExtractionValidationOk'
>

type SampleConfirmationApiTest = Pick<WizardState['apiTest'], 'status' | 'ok' | 'finishedAt'>

/** Keep confirmation timestamps aligned with the latest successful API test when paths are set. */
export function sampleConfirmationPatch(
  stream: SampleConfirmationStream,
  apiTest: SampleConfirmationApiTest,
): Pick<
  WizardConfigState,
  'recordPathConfirmedForApiTestAt' | 'eventRootConfirmedForApiTestAt' | 'checkpointConfirmedForApiTestAt'
> {
  const canConfirm = apiTest.status === 'success' && apiTest.ok && apiTest.finishedAt != null
  if (!canConfirm) {
    // Preserve previously confirmed selections (edit mode) when there is no
    // latest successful API test yet. This keeps persisted paths usable while
    // still allowing stale detection once a new sample is fetched.
    return {
      recordPathConfirmedForApiTestAt: stream.recordPathConfirmedForApiTestAt,
      eventRootConfirmedForApiTestAt: stream.eventRootConfirmedForApiTestAt,
      checkpointConfirmedForApiTestAt: stream.checkpointConfirmedForApiTestAt,
    }
  }
  const finishedAt = apiTest.finishedAt!
  const recordPathReady = stream.useWholeResponseAsEvent || stream.eventArrayPath.trim().length > 0
  const checkpointReady = stream.checkpointSourcePath.trim().length > 0
  const eventRootConfirmed =
    stream.eventRootConfirmedForApiTestAt === finishedAt ? finishedAt : null
  return {
    recordPathConfirmedForApiTestAt: recordPathReady ? finishedAt : null,
    eventRootConfirmedForApiTestAt: eventRootConfirmed,
    checkpointConfirmedForApiTestAt: checkpointReady ? finishedAt : null,
  }
}

export function mergeStreamSampleConfirmations(
  stream: WizardConfigState,
  apiTest: WizardState['apiTest'],
  patch: Partial<WizardConfigState> = {},
): WizardConfigState {
  const merged = { ...stream, ...patch }
  return { ...merged, ...sampleConfirmationPatch(merged, apiTest) }
}

export function applySampleConfirmationToWizardState(state: WizardState): WizardState {
  return {
    ...state,
    stream: mergeStreamSampleConfirmations(state.stream, state.apiTest),
  }
}

const WIZARD_STEP_ORDER: readonly WizardStepKey[] = [
  'connect',
  'sample',
  'destinations',
  'route_processing',
  'deploy',
]

/** Source-type-aware gate for live sample / query test (wizard Run Test). */
export function wizardCanRunLiveSampleTest(state: Pick<WizardState, 'connector' | 'stream'>): boolean {
  if (state.connector.connectorId == null || state.connector.sourceId == null) return false
  const sourceType = state.connector.sourceType
  if (sourceType === 'S3_OBJECT_POLLING') return true
  if (sourceType === 'REMOTE_FILE_POLLING') return state.stream.remoteDirectory.trim().length > 0
  if (sourceType === 'DATABASE_QUERY') return state.stream.sqlQuery.trim().length > 0
  return state.stream.endpoint.trim().length > 0
}

/** Whether the latest API test returned a usable response payload. */
export function wizardApiTestHasResponsePayload(state: Pick<WizardState, 'apiTest'>): boolean {
  const payload = state.apiTest.parsedJson ?? state.apiTest.rawResponse
  return payload != null
}

/** HTTP status >= 400 must not satisfy sample readiness. */
export function wizardApiTestHttpStatusOk(state: Pick<WizardState, 'apiTest'>): boolean {
  const code = state.apiTest.statusCode
  return code == null || code < 400
}

/** Latest API test result is authoritative — success + ok + payload + HTTP < 400. */
export function wizardApiTestReady(state: Pick<WizardState, 'apiTest'>): boolean {
  const t = state.apiTest
  if (t.status !== 'success' || !t.ok) return false
  if (!wizardApiTestHasResponsePayload(state)) return false
  return wizardApiTestHttpStatusOk(state)
}

/** Resolve HTTP API test status from response metadata (shared by runtime UI + tests). */
export function resolveHttpApiTestResult(
  statusCode: number | null | undefined,
  hasPayload: boolean,
): { status: 'success' | 'error'; ok: boolean } {
  if (statusCode != null && statusCode >= 400) {
    return { status: 'error', ok: false }
  }
  if (!hasPayload) {
    return { status: 'error', ok: false }
  }
  return { status: 'success', ok: true }
}

/** Record path selected (whole response or explicit array path). */
export function wizardRecordPathReady(state: Pick<WizardState, 'stream'>): boolean {
  return state.stream.useWholeResponseAsEvent || state.stream.eventArrayPath.trim().length > 0
}

/** Sync position field selected on the sample record. */
export function wizardSyncPositionReady(state: Pick<WizardState, 'stream'>): boolean {
  return state.stream.checkpointSourcePath.trim().length > 0
}

/** Record path confirmed against the latest successful API test run. */
export function wizardRecordPathConfirmed(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  if (!wizardRecordPathReady(state)) return false
  const finishedAt = state.apiTest.finishedAt
  if (finishedAt == null) return state.stream.recordPathConfirmedForApiTestAt != null
  return state.stream.recordPathConfirmedForApiTestAt === finishedAt
}

/** Event root confirmed against the latest successful API test run. */
export function wizardEventRootConfirmed(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  const finishedAt = state.apiTest.finishedAt
  if (finishedAt == null) return state.stream.eventRootConfirmedForApiTestAt != null
  return state.stream.eventRootConfirmedForApiTestAt === finishedAt
}

/** Event root is set but not reconfirmed for the current API test sample. */
export function wizardEventRootStale(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  return state.stream.eventRootConfirmedForApiTestAt != null && !wizardEventRootConfirmed(state)
}

/** Sync position confirmed against the latest successful API test run. */
export function wizardCheckpointConfirmed(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  if (!wizardSyncPositionReady(state)) return false
  const finishedAt = state.apiTest.finishedAt
  if (finishedAt == null) return state.stream.checkpointConfirmedForApiTestAt != null
  return state.stream.checkpointConfirmedForApiTestAt === finishedAt
}

/** Path is set but not reconfirmed for the current API test sample. */
export function wizardRecordPathStale(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  return wizardRecordPathReady(state) && !wizardRecordPathConfirmed(state)
}

/** Checkpoint is set but not reconfirmed for the current API test sample. */
export function wizardCheckpointStale(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  return wizardSyncPositionReady(state) && !wizardCheckpointConfirmed(state)
}

/** Advanced custom extraction mode requires an explicit successful validate action. */
export function wizardCustomExtractionReady(state: Pick<WizardState, 'stream' | 'apiTest'>): boolean {
  if (state.stream.recordSelectionMode !== 'advanced') return true
  const finishedAt = state.apiTest.finishedAt
  const explicitValidated =
    state.stream.customExtractionValidationOk &&
    (finishedAt == null
      ? state.stream.customExtractionValidatedForApiTestAt != null
      : state.stream.customExtractionValidatedForApiTestAt === finishedAt)
  if (explicitValidated) return true

  // Compatibility path: in Advanced mode, allow progress when the latest sample
  // already has confirmed record/checkpoint selections and extracted events.
  // This avoids blocking operators who manually set valid custom paths but have
  // not clicked the explicit Validate action yet.
  const fallbackExtractedCount =
    state.apiTest.eventCount > 0
      ? state.apiTest.eventCount
      : Array.isArray(state.apiTest.extractedEvents)
        ? state.apiTest.extractedEvents.length
        : 0
  return wizardRecordPathConfirmed(state) && wizardCheckpointConfirmed(state) && fallbackExtractedCount > 0
}

/** Sample step gate — latest API test + confirmed record path + confirmed sync position. */
export function wizardSampleStepGateReady(state: WizardState): boolean {
  return (
    wizardApiTestReady(state) &&
    wizardRecordPathConfirmed(state) &&
    wizardCheckpointConfirmed(state) &&
    wizardCustomExtractionReady(state)
  )
}

/**
 * Incremental-fetch helper copy (amber boxes) is only for operators still configuring
 * record path / sync position. Hide it once sample + checkpoint setup is complete.
 */
export function wizardIncrementalFetchGuidanceComplete(state: WizardState): boolean {
  if (wizardSampleStepGateReady(state)) return true

  if (
    wizardRecordPathReady(state) &&
    wizardSyncPositionReady(state) &&
    state.stream.recordPathConfirmedForApiTestAt != null &&
    state.stream.checkpointConfirmedForApiTestAt != null
  ) {
    return true
  }

  if (state.stream.incrementalRequestTestedAt != null) return true

  return false
}

/** Human-readable reason the sample-step Next control stays disabled. */
export function wizardSampleStepBlockReason(state: WizardState): string {
  if (state.apiTest.status === 'running') {
    return 'Wait for Run Test to finish.'
  }
  if (!wizardApiTestReady(state)) {
    if (
      state.apiTest.status === 'success' &&
      (state.apiTest.eventCount === 0 ||
        (Array.isArray(state.apiTest.parsedJson) && state.apiTest.parsedJson.length === 0))
    ) {
      return 'Sample data is not available (no records). Union Schema cannot be generated.'
    }
    return 'Run a successful API Test on the Run Test tab.'
  }
  if (!wizardRecordPathReady(state)) {
    return 'Confirm Record Path on Record Selection (pick a detected candidate or event array in the tree).'
  }
  if (!wizardRecordPathConfirmed(state)) {
    return 'Reconfirm Record Path for the latest API Test sample.'
  }
  if (!wizardSyncPositionReady(state)) {
    return 'Select a Sync Position (checkpoint) field on Record Selection.'
  }
  if (!wizardCheckpointConfirmed(state)) {
    return 'Reconfirm Sync Position for the latest API Test sample.'
  }
  if (!wizardCustomExtractionReady(state)) {
    return 'Validate Custom extraction paths for the latest API Test sample.'
  }
  return 'Complete required fields on this step before continuing.'
}

/** At least one enabled delivery path before Deploy. */
export function wizardDestinationGateReady(state: Pick<WizardState, 'destinations'>): boolean {
  return state.destinations.routeDrafts.some((route) => route.enabled)
}

/** Human-readable reason the route-processing Next control stays disabled. */
export function wizardRouteProcessingStepBlockReason(state: Pick<WizardState, 'destinations'>): string {
  if (!wizardDestinationGateReady(state)) {
    return 'Enable at least one delivery path before continuing.'
  }
  return 'Complete required fields on this step before continuing.'
}

/** Whether the wizard may advance from the current top-level step. */
export function canAdvanceFromWizardStep(stepKey: WizardStepKey, state: WizardState): boolean {
  switch (stepKey) {
    case 'sample':
      return wizardSampleStepGateReady(state)
    case 'route_processing':
      return wizardDestinationGateReady(state)
    default:
      return true
  }
}

export type WizardStepReachableOptions = {
  /** Existing streams: all wizard sections are navigable without create-flow gates. */
  editMode?: boolean
}

/** Whether a stepper target is reachable (all prior required gates satisfied). */
export function wizardStepReachable(
  stepKey: WizardStepKey,
  state: WizardState,
  options?: WizardStepReachableOptions,
): boolean {
  if (options?.editMode) return true
  const targetIdx = WIZARD_STEP_ORDER.indexOf(stepKey)
  if (targetIdx < 0) return false
  for (let i = 0; i < targetIdx; i++) {
    const prior = WIZARD_STEP_ORDER[i]
    if (!canAdvanceFromWizardStep(prior, state)) return false
  }
  if (stepKey === 'deploy' && !wizardDestinationGateReady(state)) return false
  return true
}
