import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StepConfig } from './step-config'
import { buildInitialState, type WizardConfigState, type WizardState } from './wizard-state'

function withRequestBody(body: string): WizardState {
  const state = buildInitialState()
  return {
    ...state,
    stream: { ...state.stream, requestBody: body },
  }
}

function ControlledStepConfig({ onPatch }: { onPatch?: (patch: Partial<WizardConfigState>) => void }) {
  const [state, setState] = useState<WizardState>(() => buildInitialState())
  return (
    <StepConfig
      state={state}
      onChange={(patch) => {
        setState((prev) => ({ ...prev, stream: { ...prev.stream, ...patch } }))
        onPatch?.(patch)
      }}
    />
  )
}

describe('StepConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders SQL query instead of HTTP endpoint for DATABASE_QUERY', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    state.stream.sqlQuery = 'SELECT id, email, created_at FROM users'
    render(<StepConfig state={state} onChange={vi.fn()} />)
    expect(screen.getByLabelText('SQL Query')).toBeInTheDocument()
    expect((screen.getByLabelText('SQL Query') as HTMLTextAreaElement).value).toBe(
      'SELECT id, email, created_at FROM users',
    )
    expect(screen.queryByText('HTTP method')).not.toBeInTheDocument()
    expect(screen.queryByText('Endpoint path *')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('JSON Request Body')).not.toBeInTheDocument()
  })

  it('does not ask event array/checkpoint before API test', () => {
    const state = buildInitialState()
    render(<StepConfig state={state} onChange={vi.fn()} />)
    expect(screen.queryByText('Event array path')).not.toBeInTheDocument()
    expect(screen.queryByText('Checkpoint mode')).not.toBeInTheDocument()
    expect(screen.getByText('JSON Request Body (optional)')).toBeInTheDocument()
    expect(screen.queryByText('Use Example Body')).not.toBeInTheDocument()
    expect(screen.queryByText('Insert Sample Payload')).not.toBeInTheDocument()
    expect(screen.queryByText(/Stellar _search body/)).not.toBeInTheDocument()
  })

  it('does not show the incremental fetch templates section on the wizard HTTP Request step', () => {
    const state = buildInitialState()
    render(<StepConfig state={state} onChange={vi.fn()} />)
    expect(screen.queryByText('Incremental fetch templates')).not.toBeInTheDocument()
    expect(
      screen.queryAllByRole('button', { name: 'Use Incremental Fetch Template' }),
    ).toHaveLength(0)
    expect(screen.queryByText('Checkpoint & runtime variables')).not.toBeInTheDocument()
  })

  it('defaults the Body template selector to "None / Empty body" with an empty textarea', () => {
    const state = buildInitialState()
    render(<StepConfig state={state} onChange={vi.fn()} />)
    const select = screen.getByLabelText('Body template') as HTMLSelectElement
    expect(select.value).toBe('none')
    const textarea = screen.getByLabelText('JSON Request Body') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('renders the compact template variables list', () => {
    const state = buildInitialState()
    render(<StepConfig state={state} onChange={vi.fn()} />)
    expect(screen.getByText('{{checkpoint.last_timestamp}}')).toBeInTheDocument()
    expect(screen.getByText('{{checkpoint.cursor}}')).toBeInTheDocument()
    expect(screen.getByText('{{now}}')).toBeInTheDocument()
    expect(screen.getByText('{{start_ts}}')).toBeInTheDocument()
    expect(screen.getByText('{{end_ts}}')).toBeInTheDocument()
  })

  it('fills the textarea with the Elasticsearch / Stellar Search template when selected', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<[Partial<WizardConfigState>], void>()
    const state = buildInitialState()
    render(<StepConfig state={state} onChange={onChange} />)

    const select = screen.getByLabelText('Body template')
    await user.selectOptions(select, 'elasticsearch_stellar')

    expect(onChange).toHaveBeenCalledTimes(1)
    const patch = onChange.mock.calls[0]![0]
    expect(patch.requestBody).toContain('"size": 100')
    expect(patch.requestBody).toContain('"timestamp": "asc"')
    expect(patch.requestBody).toContain('"_id": "asc"')
    expect(patch.requestBody).toContain('"filter": []')
  })

  it('inserts checkpoint placeholder when Incremental Timestamp Polling is selected', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<[Partial<WizardConfigState>], void>()
    render(<StepConfig state={buildInitialState()} onChange={onChange} />)

    await user.selectOptions(screen.getByLabelText('Body template'), 'incremental_timestamp')

    const patch = onChange.mock.calls[0]![0]
    expect(patch.requestBody).toContain('{{checkpoint.last_timestamp}}')
    expect(patch.requestBody).toContain('{{now}}')
  })

  it('inserts cursor placeholder when Cursor Pagination is selected', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<[Partial<WizardConfigState>], void>()
    render(<StepConfig state={buildInitialState()} onChange={onChange} />)

    await user.selectOptions(screen.getByLabelText('Body template'), 'cursor_pagination')

    const patch = onChange.mock.calls[0]![0]
    expect(patch.requestBody).toContain('{{checkpoint.cursor}}')
  })

  it('clears the textarea when None / Empty body is selected after a template', async () => {
    const user = userEvent.setup()
    const patches: Array<Partial<WizardConfigState>> = []
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<ControlledStepConfig onPatch={(p) => patches.push(p)} />)

    await user.selectOptions(screen.getByLabelText('Body template'), 'empty_json')
    expect(patches[0]?.requestBody).toBe('{}')

    await user.selectOptions(screen.getByLabelText('Body template'), 'none')
    expect(patches[1]?.requestBody).toBe('')
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('replaces a non-empty body immediately without asking for confirmation', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<[Partial<WizardConfigState>], void>()
    const confirmSpy = vi.spyOn(window, 'confirm')
    const state = withRequestBody('{"keep":"me"}')
    render(<StepConfig state={state} onChange={onChange} />)

    await user.selectOptions(screen.getByLabelText('Body template'), 'security_events')

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledTimes(1)
    const patch = onChange.mock.calls[0]![0]
    expect(patch.requestBody).toContain('"severity"')
    expect(patch.requestBody).toContain('"high"')
    expect(patch.requestBody).toContain('"critical"')
  })
})
