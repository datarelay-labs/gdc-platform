/**
 * Compute and persist Cross-Product harness version hashes.
 * Hashes are content-based (sha256 of file bytes) for every file that affects
 * scenario execution, including lab stability / retry helpers.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const E2E = path.resolve(__dirname, '..')
const ROOT = path.resolve(E2E, '..')
const GEN = path.join(__dirname, 'generated')

export type HarnessScopeEntry = {
  path: string
  sha256: string
  category: string
  required: boolean
  reason: string
  git_tracked: boolean
  invocation_proof: string
}

export type HarnessVersion = {
  executor_hash: string
  driver_hash: string
  spec_hash: string
  oracle_hash: string
  fixture_hash: string
  test_context_hash: string
  lab_stability_hash: string
  loader_hash: string
  api_context_hash: string
  fixture_client_hash: string
  playwright_config_hash: string
  retry_policy_hash: string
  applicability_source_hash: string
  axes_source_hash: string
  run_all_shards_hash: string
  recovery_lib_hash: string
  parallel_lib_hash: string
  parallel_coordinator_hash: string
  parallel_worker_hash: string
  harness_version: string
  git_commit: string
  manifest_hash: string
  applicability_rules_hash: string
  axes_hash: string
  scope_file_count: number
  scope_hash: string
  computed_at: string
}

/** Ordered harness inputs — path order is deterministic for hashing. */
export const HARNESS_SCOPE: Array<{
  rel: string
  category: string
  required: boolean
  reason: string
  invocation_proof: string
  componentKey?: keyof HarnessVersion
}> = [
  {
    rel: 'e2e/cross-product/cross-product-executor.ts',
    category: 'executor',
    required: true,
    reason: 'Scenario execution orchestration',
    invocation_proof: 'playwright cross-product.spec → runCrossProductScenario',
    componentKey: 'executor_hash',
  },
  {
    rel: 'e2e/framework/data-relay-driver.ts',
    category: 'driver',
    required: true,
    reason: 'API/browser driver for product operations',
    invocation_proof: 'executor → DataRelayDriver.*',
    componentKey: 'driver_hash',
  },
  {
    rel: 'e2e/cross-product/matrix/cross-product.spec.ts',
    category: 'spec',
    required: true,
    reason: 'Playwright entry for XP matrix',
    invocation_proof: 'npx playwright test --project=cross-product',
    componentKey: 'spec_hash',
  },
  {
    rel: 'e2e/cross-product/oracle.ts',
    category: 'oracle',
    required: true,
    reason: 'Expected outcome oracle',
    invocation_proof: 'executor → buildExpectedOracle',
    componentKey: 'oracle_hash',
  },
  {
    rel: 'e2e/cross-product/collector-route-plan.ts',
    category: 'collector_plan',
    required: true,
    reason: 'Per-route collector kind/protocol/correlation plan',
    invocation_proof: 'executor → buildRouteCollectorPlan / evaluateRouteCollectorOutcome',
  },
  {
    rel: 'e2e/cross-product/delivery-outcome.ts',
    category: 'delivery_outcome',
    required: true,
    reason: 'Runtime-evidence delivery_outcome derivation (never oracle-only delivered)',
    invocation_proof: 'executor → deriveActualDeliveryOutcome / assertDeliveryOutcomeConsistency',
  },
  {
    rel: 'e2e/cross-product/test-collector-route-plan.ts',
    category: 'collector_plan_test',
    required: true,
    reason: 'Regression+negative tests for multi-route collector verification',
    invocation_proof: 'npx tsx e2e/cross-product/test-collector-route-plan.ts',
  },
  {
    rel: 'e2e/cross-product/test-delivery-outcome.ts',
    category: 'delivery_outcome_test',
    required: true,
    reason: 'SYSLOG_TLS + failover + runtime_not_executed + SILENT_RUNTIME_NOOP delivery judgment regressions',
    invocation_proof: 'npx tsx e2e/cross-product/test-delivery-outcome.ts',
  },
  {
    rel: 'e2e/framework/test-collector-message-key.ts',
    category: 'collector_message_key_test',
    required: true,
    reason: 'Ring-buffer collector id reuse must not collapse waitForNew baseline keys',
    invocation_proof: 'npx tsx e2e/framework/test-collector-message-key.ts',
  },
  {
    rel: 'e2e/cross-product/fixtures/composite-chain-fixture.ts',
    category: 'fixture',
    required: true,
    reason: 'Composite chain fixture builder',
    invocation_proof: 'executor → composite chain fixture',
    componentKey: 'fixture_hash',
  },
  {
    rel: 'e2e/framework/test-context.ts',
    category: 'test_context',
    required: true,
    reason: 'Per-scenario context; installs lab seed/retry; bounded finalize cleanup',
    invocation_proof: 'g5: lab-seed.json x1050; createTestContext each combo; finalizeTestContext',
    componentKey: 'test_context_hash',
  },
  {
    rel: 'e2e/framework/resource-cleanup.ts',
    category: 'resource_cleanup',
    required: true,
    reason: 'ID-based cleanup after each scenario; per-call API timeouts prevent hang',
    invocation_proof: 'finalizeTestContext → cleanupRegisteredResources',
  },
  {
    rel: 'e2e/framework/lab-stability.ts',
    category: 'lab_stability',
    required: true,
    reason: 'S3 overwrite seed + empty-delivery + transient API retry',
    invocation_proof: 'g5: lab-runstream-retry x4; seedS3LabFixturesOverwriteOnly',
    componentKey: 'lab_stability_hash',
  },
  {
    rel: 'e2e/cross-product/retry-policy.json',
    category: 'retry_policy',
    required: true,
    reason: 'Declarative retry limits and forbid rules',
    invocation_proof: 'hashed into harness_version; enforced by lab-stability',
    componentKey: 'retry_policy_hash',
  },
  {
    rel: 'e2e/cross-product/cross-product-loader.ts',
    category: 'loader',
    required: true,
    reason: 'Combination loading / shard selection',
    invocation_proof: 'spec → loadCrossProductCombinations',
    componentKey: 'loader_hash',
  },
  {
    rel: 'e2e/framework/api-context.ts',
    category: 'api_context',
    required: true,
    reason: 'Owned APIRequestContext + health wait used by retries',
    invocation_proof: 'createTestContext / installTransientApiRetry → waitForApiHealth',
    componentKey: 'api_context_hash',
  },
  {
    rel: 'e2e/framework/fixture-client.ts',
    category: 'fixture_client',
    required: true,
    reason: 'Lab fixture client incl. ensureSyslogTlsReady',
    invocation_proof: 'g5: lab-seed syslog_tls_ready=true x1050',
    componentKey: 'fixture_client_hash',
  },
  {
    rel: 'e2e/playwright.config.ts',
    category: 'playwright_config',
    required: true,
    reason: 'Playwright project/timeouts/workers for XP',
    invocation_proof: 'npx playwright test -c playwright.config.ts',
    componentKey: 'playwright_config_hash',
  },
  {
    rel: 'e2e/cross-product/applicability-rules.ts',
    category: 'applicability_source',
    required: true,
    reason: 'Applicability rule source (pairs with generation rules hash)',
    invocation_proof: 'generate-cross-product / loader applicability',
    componentKey: 'applicability_source_hash',
  },
  {
    rel: 'e2e/cross-product/cross-product-axes.yaml',
    category: 'axes_source',
    required: true,
    reason: 'Axis definitions source (pairs with generation axes hash)',
    invocation_proof: 'generate-cross-product axes',
    componentKey: 'axes_source_hash',
  },
  {
    rel: 'e2e/cross-product/run-all-shards.sh',
    category: 'orchestrator',
    required: true,
    reason: 'Shard runner harness preflight (must use same compute as harness-version)',
    invocation_proof: 'resume-from-recovery-plan → run-all-shards.sh',
    componentKey: 'run_all_shards_hash',
  },
  {
    rel: 'e2e/cross-product/recovery_lib.py',
    category: 'recovery_control_plane',
    required: true,
    reason: 'Python harness compute + resume preflight shared with run-all-shards',
    invocation_proof: 'resume-from-recovery-plan / run-all-shards compute_harness_version',
    componentKey: 'recovery_lib_hash',
  },
  {
    rel: 'e2e/cross-product/parallel_lib.py',
    category: 'parallel_control_plane',
    required: true,
    reason: 'Bounded parallel scheduler, isolation namespaces, resume reuse, merge validation',
    invocation_proof: 'run-parallel-shards.sh → parallel-matrix-coordinator.py',
    componentKey: 'parallel_lib_hash',
  },
  {
    rel: 'e2e/cross-product/parallel-matrix-coordinator.py',
    category: 'parallel_orchestrator',
    required: true,
    reason: 'Normal/Fault queue coordinator (publish serialization)',
    invocation_proof: 'run-parallel-shards.sh → parallel-matrix-coordinator.py',
    componentKey: 'parallel_coordinator_hash',
  },
  {
    rel: 'e2e/cross-product/run-parallel-shard-worker.sh',
    category: 'parallel_worker',
    required: true,
    reason: 'Isolated per-shard worker runner for parallel matrix',
    invocation_proof: 'parallel-matrix-coordinator → run-parallel-shard-worker.sh',
    componentKey: 'parallel_worker_hash',
  },
  {
    rel: 'e2e/framework/connector-create-lock.ts',
    category: 'connector_create_lock',
    required: true,
    reason: 'Cross-worker Lab API mutation lock (config version UniqueViolation)',
    invocation_proof: 'DataRelayDriver.wrapMutatingApiRequest → withLabApiMutationLock',
  },
]

