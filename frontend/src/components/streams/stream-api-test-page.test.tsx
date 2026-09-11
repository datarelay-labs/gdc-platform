import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MappingUIConfigResponse, StreamRead } from '../../api/types/gdcApi'
import { StreamApiTestPage } from './stream-api-test-page'

const {
  fetchStreamById,
  fetchStreamMappingUiConfig,
  fetchConnectorById,
  runHttpApiTest,
  runConnectorAuthTest,
  runExtractionValidate,
} = vi.hoisted(() => ({
  fetchStreamById: vi.fn(),
  fetchStreamMappingUiConfig: vi.fn(),
  fetchConnectorById: vi.fn(),
  runHttpApiTest: vi.fn(),
  runConnectorAuthTest: vi.fn(),
  runExtractionValidate: vi.fn(),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: (...args: unknown[]) => fetchStreamById(...args),
}))
vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamMappingUiConfig: (...args: unknown[]) => fetchStreamMappingUiConfig(...args),
}))
vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorById: (...args: unknown[]) => fetchConnectorById(...args),
}))
vi.mock('../../api/gdcRuntimePreview', () => ({
  runHttpApiTest: (...args: unknown[]) => runHttpApiTest(...args),
  runConnectorAuthTest: (...args: unknown[]) => runConnectorAuthTest(...args),
  runExtractionValidate: (...args: unknown[]) => runExtractionValidate(...args),
}))

function mappingCfg(sourceType: string, sourceConfig: Record<string, unknown> = {}): MappingUIConfigResponse {
  return {
    stream_id: 7,
    stream_name: `${sourceType} stream`,
    stream_enabled: true,
    stream_status: 'STOPPED',
    source_id: 2,
    source_type: sourceType,
    source_config: sourceConfig,
    mapping: {
      exists: true,
      event_array_path: '',
      event_root_path: '',
      field_mappings: {},
      raw_payload_mode: null,
    },
    enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
    routes: [],
    message: '',
  }
}

