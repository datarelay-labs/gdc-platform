import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { buildInitialState } from './wizard-state'
import { StepApiTest } from './step-api-test'

function renderStep(state: ReturnType<typeof buildInitialState>) {
  return render(
    <MemoryRouter>
      <StepApiTest state={state} onChange={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('StepApiTest copy', () => {
  it('renders HTTP-specific lead and idle copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'HTTP_API_POLLING'
    renderStep(state)
    expect(screen.getByText(/execute the configured HTTP request/i)).toBeInTheDocument()
    expect(
      screen.getByText(/complete the HTTP endpoint path on the Stream Configuration step/i),
    ).toBeInTheDocument()
  })

  it('does not show JSON tree or formatted response on Run Test', () => {
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.eventCount = 3
    state.apiTest.statusCode = 200
    state.apiTest.finishedAt = Date.now()
    state.apiTest.startedAt = state.apiTest.finishedAt - 120
    state.apiTest.parsedJson = { Records: [{ id: 1 }] }
    state.apiTest.rawResponse = state.apiTest.parsedJson

    renderStep(state)

    expect(screen.getByTestId('wizard-run-test-panel')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-run-test-metrics')).toBeInTheDocument()
    expect(screen.queryByText('Formatted JSON')).not.toBeInTheDocument()
    expect(screen.queryByText('Raw Response')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-record-selection-json-tree')).not.toBeInTheDocument()
  })

  it('renders remote-file-specific lead copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'REMOTE_FILE_POLLING'
    renderStep(state)
    expect(screen.getByText(/SSH\/SFTP/i)).toBeInTheDocument()
    expect(screen.getByText(/matched files/i)).toBeInTheDocument()
  })

  it('renders database-specific lead copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    renderStep(state)
    expect(screen.getByText(/SELECT-only/i)).toBeInTheDocument()
    expect(screen.getByText(/checkpoint fields/i)).toBeInTheDocument()
  })

  it('renders S3-specific lead copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    renderStep(state)
    expect(screen.getByText(/Verifies S3 connectivity for the configured bucket/i)).toBeInTheDocument()
    expect(screen.getByText(/Union Schema is generated only from those parsed events/i)).toBeInTheDocument()
  })
})
