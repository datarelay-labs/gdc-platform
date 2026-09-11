import type { APIRequestContext, Page } from '@playwright/test'
import type { AuthKind, ConnectorRef, DestinationRef, LabEnv, StreamRef } from './scenario-types'
import { FixtureClient, maskSecrets } from './fixture-client'
import type { ResourceRegistry } from './resource-registry'
import { wrapMutatingApiRequest } from './connector-create-lock'

type Json = Record<string, unknown>

async function readJson(res: { ok: () => boolean; status: () => number; text: () => Promise<string>; json: () => Promise<unknown> }) {
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok()) {
    throw new Error(`HTTP ${res.status()}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  }
  return body
}

/**
 * Data Relay driver for Full E2E Lab.
 * Prefer API paths for reliable smoke framework validation; UI helpers are thin wrappers.
 */
export class DataRelayDriver {
  accessToken: string | null = null
  private _disposed = false
  registry: ResourceRegistry | null = null

  constructor(
    readonly env: LabEnv,
    public request: APIRequestContext,
    readonly page: Page | null,
    readonly fixtures: FixtureClient,
  ) {
    this.request = wrapMutatingApiRequest(request)
  }

  bindRequest(request: APIRequestContext): void {
    this.request = wrapMutatingApiRequest(request)
    this._disposed = false
  }

  bindRegistry(registry: ResourceRegistry | null): void {
    this.registry = registry
  }

  markDisposed(): void {
    this._disposed = true
  }

  private trackConnector(ref: ConnectorRef): void {
    this.registry?.trackConnector({
      connectorId: ref.connectorId,
      sourceId: ref.sourceId,
      name: ref.name,
    })
  }

  private trackDestination(ref: DestinationRef): void {
    this.registry?.trackDestination({ destinationId: ref.destinationId, name: ref.name })
  }

  private trackStream(ref: StreamRef): void {
    this.registry?.trackStream({
      streamId: ref.streamId,
      name: ref.name,
      routeIds: ref.routeIds,
    })
  }

  private assertRequestAlive(): void {
    if (this._disposed) {
      throw Object.assign(new Error('Request context disposed'), { classification: 'TEST_INFRA' })
    }
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`
    return h
  }

  private url(p: string): string {
    return `${this.env.apiBaseUrl}${p.startsWith('/') ? p : `/${p}`}`
  }

  /** POST /connectors. Parallel workers serialize this via wrapMutatingApiRequest. */
  private async postConnectorCreate(payload: Json): Promise<{ id?: number; source_id?: number } & Json> {
    this.assertRequestAlive()
    const res = await this.request.post(this.url('/api/v1/connectors/'), {
      headers: this.authHeaders(),
      data: payload,
    })
    return (await readJson(res)) as { id?: number; source_id?: number } & Json
  }

  private webhookCollectPath(explicit?: string): string {
    if (explicit) return explicit.startsWith('/') ? explicit : `/${explicit}`
    if (this.env.collectorChannel) return `/collect/${this.env.collectorChannel}`
    return '/collect'
  }

  private syslogAppName(): string | undefined {
    return this.env.collectorChannel || undefined
  }

  async login(username = 'admin', password = 'admin'): Promise<void> {
    this.assertRequestAlive()
    if (!this.env.requireAuth) {
      this.accessToken = null
      return
    }
    const res = await this.request.post(this.url('/api/v1/auth/login'), {
      data: { username, password },
    })
    const body = (await readJson(res)) as { access_token?: string }
    if (!body.access_token) throw new Error('login failed: no access_token')
    this.accessToken = body.access_token
  }

  async getRouteProcessingFlag(): Promise<boolean | null> {
    // Prefer explicit health/config endpoint if present; fall back to env echo endpoint.
    try {
      const res = await this.request.get(this.url('/api/v1/platform/settings/runtime-flags'), {
        headers: this.authHeaders(),
      })
      if (res.ok()) {
        const body = (await res.json()) as { GDC_ROUTE_PROCESSING_ENABLED?: boolean; route_processing_enabled?: boolean }
        if (typeof body.GDC_ROUTE_PROCESSING_ENABLED === 'boolean') return body.GDC_ROUTE_PROCESSING_ENABLED
        if (typeof body.route_processing_enabled === 'boolean') return body.route_processing_enabled
      }
    } catch {
      /* ignore */
    }
    try {
      const res = await this.request.get(this.url('/api/v1/runtime/status'), { headers: this.authHeaders() })
      if (res.ok()) {
        const body = (await res.json()) as { route_processing_enabled?: boolean; flags?: { GDC_ROUTE_PROCESSING_ENABLED?: boolean } }
        if (typeof body.route_processing_enabled === 'boolean') return body.route_processing_enabled
        if (typeof body.flags?.GDC_ROUTE_PROCESSING_ENABLED === 'boolean') return body.flags.GDC_ROUTE_PROCESSING_ENABLED
      }
    } catch {
      /* ignore */
    }
    // Last resort: trust process env that started the API (recorded in evidence).
    return this.env.routeProcessingEnabled
  }

  async assertRouteFlagOrFail(): Promise<boolean> {
    const actual = await this.getRouteProcessingFlag()
    if (actual == null) {
      throw new Error('BLOCKED: unable to resolve route processing flag')
    }
    if (actual !== this.env.routeProcessingEnabled) {
      throw new Error(
        `Route flag mismatch before scenario: env=${this.env.routeProcessingEnabled} runtime=${actual}`,
      )
    }
    return actual
  }

  async createHttpConnector(opts: {
    name: string
    auth: AuthKind
    path: string
    badCredentials?: boolean
  }): Promise<ConnectorRef & { endpointPath: string }> {
    const baseUrl = this.env.wiremockBaseUrl
    const payload: Json = {
      name: opts.name,
      connector_type: 'generic_http',
      source_type: 'HTTP_API_POLLING',
      base_url: baseUrl,
      verify_ssl: false,
      auth_type: 'no_auth',
    }

    if (opts.auth === 'basic') {
      payload.auth_type = 'basic'
      payload.basic_username = opts.badCredentials ? 'wrong-user' : 'e2e-basic-user'
      payload.basic_password = opts.badCredentials ? 'wrong-pass' : 'e2e-basic-pass'
    } else if (opts.auth === 'bearer') {
      payload.auth_type = 'bearer'
      payload.bearer_token = opts.badCredentials ? 'wrong-bearer' : 'e2e-bearer-token'
    } else if (opts.auth === 'api_key_header') {
      payload.auth_type = 'api_key'
      payload.api_key_value = opts.badCredentials ? 'wrong-key' : 'e2e-api-key-value'
      payload.api_key_location = 'headers'
      payload.api_key_name = 'X-API-Key'
    } else if (opts.auth === 'api_key_query') {
      payload.auth_type = 'api_key'
      payload.api_key_value = opts.badCredentials ? 'wrong-key' : 'e2e-api-key-value'
      payload.api_key_location = 'query_params'
      payload.api_key_name = 'api_key'
    } else if (opts.auth === 'oauth2_client_credentials') {
      payload.auth_type = 'oauth2_client_credentials'
      payload.oauth2_token_url = `${baseUrl}/oauth2/default/v1/token`
      payload.oauth2_client_id = opts.badCredentials ? 'bad-client' : 'okta-e2e-client'
      payload.oauth2_client_secret = opts.badCredentials ? 'bad-secret' : 'okta-e2e-secret'
    } else if (opts.auth === 'session_login') {
      payload.auth_type = 'session_login'
      payload.login_url = `${baseUrl}/e2e-session/login`
      payload.login_method = 'POST'
      payload.login_username = opts.badCredentials ? 'bad' : 'e2e-session-user'
      payload.login_password = opts.badCredentials ? 'bad' : 'e2e-session-pass'
    } else if (opts.auth === 'jwt_refresh_token') {
      payload.auth_type = 'jwt_refresh_token'
      payload.token_url = `${baseUrl}/oauth2/lab/refresh`
      payload.refresh_token = opts.badCredentials ? 'bad-refresh' : 'lab-dev-validation-refresh-token'
    } else if (opts.auth === 'vendor_jwt_exchange') {
      payload.auth_type = 'vendor_jwt_exchange'
      payload.token_url = `${baseUrl}/vendor/token`
      payload.user_id = opts.badCredentials ? 'bad-user' : 'e2e-vendor-user'
      payload.api_key = opts.badCredentials ? 'bad-key' : 'e2e-vendor-api-key'
      payload.token_method = 'POST'
      payload.token_auth_mode = 'basic_user_api_key'
      payload.access_token_injection = 'bearer_authorization'
    }

    const body = (await this.postConnectorCreate(payload)) as { id?: number; source_id?: number }
    const connectorId = Number(body.id)
    const sourceId = Number(body.source_id ?? body.id)
    if (!connectorId || !sourceId) throw new Error(`createConnector missing ids: ${JSON.stringify(body)}`)
    const ref = { connectorId, sourceId, name: opts.name, endpointPath: opts.path }
    this.trackConnector(ref)
    return ref
  }

  async createS3Connector(name: string, badCredentials = false): Promise<ConnectorRef> {
    const payload: Json = {
      name,
      source_type: 'S3_OBJECT_POLLING',
      auth_type: 'no_auth',
      endpoint_url: this.env.minioEndpoint,
      bucket: this.env.minioBucket,
      access_key: badCredentials ? 'bad-access' : this.env.minioAccessKey,
      secret_key: badCredentials ? 'bad-secret' : this.env.minioSecretKey,
      region: 'us-east-1',
      path_style_access: true,
      use_ssl: false,
      prefix: this.env.s3Prefix,
      object_key_pattern: `${this.env.s3Prefix}*.ndjson`,
    }
    const body = (await this.postConnectorCreate(payload)) as { id?: number; source_id?: number }
    const ref = { connectorId: Number(body.id), sourceId: Number(body.source_id ?? body.id), name }
    this.trackConnector(ref)
    return ref
  }

  async createSftpConnector(name: string, badCredentials = false): Promise<ConnectorRef> {
    const payload: Json = {
      name,
      source_type: 'REMOTE_FILE_POLLING',
      auth_type: 'no_auth',
      host: this.env.sftpHost,
      port: this.env.sftpPort,
      remote_username: this.env.sftpUser,
      remote_password: badCredentials ? 'wrong-pass' : this.env.sftpPassword,
      remote_file_protocol: 'sftp',
      known_hosts_policy: 'insecure_skip_verify',
      connection_timeout_seconds: 15,
    }
    const body = (await this.postConnectorCreate(payload)) as { id?: number; source_id?: number }
    const ref = { connectorId: Number(body.id), sourceId: Number(body.source_id ?? body.id), name }
    this.trackConnector(ref)
    return ref
  }

  async createWebhookReceiverConnector(
    name: string,
    opts?: {
      authMode?: 'no_auth' | 'shared_secret_header' | 'bearer_token'
      receiverKey?: string
      sharedSecret?: string
      bearerToken?: string
      authHeaderName?: string
    },
  ): Promise<ConnectorRef> {
    const authMode = opts?.authMode || 'no_auth'
    const sharedSecret = opts?.sharedSecret || `e2e-wh-secret-${Date.now().toString(36)}`
    const bearerToken = opts?.bearerToken || `e2e-wh-bearer-${Date.now().toString(36)}`
    const authHeaderName = opts?.authHeaderName || 'X-GDC-Webhook-Secret'
    const payload: Json = {
      name,
      connector_type: 'webhook_receiver',
      source_type: 'WEBHOOK_RECEIVER',
      auth_type: 'no_auth',
      webhook_auth_mode: authMode,
      max_request_bytes: 1_048_576,
    }
    if (opts?.receiverKey) payload.receiver_key = opts.receiverKey
    if (authMode === 'shared_secret_header') {
      payload.webhook_shared_secret = sharedSecret
      payload.webhook_auth_header_name = authHeaderName
    } else if (authMode === 'bearer_token') {
      payload.webhook_bearer_token = bearerToken
    }
    const body = (await this.postConnectorCreate(payload)) as {
      id?: number
      source_id?: number
      receiver_key?: string
      receiver_path?: string
      webhook_auth_mode?: string
    }
    const connectorId = Number(body.id)
    const sourceId = Number(body.source_id ?? body.id)
    if (!connectorId || !sourceId) throw new Error(`createWebhookReceiver missing ids: ${JSON.stringify(body)}`)
    let receiverKey = String(body.receiver_key || opts?.receiverKey || '').trim()
    let receiverPath = String(body.receiver_path || '').trim()
    if (!receiverKey) {
      const got = await this.request.get(this.url(`/api/v1/connectors/${connectorId}`), {
        headers: this.authHeaders(),
      })
      const detail = (await readJson(got)) as { receiver_key?: string; receiver_path?: string }
      receiverKey = String(detail.receiver_key || '').trim()
      receiverPath = String(detail.receiver_path || '').trim()
    }
    if (!receiverKey) throw new Error(`createWebhookReceiver missing receiver_key: connector=${connectorId}`)
    if (!receiverPath) receiverPath = `/api/v1/ingest/webhook/${receiverKey}`
    const ref = {
      connectorId,
      sourceId,
      name,
      receiverKey,
      receiverPath,
      webhookAuthMode: String(body.webhook_auth_mode || authMode),
      webhookSharedSecret: authMode === 'shared_secret_header' ? sharedSecret : undefined,
      webhookAuthHeaderName: authMode === 'shared_secret_header' ? authHeaderName : undefined,
      webhookBearerToken: authMode === 'bearer_token' ? bearerToken : undefined,
    }
    this.trackConnector(ref)
    return ref
  }

  async createPostgresConnector(name: string): Promise<ConnectorRef> {
    const payload: Json = {
      name,
      connector_type: 'relational_database',
      source_type: 'DATABASE_QUERY',
      auth_type: 'no_auth',
      db_type: 'POSTGRESQL',
      host: '127.0.0.1',
      port: 55433,
      database: 'gdc_query_fixture',
      db_username: 'gdc_fixture',
      db_password: 'gdc_fixture_pw',
      ssl_mode: 'DISABLE',
      connection_timeout_seconds: 15,
    }
    const body = (await this.postConnectorCreate(payload)) as { id?: number; source_id?: number }
    const connectorId = Number(body.id)
    const sourceId = Number(body.source_id ?? body.id)
    const ref = { connectorId, sourceId, name }
    this.trackConnector(ref)
    return ref
  }

  async testConnector(connectorId: number): Promise<unknown> {
    const alt = await this.request.post(this.url('/api/v1/runtime/api-test/connector-auth'), {
      headers: this.authHeaders(),
      data: { connector_id: connectorId },
    })
    if (alt.ok() || alt.status() < 500) {
      try {
        return await readJson(alt)
      } catch {
        return { status: alt.status() }
      }
    }
    return { status: alt.status(), note: 'connector auth test endpoint unavailable' }
  }

  async createWebhookDestination(
    name: string,
    opts?: { collectPath?: string },
  ): Promise<DestinationRef & { collectPath: string }> {
    const normalizedPath = this.webhookCollectPath(opts?.collectPath)
    const res = await this.request.post(this.url('/api/v1/destinations/'), {
      headers: this.authHeaders(),
      data: {
        name,
        destination_type: 'WEBHOOK_POST',
        config_json: {
          url: `${this.env.webhookCollectorUrl}${normalizedPath}`,
          payload_mode: 'SINGLE_EVENT_OBJECT',
          retry_count: 2,
          retry_backoff_seconds: 0.05,
        },
        rate_limit_json: { max_events: 1000, per_seconds: 1 },
      },
    })
    const body = (await readJson(res)) as { id?: number }
    const ref = {
      destinationId: Number(body.id),
      name,
      destinationType: 'WEBHOOK_POST',
      collectPath: normalizedPath,
    }
    this.trackDestination(ref)
    return ref
  }

  async createSyslogTcpDestination(name: string): Promise<DestinationRef> {
    const config_json: Json = {
      host: this.env.syslogHost,
      port: this.env.syslogPort,
      protocol: 'tcp',
      message_format: 'json',
    }
    const appName = this.syslogAppName()
    if (appName) config_json.app_name = appName
    const res = await this.request.post(this.url('/api/v1/destinations/'), {
      headers: this.authHeaders(),
      data: {
        name,
        destination_type: 'SYSLOG_TCP',
        config_json,
      },
    })
    const body = (await readJson(res)) as { id?: number }
    const ref = { destinationId: Number(body.id), name, destinationType: 'SYSLOG_TCP' }
    this.trackDestination(ref)
    return ref
  }

  async createSyslogUdpDestination(name: string): Promise<DestinationRef> {
    const config_json: Json = {
      host: this.env.syslogHost,
      port: this.env.syslogPort,
      protocol: 'udp',
      message_format: 'json',
    }
    const appName = this.syslogAppName()
    if (appName) config_json.app_name = appName
    const res = await this.request.post(this.url('/api/v1/destinations/'), {
      headers: this.authHeaders(),
      data: {
        name,
        destination_type: 'SYSLOG_UDP',
        config_json,
      },
    })
    const body = (await readJson(res)) as { id?: number }
    const ref = { destinationId: Number(body.id), name, destinationType: 'SYSLOG_UDP' }
    this.trackDestination(ref)
    return ref
  }

  async createSyslogTlsDestination(name: string): Promise<DestinationRef> {
    const config_json: Json = {
      host: this.env.syslogHost,
      port: this.env.syslogTlsPort,
      protocol: 'tls',
      message_format: 'json',
      tls_enabled: true,
      // Lab collector uses a self-signed cert (SAN includes 127.0.0.1 / localhost).
      tls_verify_mode: 'insecure_skip_verify',
      tls_server_name: 'localhost',
    }
    const appName = this.syslogAppName()
    if (appName) config_json.app_name = appName
    const res = await this.request.post(this.url('/api/v1/destinations/'), {
      headers: this.authHeaders(),
      data: {
        name,
        destination_type: 'SYSLOG_TLS',
        config_json,
      },
    })
    const body = (await readJson(res)) as { id?: number }
    const ref = { destinationId: Number(body.id), name, destinationType: 'SYSLOG_TLS' }
    this.trackDestination(ref)
    return ref
  }

  /**
   * Intentional primary failure destination for Active/Standby failover drills.
   * SYSLOG_TLS → plain TCP collector port (15614): TLS handshake EOF (not a verify bypass).
   * Other types → closed/unreachable endpoints so DestinationSendError is raised.
   */
  async createFailoverPrimaryDestination(name: string, destinationType: string): Promise<DestinationRef> {
    if (destinationType === 'SYSLOG_TLS') {
      const res = await this.request.post(this.url('/api/v1/destinations/'), {
        headers: this.authHeaders(),
        data: {
          name,
          destination_type: 'SYSLOG_TLS',
          config_json: {
            host: this.env.syslogHost,
            // Plain TCP/UDP listener can hang TLS ClientHello until write timeout.
            // Closed port fails fast with DestinationSendError (eligible for failover).
            port: 1,
            protocol: 'tls',
            message_format: 'json',
            tls_enabled: true,
            tls_verify_mode: 'insecure_skip_verify',
            tls_server_name: 'localhost',
          },
        },
      })
      const body = (await readJson(res)) as { id?: number }
      const ref = { destinationId: Number(body.id), name, destinationType: 'SYSLOG_TLS' }
      this.trackDestination(ref)
      return ref
    }
    if (destinationType === 'SYSLOG_TCP') {
      const res = await this.request.post(this.url('/api/v1/destinations/'), {
        headers: this.authHeaders(),
        data: {
          name,
          destination_type: 'SYSLOG_TCP',
          config_json: {
            host: this.env.syslogHost,
            port: 1,
            protocol: 'tcp',
            message_format: 'json',
          },
        },
      })
      const body = (await readJson(res)) as { id?: number }
      const ref = { destinationId: Number(body.id), name, destinationType: 'SYSLOG_TCP' }
      this.trackDestination(ref)
      return ref
    }
    if (destinationType === 'SYSLOG_UDP') {
      const res = await this.request.post(this.url('/api/v1/destinations/'), {
        headers: this.authHeaders(),
        data: {
          name,
          destination_type: 'SYSLOG_UDP',
          config_json: {
            // Connected UDP raises ECONNREFUSED on a closed local port (same pattern as TCP).
            host: this.env.syslogHost,
            port: 1,
            protocol: 'udp',
            message_format: 'json',
          },
        },
      })
      const body = (await readJson(res)) as { id?: number }
      const ref = { destinationId: Number(body.id), name, destinationType: 'SYSLOG_UDP' }
      this.trackDestination(ref)
      return ref
    }
    // WEBHOOK_POST / default: closed local port
    const res = await this.request.post(this.url('/api/v1/destinations/'), {
      headers: this.authHeaders(),
      data: {
        name,
        destination_type: 'WEBHOOK_POST',
        config_json: {
          url: 'http://127.0.0.1:1/gdc-failover-primary-down',
          payload_mode: 'SINGLE_EVENT_OBJECT',
          retry_count: 0,
          retry_backoff_seconds: 0.01,
          timeout_seconds: 1,
        },
        rate_limit_json: { max_events: 1000, per_seconds: 1 },
      },
    })
    const body = (await readJson(res)) as { id?: number }
    const ref = {
      destinationId: Number(body.id),
      name,
      destinationType: 'WEBHOOK_POST',
    }
    this.trackDestination(ref)
    return ref
  }

  async createDestinationByType(name: string, destinationType: string): Promise<DestinationRef> {
    switch (destinationType) {
      case 'SYSLOG_UDP':
        return this.createSyslogUdpDestination(name)
      case 'SYSLOG_TCP':
        return this.createSyslogTcpDestination(name)
      case 'SYSLOG_TLS':
        return this.createSyslogTlsDestination(name)
      case 'WEBHOOK_POST':
      default:
        return this.createWebhookDestination(name)
    }
  }

  async createMultiRouteStream(opts: {
    name: string
    connectorId: number
    sourceId: number
    destinations: DestinationRef[]
    endpointPath?: string
    /** When omitted, defaults to HTTP_API_POLLING (matrix multi-route paths). */
    sourceType?: string
  }): Promise<StreamRef> {
    if (!opts.destinations.length) {
      throw new Error('createMultiRouteStream requires at least one destination')
    }
    // Reuse source-type-aware stream creation (query / remote_directory / webhook / S3 / HTTP),
    // then attach additional routes — never invent a second Stream per destination.
    const primary = opts.destinations[0]!
    const ref = await this.createStreamForSource({
      name: opts.name,
      connectorId: opts.connectorId,
      sourceId: opts.sourceId,
      destinationId: primary.destinationId,
      sourceType: opts.sourceType || 'HTTP_API_POLLING',
      endpointPath: opts.endpointPath,
    })
    for (let i = 1; i < opts.destinations.length; i++) {
      const dest = opts.destinations[i]!
      const routeRes = await this.request.post(this.url('/api/v1/routes/'), {
        headers: this.authHeaders(),
        data: {
          stream_id: ref.streamId,
          destination_id: dest.destinationId,
          name: `${opts.name} route-${i + 1}`,
          enabled: true,
          status: 'ACTIVE',
          failure_policy: 'LOG_AND_CONTINUE',
        },
      })
      const route = (await readJson(routeRes)) as { id?: number }
      if (route.id) {
        const routeId = Number(route.id)
        ref.routeIds.push(routeId)
        this.registry?.track({
          kind: 'route',
          id: routeId,
          meta: { stream_id: ref.streamId },
        })
      }
    }
    return ref
  }

  /**
   * Active/Standby failover: one primary Route + StreamFailoverRoute binding to secondary.
   * Primary destination is expected to fail; secondary receives failover_route_send_*.
   */
  async createFailoverStream(opts: {
    name: string
    connectorId: number
    sourceId: number
    primary: DestinationRef
    secondary: DestinationRef
    endpointPath?: string
    sourceType?: string
  }): Promise<StreamRef & { failoverRouteId?: number }> {
    if (opts.primary.destinationId === opts.secondary.destinationId) {
      throw new Error('createFailoverStream requires distinct primary/secondary destinations')
    }
    const ref = await this.createStreamForSource({
      name: opts.name,
      connectorId: opts.connectorId,
      sourceId: opts.sourceId,
      destinationId: opts.primary.destinationId,
      sourceType: opts.sourceType || 'HTTP_API_POLLING',
      endpointPath: opts.endpointPath,
    })
    const foRes = await this.request.post(this.url(`/api/v1/runtime/streams/${ref.streamId}/failover-routes`), {
      headers: this.authHeaders(),
      data: {
        primary_destination_id: opts.primary.destinationId,
        secondary_destination_id: opts.secondary.destinationId,
        enabled: true,
      },
    })
    if (!foRes.ok()) {
      const body = await foRes.text().catch(() => '')
      throw new Error(`create failover binding failed HTTP ${foRes.status()}: ${body}`)
    }
    const foBody = (await readJson(foRes)) as { route?: { id?: number } }
    const failoverRouteId = foBody.route?.id != null ? Number(foBody.route.id) : undefined
    if (failoverRouteId != null) {
      this.registry?.track({
        kind: 'route',
        id: failoverRouteId,
        meta: { stream_id: ref.streamId, failover: true },
      })
    }
    return Object.assign(ref, { failoverRouteId })
  }

  async getStreamFailoverRoutes(streamId: number): Promise<{
    stream_id?: number
    route_count?: number
    routes?: Array<{
      id?: number
      primary_destination_id?: number
      secondary_destination_id?: number
      enabled?: boolean
      policy?: string
    }>
  }> {
    const res = await this.request.get(this.url(`/api/v1/runtime/streams/${streamId}/failover-routes`), {
      headers: this.authHeaders(),
    })
    if (!res.ok()) {
      const body = await res.text().catch(() => '')
      throw new Error(`get failover-routes failed HTTP ${res.status()}: ${body}`)
    }
    return (await readJson(res)) as {
      stream_id?: number
      route_count?: number
      routes?: Array<{
        id?: number
        primary_destination_id?: number
        secondary_destination_id?: number
        enabled?: boolean
        policy?: string
      }>
    }
  }

  async saveEnrichmentRules(streamId: number, rules: unknown[]): Promise<unknown> {
    const res = await this.request.put(this.url(`/api/v1/streams/${streamId}`), {
      headers: this.authHeaders(),
      data: { enrichment_rules_json: rules },
    })
    if (res.ok()) return readJson(res)
    const alt = await this.request.post(this.url(`/api/v1/runtime/streams/${streamId}/enrichment/save`), {
      headers: this.authHeaders(),
      data: { rules },
    })
    if (alt.status() === 404) return { status: alt.status(), note: 'enrichment save endpoint optional' }
    try {
      return await readJson(alt)
    } catch {
      return { status: alt.status() }
    }
  }

  async previewEnrichment(streamId: number, sampleEvent: unknown, rules: unknown[]): Promise<unknown> {
    const res = await this.request.post(this.url(`/api/v1/runtime/streams/${streamId}/enrichment/preview`), {
      headers: this.authHeaders(),
      data: { event: sampleEvent, rules },
    })
    if (res.status() === 404) {
      return { skipped: true, reason: 'enrichment preview unavailable' }
    }
    try {
      return await readJson(res)
    } catch {
      return { status: res.status() }
    }
  }

  async configureDedup(streamId: number, enabled = true): Promise<unknown> {
    // Product config lives under stream.config_json.deduplication via runtime API.
    // Webhook pushes are separate runs — use last_n_hours so duplicate POSTs are suppressed.
    const res = await this.request.put(this.url(`/api/v1/runtime/streams/${streamId}/deduplication`), {
      headers: this.authHeaders(),
      data: {
        enabled,
        key_field: 'id',
        duplicate_handling: 'skip_duplicate',
        scope: 'last_n_hours',
        window_hours: 24,
      },
    })
    try {
      return await readJson(res)
    } catch {
      const body = await res.text().catch(() => '')
      throw new Error(`configureDedup failed HTTP ${res.status()}: ${body}`)
    }
  }

  async configureDedupWithKey(
    streamId: number,
    opts: { keyField: string; enabled?: boolean },
  ): Promise<unknown> {
    const res = await this.request.put(this.url(`/api/v1/runtime/streams/${streamId}/deduplication`), {
      headers: this.authHeaders(),
      data: {
        enabled: opts.enabled !== false,
        key_field: opts.keyField,
        duplicate_handling: 'skip_duplicate',
        scope: 'last_n_hours',
        window_hours: 24,
      },
    })
    try {
      return await readJson(res)
    } catch {
      const body = await res.text().catch(() => '')
      throw new Error(`configureDedupWithKey failed HTTP ${res.status()}: ${body}`)
    }
  }

  async configureProtection(streamId: number, opts: {
    action: string
    deliveryBehavior: string
    field?: string
  }): Promise<unknown> {
    const modeMap: Record<string, string> = {
      audit: 'full_mask', // audit-only is policy-level; field rule still applies mask for detection
      mask: 'full_mask',
      tokenize: 'tokenization',
      hash: 'hash',
      remove: 'drop_field',
      drop_field: 'drop_field',
    }
    const protectionMode = modeMap[opts.action] || 'FULL_MASK'
    const res = await this.request.post(this.url(`/api/v1/runtime/streams/${streamId}/protection-rules/direct`), {
      headers: this.authHeaders(),
      data: {
        rules: [
          {
            field_path: opts.field || 'message',
            sensitivity_class: 'SECRET',
            protection_mode: protectionMode,
            enabled: true,
          },
        ],
      },
    })
    let rulesResult: unknown
    try {
      rulesResult = await readJson(res)
    } catch {
      rulesResult = { status: res.status(), body: await res.text().catch(() => '') }
    }

    // Persist Contract v1 governance so stream-level delivery_behavior reaches runtime gates.
    const behaviorMap: Record<string, string> = {
      continue: 'continue',
      review: 'require_review',
      quarantine: 'quarantine',
      block: 'block',
    }
    const behavior = behaviorMap[opts.deliveryBehavior] || String(opts.deliveryBehavior).toLowerCase()
    const actionMap: Record<string, string> = {
      audit: 'audit',
      mask: 'mask_full',
      tokenize: 'tokenize',
      hash: 'hash',
      remove: 'drop_field',
      drop_field: 'drop_field',
      mask_full: 'mask_full',
      mask_partial: 'mask_partial',
    }
    const protectionAction = actionMap[opts.action] || 'audit'
    const rawField = opts.field || 'message'
    const fieldPath = rawField.startsWith('$') ? rawField : `$.${rawField}`
    const pol = await this.request.put(this.url(`/api/v1/runtime/streams/${streamId}/governance`), {
      headers: this.authHeaders(),
      data: {
        enabled: true,
        rules: [
          {
            field_path: fieldPath,
            sensitivity_type: 'SECRET',
            default_protection_action: protectionAction,
            default_delivery_behavior: behavior,
            enabled: true,
            route_overrides: [],
          },
        ],
        route_overrides: [],
      },
    })
    let policyResult: unknown = { status: pol.status() }
    try {
      if (pol.ok()) {
        policyResult = await pol.json()
      } else {
        const body = await pol.text().catch(() => '')
        throw new Error(`governance configure failed HTTP ${pol.status()}: ${body}`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('governance configure failed')) throw err
      throw new Error(`governance configure failed: ${String(err)}`)
    }
    return { rules: rulesResult, policy: policyResult, requested_behavior: behavior, field_path: fieldPath }
  }

  async getStreamGovernance(streamId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/streams/${streamId}/governance`), {
      headers: this.authHeaders(),
    })
    return readJson(res)
  }

  async listRoutesForStream(streamId: number): Promise<
    Array<{ id: number; stream_id?: number; destination_id?: number; name?: string; enabled?: boolean }>
  > {
    const res = await this.request.get(this.url('/api/v1/routes/'), { headers: this.authHeaders() })
    const body = await readJson(res)
    const rows = Array.isArray(body) ? body : []
    return rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .filter((row) => Number(row.stream_id) === streamId)
      .map((row) => ({
        id: Number(row.id),
        stream_id: Number(row.stream_id),
        destination_id: Number(row.destination_id),
        name: typeof row.name === 'string' ? row.name : undefined,
        enabled: typeof row.enabled === 'boolean' ? row.enabled : undefined,
      }))
      .filter((row) => Number.isFinite(row.id))
  }

  async getRouteMappingUi(routeId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/routes/${routeId}/mapping-ui/config`), {
      headers: this.authHeaders(),
    })
    return readJson(res)
  }

  async getRoutePolicyRules(routeId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/routes/${routeId}/policy-rules`), {
      headers: this.authHeaders(),
    })
    return readJson(res)
  }

  async getRouteClassificationRules(routeId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/routes/${routeId}/classification-rules`), {
      headers: this.authHeaders(),
    })
    return readJson(res)
  }

  async getRouteClassificationEffective(routeId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/routes/${routeId}/classification/effective`), {
      headers: this.authHeaders(),
    })
    return readJson(res)
  }

  async findStreamIdByName(name: string): Promise<number | null> {
    const res = await this.request.get(this.url('/api/v1/streams/'), { headers: this.authHeaders() })
    const body = await readJson(res)
    const rows = Array.isArray(body) ? body : []
    const hit = rows.find((row) => row && typeof row === 'object' && String((row as { name?: string }).name) === name)
    const id = hit && typeof hit === 'object' ? Number((hit as { id?: number }).id) : NaN
    return Number.isFinite(id) && id > 0 ? id : null
  }

  async stopStream(streamId: number): Promise<void> {
    const res = await this.request.put(this.url(`/api/v1/streams/${streamId}`), {
      headers: this.authHeaders(),
      data: { enabled: false, status: 'STOPPED' },
    })
    await readJson(res).catch(() => null)
  }

  async listQuarantine(limit = 50): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/governance/quarantine?limit=${limit}`), {
      headers: this.authHeaders(),
    })
    if (!res.ok()) return { status: res.status() }
    return readJson(res)
  }

  async replayQuarantine(itemId: number | string): Promise<unknown> {
    const res = await this.request.post(this.url(`/api/v1/governance/quarantine/${itemId}/replay`), {
      headers: this.authHeaders(),
      data: {},
    })
    if (res.status() === 404) {
      const alt = await this.request.post(this.url('/api/v1/governance/replay'), {
        headers: this.authHeaders(),
        data: { quarantine_id: itemId },
      })
      try {
        return await readJson(alt)
      } catch {
        return { status: alt.status() }
      }
    }
    try {
      return await readJson(res)
    } catch {
      return { status: res.status() }
    }
  }

  async createConnectorForSourceType(
    sourceType: string,
    name: string,
    auth?: string,
    badCredentials = false,
  ): Promise<ConnectorRef & { endpointPath?: string }> {
    switch (sourceType) {
      case 'DATABASE_QUERY':
        return this.createPostgresConnector(name)
      case 'S3_OBJECT_POLLING':
        return this.createS3Connector(name, badCredentials)
      case 'REMOTE_FILE_POLLING':
        return this.createSftpConnector(name, badCredentials)
      case 'WEBHOOK_RECEIVER': {
        // "inbound" auth variant exercises shared-secret header; default is open receiver.
        const authMode =
          auth === 'inbound' || auth === 'shared_secret_header' || auth === 'bearer'
            ? auth === 'bearer'
              ? 'bearer_token'
              : 'shared_secret_header'
            : 'no_auth'
        return this.createWebhookReceiverConnector(name, { authMode })
      }
      case 'HTTP_API_POLLING':
      default: {
        const authKind = mapAuthVariant(auth || 'no_auth')
        const path = endpointForAuth(authKind)
        return this.createHttpConnector({ name, auth: authKind, path, badCredentials })
      }
    }
  }

  async saveDefaultFieldMappings(streamId: number): Promise<void> {
    const fieldMappings = {
      id: '$.id',
      e2e_correlation_id: '$.e2e_correlation_id',
      message: '$.message',
      severity: '$.severity',
    }
    const mapRes = await this.request.post(this.url(`/api/v1/runtime/mappings/stream/${streamId}/save`), {
      headers: this.authHeaders(),
      data: { field_mappings: fieldMappings },
    })
    if (!mapRes.ok()) {
      await this.request.post(this.url(`/api/v1/runtime/streams/${streamId}/mapping-ui/save`), {
        headers: this.authHeaders(),
        data: { field_mappings_json: fieldMappings },
      })
    }
  }

  async createStreamForSource(opts: {
    name: string
    connectorId: number
    sourceId: number
    destinationId: number
    sourceType: string
    endpointPath?: string
  }): Promise<StreamRef> {
    if (opts.sourceType === 'DATABASE_QUERY') {
      return this.createStream({
        name: opts.name,
        connectorId: opts.connectorId,
        sourceId: opts.sourceId,
        destinationId: opts.destinationId,
        sqlMode: true,
      })
    }
    if (opts.sourceType === 'S3_OBJECT_POLLING') {
      const streamRes = await this.request.post(this.url('/api/v1/streams/'), {
        headers: this.authHeaders(),
        data: {
          name: opts.name,
          connector_id: opts.connectorId,
          source_id: opts.sourceId,
          stream_type: 'S3_OBJECT_POLLING',
          config_json: {
            prefix: this.env.s3Prefix,
            // Product filter key is object_key_pattern (fnmatch); plain "suffix" is ignored.
            object_key_pattern: `${this.env.s3Prefix}*.ndjson`,
            max_objects_per_run: 20,
          },
          polling_interval: 60,
          enabled: false,
          status: 'STOPPED',
        },
      })
      const stream = (await readJson(streamRes)) as { id?: number }
      const streamId = Number(stream.id)
      // NDJSON object sources already carry e2e_correlation_id at the root; identity
      // field mappings can null out fields when paths do not match the mapped shape.
      const routeRes = await this.request.post(this.url('/api/v1/routes/'), {
        headers: this.authHeaders(),
        data: {
          stream_id: streamId,
          destination_id: opts.destinationId,
          name: `${opts.name} route`,
          enabled: true,
          status: 'ACTIVE',
          failure_policy: 'LOG_AND_CONTINUE',
        },
      })
      const route = (await readJson(routeRes)) as { id?: number }
      const ref = { streamId, name: opts.name, routeIds: [Number(route.id)].filter(Boolean) }
      this.trackStream(ref)
      return ref
    }
    if (opts.sourceType === 'REMOTE_FILE_POLLING') {
      const streamRes = await this.request.post(this.url('/api/v1/streams/'), {
        headers: this.authHeaders(),
        data: {
          name: opts.name,
          connector_id: opts.connectorId,
          source_id: opts.sourceId,
          stream_type: 'REMOTE_FILE_POLLING',
          config_json: {
            remote_directory: '/upload/full-e2e',
            file_glob: '*.ndjson',
            max_files_per_run: 20,
          },
          polling_interval: 60,
          enabled: false,
          status: 'STOPPED',
        },
      })
      const stream = (await readJson(streamRes)) as { id?: number }
      const streamId = Number(stream.id)
      const routeRes = await this.request.post(this.url('/api/v1/routes/'), {
        headers: this.authHeaders(),
        data: {
          stream_id: streamId,
          destination_id: opts.destinationId,
          name: `${opts.name} route`,
          enabled: true,
          status: 'ACTIVE',
          failure_policy: 'LOG_AND_CONTINUE',
        },
      })
      const route = (await readJson(routeRes)) as { id?: number }
      const ref = { streamId, name: opts.name, routeIds: [Number(route.id)].filter(Boolean) }
      this.trackStream(ref)
      return ref
    }
    if (opts.sourceType === 'WEBHOOK_RECEIVER') {
      const streamRes = await this.request.post(this.url('/api/v1/streams/'), {
        headers: this.authHeaders(),
        data: {
          name: opts.name,
          connector_id: opts.connectorId,
          source_id: opts.sourceId,
          stream_type: 'WEBHOOK_RECEIVER',
          config_json: {},
          polling_interval: 60,
          enabled: false,
          status: 'STOPPED',
        },
      })
      const stream = (await readJson(streamRes)) as { id?: number }
      const streamId = Number(stream.id)
      if (!streamId) throw new Error('createStreamForSource WEBHOOK_RECEIVER missing id')
      // Keep e2e_correlation_id through mapping so destination collectors can correlate.
      await this.saveDefaultFieldMappings(streamId)
      const routeRes = await this.request.post(this.url('/api/v1/routes/'), {
        headers: this.authHeaders(),
        data: {
          stream_id: streamId,
          destination_id: opts.destinationId,
          name: `${opts.name} route`,
          enabled: true,
          status: 'ACTIVE',
          failure_policy: 'LOG_AND_CONTINUE',
        },
      })
      const route = (await readJson(routeRes)) as { id?: number }
      const ref = { streamId, name: opts.name, routeIds: [Number(route.id)].filter(Boolean) }
      this.trackStream(ref)
      return ref
    }
    return this.createStream({
      name: opts.name,
      connectorId: opts.connectorId,
      sourceId: opts.sourceId,
      destinationId: opts.destinationId,
      endpointPath: opts.endpointPath,
    })
  }

  async testDestination(destinationId: number): Promise<unknown> {
    const res = await this.request.post(this.url(`/api/v1/destinations/${destinationId}/test`), {
      headers: this.authHeaders(),
      data: {},
    })
    return readJson(res)
  }

  async createStream(opts: {
    name: string
    connectorId: number
    sourceId: number
    destinationId: number
    endpointPath?: string
    sqlMode?: boolean
    eventArrayPath?: string | null
  }): Promise<StreamRef> {
    const configJson: Json = opts.sqlMode
      ? {
          query:
            'SELECT event_id AS id, e2e_correlation_id, message, severity, event_ts, ordering_seq FROM full_e2e_rows ORDER BY ordering_seq',
          max_rows_per_run: 100,
          query_timeout_seconds: 30,
          checkpoint_mode: 'NONE',
        }
      : {
          endpoint: opts.endpointPath || '/no-auth/events',
          method: 'GET',
        }

    const streamRes = await this.request.post(this.url('/api/v1/streams/'), {
      headers: this.authHeaders(),
      data: {
        name: opts.name,
        connector_id: opts.connectorId,
        source_id: opts.sourceId,
        stream_type: opts.sqlMode ? 'DATABASE_QUERY' : 'HTTP_API_POLLING',
        config_json: configJson,
        polling_interval: 60,
        enabled: false,
        status: 'STOPPED',
        event_array_path: opts.sqlMode ? null : (opts.eventArrayPath ?? '$.data'),
        rate_limit_json: { max_requests: 100, per_seconds: 60 },
      },
    })
    const stream = (await readJson(streamRes)) as { id?: number }
    const streamId = Number(stream.id)
    if (!streamId) throw new Error('createStream missing id')

    const mapRes = await this.request.post(this.url(`/api/v1/runtime/mappings/stream/${streamId}/save`), {
      headers: this.authHeaders(),
      data: {
        field_mappings: {
          id: '$.id',
          e2e_correlation_id: '$.e2e_correlation_id',
          message: '$.message',
          severity: '$.severity',
        },
      },
    })
    if (!mapRes.ok()) {
      // continue; some envs may use mapping-ui/save
      await this.request.post(this.url(`/api/v1/runtime/streams/${streamId}/mapping-ui/save`), {
        headers: this.authHeaders(),
        data: {
          field_mappings_json: {
            id: '$.id',
            e2e_correlation_id: '$.e2e_correlation_id',
            message: '$.message',
            severity: '$.severity',
          },
        },
      })
    }

    const routeRes = await this.request.post(this.url('/api/v1/routes/'), {
      headers: this.authHeaders(),
      data: {
        stream_id: streamId,
        destination_id: opts.destinationId,
        name: `${opts.name} route`,
        enabled: true,
        status: 'ACTIVE',
        failure_policy: 'LOG_AND_CONTINUE',
      },
    })
    const route = (await readJson(routeRes)) as { id?: number }
    const ref = { streamId, name: opts.name, routeIds: [Number(route.id)].filter(Boolean) }
    this.trackStream(ref)
    return ref
  }

  async deployStream(streamId: number): Promise<void> {
    const res = await this.request.put(this.url(`/api/v1/streams/${streamId}`), {
      headers: this.authHeaders(),
      data: { enabled: true, status: 'RUNNING' },
    })
    await readJson(res)
  }

  async configureCheckpoint(_streamId: number): Promise<void> {
    // Smoke uses static fixtures; checkpoint config optional for first delivery.
  }

  async selectRecordPath(streamId: number, path: string): Promise<void> {
    await this.request.put(this.url(`/api/v1/streams/${streamId}`), {
      headers: this.authHeaders(),
      data: { event_array_path: path },
    })
  }

  async selectEventRoot(_streamId: number, _path: string | null): Promise<void> {
    // Optional for smoke
  }

  async runSample(connectorId: number): Promise<unknown> {
    const res = await this.request.post(this.url('/api/v1/runtime/api-test/http'), {
      headers: this.authHeaders(),
      data: { connector_id: connectorId, fetch_sample: true },
    })
    if (res.status() === 404) {
      return { skipped: true, reason: 'api-test/http unavailable' }
    }
    try {
      return await readJson(res)
    } catch {
      return { status: res.status() }
    }
  }

  async openRuntime(): Promise<void> {
    if (!this.page) return
    await this.page.goto(`${this.env.uiBaseUrl}/runtime`)
  }

  /**
   * Invoke POST /runtime/streams/{id}/run-once.
   * HTTP 2xx alone is not product success — callers must still verify lifecycle telemetry.
   * Lock contention and dispatch failures return non-2xx (e.g. 409 RUN_ALREADY_ACTIVE).
   *
   * After deploy, the lab standalone scheduler may briefly own the stream. Retry a short
   * window on RUN_ALREADY_ACTIVE so harness run-once still executes once the poller releases.
   */
  async runStream(streamId: number): Promise<unknown> {
    const maxAttempts = 8
    let lastErr: Error | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.request.post(this.url(`/api/v1/runtime/streams/${streamId}/run-once`), {
        headers: this.authHeaders(),
        data: {},
      })
      const body = await readJson(res).catch(async () => ({ raw: await res.text().catch(() => '') }))
      if (!res.ok()) {
        const err = new Error(`run-once failed HTTP ${res.status()}: ${JSON.stringify(body)}`) as Error & {
          status?: number
          body?: unknown
          error_code?: string
        }
        err.status = res.status()
        err.body = body
        const detail =
          body && typeof body === 'object'
            ? ((body as { detail?: { error_code?: string } }).detail ?? body)
            : undefined
        err.error_code =
          detail && typeof detail === 'object'
            ? String((detail as { error_code?: string }).error_code || '')
            : undefined
        const isLockContention =
          err.status === 409 &&
          (err.error_code === 'RUN_ALREADY_ACTIVE' ||
            /RUN_ALREADY_ACTIVE|stream already running/i.test(String(err.message)))
        if (isLockContention && attempt < maxAttempts) {
          lastErr = err
          await new Promise((r) => setTimeout(r, 400 + attempt * 150))
          continue
        }
        throw err
      }
      const outcome =
        body && typeof body === 'object' ? String((body as { outcome?: string }).outcome || '') : ''
      if (outcome === 'skipped_lock') {
        if (attempt < maxAttempts) {
          lastErr = Object.assign(new Error('SILENT_RUNTIME_NOOP: run-once 2xx with skipped_lock'), {
            classification: 'RUNTIME',
            error_code: 'SILENT_RUNTIME_NOOP',
            body,
          })
          await new Promise((r) => setTimeout(r, 400 + attempt * 150))
          continue
        }
        // Product must not return 2xx for lock skips; treat as hard failure if it regresses.
        throw Object.assign(new Error('SILENT_RUNTIME_NOOP: run-once 2xx with skipped_lock'), {
          classification: 'RUNTIME',
          error_code: 'SILENT_RUNTIME_NOOP',
          body,
        })
      }
      return body
    }
    throw lastErr || new Error(`run-once failed after ${maxAttempts} attempts stream=${streamId}`)
  }

  async waitForDelivery(opts: {
    kind: 'webhook' | 'syslog'
    correlationId: string | string[]
    protocol?: string
    timeoutMs?: number
  }): Promise<unknown[]> {
    if (opts.kind === 'webhook') {
      const id = Array.isArray(opts.correlationId) ? opts.correlationId[0] : opts.correlationId
      return this.fixtures.waitForWebhookCorrelation(id, opts.timeoutMs)
    }
    return this.fixtures.waitForSyslogCorrelation(opts.correlationId, {
      protocol: opts.protocol,
      timeoutMs: opts.timeoutMs,
    })
  }

  /**
   * POST an event into a WEBHOOK_RECEIVER ingest path and record request evidence fields.
   * Success (2xx) only means the platform accepted the request — caller must still correlate delivery.
   */
  async pushWebhookEvent(opts: {
    receiverKey: string
    correlationId: string
    payload?: Record<string, unknown>
    authMode?: string
    sharedSecret?: string
    authHeaderName?: string
    bearerToken?: string
  }): Promise<{
    requestUrl: string
    method: string
    maskedHeaders: Record<string, string>
    contentType: string
    requestBody: Record<string, unknown>
    correlationId: string
    responseStatus: number
    responseBody: unknown
    accepted: boolean
  }> {
    this.assertRequestAlive()
    const body: Record<string, unknown> = {
      id: `wh-${opts.correlationId}`,
      e2e_correlation_id: opts.correlationId,
      message: `full-e2e webhook ${opts.correlationId}`,
      severity: 'MEDIUM',
      ...(opts.payload || {}),
    }
    // Ensure correlation cannot be overwritten by payload spread above.
    body.e2e_correlation_id = opts.correlationId

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const mode = String(opts.authMode || 'no_auth')
    if (mode === 'shared_secret_header' && opts.sharedSecret) {
      headers[opts.authHeaderName || 'X-GDC-Webhook-Secret'] = opts.sharedSecret
    } else if (mode === 'bearer_token' && opts.bearerToken) {
      headers.Authorization = `Bearer ${opts.bearerToken}`
    }

    const requestUrl = this.url(`/api/v1/ingest/webhook/${encodeURIComponent(opts.receiverKey)}`)
    const res = await this.request.post(requestUrl, { headers, data: body })
    let responseBody: unknown = null
    const text = await res.text()
    try {
      responseBody = text ? JSON.parse(text) : null
    } catch {
      responseBody = text
    }
    const maskedHeaders = maskSecrets(headers) as Record<string, string>
    const accepted = res.ok()
    if (!accepted) {
      throw Object.assign(
        new Error(
          `Webhook push failed HTTP ${res.status()}: ${typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)}`,
        ),
        { classification: 'SOURCE_FIXTURE' as const, pushEvidence: { requestUrl, responseStatus: res.status(), responseBody } },
      )
    }
    return {
      requestUrl,
      method: 'POST',
      maskedHeaders,
      contentType: 'application/json',
      requestBody: body,
      correlationId: opts.correlationId,
      responseStatus: res.status(),
      responseBody,
      accepted: true,
    }
  }

  async getWebhookIngestObservability(streamId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/streams/${streamId}/webhook-ingest?window=1h`), {
      headers: this.authHeaders(),
    })
    if (!res.ok()) return { status: res.status() }
    return readJson(res)
  }

  /** Poll until webhook ingest returned accepted:true (or timeout). */
  async waitForWebhookAccepted(
    pushResult: { accepted?: boolean; responseStatus?: number },
    timeoutMs = 5_000,
  ): Promise<{ stage: 'accepted'; detail: unknown }> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (pushResult.accepted === true || (pushResult.responseStatus != null && pushResult.responseStatus < 300)) {
        return { stage: 'accepted', detail: pushResult }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`waitForWebhookAccepted timeout: last=${JSON.stringify(pushResult)}`)
  }

  /** Poll delivery logs until ingest/runtime stages appear after a webhook push. */
  async waitForWebhookIngested(streamId: number, timeoutMs = 20_000): Promise<{ stage: 'ingested'; detail: unknown }> {
    const deadline = Date.now() + timeoutMs
    let last: unknown = null
    while (Date.now() < deadline) {
      const logs = await this.getDeliveryLogs(streamId, 50).catch((e) => ({ error: String(e) }))
      last = logs
      const logText = JSON.stringify(logs || {}).toLowerCase()
      if (
        logText.includes('run_complete') ||
        logText.includes('route_send') ||
        logText.includes('run_start') ||
        logText.includes('extract') ||
        logText.includes('dedup')
      ) {
        return { stage: 'ingested', detail: logs }
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(`waitForWebhookIngested timeout stream=${streamId} last=${JSON.stringify(last)}`)
  }

  async waitForStreamProcessing(streamId: number, timeoutMs = 20_000): Promise<{ stage: 'processing'; detail: unknown }> {
    const deadline = Date.now() + timeoutMs
    let last: unknown = null
    while (Date.now() < deadline) {
      const logs = await this.getDeliveryLogs(streamId, 50).catch((e) => ({ error: String(e) }))
      last = logs
      const text = JSON.stringify(logs).toLowerCase()
      if (text.includes('run_complete') || text.includes('route_send') || text.includes('enrichment')) {
        return { stage: 'processing', detail: logs }
      }
      const status = await this.getRuntimeStatus(streamId).catch(() => null)
      if (status) last = { logs, status }
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(`waitForStreamProcessing timeout stream=${streamId} last=${JSON.stringify(last)}`)
  }

  async waitForDeliveryLog(
    streamId: number,
    opts?: { stageIncludes?: string[]; timeoutMs?: number },
  ): Promise<{ stage: 'delivery_log'; detail: unknown }> {
    const needles = (opts?.stageIncludes || ['route_send_success', 'run_complete']).map((s) => s.toLowerCase())
    const timeoutMs = opts?.timeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    let last: unknown = null
    while (Date.now() < deadline) {
      const logs = await this.getDeliveryLogs(streamId, 50).catch((e) => ({ error: String(e) }))
      last = logs
      const text = JSON.stringify(logs).toLowerCase()
      if (needles.some((n) => text.includes(n))) {
        return { stage: 'delivery_log', detail: logs }
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(`waitForDeliveryLog timeout stream=${streamId} needles=${needles.join(',')} last=${JSON.stringify(last)}`)
  }

  async waitForCollectorMessage(opts: {
    kind: 'webhook' | 'syslog'
    correlationId: string | string[]
    protocol?: string
    timeoutMs?: number
  }): Promise<{ stage: 'collector'; detail: unknown[] }> {
    const msgs = await this.waitForDelivery(opts)
    return { stage: 'collector', detail: msgs }
  }

  async snapshotCollectorMessages(opts: {
    kind: 'webhook' | 'syslog'
    correlationId: string | string[]
    protocol?: string
  }): Promise<{ messages: unknown[]; keys: string[] }> {
    const messages = await this.fixtures.listByCorrelation(opts.kind, opts.correlationId, {
      protocol: opts.protocol,
    })
    const keys = messages.map((m) => FixtureClient.collectorMessageKey(m))
    return { messages, keys }
  }

  async waitForNewCollectorMessage(opts: {
    kind: 'webhook' | 'syslog'
    correlationId: string | string[]
    protocol?: string
    timeoutMs?: number
    baselineKeys: Set<string>
    requireNew?: boolean
  }): Promise<{ stage: 'collector'; detail: unknown[]; all: unknown[]; baselineSize: number }> {
    const result = await this.fixtures.waitForNewByCorrelation(
      opts.kind,
      opts.correlationId,
      opts.baselineKeys,
      {
        protocol: opts.protocol,
        timeoutMs: opts.timeoutMs,
        requireNew: opts.requireNew,
      },
    )
    return {
      stage: 'collector',
      detail: result.neu,
      all: result.all,
      baselineSize: result.baselineSize,
    }
  }

  async getStreamConfig(streamId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/streams/${streamId}`), { headers: this.authHeaders() })
    return readJson(res)
  }

  async getRuntimeStatus(streamId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/streams/${streamId}/stats-health`), {
      headers: this.authHeaders(),
    })
    if (!res.ok()) {
      const alt = await this.request.get(this.url('/api/v1/runtime/status'), { headers: this.authHeaders() })
      return readJson(alt)
    }
    return readJson(res)
  }

  async getCheckpoint(streamId: number): Promise<unknown> {
    const res = await this.request.get(this.url(`/api/v1/runtime/streams/${streamId}/checkpoint`), {
      headers: this.authHeaders(),
    })
    if (!res.ok()) return { status: res.status() }
    return readJson(res)
  }

  /**
   * Fetch delivery logs for evidence / outcome judgment.
   * Default limit is API max (1000): multi-event webhook runs can emit 5 lifecycle
   * rows per event and push route_send_* out of a 50-row newest-first window.
   * Also merges stage-filtered pages for send/failover stages so judgment is not
   * truncated by lifecycle-only noise.
   */
  async getDeliveryLogs(streamId: number, limit = 1000): Promise<unknown> {
    const fetchSearch = async (extraQuery = '') => {
      const res = await this.request.get(
        this.url(`/api/v1/runtime/logs/search?stream_id=${streamId}&limit=${limit}&window=1h${extraQuery}`),
        { headers: this.authHeaders() },
      )
      if (res.ok()) return readJson(res)
      const alt = await this.request.get(
        this.url(`/api/v1/runtime/logs/page?stream_id=${streamId}&limit=${limit}&window=1h${extraQuery}`),
        { headers: this.authHeaders() },
      )
      if (!alt.ok()) return { status: res.status(), alt_status: alt.status() }
      return readJson(alt)
    }

    const primary = await fetchSearch()
    const primaryLogs = Array.isArray((primary as { logs?: unknown[] })?.logs)
      ? ((primary as { logs: unknown[] }).logs)
      : []
    const byId = new Map<string | number, unknown>()
    for (const row of primaryLogs) {
      if (!row || typeof row !== 'object') continue
      const id = (row as { id?: string | number }).id
      byId.set(id ?? byId.size, row)
    }

    const sendStages = [
      'route_send_success',
      'route_send_failed',
      'route_retry_success',
      'route_retry_failed',
      'destination_send_success',
      'failover_route_attempt',
      'failover_route_send_success',
      'failover_route_send_failed',
      'dynamic_route_send_success',
    ]
    for (const stage of sendStages) {
      const page = await fetchSearch(`&stage=${encodeURIComponent(stage)}`)
      const rows = Array.isArray((page as { logs?: unknown[] })?.logs)
        ? ((page as { logs: unknown[] }).logs)
        : []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const id = (row as { id?: string | number }).id
        byId.set(id ?? `${stage}-${byId.size}`, row)
      }
    }

    const merged = [...byId.values()]
    if (primary && typeof primary === 'object') {
      return {
        ...(primary as Record<string, unknown>),
        logs: merged,
        total_returned: merged.length,
        evidence_merge: {
          primary_count: primaryLogs.length,
          merged_count: merged.length,
          // Avoid embedding stage name substrings that naive string matchers could false-positive on.
          send_stage_query_count: sendStages.length,
        },
      }
    }
    return { logs: merged, total_returned: merged.length }
  }

  async getAuditEvents(_streamId?: number): Promise<unknown> {
    const res = await this.request.get(this.url('/api/v1/governance/audit?limit=20'), {
      headers: this.authHeaders(),
    })
    if (!res.ok()) return { status: res.status(), note: 'audit endpoint optional for smoke' }
    return readJson(res)
  }

  async getReceivedPayload(kind: 'webhook' | 'syslog', correlationId: string): Promise<unknown[]> {
    if (kind === 'webhook') return this.fixtures.getWebhookByCorrelation(correlationId)
    return this.fixtures.getSyslogByCorrelation(correlationId)
  }

  async configureRoute(_streamId: number, _routeId: number): Promise<void> {
    // Smoke uses default route created in createStream
  }

}

function mapAuthVariant(auth: string): AuthKind {
  switch (auth) {
    case 'basic':
      return 'basic'
    case 'bearer':
      return 'bearer'
    case 'api_key':
    case 'api_key_header':
      return 'api_key_header'
    case 'api_key_query':
      return 'api_key_query'
    case 'oauth2_client_credentials':
      return 'oauth2_client_credentials'
    case 'session_login':
      return 'session_login'
    case 'jwt_refresh_token':
      return 'jwt_refresh_token'
    case 'vendor_jwt_exchange':
      return 'vendor_jwt_exchange'
    default:
      return 'no_auth'
  }
}

function endpointForAuth(auth: AuthKind): string {
  switch (auth) {
    case 'basic':
      return '/basic/events'
    case 'bearer':
      return '/bearer/events'
    case 'api_key_header':
      return '/api-key-header/events'
    case 'api_key_query':
      return '/api-key-query/events'
    case 'oauth2_client_credentials':
      return '/oauth2/events'
    case 'session_login':
      return '/e2e-session/events'
    case 'jwt_refresh_token':
      return '/jwt-refresh/events'
    case 'vendor_jwt_exchange':
      return '/vendor/events'
    default:
      return '/no-auth/events'
  }
}
