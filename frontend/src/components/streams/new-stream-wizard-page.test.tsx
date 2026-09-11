import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { createStream } from '../../api/gdcStreams'
import { createRoute } from '../../api/gdcRoutes'
import { startRuntimeStream } from '../../api/gdcRuntime'
import { NewStreamWizardPage } from './new-stream-wizard-page'
import { persistWizardRouteProtection } from './wizard/wizard-route-protection-persist'
import { StepMapping } from './wizard/step-mapping'
import { EnrichmentRulesEditor } from './wizard/enrichment-rules-editor'
import { FinalEventPreviewPanel } from '../mappings/final-event-preview-panel'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard/wizard-state'
import { WIZARD_DRAFT_KEY_V2 } from './wizard/wizard-draft-migration'
import { computeDeployReadiness } from './wizard/wizard-deploy-readiness'

vi.mock('../../api/gdcStreams', () => ({
  createStream: vi.fn(),
  updateStream: vi.fn(async () => ({ id: 42, name: 'Created', status: 'STOPPED' })),
  fetchStreamById: vi.fn(async () => ({ id: 42, name: 'Created', status: 'STOPPED', config_json: {} })),
}))

vi.mock('../../api/gdcRuntimeUi', () => ({
  saveStreamMappingUiConfigStrict: vi.fn(),
}))

vi.mock('../../api/gdcRoutes', () => ({
  createRoute: vi.fn(),
}))

vi.mock('../../api/gdcRuntime', () => ({
  startRuntimeStream: vi.fn(),
}))

vi.mock('../../api/gdcCatalog', () => ({
  fetchCatalogSnapshot: vi.fn(async () => ({ connectors: [], sources: [], apiBacked: false })),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => []),
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcSources', () => ({
  fetchSourceById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
}))

vi.mock('./wizard/wizard-route-protection-persist', () => ({
  persistWizardRouteProtection: vi.fn(async () => ({ saved: true, routesUpdated: 3, errors: [] })),
}))

vi.mock('./wizard/wizard-classification-persist', () => ({
  persistWizardRouteClassification: vi.fn(async () => ({ saved: true, routesUpdated: 0, errors: [] })),
}))

vi.mock('./wizard/wizard-failover-persist', () => ({
  persistWizardFailover: vi.fn(async () => ({ saved: true, routesUpdated: 0, errors: [] })),
}))

vi.mock('./wizard/wizard-transform-persist', () => ({
  persistWizardRouteTransforms: vi.fn(async () => ({ saved: true, routesUpdated: 0, errors: [] })),
}))

vi.mock('./wizard/wizard-governance-persist', () => ({
  persistWizardStreamGovernance: vi.fn(async () => ({ saved: true, errors: [], warnings: [] })),
}))

vi.mock('./wizard/wizard-policy-persist', () => ({
  persistWizardSharedAndRoutePolicy: vi.fn(async () => ({
    saved: true,
    streamRulesUpserted: 0,
    routeRulesUpserted: 0,
    errors: [],
  })),
}))

vi.mock('./wizard/wizard-union-schema-persist', () => ({
  persistWizardUnionSchema: vi.fn(async () => ({ saved: true, errors: [] })),
}))

