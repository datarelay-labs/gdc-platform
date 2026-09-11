/**
 * Lab stability helpers used by createTestContext.
 * Included in Cross-Product harness hash (see harness-version.ts / harness-scope.json).
 *
 * Policy (retry-policy.json):
 * - Empty-delivery retry: S3_OBJECT_POLLING or REMOTE_FILE_POLLING + continue only, max 1.
 * - Transient API retry: network/transport only, max 1; never 401/403.
 * - S3 seed: overwrite-only put_object on fixed keys (no delete).
 * - REMOTE_FILE: re-run only (durable SFTP fixtures; no assertion softening).
 */
import type { DataRelayDriver } from './data-relay-driver'
import type { EvidenceCollector } from './evidence-collector'
import { waitForApiHealth } from './api-context'
import type { LabEnv } from './scenario-types'

export type LabRetryOpts = {
  /** Empty-delivery retry allowed for S3 / REMOTE_FILE continue scenarios. */
  enableEmptyDeliveryRetry?: boolean
  enableTransientApiRetry?: boolean
  sourceType?: string
  deliveryBehavior?: string
}

export const EMPTY_DELIVERY_RETRY_MAX = 1
export const TRANSIENT_API_RETRY_MAX = 1

const EMPTY_DELIVERY_ALLOWED_SOURCES = new Set(['S3_OBJECT_POLLING', 'REMOTE_FILE_POLLING'])

export function shouldEnableEmptyDeliveryRetry(opts: LabRetryOpts): boolean {
  if (opts.enableEmptyDeliveryRetry === false) return false
  if (opts.enableEmptyDeliveryRetry === true) {
    // Explicit enable still forbids governance outcomes.
    if (opts.deliveryBehavior === 'block' || opts.deliveryBehavior === 'quarantine') return false
    return true
  }
  return (
    EMPTY_DELIVERY_ALLOWED_SOURCES.has(String(opts.sourceType || '')) &&
    opts.deliveryBehavior === 'continue'
  )
}

export function isTransientApiError(err: unknown): boolean {
  const msg = String(err ?? '')
  if (/\b401\b|\b403\b|Unauthorized|Forbidden|authentication|authorization/i.test(msg)) {
    return false
  }
  return /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|net::ERR_/i.test(msg)
}

