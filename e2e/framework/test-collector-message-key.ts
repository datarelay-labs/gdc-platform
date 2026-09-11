#!/usr/bin/env npx tsx
/**
 * Regression: lab collectors cap in-memory rows and historically reused
 * id=len(MESSAGES). waitForNew keyed only on id, so every post-wrap hit
 * looked like the baseline (collector=0 despite route_send_success).
 */
import assert from 'node:assert/strict'
import { FixtureClient } from './fixture-client.js'

function main(): void {
  const baselineMsg = {
    id: 5000,
    timestamp: '2026-08-18T02:00:00.000000+00:00',
    correlation_id: 'full-e2e-corr-noauth-1',
    protocol: 'TLS',
    raw_message: '{"e2e_correlation_id":"full-e2e-corr-noauth-1","event_id":"old"}',
  }
  const freshMsg = {
    id: 5000,
    timestamp: '2026-08-18T02:04:00.000000+00:00',
    correlation_id: 'full-e2e-corr-noauth-1',
    protocol: 'TLS',
    raw_message: '{"e2e_correlation_id":"full-e2e-corr-noauth-1","event_id":"new"}',
  }
  const baselineKey = FixtureClient.collectorMessageKey(baselineMsg)
  const freshKey = FixtureClient.collectorMessageKey(freshMsg)
  assert.notEqual(baselineKey, freshKey, 'recycled collector ids must still be distinct keys')

  const baseline = new Set([baselineKey])
  const all = [baselineMsg, freshMsg]
  const neu = all.filter((m) => !baseline.has(FixtureClient.collectorMessageKey(m)))
  assert.equal(neu.length, 1, 'waitForNew delta must keep the fresh row')
  assert.equal(neu[0], freshMsg)

  const webhookA = {
    id: 5000,
    timestamp: '2026-08-18T02:00:00.000000+00:00',
    correlation_id: 'full-e2e-corr-noauth-1',
    path: '/collect/xpw-a',
    body: { e2e_correlation_id: 'full-e2e-corr-noauth-1', event_id: 'a' },
  }
  const webhookB = {
    id: 5000,
    timestamp: '2026-08-18T02:00:00.000000+00:00',
    correlation_id: 'full-e2e-corr-noauth-1',
    path: '/collect/xpw-b',
    body: { e2e_correlation_id: 'full-e2e-corr-noauth-1', event_id: 'b' },
  }
  assert.notEqual(
    FixtureClient.collectorMessageKey(webhookA),
    FixtureClient.collectorMessageKey(webhookB),
    'same recycled id across webhook channels must not collapse',
  )

  console.log(JSON.stringify({ ok: true, recycled_id_keys_distinct: true }, null, 2))
}

main()
