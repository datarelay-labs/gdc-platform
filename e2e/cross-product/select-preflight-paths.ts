#!/usr/bin/env npx tsx
/**
 * Select ≥1 valid combination per critical execution path for preflight smoke.
 * Does not sample/shrink the full suite — only picks representatives for gate-before-full-run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CrossProductAxes, ValidCombination } from './cross-product-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GEN = path.join(__dirname, 'generated')

type PathDef = {
  id: string
  match: (a: CrossProductAxes) => boolean
}

const PATHS: PathDef[] = [
  {
    id: 'browser-route-off',
    match: (a) => a.execution_surface === 'BROWSER' && a.route_runtime === 'ROUTE_OFF',
  },
  {
    id: 'browser-route-on',
    match: (a) => a.execution_surface === 'BROWSER' && a.route_runtime === 'ROUTE_ON',
  },
  {
    id: 'api-route-on',
    match: (a) => a.execution_surface === 'API_SEEDED' && a.route_runtime === 'ROUTE_ON',
  },
  {
    id: 'multi-route-inherit',
    match: (a) => a.route_topology === 'MULTI_ROUTE_ALL_INHERIT',
  },
  {
    id: 'transform-override',
    match: (a) => a.route_topology === 'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE',
  },
  {
    id: 'protection-override',
    match: (a) => a.route_topology === 'MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE',
  },
  {
    id: 'policy-override',
    match: (a) => a.route_topology === 'MULTI_ROUTE_MIXED_POLICY_OVERRIDE',
  },
  {
    id: 'browser-mixed-transform',
    match: (a) =>
      a.execution_surface === 'BROWSER' && a.route_topology === 'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE',
  },
  {
    id: 'browser-mixed-policy',
    match: (a) =>
      a.execution_surface === 'BROWSER' && a.route_topology === 'MULTI_ROUTE_MIXED_POLICY_OVERRIDE',
  },
  {
    id: 'delivery-continue',
    match: (a) => a.delivery_behavior === 'continue' && a.fault_type === 'NONE',
  },
  {
    id: 'delivery-quarantine',
    match: (a) => a.delivery_behavior === 'quarantine',
  },
  {
    id: 'delivery-block',
    match: (a) => a.delivery_behavior === 'block',
  },
  {
    id: 'syslog-udp',
    match: (a) => a.destination_type === 'SYSLOG_UDP',
  },
  {
    id: 'syslog-tcp',
    match: (a) => a.destination_type === 'SYSLOG_TCP',
  },
  {
    id: 'syslog-tls',
    match: (a) => a.destination_type === 'SYSLOG_TLS',
  },
  {
    id: 'webhook-post',
    match: (a) => a.destination_type === 'WEBHOOK_POST',
  },
  {
    id: 'source-http',
    match: (a) => a.source_type === 'HTTP_API_POLLING',
  },
  {
    id: 'source-postgresql',
    match: (a) => a.source_type === 'DATABASE_QUERY',
  },
  {
    id: 'source-s3',
    match: (a) => a.source_type === 'S3_OBJECT_POLLING',
  },
  {
    id: 'source-sftp',
    match: (a) => a.source_type === 'REMOTE_FILE_POLLING',
  },
  {
    id: 'source-webhook-receiver',
    match: (a) => a.source_type === 'WEBHOOK_RECEIVER',
  },
  {
    id: 'fault',
    match: (a) => a.fault_type !== 'NONE',
  },
  {
    id: 'recovery-replay',
    match: (a) => a.replay_mode === 'REPLAY_AFTER_RECOVERY',
  },
  {
    id: 'failover',
    match: (a) => a.route_topology === 'FAILOVER_ROUTE' || a.failover_mode !== 'NONE',
  },
]

function main() {
  const rows = fs
    .readFileSync(path.join(GEN, 'valid-combinations.jsonl'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ValidCombination)

  const selected: Array<{ path_id: string; combination_id: string; axes: CrossProductAxes }> = []
  const missing: string[] = []
  const used = new Set<string>()

  for (const p of PATHS) {
    const hit = rows.find((r) => !used.has(r.combination_id) && p.match(r.axes))
    if (!hit) {
      missing.push(p.id)
      continue
    }
    used.add(hit.combination_id)
    selected.push({ path_id: p.id, combination_id: hit.combination_id, axes: hit.axes })
  }

  const out = {
    generated_at: new Date().toISOString(),
    path_count: PATHS.length,
    selected_count: selected.length,
    missing_paths: missing,
    combination_ids: selected.map((s) => s.combination_id),
    selected,
  }
  const outPath = path.join(GEN, 'preflight-paths.json')
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  console.log(JSON.stringify({ ok: missing.length === 0, ...out, selected: undefined }, null, 2))
  if (missing.length) process.exitCode = 1
}

main()
