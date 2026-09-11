import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StepDeploy } from './step-deploy'
import { buildInitialState } from './wizard-state'

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [
    {
      id: 10,
      name: 'MSS Syslog',
      destination_type: 'SYSLOG_UDP',
      config_json: { host: '10.0.0.1', port: 514 },
      last_connectivity_test_success: true,
    },
    {
      id: 11,
      name: 'Stellar Cyber',
      destination_type: 'HTTP',
      config_json: { url: 'https://example.test' },
      last_connectivity_test_success: true,
    },
    {
      id: 12,
      name: 'Data Lake',
      destination_type: 'S3',
      config_json: { bucket: 'lake' },
      last_connectivity_test_success: true,
    },
  ]),
}))

vi.mock('../../../api/gdcRuntime', () => ({
  runStreamOnce: vi.fn(async () => ({ outcome: 'completed' })),
}))

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

function multiRouteReadyState() {
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

describe('StepDeploy', () => {
  it('renders Deployment Decision Center with seven checklist categories', () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-step-deploy')).toBeInTheDocument()
    expect(screen.getByText(/Deployment Decision Center/i)).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-connection')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-data')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-records')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-transform')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-protection')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-route_processing')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-delivery')).toBeInTheDocument()
  })

  it('shows READY status when configuration is deployable', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('deploy-status-label')).toHaveTextContent('READY')
  })

  it('shows NEEDS ATTENTION for incomplete wizard state', () => {
    render(
      <MemoryRouter>
        <StepDeploy state={buildInitialState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('deploy-status-label')).toHaveTextContent('NEEDS ATTENTION')
  })

  it('keeps configuration summary collapsed by default', () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    const summary = screen.getByTestId('deploy-configuration-summary')
    expect(summary).toBeInTheDocument()
    expect(screen.queryByText('Template materialization')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Configuration Summary' }))
    expect(summary.querySelector('dl')).toBeTruthy()
  })

  it('shows template materialization rows when expanded', () => {
    const state = readyState()
    state.connector.registryModuleId = 'crowdstrike'
    state.connector.selectedTemplateIds = ['detections', 'incidents']

    render(
      <MemoryRouter>
        <StepDeploy state={state} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Configuration Summary' }))
    expect(screen.getByTestId('deploy-template-materialization')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-template-row-detections')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-template-row-incidents')).toBeInTheDocument()
  })

  it('shows route processing summary in deploy aside', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    const summary = await screen.findByTestId('deploy-route-processing-summary')
    expect(summary).toHaveTextContent('Route Processing')
    expect(summary).toHaveTextContent('1 Configured')
    expect(summary).toHaveTextContent('Enabled routes')
    expect(summary).toHaveTextContent('1 / 1')
  })

  it('renders route readiness summary and health cards', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={multiRouteReadyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('deploy-route-readiness-summary')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('deploy-route-ready-count')).toHaveTextContent('3 / 3')
    })
    expect(screen.getByTestId('deploy-route-warning-count')).toHaveTextContent('0 / 3')
    expect(screen.getByTestId('deploy-route-readiness-row-r1')).toHaveTextContent('MSS Syslog')
    expect(screen.getByTestId('deploy-route-readiness-row-r2')).toHaveTextContent('Stellar Cyber')
    expect(screen.getByTestId('deploy-route-readiness-row-r3')).toHaveTextContent('Data Lake')
    expect(screen.getByTestId('deploy-route-health-cards')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-health-card-r1')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-health-card-r2')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-health-card-r3')).toBeInTheDocument()
  })

  it('shows per-route override list and shared processing applied count', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={multiRouteReadyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('deploy-route-processing-intent-notice')).toBeInTheDocument()
    expect(screen.getByText(/Route Processing Intent/i)).toBeInTheDocument()
    expect(await screen.findByTestId('deploy-route-override-list')).toBeInTheDocument()
    expect(await screen.findByTestId('deploy-route-override-Stellar Cyber')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-override-r2-transform')).toHaveTextContent('Transform — Override')
    expect(screen.getByTestId('deploy-route-override-r2-transform')).toHaveTextContent(
      'Persisted through route transform',
    )
    expect(screen.getByTestId('deploy-shared-processing-summary')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-shared-processing-applied-count')).toHaveTextContent('3 Routes')
  })

  it('shows Shared, Override, and Mixed badges on deploy route health cards', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={multiRouteReadyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    const card = await screen.findByTestId('deploy-route-health-card-r2')
    expect(card).toHaveTextContent('Override')
    expect(card).toHaveTextContent('Shared')
    await waitFor(() => {
      expect(screen.getByTestId('deploy-route-health-status-r2')).toHaveTextContent('Ready')
    })
    expect(screen.queryByTestId('deploy-route-intent-gaps-r2')).not.toBeInTheDocument()
  })

  it('shows split projected counts for override and mixed', async () => {
    const state = multiRouteReadyState()
    state.destinations.routeDrafts[1] = {
      ...state.destinations.routeDrafts[1]!,
      inherit: { transform: false, protection: false, classification: true, policy: true },
    }
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

    render(
      <MemoryRouter>
        <StepDeploy state={state} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('deploy-projected-count-transform')).toHaveTextContent('Override: 1')
    expect(screen.getByTestId('deploy-projected-count-protection')).toHaveTextContent('Mixed: 1')
  })

  it('shows data protection summary in expanded configuration summary', () => {
    const state = readyState()
    state.dataProtection.unknownNormalFieldPolicy = 'require_review'
    state.dataProtection.unknownSensitiveFieldPolicy = 'quarantine'
    state.dataProtection.intents = [
      { key: 'r1', detectedField: '$.email', protectionAction: 'mask_partial', deliveryBehavior: 'continue' },
    ]

    render(
      <MemoryRouter>
        <StepDeploy state={state} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Configuration Summary' }))
    const summary = screen.getByTestId('deploy-data-protection')
    expect(summary).toHaveTextContent('Schema Drift Policy')
    expect(summary).toHaveTextContent('Require Review')
    expect(summary).toHaveTextContent('Quarantine')
    expect(summary).toHaveTextContent('Protection Rules')
    expect(summary).toHaveTextContent('$.email')
    expect(summary).toHaveTextContent('Mask (partial)')
  })
})
