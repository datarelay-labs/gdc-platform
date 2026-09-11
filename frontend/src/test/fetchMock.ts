import { expect } from 'vitest'

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function getUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

export function parseJsonBody(init: RequestInit | undefined): unknown {
  const raw = init?.body
  if (typeof raw !== 'string') {
    throw new Error('Expected fetch init.body to be a JSON string')
  }
  return JSON.parse(raw) as unknown
}

/** Mapping tab preview guard: no destination routes or live delivery URLs. */
export function assertNoLiveDeliveryInCalls(mockCalls: unknown[][]): void {
  for (const call of mockCalls) {
    const u = getUrl(call[0] as RequestInfo | URL)
    expect(u).not.toMatch(/\/destinations\//)
    expect(u).not.toMatch(/\/routes\/[^/]+\/send/)
    expect(u).not.toMatch(/delivery/)
  }
}

/** Preview-only Control & Test sequence: no stream start/stop, checkpoint, or /send. */
export function assertPreviewOnlySafeUrls(mockCalls: unknown[][]): void {
  for (const call of mockCalls) {
    const u = getUrl(call[0] as RequestInfo | URL)
    expect(u).not.toMatch(/\/streams\/[^/]+\/(start|stop)/)
    expect(u.toLowerCase()).not.toMatch(/checkpoint/)
    expect(u).not.toMatch(/\/send(?:\/|$)/)
    const allowed =
      u.includes('/api-test/http') ||
      u.includes('/api-test/connector-auth') ||
      u.includes('/preview/mapping') ||
      u.includes('/preview/format') ||
      u.includes('/preview/route-delivery') ||
      u.includes('/preview/sensitive-detection') ||
      u.includes('/format-preview')
    expect(allowed).toBe(true)
  }
}
