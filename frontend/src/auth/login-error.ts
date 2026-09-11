/** Shown when login cannot reach a healthy authentication API (5xx, gateway HTML, network). */
export const AUTH_SERVICE_UNAVAILABLE_MESSAGE =
  'Authentication service is temporarily unavailable. Please try again.'

const AUTH_STATUS_KEEP = new Set([400, 401, 403])

function looksLikeHtmlOrGatewayDump(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/^<!DOCTYPE/i.test(t) || /^<html[\s>]/i.test(t)) return true
  if (/<\s*(html|head|body|title)[\s>]/i.test(t)) return true
  if (/\bnginx\b/i.test(t) && /\b(502|503|504|bad gateway|html)\b/i.test(t)) return true
  return false
}

function looksLikeNetworkFailure(message: string): boolean {
  return (
    /failed to fetch/i.test(message) ||
    /network\s*error/i.test(message) ||
    /network request failed/i.test(message) ||
    /load failed/i.test(message) ||
    /err_connection/i.test(message) ||
    /econnrefused/i.test(message)
  )
}

/**
 * Map a login failure to copy that is safe to show on the sign-in form.
 *
 * 400/401/403 JSON auth errors keep existing semantics (invalid credentials, forbidden).
 * 5xx, gateway/proxy HTML, non-JSON bodies, and transport failures are sanitized.
 */
export function userFacingLoginError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '')
  const trimmed = message.trim()
  if (!trimmed) return AUTH_SERVICE_UNAVAILABLE_MESSAGE

  if (looksLikeNetworkFailure(trimmed) || looksLikeHtmlOrGatewayDump(trimmed)) {
    return AUTH_SERVICE_UNAVAILABLE_MESSAGE
  }
  if (/\bNON_JSON_RESPONSE\b/i.test(trimmed)) {
    return AUTH_SERVICE_UNAVAILABLE_MESSAGE
  }

  const statusMatch = /^(\d{3})\b/.exec(trimmed)
  const status = statusMatch ? Number(statusMatch[1]) : 0
  if (status >= 500) return AUTH_SERVICE_UNAVAILABLE_MESSAGE
  if (AUTH_STATUS_KEEP.has(status)) return trimmed

  return trimmed || 'Sign-in failed.'
}
