import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StepDataProtection } from './step-data-protection'
import { buildInitialState } from './wizard-state'

describe('StepDataProtection', () => {
  it('renders data protection step without engine terminology', () => {
    const state = buildInitialState()
    state.apiTest.analysis = {
      sampleEvent: { email: 'a@b.c' },
      flatPreviewFields: ['$.email'],
      detectedArrays: [],
      detectedCheckpointCandidates: [],
      previewError: null,
    }

    render(<StepDataProtection state={state} onChange={vi.fn()} />)

    expect(screen.getByTestId('wizard-step-data-protection')).toBeInTheDocument()
    expect(screen.getByText(/Detected Fields/i)).toBeInTheDocument()
    expect(screen.getByText(/Protection Action/i)).toBeInTheDocument()
    expect(screen.getByText(/Delivery Behavior/i)).toBeInTheDocument()
    expect(screen.queryByText(/Remove from delivery/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Protection Engine/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Policy Engine/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Classification Engine/i)).not.toBeInTheDocument()
  })

  it('adds protection intent rows', () => {
    const onChange = vi.fn()
    const state = buildInitialState()
    render(<StepDataProtection state={state} onChange={onChange} />)

    fireEvent.click(screen.getByTestId('data-protection-add-row'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        intents: expect.arrayContaining([
          expect.objectContaining({
            detectedField: '',
            protectionAction: 'mask_partial',
            deliveryBehavior: 'continue',
          }),
        ]),
      }),
    )
  })

  it('lists protection actions without Remove from delivery', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      { key: 'row-1', detectedField: '$.email', protectionAction: 'mask_partial', deliveryBehavior: 'continue' },
    ]
    render(<StepDataProtection state={state} onChange={vi.fn()} />)

    const select = screen.getByDisplayValue('Mask (partial)')
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(options).toEqual(['Audit only', 'Mask (partial)', 'Mask (full)', 'Tokenize', 'Hash', 'Drop'])
    expect(options).not.toContain('Remove from delivery')
  })

  it('shows likely sensitive field suggestions', () => {
    const state = buildInitialState()
    state.apiTest.analysis = {
      sampleEvent: { user: { email: 'a@b.c' } },
      flatPreviewFields: ['$.user.email', '$.count'],
      detectedArrays: [],
      detectedCheckpointCandidates: [],
      previewError: null,
    }
    state.apiTest.extractedEvents = [{ user: { email: 'a@b.c' }, count: 1 }]
    state.apiTest.unionSchema = {
      total_events: 1,
      sensitive_suggestions_applied: true,
      fields: [
        {
          field_path: '$.user.email',
          field_type: 'string',
          occurrence_count: 1,
          sample_values: ['a@b.c'],
          suggested_sensitive_type: 'Likely Email',
          sensitivity_class: 'pii',
          detection_source: 'sensitive_detection_engine',
          detection_method: 'field_name',
        },
        {
          field_path: '$.count',
          field_type: 'integer',
          occurrence_count: 1,
          sample_values: [1],
        },
      ],
    }

    render(<StepDataProtection state={state} onChange={vi.fn()} />)
    expect(screen.getByTestId('data-protection-suggestions')).toBeInTheDocument()
    expect(screen.getByText('$.user.email')).toBeInTheDocument()
  })

  it('renders schema drift policy section with defaults', () => {
    const state = buildInitialState()
    render(<StepDataProtection state={state} onChange={vi.fn()} />)

    expect(screen.getByTestId('schema-drift-policy-section')).toBeInTheDocument()
    expect(screen.getByTestId('schema-drift-unknown-normal-field-policy-pass_through')).toBeChecked()
    expect(screen.getByTestId('schema-drift-unknown-sensitive-field-policy-auto_protect')).toBeChecked()
  })

  it('orders schema drift policy before protection rules', () => {
    const state = buildInitialState()
    render(<StepDataProtection state={state} onChange={vi.fn()} />)

    const drift = screen.getByTestId('schema-drift-policy-section')
    const rules = screen.getByTestId('protection-rules-section')
    expect(drift.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps schema drift settings outside protection rules section', () => {
    const state = buildInitialState()
    render(<StepDataProtection state={state} onChange={vi.fn()} />)

    const rules = screen.getByTestId('protection-rules-section')
    expect(rules).not.toContainElement(screen.getByTestId('schema-drift-unknown-normal-field-policy-group'))
    expect(rules).not.toContainElement(screen.getByTestId('schema-drift-unknown-sensitive-field-policy-group'))
  })

  it('persists schema drift policy changes via onChange', () => {
    const onChange = vi.fn()
    const state = buildInitialState()
    render(<StepDataProtection state={state} onChange={onChange} />)

    fireEvent.click(screen.getByTestId('schema-drift-unknown-normal-field-policy-quarantine'))
    expect(onChange).toHaveBeenCalledWith({ unknownNormalFieldPolicy: 'quarantine' })

    fireEvent.click(screen.getByTestId('schema-drift-unknown-sensitive-field-policy-require_review'))
    expect(onChange).toHaveBeenCalledWith({ unknownSensitiveFieldPolicy: 'require_review' })
  })

  it('adds route override for an intent field', () => {
    const onChange = vi.fn()
    const state = buildInitialState()
    state.dataProtection.intents = [
      { key: 'row-1', detectedField: '$.email', protectionAction: 'mask_partial', deliveryBehavior: 'continue' },
    ]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    render(<StepDataProtection state={state} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('route-override-add-row-1'))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        routeOverrides: expect.arrayContaining([
          expect.objectContaining({
            fieldPath: '$.email',
            routeDraftKey: 'r1',
            protectionAction: 'tokenize',
            enabled: true,
          }),
        ]),
      }),
    )
  })

  it('shows effective preview when overrides exist', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      { key: 'row-1', detectedField: '$.email', protectionAction: 'mask_partial', deliveryBehavior: 'continue' },
    ]
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
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 10, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
      { key: 'r2', destinationId: 20, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {} },
    ]

    render(<StepDataProtection state={state} onChange={vi.fn()} />)
    expect(screen.getByTestId('route-override-effective-preview-row-1')).toBeInTheDocument()
    expect(screen.getByText(/tokenize \(override\)/i)).toBeInTheDocument()
  })
})
