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

function s3State() {
  const state = buildInitialState()
  state.connector.connectorId = 11
  state.connector.sourceId = 22
  state.connector.sourceType = 'S3_OBJECT_POLLING'
  state.connector.hostBaseUrl = 'http://127.0.0.1:9000'
  state.stream.name = 'S3 stream'
  state.stream.maxObjectsPerRun = 5
  return state
}

describe('StepApiTest S3 actual sample', () => {
  beforeEach(() => {
    runConnectorAuthTest.mockReset()
    runHttpApiTest.mockReset()
  })

  it('uses actual parsed S3 events instead of synthetic preview objects', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    runConnectorAuthTest.mockResolvedValue({
      ok: true,
      auth_type: 'S3_OBJECT_POLLING',
      s3_bucket_exists: true,
      s3_auth_ok: true,
      s3_endpoint_reachable: true,
      s3_object_count_preview: 1,
      s3_sample_keys: ['events/alice.ndjson'],
    })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'S3_OBJECT_POLLING', url: 's3://lab/events', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 12,
        headers: {},
        raw_body: '[{"user":"alice","email":"alice@example.com","source_ip":"10.1.1.1"}]',
        parsed_json: [{ user: 'alice', email: 'alice@example.com', source_ip: '10.1.1.1', s3_key: 'events/alice.ndjson' }],
        content_type: 'application/json',
      },
      s3_event_count: 1,
      s3_sample_keys: ['events/alice.ndjson'],
    })

    render(
      <MemoryRouter>
        <StepApiTest state={s3State()} onChange={onChange} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: /run test/i }))

    expect(runConnectorAuthTest).toHaveBeenCalled()
    expect(runHttpApiTest).toHaveBeenCalled()
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toEqual({ max_objects_per_run: 5 })

    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(last.status).toBe('success')
    expect(last.ok).toBe(true)
    expect(last.s3ConnectivityPassed).toBe(true)
    expect(JSON.stringify(last)).not.toContain('s3-wizard-preview')
    expect(JSON.stringify(last.analysis)).toContain('alice@example.com')
    expect((last.analysis as { sampleEvent?: Record<string, unknown> }).sampleEvent).toMatchObject({
      user: 'alice',
      email: 'alice@example.com',
      source_ip: '10.1.1.1',
    })
  })

  it('keeps connection success and does not fabricate schema when S3 has no records', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    runConnectorAuthTest.mockResolvedValue({
      ok: true,
      auth_type: 'S3_OBJECT_POLLING',
      s3_bucket_exists: true,
      s3_auth_ok: true,
      s3_endpoint_reachable: true,
      s3_object_count_preview: 0,
      s3_sample_keys: [],
    })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'S3_OBJECT_POLLING', url: 's3://lab', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 8,
        headers: {},
        raw_body: '[]',
        parsed_json: [],
        content_type: 'application/json',
      },
      s3_event_count: 0,
      s3_sample_keys: [],
    })

    render(
      <MemoryRouter>
        <StepApiTest state={s3State()} onChange={onChange} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: /run test/i }))

    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(last.status).toBe('success')
    expect(last.ok).toBe(false)
    expect(last.s3ConnectivityPassed).toBe(true)
    expect(last.unionSchema).toBeNull()
    expect(last.extractedEvents).toEqual([])
    expect(String(last.errorMessage)).toMatch(/no records/i)
    expect(JSON.stringify(last)).not.toContain('s3-wizard-preview')
  })
})
