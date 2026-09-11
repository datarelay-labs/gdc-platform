import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInitialState } from './wizard-state'
import { StepApiTest } from './step-api-test'

const runConnectorAuthTest = vi.fn()
const runHttpApiTest = vi.fn()

vi.mock('../../../api/gdcRuntimePreview', () => ({
  runConnectorAuthTest: (...args: unknown[]) => runConnectorAuthTest(...args),
  runHttpApiTest: (...args: unknown[]) => runHttpApiTest(...args),
}))

function dbState() {
  const state = buildInitialState()
  state.connector.connectorId = 11
  state.connector.sourceId = 22
  state.connector.sourceType = 'DATABASE_QUERY'
  state.connector.hostBaseUrl = 'db.internal'
  state.stream.name = 'DB stream'
  state.stream.sqlQuery = 'SELECT id, email, created_at FROM users'
  state.stream.endpoint = ''
  return state
}

describe('StepApiTest DATABASE_QUERY actual sample', () => {
  beforeEach(() => {
    runConnectorAuthTest.mockReset()
    runHttpApiTest.mockReset()
  })

  it('disables Run Test until SQL query is configured', () => {
    const state = dbState()
    state.stream.sqlQuery = ''
    render(
      <MemoryRouter>
        <StepApiTest state={state} onChange={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: /run test/i })).toBeDisabled()
  })

  it('uses actual database rows instead of synthetic preview objects', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    runConnectorAuthTest.mockResolvedValue({
      ok: true,
      auth_type: 'DATABASE_QUERY',
      db_reachable: true,
      db_auth_ok: true,
    })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'DATABASE_QUERY', url: 'postgresql://db.internal/app', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 18,
        headers: {},
        raw_body: '[{"id":1,"email":"a@example.com","created_at":"2026-01-01T00:00:00Z"}]',
        parsed_json: [{ id: 1, email: 'a@example.com', created_at: '2026-01-01T00:00:00Z' }],
        content_type: 'application/json',
      },
      database_query_row_count: 1,
      database_query_sample_rows: [{ id: 1, email: 'a@example.com', created_at: '2026-01-01T00:00:00Z' }],
    })

    render(
      <MemoryRouter>
        <StepApiTest state={dbState()} onChange={onChange} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: /run test/i }))

    expect(runConnectorAuthTest).toHaveBeenCalled()
    expect(runHttpApiTest).toHaveBeenCalled()
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toEqual({
      query: 'SELECT id, email, created_at FROM users',
      query_timeout_seconds: 30,
    })
    expect(streamConfig).not.toHaveProperty('endpoint')

    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(last.status).toBe('success')
    expect(last.ok).toBe(true)
    expect(last.dbConnectivityPassed).toBe(true)
    expect(JSON.stringify(last.analysis)).toContain('a@example.com')
    expect((last.analysis as { sampleEvent?: Record<string, unknown> }).sampleEvent).toMatchObject({
      id: 1,
      email: 'a@example.com',
      created_at: '2026-01-01T00:00:00Z',
    })
  })

  it('keeps connection/query success and does not fabricate schema when query returns no rows', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    runConnectorAuthTest.mockResolvedValue({
      ok: true,
      auth_type: 'DATABASE_QUERY',
      db_reachable: true,
      db_auth_ok: true,
    })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'DATABASE_QUERY', url: 'postgresql://db.internal/app', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 9,
        headers: {},
        raw_body: '[]',
        parsed_json: [],
        content_type: 'application/json',
      },
      database_query_row_count: 0,
      database_query_sample_rows: [],
    })

    render(
      <MemoryRouter>
        <StepApiTest state={dbState()} onChange={onChange} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: /run test/i }))

    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(last.status).toBe('success')
    expect(last.ok).toBe(false)
    expect(last.dbConnectivityPassed).toBe(true)
    expect(last.unionSchema).toBeNull()
    expect(last.extractedEvents).toEqual([])
    expect(String(last.errorMessage)).toMatch(/no records/i)
  })
})
