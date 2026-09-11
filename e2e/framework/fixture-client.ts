import type { APIRequestContext } from '@playwright/test'
import type { LabEnv } from './scenario-types'

const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'private_key',
  'secret_key',
  'access_key',
  'bearer_token',
  'db_password',
  'remote_password',
  'remote_private_key',
])

export function loadLabEnv(): LabEnv {
  const routeRaw = (process.env.GDC_ROUTE_PROCESSING_ENABLED ?? 'false').trim().toLowerCase()
  const routeProcessingEnabled = routeRaw === 'true' || routeRaw === '1' || routeRaw === 'on'
  return {
    apiBaseUrl: (process.env.PLAYWRIGHT_API_BASE_URL || process.env.GDC_E2E_API_BASE_URL || 'http://127.0.0.1:18000').replace(
      /\/$/,
      '',
    ),
    uiBaseUrl: (process.env.PLAYWRIGHT_BASE_URL || process.env.GDC_E2E_UI_BASE_URL || 'http://127.0.0.1:4173').replace(
      /\/$/,
      '',
    ),
    wiremockBaseUrl: (process.env.WIREMOCK_BASE_URL || 'http://127.0.0.1:28080').replace(/\/$/, ''),
    webhookCollectorUrl: (process.env.GDC_E2E_WEBHOOK_COLLECTOR_URL || 'http://127.0.0.1:18192').replace(/\/$/, ''),
    syslogCollectorApiUrl: (process.env.GDC_E2E_SYSLOG_COLLECTOR_API_URL || 'http://127.0.0.1:18193').replace(/\/$/, ''),
    syslogHost: process.env.GDC_E2E_SYSLOG_COLLECTOR_HOST || '127.0.0.1',
    syslogPort: Number(process.env.GDC_E2E_SYSLOG_COLLECTOR_PORT || 15614),
    syslogTlsPort: Number(process.env.GDC_E2E_SYSLOG_TLS_PORT || 16614),
    namePrefix: process.env.GDC_E2E_NAME_PREFIX || '[FULL E2E]',
    s3Prefix: (process.env.GDC_E2E_S3_PREFIX || 'full-e2e/').replace(/\/*$/, '/'),
    collectorChannel: (process.env.GDC_E2E_COLLECTOR_CHANNEL || '').trim(),
    sftpDirectory: process.env.GDC_E2E_SFTP_DIRECTORY || '/upload/full-e2e',
    routeProcessingEnabled,
    requireAuth: (process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true',
    minioEndpoint: process.env.SOURCE_E2E_MINIO_ENDPOINT || 'http://127.0.0.1:59000',
    minioAccessKey: process.env.SOURCE_E2E_MINIO_ACCESS_KEY || 'gdcminioaccess',
    minioSecretKey: process.env.SOURCE_E2E_MINIO_SECRET_KEY || 'gdcminioaccesssecret12',
    minioBucket: process.env.SOURCE_E2E_MINIO_BUCKET || 'gdc-full-e2e',
    pgFixtureUrl:
      process.env.SOURCE_E2E_PG_FIXTURE_URL ||
      'postgresql://gdc_fixture:gdc_fixture_pw@127.0.0.1:55433/gdc_query_fixture',
    sftpHost: process.env.SOURCE_E2E_SFTP_HOST || '127.0.0.1',
    sftpPort: Number(process.env.SOURCE_E2E_SFTP_PORT || 22222),
    sftpUser: process.env.SOURCE_E2E_SFTP_USER || 'gdc',
    sftpPassword: process.env.SOURCE_E2E_SFTP_PASSWORD || 'devlab123',
  }
}

export function maskSecrets<T>(value: T): T {
  return maskValue(value) as T
}

function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase()) || /password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key/i.test(k)) {
        out[k] = typeof v === 'string' && v.length === 0 ? '' : '********'
      } else {
        out[k] = maskValue(v)
      }
    }
    return out
  }
  return value
}

export class FixtureClient {
  private _disposed = false

  constructor(
    readonly env: LabEnv,
    private request: APIRequestContext,
  ) {}

  bindRequest(request: APIRequestContext): void {
    this.request = request
    this._disposed = false
  }

  markDisposed(): void {
    this._disposed = true
  }

  private assertRequestAlive(): void {
    if (this._disposed) {
      throw Object.assign(new Error('Request context disposed'), { classification: 'TEST_INFRA' })
    }
  }

  /**
   * Readiness requires more than a listening TCP port:
   * HTTP /ready/tls → TCP connect → TLS handshake → probe send → collector API receipt.
   */
  async ensureSyslogTlsReady(timeoutMs = 30_000): Promise<void> {
    this.assertRequestAlive()
    const deadline = Date.now() + timeoutMs
    let lastErr = 'not attempted'
    while (Date.now() < deadline) {
      try {
        const ready = await this.request.get(`${this.env.syslogCollectorApiUrl}/ready/tls`)
        if (!ready.ok()) {
          lastErr = `ready/tls HTTP ${ready.status()}`
          await new Promise((r) => setTimeout(r, 400))
          continue
        }
        const body = (await ready.json().catch(() => ({}))) as { tls_ready?: boolean; ok?: boolean }
        if (body.tls_ready !== true && body.ok !== true) {
          lastErr = 'ready/tls flag false'
          await new Promise((r) => setTimeout(r, 400))
          continue
        }
        const probeId = `tls-ready-probe-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
        await this.probeSyslogTlsHandshake(probeId)
        const seen = await this.waitForSyslogCorrelation(probeId, {
          protocol: 'tls',
          timeoutMs: Math.min(5_000, Math.max(1_000, deadline - Date.now())),
        })
        if (seen.length > 0) return
        lastErr = `probe sent but collector API did not observe ${probeId}`
      } catch (err) {
        lastErr = String(err)
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    throw Object.assign(new Error(`syslog TLS collector not ready: ${lastErr}`), {
      classification: 'DESTINATION_FIXTURE',
    })
  }

  /** TCP connect + TLS handshake + one newline-framed JSON probe to the lab TLS port. */
  async probeSyslogTlsHandshake(correlationId: string): Promise<void> {
    const tls = await import('node:tls')
    const host = this.env.syslogHost
    const port = this.env.syslogTlsPort
    const payload = JSON.stringify({
      e2e_correlation_id: correlationId,
      message: 'syslog-tls-readiness-probe',
      probe: true,
    })
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(
        {
          host,
          port,
          servername: 'localhost',
          rejectUnauthorized: false,
          timeout: 5_000,
        },
        () => {
          socket.write(`${payload}\n`, (err) => {
            if (err) {
              socket.destroy()
              reject(err)
              return
            }
            socket.end()
            resolve()
          })
        },
      )
      socket.on('error', (err) => reject(err))
      socket.on('timeout', () => {
        socket.destroy()
        reject(new Error(`TLS probe timeout ${host}:${port}`))
      })
    })
  }

  async resetCollectors(): Promise<void> {
    this.assertRequestAlive()
    // Parallel workers must not wipe a shared collector. Isolation is by
    // destination collect path / syslog app_name + baseline/delta reads.
    if (this.env.collectorChannel) {
      return
    }
    const wh = await this.request.post(`${this.env.webhookCollectorUrl}/reset`)
    if (!wh.ok()) throw new Error(`webhook collector reset failed: ${wh.status()}`)
    const sy = await this.request.post(`${this.env.syslogCollectorApiUrl}/reset`)
    if (!sy.ok()) throw new Error(`syslog collector reset failed: ${sy.status()}`)
  }

  async listWebhookMessages(limit = 200): Promise<unknown[]> {
    const res = await this.request.get(`${this.env.webhookCollectorUrl}/messages?limit=${limit}`)
    if (!res.ok()) throw new Error(`webhook list failed: ${res.status()}`)
    const body = (await res.json()) as { messages?: unknown[] }
    return body.messages ?? []
  }

  async getWebhookByCorrelation(correlationId: string): Promise<unknown[]> {
    const res = await this.request.get(
      `${this.env.webhookCollectorUrl}/messages/by-correlation/${encodeURIComponent(correlationId)}`,
    )
    if (!res.ok()) throw new Error(`webhook by-correlation failed: ${res.status()}`)
    const body = (await res.json()) as { messages?: unknown[] }
    return body.messages ?? []
  }

  async countWebhook(): Promise<number> {
    const res = await this.request.get(`${this.env.webhookCollectorUrl}/count`)
    if (!res.ok()) throw new Error(`webhook count failed: ${res.status()}`)
    const body = (await res.json()) as { count?: number }
    return Number(body.count ?? 0)
  }

  async listSyslogMessages(opts?: { protocol?: string; limit?: number }): Promise<unknown[]> {
    const q = new URLSearchParams()
    if (opts?.protocol) q.set('protocol', opts.protocol)
    q.set('limit', String(opts?.limit ?? 200))
    const res = await this.request.get(`${this.env.syslogCollectorApiUrl}/messages?${q.toString()}`)
    if (!res.ok()) throw new Error(`syslog list failed: ${res.status()}`)
    const body = (await res.json()) as { messages?: unknown[] }
    return body.messages ?? []
  }

  async getSyslogByCorrelation(correlationId: string, opts?: { protocol?: string }): Promise<unknown[]> {
    this.assertRequestAlive()
    const q = opts?.protocol ? `?protocol=${encodeURIComponent(opts.protocol)}` : ''
    const res = await this.request.get(
      `${this.env.syslogCollectorApiUrl}/messages/by-correlation/${encodeURIComponent(correlationId)}${q}`,
    )
    if (!res.ok()) throw new Error(`syslog by-correlation failed: ${res.status()}`)
    const body = (await res.json()) as { messages?: unknown[] }
    return body.messages ?? []
  }

  async countSyslog(): Promise<number> {
    const res = await this.request.get(`${this.env.syslogCollectorApiUrl}/count`)
    if (!res.ok()) throw new Error(`syslog count failed: ${res.status()}`)
    const body = (await res.json()) as { count?: number }
    return Number(body.count ?? 0)
  }

  async waitForWebhookCorrelation(correlationId: string, timeoutMs = 30_000): Promise<unknown[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const msgs = await this.getWebhookByCorrelation(correlationId)
      if (msgs.length > 0) return msgs
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`timeout waiting for webhook correlation_id=${correlationId}`)
  }

  async waitForSyslogCorrelation(
    correlationId: string | string[],
    opts?: { protocol?: string; timeoutMs?: number },
  ): Promise<unknown[]> {
    this.assertRequestAlive()
    const ids = Array.isArray(correlationId) ? correlationId : [correlationId]
    const timeoutMs = opts?.timeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const id of ids) {
        const msgs = await this.getSyslogByCorrelation(id, { protocol: opts?.protocol })
        if (msgs.length > 0) return msgs
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(
      `timeout waiting for syslog correlation_id=${ids.join('|')}` +
        (opts?.protocol ? ` protocol=${opts.protocol}` : ''),
    )
  }

  /**
   * Keep only this worker's collector rows. Webhook destinations post to
   * /collect/<channel>; syslog app_name is the same token.
   */
  private filterByCollectorChannel(messages: unknown[]): unknown[] {
    const channel = this.env.collectorChannel
    if (!channel) return messages
    return messages.filter((msg) => FixtureClient.messageBelongsToChannel(msg, channel))
  }

  static messageBelongsToChannel(msg: unknown, channel: string): boolean {
    if (!channel) return true
    const row = msg as { path?: unknown; raw_message?: unknown; body?: unknown; raw_body?: unknown }
    const path = String(row?.path ?? '')
    if (path.includes(`/${channel}`) || path.endsWith(channel)) return true
    const raw = `${String(row?.raw_message ?? '')} ${String(row?.raw_body ?? '')}`
    if (raw.includes(channel)) return true
    try {
      const bodyText = typeof row?.body === 'string' ? row.body : JSON.stringify(row?.body ?? '')
      if (bodyText.includes(channel)) return true
    } catch {
      /* ignore */
    }
    return false
  }

  static collectorMessageKey(msg: unknown): string {
    const row = msg as {
      id?: unknown
      timestamp?: unknown
      correlation_id?: unknown
      protocol?: unknown
      path?: unknown
      raw_message?: unknown
      raw_body?: unknown
      body?: unknown
    }
    const idPart = row?.id !== undefined && row?.id !== null ? String(row.id) : ''
    const ts = String(row?.timestamp ?? '')
    const cid = String(row?.correlation_id ?? '')
    const proto = String(row?.protocol ?? '')
    const path = String(row?.path ?? '')
    const raw = String(row?.raw_message ?? row?.raw_body ?? '')
    let bodyBit = ''
    try {
      bodyBit = typeof row?.body === 'string' ? row.body : JSON.stringify(row?.body ?? '')
    } catch {
      bodyBit = ''
    }
    // Lab collectors cap in-memory rows and used to reuse id=len(MESSAGES).
    // Identity must survive that collision or waitForNew treats fresh hits as baseline.
    return `id:${idPart}|ts:${ts}|cid:${cid}|p:${proto}|path:${path}|fp:${raw.slice(0, 240)}|b:${bodyBit.slice(0, 120)}`
  }

  async listByCorrelation(
    kind: 'webhook' | 'syslog',
    correlationId: string | string[],
    opts?: { protocol?: string },
  ): Promise<unknown[]> {
    const ids = Array.isArray(correlationId) ? correlationId : [correlationId]
    const out: unknown[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      const msgs =
        kind === 'webhook'
          ? await this.getWebhookByCorrelation(id)
          : await this.getSyslogByCorrelation(id, { protocol: opts?.protocol })
      for (const msg of msgs) {
        const key = FixtureClient.collectorMessageKey(msg)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(msg)
      }
    }
    // Correlation IDs are per-scenario unique. Do not drop syslog/webhook hits
    // that lack the worker channel token (APP-NAME is not always in raw payload).
    return out
  }

  /**
   * Wait for collector rows that were not present in baselineKeys.
   * When requireNew is false, returns the current new-row delta immediately (may be empty).
   */
  async waitForNewByCorrelation(
    kind: 'webhook' | 'syslog',
    correlationId: string | string[],
    baselineKeys: Set<string>,
    opts?: { protocol?: string; timeoutMs?: number; requireNew?: boolean },
  ): Promise<{ all: unknown[]; neu: unknown[]; baselineSize: number }> {
    this.assertRequestAlive()
    const timeoutMs = opts?.timeoutMs ?? 30_000
    const requireNew = opts?.requireNew !== false
    const deadline = Date.now() + timeoutMs
    let all: unknown[] = []
    let neu: unknown[] = []
    do {
      all = await this.listByCorrelation(kind, correlationId, { protocol: opts?.protocol })
      neu = all.filter((m) => !baselineKeys.has(FixtureClient.collectorMessageKey(m)))
      if (!requireNew || neu.length > 0) {
        return { all, neu, baselineSize: baselineKeys.size }
      }
      await new Promise((r) => setTimeout(r, 500))
    } while (Date.now() < deadline)
    if (requireNew) {
      const ids = Array.isArray(correlationId) ? correlationId.join('|') : correlationId
      throw new Error(
        `timeout waiting for NEW collector rows correlation_id=${ids}` +
          ` baseline=${baselineKeys.size} all=${all.length}` +
          (opts?.protocol ? ` protocol=${opts.protocol}` : ''),
      )
    }
    return { all, neu, baselineSize: baselineKeys.size }
  }

  async probeHttpAuth(path: string, init?: { headers?: Record<string, string> }): Promise<{ status: number; body: unknown }> {
    const res = await this.request.get(`${this.env.wiremockBaseUrl}${path}`, {
      headers: init?.headers,
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = await res.text()
    }
    return { status: res.status(), body }
  }
}
