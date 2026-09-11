import { createAbortError, isRequestAborted, throwIfAborted } from './lib/request-abort'
import { getEffectiveApiBaseUrl } from './localPreferences'
import {
  extractHttpErrorCode,
  isPasswordChangeRequiredCode,
  markSessionRequiresPasswordChange,
  PasswordChangeRequiredError,
} from './auth/password-change-gate'
import { clearSession, getAccessToken, getRefreshToken, persistSession, readSession } from './auth/session'

export { PasswordChangeRequiredError } from './auth/password-change-gate'
export { createAbortError, isRequestAborted, throwIfAborted } from './lib/request-abort'

/** Shown when protected APIs return 401/403 after refresh failure. */
export const GDC_AUTH_REQUIRED_MESSAGE =
  'Session expired or authentication is required. Sign in again to load this data.'

export type GdcJsonResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; message: string; authRequired: boolean }

function isAuthHttpStatus(status: number): boolean {
  return status === 401 || status === 403
}

function formatHttpErrorBody(status: number, body: unknown): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const o = body as Record<string, unknown>
    const detail = o.detail
    if (typeof detail === 'string') return `${status}: ${detail}`
    if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
      const d = detail as Record<string, unknown>
      const parseErrors = d.parse_errors
      if (Array.isArray(parseErrors) && parseErrors.length) {
        const joined = parseErrors.map((item) => String(item)).join(' ')
        if (typeof d.error_code === 'string') return `${status}: [${d.error_code}] ${joined}`
        return `${status}: ${joined}`
      }
      if (typeof d.message === 'string') {
        if (typeof d.error_code === 'string') return `${status}: [${d.error_code}] ${d.message}`
        return `${status}: ${d.message}`
      }
    }
    if (typeof o.message === 'string') return `${status}: ${o.message}`
  }
  return `${status}: Request failed`
}

export function parseResponseBody(raw: string): unknown | null {
  if (!raw || !raw.trim()) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {
      error_code: 'NON_JSON_RESPONSE',
      message: 'The service returned a non-JSON error response.',
    }
  }
}

/**
 * Default origin for backend requests in dev mode.
 *
 * 127.0.0.1 is preferred over `localhost` because some browsers/OS resolvers
 * resolve `localhost` to `::1` (IPv6) first, while the dev uvicorn server
 * (`uvicorn --host 0.0.0.0`) binds IPv4 only. Hitting `localhost:8000` would
 * then fail silently before any HTTP request reaches the backend.
 */
const DEV_DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000'

function defaultApiBaseUrl(): string {
  const envBase = import.meta.env.VITE_API_BASE_URL
  if (envBase != null && String(envBase).trim() !== '') {
    return String(envBase).replace(/\/+$/, '')
  }
  if (import.meta.env.DEV) {
    // Vitest must keep a concrete origin; real dev uses the Vite page origin so `/api` hits the dev-server proxy.
    if (import.meta.env.VITEST) {
      return DEV_DEFAULT_API_BASE_URL
    }
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin
    }
    return DEV_DEFAULT_API_BASE_URL
  }
  // Production bundle: same-origin relative `/api/...` (nginx reverse-proxy, typically host :18080 in dev compose, or `vite preview` with proxy).
  if (typeof window !== 'undefined') {
    return ''
  }
  return DEV_DEFAULT_API_BASE_URL
}

export const API_BASE_URL = defaultApiBaseUrl()

/** Resolved origin for outbound requests (respects optional localStorage override). */
export function resolveApiBaseUrl(): string {
  return getEffectiveApiBaseUrl(API_BASE_URL)
}

/**
 * Visible debug log: surfaces the resolved backend origin once in dev mode.
 *
 * Helps the operator confirm `VITE_API_BASE_URL` was honored and spot the
 * common "frontend talks to wrong host" failure (e.g. when [DEV VALIDATION]
 * connectors are visible via curl but not in the UI).
 */
