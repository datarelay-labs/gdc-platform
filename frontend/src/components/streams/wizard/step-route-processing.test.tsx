import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StepRouteProcessing } from './step-route-processing'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'
import { ROUTE_PROCESSING_COPY } from '../route-processing/route-processing-labels'

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [
    {
      id: 10,
      name: 'Syslog Primary',
      destination_type: 'SYSLOG_UDP',
      config_json: { host: '10.0.0.1', port: 514 },
      last_connectivity_test_success: true,
    },
    {
      id: 20,
      name: 'SIEM Archive',
      destination_type: 'SYSLOG_TCP',
      config_json: { host: '10.0.0.2', port: 514 },
      last_connectivity_test_success: true,
    },
    {
      id: 30,
      name: 'Webhook Notify',
      destination_type: 'WEBHOOK',
      config_json: { url: 'https://example.invalid/hook' },
      last_connectivity_test_success: true,
    },
  ]),
}))

function readyState() {
  const state = buildInitialState()
  const finishedAt = Date.now()
  state.apiTest.status = 'success'
  state.apiTest.ok = true
  state.apiTest.parsedJson = { events: [{ id: 'evt-1', message: 'hello' }] }
  state.apiTest.extractedEvents = [{ id: 'evt-1', message: 'hello' }]
  state.apiTest.eventCount = 1
  state.apiTest.finishedAt = finishedAt
  state.stream.useWholeResponseAsEvent = true
  state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
  state.destinations.routeDrafts = [
    {
      key: 'r1',
      destinationId: 10,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
      inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    },
  ]
  return state
}