function absFromRel(rel: string): string {
  return path.join(ROOT, rel)
}

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
}

function isGitTracked(rel: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', rel], {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim()
    return out.length > 0
  } catch {
    return false
  }
}

function readGenerationHashes(): {
  manifest_hash: string
  applicability_rules_hash: string
  axes_hash: string
} {
  const summaryPath = path.join(GEN, 'generation-summary.json')
  if (!fs.existsSync(summaryPath)) {
    return { manifest_hash: '', applicability_rules_hash: '', axes_hash: '' }
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as Record<string, string>
  return {
    manifest_hash: String(summary.manifest_hash || ''),
    applicability_rules_hash: String(summary.applicability_rules_hash || ''),
    axes_hash: String(summary.axes_hash || ''),
  }
}

function gitCommit(): string {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim()
    if (out && /^[0-9a-f]{40}$/i.test(out)) return out
  } catch {
    /* fall through */
  }
  try {
    const head = path.join(ROOT, '.git/HEAD')
    if (!fs.existsSync(head)) return 'unknown'
    const ref = fs.readFileSync(head, 'utf-8').trim()
    if (ref.startsWith('ref:')) {
      const refPath = path.join(ROOT, '.git', ref.slice(5).trim())
      if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf-8').trim()
    }
    return ref.slice(0, 40) || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Build deterministic harness-scope.json entries. */
export function buildHarnessScope(): HarnessScopeEntry[] {
  const entries: HarnessScopeEntry[] = []
  for (const item of HARNESS_SCOPE) {
    const abs = absFromRel(item.rel)
    if (!fs.existsSync(abs)) {
      if (item.required) {
        throw new Error(`Harness scope missing required file: ${item.rel}`)
      }
      continue
    }
    entries.push({
      path: item.rel,
      sha256: sha256File(abs),
      category: item.category,
      required: item.required,
      reason: item.reason,
      git_tracked: isGitTracked(item.rel),
      invocation_proof: item.invocation_proof,
    })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

export function writeHarnessScope(dir: string = __dirname): string {
  const scope = buildHarnessScope()
  const out = path.join(dir, 'harness-scope.json')
  const doc = {
    version: 1,
    computed_at: new Date().toISOString(),
    file_count: scope.length,
    files: scope,
  }
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
  return out
}

/** Compute harness version once per process (shard start). */
let cached: HarnessVersion | null = null

export function computeHarnessVersion(): HarnessVersion {
  if (cached) return cached

  const missing: string[] = []
  const componentHashes: Record<string, string> = {}
  for (const item of HARNESS_SCOPE) {
    const abs = absFromRel(item.rel)
    if (!fs.existsSync(abs)) {
      if (item.required) missing.push(item.rel)
      continue
    }
    const h = sha256File(abs)
    if (item.componentKey) componentHashes[item.componentKey] = h
  }
  if (missing.length) {
    throw new Error(`Harness scope missing required files:\n${missing.join('\n')}`)
  }

  const scope = buildHarnessScope()
  const scope_hash = sha256Text(scope.map((e) => `${e.path}:${e.sha256}`).join('\n'))
  const gen = readGenerationHashes()
  const git_commit = process.env.GDC_XP_COMMIT || gitCommit()

  // Deterministic join: sorted component path hashes + generation hashes + commit.
  const harness_version = sha256Text(
    [
      ...scope.map((e) => `${e.path}=${e.sha256}`),
      `git_commit=${git_commit}`,
      `manifest_hash=${gen.manifest_hash}`,
      `applicability_rules_hash=${gen.applicability_rules_hash}`,
      `axes_hash=${gen.axes_hash}`,
      `scope_hash=${scope_hash}`,
    ].join('\n'),
  )

  cached = {
    executor_hash: componentHashes.executor_hash,
    driver_hash: componentHashes.driver_hash,
    spec_hash: componentHashes.spec_hash,
    oracle_hash: componentHashes.oracle_hash,
    fixture_hash: componentHashes.fixture_hash,
    test_context_hash: componentHashes.test_context_hash,
    lab_stability_hash: componentHashes.lab_stability_hash,
    loader_hash: componentHashes.loader_hash,
    api_context_hash: componentHashes.api_context_hash,
    fixture_client_hash: componentHashes.fixture_client_hash,
    playwright_config_hash: componentHashes.playwright_config_hash,
    retry_policy_hash: componentHashes.retry_policy_hash,
    applicability_source_hash: componentHashes.applicability_source_hash,
    axes_source_hash: componentHashes.axes_source_hash,
    run_all_shards_hash: componentHashes.run_all_shards_hash,
    recovery_lib_hash: componentHashes.recovery_lib_hash,
    parallel_lib_hash: componentHashes.parallel_lib_hash,
    parallel_coordinator_hash: componentHashes.parallel_coordinator_hash,
    parallel_worker_hash: componentHashes.parallel_worker_hash,
    harness_version,
    git_commit,
    manifest_hash: gen.manifest_hash,
    applicability_rules_hash: gen.applicability_rules_hash,
    axes_hash: gen.axes_hash,
    scope_file_count: scope.length,
    scope_hash,
    computed_at: new Date().toISOString(),
  }
  return cached
}

export function clearHarnessVersionCache(): void {
  cached = null
}

export function harnessVersionEqual(a: Partial<HarnessVersion>, b: Partial<HarnessVersion>): boolean {
  return String(a.harness_version || '') === String(b.harness_version || '')
}

export function writeHarnessManifest(dir: string, version: HarnessVersion = computeHarnessVersion()): string {
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'harness-manifest.json')
  fs.writeFileSync(out, `${JSON.stringify(version, null, 2)}\n`)
  writeHarnessScope(__dirname)
  return out
}

/**
 * Full-run preflight: refuse residual filters.
 * Call only from full-shard orchestrators (run-all-shards / rerun-full-shard).
 * Preflight and explicit limited re-runs must NOT call this (they set filters intentionally).
 */
export function assertFullRunEnvClean(): void {
  const ids = process.env.GDC_XP_COMBINATION_IDS?.trim()
  const limit = process.env.GDC_XP_LIMIT?.trim()
  if (ids || limit) {
    throw new Error(
      `Full shard run refuses residual filters: GDC_XP_COMBINATION_IDS=${ids || '(unset)'} GDC_XP_LIMIT=${limit || '(unset)'}`,
    )
  }
}

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith('harness-version.ts'))

if (isMain) {
  clearHarnessVersionCache()
  const v = computeHarnessVersion()
  writeHarnessScope(__dirname)
  console.log(JSON.stringify(v, null, 2))
}