function logResolvedApiBaseUrlOnce(): void {
  if (!import.meta.env.DEV) return
  if (typeof window === 'undefined') return
  const w = window as unknown as { __gdcApiBaseLogged?: boolean }
  if (w.__gdcApiBaseLogged === true) return
  w.__gdcApiBaseLogged = true
  const envBase = import.meta.env.VITE_API_BASE_URL ?? null
  const resolved = resolveApiBaseUrl()
  const honoredEnv = envBase != null && String(envBase).trim() !== ''
  const consoleAny = console as unknown as { info?: (...args: unknown[]) => void; log: (...args: unknown[]) => void }
  const log = typeof consoleAny.info === 'function' ? consoleAny.info.bind(console) : consoleAny.log.bind(console)
  const hint = honoredEnv
    ? `(VITE_API_BASE_URL=${envBase})`
    : resolved === ''
      ? '(same-origin /api/*)'
      : resolved === DEV_DEFAULT_API_BASE_URL
        ? `(default=${DEV_DEFAULT_API_BASE_URL})`
        : '(see localStorage gdc.apiBaseUrlOverride)'
  log('[gdc] API base resolved:', resolved || '(empty → relative /api)', hint)
  if (!honoredEnv && resolved !== DEV_DEFAULT_API_BASE_URL && resolved !== '' && resolved !== window.location?.origin) {
    log('[gdc] API base differs from dev default. localStorage override active:', resolved)
  }
}

if (typeof window !== 'undefined') {
  try {
    logResolvedApiBaseUrlOnce()
  } catch {
    /* never crash the app for a diagnostic log */
  }
}