function streamRead(sourceType: string, configJson: Record<string, unknown> = {}): StreamRead {
  return {
    id: 7,
    name: `${sourceType} stream`,
    connector_id: 11,
    source_id: 2,
    status: 'STOPPED',
    stream_type: sourceType,
    config_json: configJson,
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/streams/7/api-test']}>
      <Routes>
        <Route path="/streams/:streamId/api-test" element={<StreamApiTestPage />} />
        <Route path="/streams/:streamId/mapping" element={<div>mapping</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('StreamApiTestPage source-type parity', () => {
  beforeEach(() => {
    fetchStreamById.mockReset()
    fetchStreamMappingUiConfig.mockReset()
    fetchConnectorById.mockReset()
    runHttpApiTest.mockReset()
    runConnectorAuthTest.mockReset()
    runExtractionValidate.mockReset()
    fetchConnectorById.mockResolvedValue({ id: 11, name: 'Lab connector' })
  })

  it('HTTP existing stream fetches actual sample without synthesizing data', async () => {
    fetchStreamById.mockResolvedValue(
      streamRead('HTTP_API_POLLING', { method: 'GET', endpoint: '/v1/events', timeout_seconds: 30 }),
    )
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('HTTP_API_POLLING', { base_url: 'https://api.example' }))
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'GET', url: 'https://api.example/v1/events', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 15,
        headers: {},
        raw_body: '{"id":1,"email":"a@example.com"}',
        parsed_json: { id: 1, email: 'a@example.com' },
        content_type: 'application/json',
      },
    })
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Request Configuration' })).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('standalone-source-test-run'))
    await waitFor(() => expect(runHttpApiTest).toHaveBeenCalled())
    expect(runConnectorAuthTest).not.toHaveBeenCalled()
    const payload = runHttpApiTest.mock.calls[0]?.[0] as { stream_config: Record<string, unknown> }
    expect(payload.stream_config).toMatchObject({ method: 'GET', endpoint: '/v1/events' })
    expect(await screen.findByTestId('standalone-connection-status')).toHaveTextContent('Connection Success')
    expect(screen.getByTestId('standalone-sample-status')).toHaveTextContent('Sample Available')
    expect(screen.getAllByText(/a@example.com/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/s3-wizard-preview/i)).not.toBeInTheDocument()
  })

  it('S3 existing stream uses object sample path instead of HTTP endpoint', async () => {
    fetchStreamById.mockResolvedValue(streamRead('S3_OBJECT_POLLING', { max_objects_per_run: 6 }))
    fetchStreamMappingUiConfig.mockResolvedValue(
      mappingCfg('S3_OBJECT_POLLING', { bucket: 'lab', prefix: 'events/' }),
    )
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'S3_OBJECT_POLLING', s3_bucket_exists: true })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'S3_OBJECT_POLLING', url: 's3://lab/events', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 10,
        headers: {},
        raw_body: '[{"user":"alice"}]',
        parsed_json: [{ user: 'alice', email: 'alice@example.com', s3_key: 'events/alice.ndjson' }],
        content_type: 'application/json',
      },
      s3_event_count: 1,
      s3_sample_keys: ['events/alice.ndjson'],
    })
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-non-http-config')).toBeInTheDocument()
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('standalone-source-test-run'))
    await waitFor(() => expect(runHttpApiTest).toHaveBeenCalled())
    expect(runConnectorAuthTest).toHaveBeenCalled()
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toEqual({ max_objects_per_run: 6 })
    expect(streamConfig).not.toHaveProperty('endpoint')
    expect(await screen.findByTestId('standalone-connection-status')).toHaveTextContent('Connection Success')
    expect(screen.getByTestId('standalone-sample-status')).toHaveTextContent('Sample Available')
    expect(screen.getAllByText(/alice@example.com/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/s3-wizard-preview/i)).not.toBeInTheDocument()
  })

  it('S3 empty bucket keeps connection success and shows no records', async () => {
    fetchStreamById.mockResolvedValue(streamRead('S3_OBJECT_POLLING', { max_objects_per_run: 5 }))
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('S3_OBJECT_POLLING', { bucket: 'lab' }))
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'S3_OBJECT_POLLING', s3_object_count_preview: 0 })
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
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('standalone-source-test-run'))
    expect(await screen.findByTestId('standalone-connection-status')).toHaveTextContent('Connection Success')
    expect(screen.getByTestId('standalone-sample-status')).toHaveTextContent('No Records')
    expect(screen.getByTestId('standalone-sample-no-records')).toBeInTheDocument()
    expect(screen.queryByText(/s3-wizard-preview/i)).not.toBeInTheDocument()
  })

  it('Database existing stream uses saved query and actual rows', async () => {
    fetchStreamById.mockResolvedValue(
      streamRead('DATABASE_QUERY', { query: 'SELECT id, email FROM users', query_timeout_seconds: 15 }),
    )
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('DATABASE_QUERY'))
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'DATABASE_QUERY', db_reachable: true })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'DATABASE_QUERY', url: 'postgresql://db/app', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 14,
        headers: {},
        raw_body: '[{"id":1}]',
        parsed_json: [{ id: 1, email: 'a@example.com' }],
        content_type: 'application/json',
      },
      database_query_row_count: 1,
      database_query_sample_rows: [{ id: 1, email: 'a@example.com' }],
    })
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByText('SELECT id, email FROM users')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('standalone-source-test-run'))
    await waitFor(() => expect(runHttpApiTest).toHaveBeenCalled())
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toEqual({ query: 'SELECT id, email FROM users', query_timeout_seconds: 15 })
    expect(streamConfig).not.toHaveProperty('endpoint')
    expect(await screen.findByTestId('standalone-sample-status')).toHaveTextContent('Sample Available')
    expect(screen.getAllByText(/a@example.com/).length).toBeGreaterThan(0)
  })

  it('Database 0 rows keeps connection success and shows no records', async () => {
    fetchStreamById.mockResolvedValue(streamRead('DATABASE_QUERY', { query: 'SELECT id FROM empty_table' }))
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('DATABASE_QUERY'))
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'DATABASE_QUERY', db_reachable: true })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'DATABASE_QUERY', url: 'postgresql://db/app', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 5,
        headers: {},
        raw_body: '[]',
        parsed_json: [],
        content_type: 'application/json',
      },
      database_query_row_count: 0,
      database_query_sample_rows: [],
    })
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('standalone-source-test-run'))
    expect(await screen.findByTestId('standalone-connection-status')).toHaveTextContent('Connection Success')
    expect(screen.getByTestId('standalone-sample-status')).toHaveTextContent('No Records')
    expect(screen.getByTestId('standalone-sample-no-records')).toBeInTheDocument()
  })

  it('Remote file uses saved path and actual parsed events', async () => {
    fetchStreamById.mockResolvedValue(
      streamRead('REMOTE_FILE_POLLING', { remote_directory: '/data', file_pattern: '*.ndjson', recursive: true }),
    )
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('REMOTE_FILE_POLLING'))
    runConnectorAuthTest.mockResolvedValue({ ok: true, auth_type: 'REMOTE_FILE_POLLING', ssh_reachable: true })
    runHttpApiTest.mockResolvedValue({
      ok: true,
      request: { method: 'REMOTE_FILE_POLLING', url: 'sftp://files/data', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 18,
        headers: {},
        raw_body: '[{"line":"a"}]',
        parsed_json: [{ line: 'a', path: '/data/a.ndjson' }],
        content_type: 'application/json',
      },
      remote_file_event_count: 1,
    })
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByText('/data')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('standalone-source-test-run'))
    await waitFor(() => expect(runHttpApiTest).toHaveBeenCalled())
    const streamConfig = runHttpApiTest.mock.calls[0]?.[0]?.stream_config as Record<string, unknown>
    expect(streamConfig).toMatchObject({ remote_directory: '/data', file_pattern: '*.ndjson' })
    expect(streamConfig).not.toHaveProperty('endpoint')
    expect(await screen.findByTestId('standalone-sample-status')).toHaveTextContent('Sample Available')
    expect(screen.getAllByText(/\/data\/a\.ndjson/).length).toBeGreaterThan(0)
  })

  it('Webhook sample_payload is displayed without live HTTP fetch', async () => {
    fetchStreamById.mockResolvedValue(streamRead('WEBHOOK_RECEIVER'))
    fetchStreamMappingUiConfig.mockResolvedValue(
      mappingCfg('WEBHOOK_RECEIVER', { sample_payload: { id: 9, email: 'hook@example.com' } }),
    )
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-sample-status')).toHaveTextContent('Sample Available')
    expect(screen.getAllByText(/hook@example.com/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('standalone-connection-status')).toHaveTextContent('N/A')
    expect(runHttpApiTest).not.toHaveBeenCalled()
    expect(runConnectorAuthTest).not.toHaveBeenCalled()
  })

  it('Webhook without sample_payload shows Sample Not Available', async () => {
    fetchStreamById.mockResolvedValue(streamRead('WEBHOOK_RECEIVER'))
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('WEBHOOK_RECEIVER'))
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-sample-status')).toHaveTextContent('Sample Not Available')
    expect(screen.getByTestId('standalone-sample-not-available')).toBeInTheDocument()
    expect(runHttpApiTest).not.toHaveBeenCalled()
  })

  it('AI_PROXY does not fall back to HTTP test', async () => {
    fetchStreamById.mockResolvedValue(streamRead('AI_PROXY_RECEIVER'))
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('AI_PROXY_RECEIVER'))
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-unsupported-source')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-sample-status')).toHaveTextContent('Sample Not Available')
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
    expect(runHttpApiTest).not.toHaveBeenCalled()
  })

  it('does not fall back to HTTP when mapping source_type is empty and stream_type is S3', async () => {
    fetchStreamById.mockResolvedValue(streamRead('S3_OBJECT_POLLING', { max_objects_per_run: 4 }))
    fetchStreamMappingUiConfig.mockResolvedValue(mappingCfg('', { bucket: 'lab', prefix: 'events/' }))
    renderPage()
    expect(await screen.findByText('Lab connector')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-non-http-config')).toBeInTheDocument()
    expect(screen.getAllByText('S3_OBJECT_POLLING').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
    expect(screen.queryByText('HTTP status')).not.toBeInTheDocument()
  })
})