/** Overwrite-only MinIO seed for shared full-e2e S3 fixtures. */
export async function seedS3LabFixturesOverwriteOnly(
  env: LabEnv,
): Promise<{ ok: boolean; keys: string[]; mode: 'overwrite_only' }> {
  const { spawnSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const fixtureDir = path.resolve(here, '../lab/fixtures/s3')
  const py = `
import os
from pathlib import Path
import boto3
from botocore.client import Config as BotoConfig
endpoint = os.environ["MINIO_ENDPOINT"]
bucket = os.environ["MINIO_BUCKET"]
client = boto3.client(
    "s3",
    endpoint_url=endpoint,
    aws_access_key_id=os.environ["MINIO_ACCESS"],
    aws_secret_access_key=os.environ["MINIO_SECRET"],
    use_ssl=endpoint.lower().startswith("https://"),
    config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
    region_name="us-east-1",
)
try:
    client.create_bucket(Bucket=bucket)
except Exception:
    pass
src = Path(os.environ["FIXTURE_S3_DIR"])
prefix = os.environ.get("S3_PREFIX") or "full-e2e/"
if not prefix.endswith("/"):
    prefix += "/"
mapping = {
    "init.ndjson": prefix + "init.ndjson",
    "new.ndjson": prefix + "new.ndjson",
    "dup.ndjson": prefix + "dup.ndjson",
    "invalid.ndjson": prefix + "invalid.ndjson",
    "nested.json": prefix + "nested.json",
}
keys = []
for name, key in mapping.items():
    body = (src / name).read_bytes()
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/octet-stream")
    keys.append(key)
print(",".join(keys))
`
  const r = spawnSync('python3', ['-c', py], {
    env: {
      ...process.env,
      MINIO_ENDPOINT: env.minioEndpoint,
      MINIO_ACCESS: env.minioAccessKey,
      MINIO_SECRET: env.minioSecretKey,
      MINIO_BUCKET: env.minioBucket,
      S3_PREFIX: env.s3Prefix,
      FIXTURE_S3_DIR: fixtureDir,
    },
    encoding: 'utf-8',
  })
  if (r.status !== 0) {
    throw Object.assign(new Error(`seedS3LabFixtures failed: ${r.stderr || r.stdout}`), {
      classification: 'TEST_INFRA',
    })
  }
  const keys = String(r.stdout || '')
    .trim()
    .split(',')
    .filter(Boolean)
  return { ok: true, keys, mode: 'overwrite_only' }
}

/**
 * At most one empty-delivery retry for allowed S3 / REMOTE_FILE continue scenarios.
 * Preserves attempt-1 and attempt-2 evidence; does not soften assertions.
 */
export function installEmptyDeliveryRetry(
  driver: DataRelayDriver,
  env: LabEnv,
  evidence: EvidenceCollector,
  opts: LabRetryOpts = {},
): void {
  const origRun = driver.runStream.bind(driver)
  const origLogs = driver.getDeliveryLogs.bind(driver)
  let retriesUsed = 0
  const sourceType = String(opts.sourceType || '')
  driver.getDeliveryLogs = async (streamId: number) => {
    let logs = await origLogs(streamId)
    const total = Number((logs as { total_returned?: number })?.total_returned ?? 0)
    const nlogs = Array.isArray((logs as { logs?: unknown[] })?.logs)
      ? (logs as { logs: unknown[] }).logs.length
      : 0
    if (total > 0 || nlogs > 0) return logs
    if (retriesUsed >= EMPTY_DELIVERY_RETRY_MAX) {
      evidence.writeJsonFile('lab-runstream-retry.json', {
        reason: 'empty_delivery_logs_after_run',
        streamId,
        sourceType,
        retries_used: retriesUsed,
        max_attempts: EMPTY_DELIVERY_RETRY_MAX,
        final: { total_returned: total, logs_len: nlogs },
        note: 'max empty-delivery retries exhausted; assertions unchanged',
      })
      return logs
    }
    retriesUsed += 1
    const attempt1 = {
      reason: 'empty_delivery_logs_after_run',
      streamId,
      sourceType,
      attempt: 1,
      total_returned: total,
      logs_len: nlogs,
    }
    evidence.writeJsonFile('lab-runstream-retry-attempt-1.json', attempt1)
    if (sourceType === 'S3_OBJECT_POLLING' || !sourceType) {
      await seedS3LabFixturesOverwriteOnly(env)
    }
    await new Promise((r) => setTimeout(r, 400))
    await origRun(streamId)
    logs = await origLogs(streamId)
    const attempt2 = {
      reason: 'empty_delivery_logs_after_run',
      streamId,
      sourceType,
      attempt: 2,
      total_returned: Number((logs as { total_returned?: number })?.total_returned ?? 0),
      logs_len: Array.isArray((logs as { logs?: unknown[] })?.logs)
        ? (logs as { logs: unknown[] }).logs.length
        : 0,
    }
    evidence.writeJsonFile('lab-runstream-retry-attempt-2.json', attempt2)
    evidence.writeJsonFile('lab-runstream-retry.json', {
      reason: 'empty_delivery_logs_after_run',
      streamId,
      sourceType,
      retries_used: retriesUsed,
      max_attempts: EMPTY_DELIVERY_RETRY_MAX,
      attempts: [attempt1, attempt2],
    })
    return logs
  }
}

/** At most one transient transport retry; never auth/governance/payload failures. */
export function installTransientApiRetry(
  driver: DataRelayDriver,
  env: LabEnv,
  evidence: EvidenceCollector,
): void {
  const wrap = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      let lastErr: unknown
      const maxTries = TRANSIENT_API_RETRY_MAX + 1
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
          return await fn(...args)
        } catch (err) {
          lastErr = err
          if (attempt >= maxTries || !isTransientApiError(err)) throw err
          evidence.writeJsonFile('lab-api-retry.json', {
            method: name,
            attempt,
            max_attempts: TRANSIENT_API_RETRY_MAX,
            error: String(err).slice(0, 500),
          })
          await waitForApiHealth(env.apiBaseUrl).catch(() => undefined)
          await new Promise((r) => setTimeout(r, 400 * attempt))
          try {
            await driver.login()
          } catch {
            /* best-effort */
          }
        }
      }
      throw lastErr
    }
  }

  const methods = [
    'createConnectorForSourceType',
    'createDestinationByType',
    'createStreamForSource',
    'createMultiRouteStream',
    'deployStream',
    'runStream',
    'configureDedup',
    'configureProtection',
    'saveDefaultFieldMappings',
    'saveEnrichmentRules',
    'getDeliveryLogs',
    'getCheckpoint',
    'getStreamConfig',
    'getRuntimeStatus',
  ] as const

  for (const name of methods) {
    const current = (driver as unknown as Record<string, unknown>)[name]
    if (typeof current !== 'function') continue
    ;(driver as unknown as Record<string, unknown>)[name] = wrap(
      name,
      (current as (...args: unknown[]) => Promise<unknown>).bind(driver),
    )
  }
}