function authHeader(): Record<string, string> {
  const token = getAccessToken()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

const REFRESH_PATH = '/api/v1/auth/refresh'
const LOGIN_PATH = '/api/v1/auth/login'

let refreshInFlight: Promise<boolean> | null = null

/**
 * Attempt to exchange the stored refresh token for a fresh access token.
 *
 * Returns true on success.  The single in-flight promise is shared between
 * concurrent callers so we never fire multiple refresh requests when several
 * API calls race a 401 at the same time.
 */
async function tryRefreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  const refresh = getRefreshToken()
  if (!refresh) return false
  refreshInFlight = (async () => {
    try {
      const base = resolveApiBaseUrl()
      const res = await fetch(`${base}${REFRESH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      })
      if (!res.ok) return false
      const body = (await res.json()) as {
        access_token?: string
        refresh_token?: string
        expires_at?: string
        user?: {
          username?: string
          role?: 'ADMINISTRATOR' | 'OPERATOR' | 'VIEWER'
          status?: string
          must_change_password?: boolean
          capabilities?: Record<string, boolean>
        }
      }
      const current = readSession()
      if (!body.access_token || !body.refresh_token || !body.expires_at || !body.user) return false
      persistSession({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: body.expires_at,
        user: {
          username: body.user.username ?? current?.user.username ?? '',
          role: body.user.role ?? current?.user.role ?? 'VIEWER',
          status: body.user.status ?? current?.user.status ?? 'ACTIVE',
          ...(body.user.capabilities
            ? { capabilities: body.user.capabilities as Record<string, boolean> }
            : current?.user.capabilities
              ? { capabilities: current.user.capabilities }
              : {}),
        },
      })
      const refreshedSession = readSession()
      if (refreshedSession) {
        const user = { ...refreshedSession.user }
        if (body.user.must_change_password === true) {
          user.must_change_password = true
        } else {
          delete user.must_change_password
        }
        persistSession({ ...refreshedSession, user })
      }
      return true
    } catch {
      return false
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * Triggered on a hard auth failure (refresh failed / no refresh token).
 *
 * Clears the persisted session and bounces to `/` so the SPA's root component
 * shows the login screen again.  Safe to call multiple times.
 */
function handleAuthFailure(): void {
  clearSession()
  if (typeof window === 'undefined') return
  // Avoid redirect loops on the login flow itself.
  const path = window.location.pathname || ''
  if (path === '/' || path.startsWith('/login')) return
  try {
    window.location.assign('/')
  } catch {
    /* ignore */
  }
}

function isAuthEndpoint(path: string): boolean {
  return path.startsWith(LOGIN_PATH) || path.startsWith(REFRESH_PATH)
}

/** Optional client-side deadline for dashboard / list reads (AbortSignal + timer). */
export type GdcJsonFetchInit = RequestInit & { timeoutMs?: number }

/** Default ceiling for parallel dashboard and list-page JSON reads (ms). */
export const GDC_DEFAULT_READ_JSON_TIMEOUT_MS = 15_000

/** Longer ceiling for critical operational reads (snapshot, health overview). */
export const GDC_CRITICAL_READ_JSON_TIMEOUT_MS = 30_000

function mergeAbortSignals(user: AbortSignal | undefined, deadline: AbortSignal): AbortSignal {
  const anyFn =
    typeof AbortSignal !== 'undefined'
      ? (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
      : undefined
  if (typeof anyFn === 'function') {
    return anyFn(user ? [user, deadline] : [deadline])
  }
  if (!user) return deadline
  const c = new AbortController()
  const forward = () => {
    if (!c.signal.aborted) c.abort()
  }
  if (user.aborted || deadline.aborted) {
    forward()
    return c.signal
  }
  user.addEventListener('abort', forward)
  deadline.addEventListener('abort', forward)
  return c.signal
}

async function doFetch(path: string, init?: GdcJsonFetchInit, withJsonContentType = true): Promise<Response> {
  const raw = init ?? {}
  const { timeoutMs, ...rest } = raw
  const headersBase: Record<string, string> = {
    ...(withJsonContentType ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' }),
    ...authHeader(),
    ...((rest.headers as Record<string, string>) ?? {}),
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let effective: RequestInit = { ...rest, headers: headersBase }
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    const deadline = new AbortController()
    timer = setTimeout(() => deadline.abort(), timeoutMs)
    effective = {
      ...rest,
      headers: headersBase,
      signal: mergeAbortSignals(rest.signal, deadline.signal),
    }
  }
  const base = resolveApiBaseUrl()
  try {
    return await fetch(`${base}${path}`, effective)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function doFetchBinary(path: string, init?: GdcJsonFetchInit): Promise<Response> {
  const raw = init ?? {}
  const { timeoutMs, ...rest } = raw
  const headersBase: Record<string, string> = {
    Accept: '*/*',
    ...authHeader(),
    ...((rest.headers as Record<string, string>) ?? {}),
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let effective: RequestInit = { ...rest, headers: headersBase }
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    const deadline = new AbortController()
    timer = setTimeout(() => deadline.abort(), timeoutMs)
    effective = {
      ...rest,
      headers: headersBase,
      signal: mergeAbortSignals(rest.signal, deadline.signal),
    }
  }
  const base = resolveApiBaseUrl()
  try {
    return await fetch(`${base}${path}`, effective)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function requestJson<T>(path: string, init?: GdcJsonFetchInit): Promise<T> {
  throwIfAborted(init?.signal)
  let response: Response
  try {
    response = await doFetch(path, init, true)
  } catch (e) {
    if (isRequestAborted(e)) throw createAbortError()
    throw e
  }
  if (response.status === 401 && !isAuthEndpoint(path)) {
    throwIfAborted(init?.signal)
    const refreshed = await tryRefreshSession()
    if (refreshed) {
      throwIfAborted(init?.signal)
      try {
        response = await doFetch(path, init, true)
      } catch (e) {
        if (isRequestAborted(e)) throw createAbortError()
        throw e
      }
    } else {
      handleAuthFailure()
    }
  }
  throwIfAborted(init?.signal)
  const raw = await response.text()
  const body = parseResponseBody(raw)
  if (!response.ok) {
    if (response.status >= 500 || (body !== null && typeof body === 'object' && !Array.isArray(body) && (body as { error_code?: unknown }).error_code === 'NON_JSON_RESPONSE')) {
      console.warn('[gdc] request failed', path, response.status, raw.slice(0, 300))
    }
    const errorCode = extractHttpErrorCode(body)
    if (isPasswordChangeRequiredCode(errorCode)) {
      markSessionRequiresPasswordChange()
      const message =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? formatHttpErrorBody(response.status, body)
          : 'You must change your password before using this resource.'
      throw new PasswordChangeRequiredError(message)
    }
    throw new Error(formatHttpErrorBody(response.status, body ?? { message: 'Request failed' }))
  }
  if (response.status === 204 || raw.trim() === '') {
    return undefined as T
  }
  return body as T
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)
  if (quoted) return quoted[1].trim()
  const plain = /filename\s*=\s*([^;\s]+)/i.exec(header)
  return plain ? plain[1].trim() : null
}

/**
 * Authenticated binary download (401 triggers refresh like ``requestJson``).
 */
export async function requestBlob(path: string, init?: GdcJsonFetchInit): Promise<{ blob: Blob; filename: string | null }> {
  let response = await doFetchBinary(path, init)
  if (response.status === 401 && !isAuthEndpoint(path)) {
    const refreshed = await tryRefreshSession()
    if (refreshed) {
      response = await doFetchBinary(path, init)
    } else {
      handleAuthFailure()
    }
  }
  if (!response.ok) {
    const raw = await response.text()
    const body = parseResponseBody(raw)
    const errorCode = extractHttpErrorCode(body)
    if (isPasswordChangeRequiredCode(errorCode)) {
      markSessionRequiresPasswordChange()
      throw new PasswordChangeRequiredError(
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? formatHttpErrorBody(response.status, body)
          : 'You must change your password before using this resource.',
      )
    }
    throw new Error(formatHttpErrorBody(response.status, body ?? { message: 'Request failed' }))
  }
  const filename = parseContentDispositionFilename(response.headers.get('Content-Disposition'))
  const blob = await response.blob()
  return { blob, filename }
}

/**
 * JSON fetch with HTTP status and auth discrimination (for list/runtime polling UIs).
 */
export async function safeRequestJsonResult<T>(path: string, init?: GdcJsonFetchInit): Promise<GdcJsonResult<T>> {
  try {
    throwIfAborted(init?.signal)
    let response = await doFetch(path, init, false)
    if (response.status === 401 && !isAuthEndpoint(path)) {
      throwIfAborted(init?.signal)
      const refreshed = await tryRefreshSession()
      if (refreshed) {
        throwIfAborted(init?.signal)
        response = await doFetch(path, init, false)
      } else {
        handleAuthFailure()
        return {
          ok: false,
          status: 401,
          message: GDC_AUTH_REQUIRED_MESSAGE,
          authRequired: true,
        }
      }
    }
    const raw = await response.text()
    const body = parseResponseBody(raw)
    if (!response.ok) {
      const errorCode = extractHttpErrorCode(body)
      if (isPasswordChangeRequiredCode(errorCode)) {
        markSessionRequiresPasswordChange()
      }
      return {
        ok: false,
        status: response.status,
        message: formatHttpErrorBody(response.status, body ?? { message: 'Request failed' }),
        authRequired: isAuthHttpStatus(response.status),
      }
    }
    if (response.status === 204 || raw.trim() === '') {
      return { ok: true, data: undefined as T, status: response.status }
    }
    return { ok: true, data: JSON.parse(raw) as T, status: response.status }
  } catch (e) {
    if (isRequestAborted(e)) throw createAbortError()
    const message = e instanceof Error ? e.message : 'Request failed'
    return {
      ok: false,
      status: 0,
      message,
      authRequired: false,
    }
  }
}

/**
 * Best-effort JSON fetch: returns null on network/HTTP/parse errors (for mock fallbacks).
 */
export async function safeRequestJson<T>(path: string, init?: GdcJsonFetchInit): Promise<T | null> {
  try {
    const result = await safeRequestJsonResult<T>(path, init)
    return result.ok ? result.data : null
  } catch (e) {
    if (isRequestAborted(e)) throw createAbortError()
    throw e
  }
}