describe('NewStreamWizardPage v5.2 5-step', () => {
  it('renders 5-step stepper labels with Route Processing', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')
    localStorage.removeItem('gdc-stream-wizard-draft-v1')

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    const stepper = screen.getByTestId('wizard-stepper')
    expect(stepper.textContent).toContain('Connect')
    expect(stepper.textContent).toContain('Sample & Record Selection')
    expect(stepper.textContent).toContain('Route Processing')
    expect(stepper.textContent).not.toContain('Data Protection')
    expect(stepper.textContent).toContain('Destinations')
    expect(stepper.textContent).toContain('Deploy')
    expect(stepper.textContent).not.toContain('Enrichment')
    expect(stepper.textContent).not.toContain('Review & Create')
  })

  it('shows connect step with Charter v3 connect tabs', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-connector')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-request')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-advanced')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-connect-tab-authentication')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-connect-tab-connection')).not.toBeInTheDocument()
  })

  it('StepMapping renders Basic, Advanced, and Expert tabs with wizard sample', () => {
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.parsedJson = { events: [{ id: 'evt-1', message: 'hello' }] }
    state.apiTest.extractedEvents = [{ id: 'evt-1', message: 'hello' }]
    state.apiTest.eventCount = 1
    state.apiTest.finishedAt = Date.now()
    state.stream.useWholeResponseAsEvent = true

    render(
      <StepMapping
        state={state}
        onChangeMapping={() => {}}
        onChangeMappingMode={() => {}}
        onChangeFullEventJsonata={() => {}}
        onChangeFullEventRegexConfigJson={() => {}}
        transformRules={[]}
        onChangeTransformRules={() => {}}
      />,
    )

    expect(screen.getByRole('tab', { name: /Basic · JSONPath/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Advanced · JSONata/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Expert · Full Event Regex/i })).toBeInTheDocument()
  })

  it('shows deploy decision center on deploy step after resuming draft', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')

    const state = buildInitialState()
    const finishedAt = Date.now()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Deploy Test'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.checkpointFieldType = 'datetime'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.apiTest.eventCount = 1
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 1,
        enabled: true,
        failurePolicy: 'RETRY_THEN_DLQ',
        rateLimitJson: '{}',
      },
    ]
    localStorage.setItem(
      'gdc-stream-wizard-draft-v2',
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-draft-banner')).toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-draft-resume'))

    expect(screen.getByTestId('wizard-step-deploy')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-create-and-start')).toHaveTextContent('Create & Start Stream')
    expect(screen.queryByRole('heading', { name: 'Review' })).not.toBeInTheDocument()
  })

  it('does not auto-restore draft on /streams/new', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    state.connector.connectorId = 42
    state.connector.connectorName = 'Saved Connector'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'connect', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-draft-banner')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.queryByText('Draft restored from local storage.')).not.toBeInTheDocument()
  })

  it('shows Resume draft and Start fresh actions when a draft exists', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const state = buildInitialState()
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'connect', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Saved draft found.')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-draft-resume')).toHaveTextContent('Resume draft')
    expect(screen.getByTestId('wizard-draft-start-fresh')).toHaveTextContent('Start fresh')
  })

  it('resume draft restores connector selection', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const state = buildInitialState()
    state.connector.connectorId = 77
    state.connector.connectorName = 'Restored Connector'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'connect', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    await waitFor(() => {
      expect(screen.getByText('Draft restored from local storage.')).toBeInTheDocument()
    })
  })

  it('start fresh clears saved draft and keeps empty connect step', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const state = buildInitialState()
    state.connector.connectorId = 88
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'sample', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-start-fresh'))

    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-draft-banner')).not.toBeInTheDocument()
  })

  it('enables Next on sample step when draft has paths and a successful API test', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    const finishedAt = Date.now()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'sample', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(screen.getByRole('button', { name: /Next: Destinations/i })).toBeEnabled()
  })

  it('keeps Next disabled on sample step when checkpoint is missing', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    const finishedAt = Date.now()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.stream.eventArrayPath = '$.events'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'sample', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(screen.getByRole('button', { name: /Next: Destinations/i })).toBeDisabled()
  })

  it('create another stream clears saved draft', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const finishedAt = Date.now()
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Done Stream'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 1, enabled: true, failurePolicy: 'RETRY_THEN_DLQ', rateLimitJson: {} },
    ]
    state.outcome = {
      streamId: 999,
      routeId: 1,
      routeIds: [1],
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
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    await user.click(screen.getByRole('button', { name: /Create Another Stream/i }))

    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
  })

  it('blocks deploy create after latest API test failure', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const finishedAt = Date.now()
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Deploy Test'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'error'
    state.apiTest.ok = false
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 1, enabled: true, failurePolicy: 'RETRY_THEN_DLQ', rateLimitJson: {} },
    ]

    const user = userEvent.setup()
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(computeDeployReadiness(state).canCreate).toBe(false)
    expect(screen.getByTestId('deploy-create-and-start')).toBeDisabled()
  })

  it('blocks create deploy when protection override has no persistable rule', async () => {
    vi.clearAllMocks()
    localStorage.setItem('gdc-platform-persona', 'connector')
    const finishedAt = Date.now()
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Incomplete Protection'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.checkpointFieldType = 'datetime'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.statusCode = 200
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.extractedEvents = [{ id: '1' }]
    state.apiTest.finishedAt = finishedAt
    state.apiTest.eventCount = 20
    state.apiTest.unionSchema = {
      total_events: 20,
      fields: [{ field_path: '$.id', field_type: 'string', occurrence_count: 20, sample_values: ['1'] }],
    }
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.destinationApiBacked = true
    state.destinations.routeDrafts = [
      {
        key: 'route-b',
        destinationId: 20,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: false, classification: true, policy: true },
      },
    ]

    const user = userEvent.setup()
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(computeDeployReadiness(state).canCreate).toBe(false)
    expect(screen.getByTestId('deploy-create-and-start')).toBeDisabled()
    expect(createStream).not.toHaveBeenCalled()
    expect(persistWizardRouteProtection).not.toHaveBeenCalled()
  })

  it('uses Transform terminology in enrichment rules editor', () => {
    render(<EnrichmentRulesEditor rules={[]} onChange={() => {}} />)
    expect(screen.getByText('Transform rules')).toBeInTheDocument()
    expect(screen.queryByText(/Enrichment Rules/i)).not.toBeInTheDocument()
  })

  it('persists route protection after create wizard routes receive IDs', async () => {
    vi.clearAllMocks()
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    const finishedAt = Date.now()
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Create Protection Persist'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.checkpointFieldType = 'datetime'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.statusCode = 200
    state.apiTest.parsedJson = { events: [{ id: '1', email: 'a@b.c', api_key: 'secret' }] }
    state.apiTest.extractedEvents = [{ id: '1', email: 'a@b.c', api_key: 'secret' }]
    state.apiTest.finishedAt = finishedAt
    state.apiTest.eventCount = 1
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.destinationApiBacked = true
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
      },
      {
        key: 'route-c',
        destinationId: 30,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: false, classification: true, policy: true },
        overrides: {
          protection: {
            intents: [
              {
                key: 'i2',
                detectedField: '$.api_key',
                protectionAction: 'drop_field',
                deliveryBehavior: 'continue',
              },
            ],
            unknownNormalFieldPolicy: 'pass_through',
            unknownSensitiveFieldPolicy: 'auto_protect',
          },
        },
      },
    ]

    vi.mocked(createStream).mockResolvedValue({
      id: 42,
      name: 'Create Protection Persist',
      connector_id: 1,
      source_id: 1,
      status: 'STOPPED',
      config_json: {},
    })
    vi.mocked(createRoute)
      .mockResolvedValueOnce({ id: 201, stream_id: 42, destination_id: 10, enabled: true })
      .mockResolvedValueOnce({ id: 202, stream_id: 42, destination_id: 20, enabled: true })
      .mockResolvedValueOnce({ id: 203, stream_id: 42, destination_id: 30, enabled: true })
    vi.mocked(startRuntimeStream).mockResolvedValue({
      stream_id: 42,
      enabled: true,
      status: 'RUNNING',
      action: 'start',
      message: 'started',
    })

    const user = userEvent.setup()
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(screen.getByTestId('deploy-create-and-start')).toBeEnabled()
    await user.click(screen.getByTestId('deploy-create-and-start'))

    await waitFor(() => {
      expect(createStream).toHaveBeenCalled()
      expect(createRoute).toHaveBeenCalledTimes(3)
      expect(persistWizardRouteProtection).toHaveBeenCalledWith(
        expect.objectContaining({
          destinations: expect.objectContaining({
            routeDrafts: expect.arrayContaining([
              expect.objectContaining({ key: 'route-a', inherit: expect.objectContaining({ protection: true }) }),
              expect.objectContaining({ key: 'route-b', inherit: expect.objectContaining({ protection: false }) }),
              expect.objectContaining({ key: 'route-c', inherit: expect.objectContaining({ protection: false }) }),
            ]),
          }),
        }),
        [201, 202, 203],
      )
    })
    const persistOrder = vi.mocked(persistWizardRouteProtection).mock.invocationCallOrder[0]
    const lastRouteOrder = vi.mocked(createRoute).mock.invocationCallOrder[2]
    expect(persistOrder).toBeGreaterThan(lastRouteOrder)
  })

  it('uses final event preview terminology', () => {
    render(
      <FinalEventPreviewPanel
        preview={{
          loading: false,
          error: null,
          mapped: null,
          final: null,
          validationWarnings: [],
        }}
        rawSampleEvent={{ id: '1' }}
        eventCount={1}
        sampleEventIndex={0}
        onSampleIndexChange={() => {}}
        onRefresh={() => {}}
        localWarnings={[]}
      />,
    )
    expect(screen.getByRole('button', { name: /^Transformed$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Final event$/i })).toBeInTheDocument()
    expect(screen.queryByText(/^Mapped event$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Enriched final event/i)).not.toBeInTheDocument()
  })
})