describe('StepRouteProcessing', () => {
  it('renders shared processing editor, route list, and route detail panel', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-step-route-processing')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-section')).toBeInTheDocument()
    expect(screen.queryByText('Global Processing')).not.toBeInTheDocument()
    expect(screen.getByText('Shared Processing')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-route-count')).toHaveTextContent('Applied to 1 Route')
    expect(screen.getByTestId('shared-processing-editor')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-shared-transform')).toBeInTheDocument()
    expect(screen.queryByTestId('shared-processing-edit-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('route-processing-split-layout')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-list')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-detail-panel')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('route-processing-list-card-r1')).toHaveTextContent('Syslog Primary')
    })
    expect(screen.getByTestId('route-processing-list-card-r1')).toHaveTextContent('Shared')
  })

  it('shows shared processing concern tabs and switches editors', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-processing-shared-transform')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('shared-processing-tab-data_protection'))
    expect(screen.getByTestId('wizard-step-data-protection')).toBeInTheDocument()
    expect(screen.getByTestId('schema-drift-policy-section')).toBeInTheDocument()
    expect(screen.getByTestId('protection-rules-section')).toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-shared-transform')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('shared-processing-tab-classification'))
    expect(screen.getByTestId('shared-classification-editor')).toBeInTheDocument()
    expect(screen.getByTestId('shared-classification-default-level')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('shared-processing-tab-policy'))
    expect(screen.getByTestId('shared-policy-editor')).toBeInTheDocument()
    expect(screen.getByTestId('shared-policy-restricted-response')).toBeInTheDocument()
    expect(screen.getByTestId('shared-policy-confidential-response')).toBeInTheDocument()
  })

  it('shows first-class classification and policy tabs in route override mode', async () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: false, protection: false, classification: false, policy: false },
    }

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-detail-tab-transform')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-data_protection')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-classification')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-policy')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-delivery')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('route-detail-tab-data_protection'))
    expect(screen.getByTestId('route-detail-data-protection')).toBeInTheDocument()
    expect(screen.getByTestId('schema-drift-policy-section')).toBeInTheDocument()
    expect(screen.getByTestId('protection-rules-section')).toBeInTheDocument()
    expect(screen.queryByTestId('route-default-delivery-behavior-section')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('route-detail-tab-classification'))
    expect(screen.getByTestId('route-detail-classification')).toBeInTheDocument()
    expect(screen.getByTestId('route-classification-floor')).toBeInTheDocument()
    expect(screen.getByTestId('route-classification-rules')).toBeInTheDocument()
    expect(screen.getByTestId('route-classification-rule-add')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('route-detail-tab-policy'))
    expect(screen.getByTestId('route-detail-policy')).toBeInTheDocument()
    expect(screen.getByTestId('route-policy-override-section')).toBeInTheDocument()
    expect(screen.getByTestId('route-policy-delivery-behavior')).toBeInTheDocument()
  })

  it('shows processing concern statuses and delivery on route card', async () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: false, protection: true, classification: true, policy: false },
    }

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    const card = await screen.findByTestId('route-processing-list-card-r1')
    expect(card).toHaveTextContent('Transform')
    expect(card).toHaveTextContent('Override')
    expect(card).toHaveTextContent('Shared')
    expect(card).toHaveTextContent('Delivery')
    expect(within(card).getByTestId('route-card-delivery-status')).toHaveTextContent('Enabled')
  })

  it('shows active route badge and detail header with destination', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    const card = await screen.findByTestId('route-processing-list-card-r1')
    expect(card).toHaveAttribute('aria-current', 'true')
    expect(card).toHaveTextContent('Selected')
    expect(screen.getByTestId('route-processing-detail-header')).toBeInTheDocument()
    expect(screen.getByTestId('route-header-processing-statuses')).toBeInTheDocument()
    expect(await screen.findByTestId('route-detail-destination')).toHaveTextContent('Destination: Syslog Primary')
    expect(
      within(screen.getByTestId('route-processing-workspace')).getByTestId('route-processing-output-workspace'),
    ).toBeInTheDocument()
  })

  it('shows all five route stages when using shared processing', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-processing-mode')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-mode-shared')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('route-shared-mode-summary')).toHaveTextContent(ROUTE_PROCESSING_COPY.routeUsesShared)
    expect(screen.getByTestId('route-detail-tab-transform')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-data_protection')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-classification')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-policy')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-delivery')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-transform')).toBeInTheDocument()
    expect(screen.getByTestId('route-inherit-transform')).toBeInTheDocument()
  })

  it('shows override editors when override mode is selected', async () => {
    const onChangeDestinations = vi.fn()
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={onChangeDestinations}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-processing-mode-override'))
    expect(onChangeDestinations).toHaveBeenCalledWith(
      expect.objectContaining({
        routeDrafts: [
          expect.objectContaining({
            key: 'r1',
            inherit: { transform: false, protection: false, classification: false, policy: false },
          }),
        ],
      }),
    )
  })

  it('patches route draft when enabled is toggled in delivery tab', async () => {
    const onChangeDestinations = vi.fn()
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={onChangeDestinations}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-detail-tab-delivery'))
    fireEvent.click(screen.getByTestId('route-processing-enabled-r1'))
    expect(onChangeDestinations).toHaveBeenCalledWith(
      expect.objectContaining({
        routeDrafts: [expect.objectContaining({ key: 'r1', enabled: false })],
      }),
    )
  })

  it('exposes failure policy and rate limit controls in delivery tab', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-detail-tab-delivery'))
    expect(await screen.findByTestId('route-processing-failure-policy-r1')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-eps-r1')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-burst-r1')).toBeInTheDocument()
    expect(screen.getByTestId('route-failover-configuration')).toBeInTheDocument()
    expect(screen.getByTestId('route-failover-enabled')).toBeInTheDocument()
    expect(screen.getByTestId('route-failover-primary')).toHaveTextContent('Syslog Primary')
    expect(screen.getByTestId('route-failover-standby')).toBeInTheDocument()
  })

  it('lets the operator enable failover and choose a standby destination', async () => {
    const onChangeDestinations = vi.fn()
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      failover: { enabled: true, secondaryDestinationId: null },
    }
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={onChangeDestinations}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-detail-tab-delivery'))
    const enabled = await screen.findByTestId('route-failover-enabled')
    expect(enabled).toBeChecked()
    const standby = screen.getByTestId('route-failover-standby')
    await waitFor(() => {
      expect(standby).not.toBeDisabled()
      expect(within(standby).getByRole('option', { name: 'SIEM Archive' })).toBeInTheDocument()
    })
    fireEvent.change(standby, { target: { value: '20' } })
    expect(onChangeDestinations).toHaveBeenCalledWith(
      expect.objectContaining({
        routeDrafts: [
          expect.objectContaining({
            failover: expect.objectContaining({ enabled: true, secondaryDestinationId: 20 }),
          }),
        ],
      }),
    )
  })

  it('shows protection override status when route has field overrides', () => {
    const state = readyState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    const card = screen.getByTestId('route-processing-list-card-r1')
    expect(card).toHaveTextContent('Override')
  })

  it('shows empty route message when no routes configured', () => {
    const state = readyState()
    state.destinations.routeDrafts = []

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-processing-empty')).toHaveTextContent(ROUTE_PROCESSING_COPY.noRoutes)
    expect(screen.getByTestId('route-processing-empty')).toHaveTextContent(ROUTE_PROCESSING_COPY.noRoutesHint)
  })

  it('exposes shared transform, protection, classification, and policy cards', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('shared-processing-card-transform')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-card-data_protection')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-card-classification')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-card-policy')).toBeInTheDocument()
  })

  it('patches shared classification and policy through onChangeDataPolicy', async () => {
    const onChangeDataPolicy = vi.fn()
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDataPolicy={onChangeDataPolicy}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('shared-processing-tab-classification'))
    fireEvent.change(screen.getByTestId('shared-classification-default-level'), { target: { value: 'RESTRICTED' } })
    expect(onChangeDataPolicy).toHaveBeenCalledWith({ defaultClassification: 'RESTRICTED' })

    fireEvent.click(screen.getByTestId('shared-processing-tab-policy'))
    fireEvent.change(screen.getByTestId('shared-policy-restricted-response'), { target: { value: 'block' } })
    expect(onChangeDataPolicy).toHaveBeenCalledWith({ restrictedResponse: 'block' })
  })

  it('renders 1 stream / 3 routes inherit, protection override, and classification+policy override', async () => {
    const state = readyState()
    state.destinations.routeDrafts = [
      {
        key: 'route-a',
        destinationId: 10,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: true },
      },
      {
        key: 'route-b',
        destinationId: 20,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: false, classification: true, policy: true },
      },
      {
        key: 'route-c',
        destinationId: 30,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: false, policy: false },
        overrides: { policy: { deliveryBehavior: 'quarantine' } },
      },
    ]
    state.dataProtection.routeClassificationOverrides = [
      {
        key: 'c1',
        routeDraftKey: 'route-c',
        classificationLevel: 'RESTRICTED',
        enabled: true,
      },
    ]

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    const routeA = await screen.findByTestId('route-processing-list-card-route-a')
    const routeB = screen.getByTestId('route-processing-list-card-route-b')
    const routeC = screen.getByTestId('route-processing-list-card-route-c')
    expect(routeA).toHaveTextContent('Shared')
    expect(within(routeB).getByText('Override')).toBeInTheDocument()
    expect(within(routeC).getAllByText('Override').length).toBeGreaterThanOrEqual(1)

    fireEvent.click(routeC)
    fireEvent.click(screen.getByTestId('route-detail-tab-classification'))
    expect(screen.getByTestId('route-classification-floor')).toHaveValue('RESTRICTED')
    expect(screen.getByTestId('route-classification-rules')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('route-detail-tab-policy'))
    expect(screen.getByTestId('route-policy-delivery-behavior')).toHaveValue('quarantine')
    fireEvent.click(screen.getByTestId('route-detail-tab-delivery'))
    expect(screen.getByTestId('route-processing-enabled-route-c')).toBeInTheDocument()
  })

  it('lets the operator add a route classification rule on override', () => {
    const onChangeDestinations = vi.fn()
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: true, protection: true, classification: false, policy: true },
    }
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={onChangeDestinations}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-detail-tab-classification'))
    fireEvent.click(screen.getByTestId('route-classification-rule-add'))
    expect(onChangeDestinations).toHaveBeenCalledWith(
      expect.objectContaining({
        routeDrafts: [
          expect.objectContaining({
            overrides: expect.objectContaining({
              classification: expect.objectContaining({
                rules: [expect.objectContaining({ sensitivityClass: 'pii', classificationLevel: 'CONFIDENTIAL' })],
              }),
            }),
          }),
        ],
      }),
    )
  })
})
