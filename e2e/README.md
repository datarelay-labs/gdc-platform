# Full E2E Lab (Phase 2 Smoke + Phase 3 Matrix + Phase 4 Release Gate)

Unified lab + Playwright framework for connector → runtime → collector delivery.

## Quick start

```bash
# Phase 2 smoke
./e2e/run-full-e2e-lab.sh all --route-processing=off
./e2e/run-full-e2e-lab.sh all --route-processing=on

# Phase 3 full matrix
./e2e/run-full-e2e-lab.sh all-matrix --route-processing=off
./e2e/run-full-e2e-lab.sh all-matrix --route-processing=on

# Shard optional
GDC_E2E_SHARD=authentication ./e2e/run-full-e2e-lab.sh all-matrix --route-processing=off

# Cross-Product Full Matrix — bounded parallel shards (default 2 workers)
./e2e/cross-product/run-parallel-shards.sh --workers 2
./e2e/cross-product/run-parallel-shards.sh --workers 2 --resume
./e2e/cross-product/run-all-shards.sh   # sequential (workers=1)

# Merge + validate execution completeness
./e2e/run-full-e2e-lab.sh merge-results
./e2e/run-full-e2e-lab.sh validate-results

# Phase 4 Release Gate
./e2e/run-full-e2e-lab.sh release-gate evaluate --run-id phase33_final
./e2e/run-full-e2e-lab.sh release-gate compare-baseline
./e2e/run-full-e2e-lab.sh release-gate validate-evidence --commit "$(git rev-parse HEAD)" --run-id phase33_final
./e2e/run-full-e2e-lab.sh release-gate rc --run-id <a> --run-id <b>

# Fault injection (test fixtures / lab API only)
./e2e/run-full-e2e-lab.sh fault start database
./e2e/run-full-e2e-lab.sh fault stop database
./e2e/run-full-e2e-lab.sh fault reset
```

Commands: `up` | `reset` | `test` | `matrix` | `collect` | `cleanup` | `cleanup-stale` | `validate-cleanup` | `down` | `all` | `all-matrix` | `fault` | `merge-results` | `validate-results` | `release-gate`

## When Full E2E runs (developers)

You do **not** need to run the Full Matrix (332) locally for routine work.

| Cadence | Who runs it | Scope |
| ------- | ----------- | ----- |
| PR | CI | Smoke 4 + capability/scenario coverage + **affected shards only** |
| Nightly | CI | Full Matrix 332 × route-off/on + browser/API-seeded + merge + Release Gate |
| Weekly | CI | Fault / recovery / checkpoint / dedup stability |
| RC | CI (dispatch / RC branch) | Same commit Full Matrix **2×** consecutive PASS |
| Release | CI (dispatch) | Latest PASS evidence commit match + age + FAIL/BLOCKED/GAP/Missing = 0 |

Local use: smoke, a single scenario, or an affected shard when debugging.

## Automatic resource cleanup

Every Full E2E run tracks created resource **IDs** in:

`e2e/reports/<run-id>/created-resources.json`

Lifecycle (success, failure, timeout, SIGINT/CI cancel best-effort):

```text
E2E execution
→ evidence collect
→ cleanup registered IDs (API-first)
→ validate cleanup
→ return original test exit code
```

Rules:

- Delete by **recorded IDs** only — never by `[FULL E2E]` name prefix alone.
- Do **not** delete general developer resources or `[DEV VALIDATION]` assets.
- Evidence is collected **before** cleanup; evidence files are retained.
- Cleanup success never upgrades a scenario FAIL to PASS.

### Manual cleanup commands

```bash
# Cleanup one run's registry
./e2e/run-full-e2e-lab.sh cleanup --run-id <run-id>
./e2e/run-full-e2e-lab.sh validate-cleanup --run-id <run-id>

# Inventory evidence-correlated leftovers, then cleanup owned registries only
./e2e/run-full-e2e-lab.sh cleanup-stale

# Inspect leftovers without deleting
cd e2e && npm run cleanup:inventory -- --write-run-id inspect-$(date -u +%Y%m%d_%H%M%S)
# Review e2e/reports/inspect-*/ownership-inventory.json (unowned listed, not deleted)
```

## Scenario generation

```bash
cd e2e
npm run scenarios:generate
npm run scenarios:validate
npm run results:merge
npm run results:validate
```

Source of truth: `e2e/capabilities/data-relay-capabilities.yaml`  
Generated: `e2e/scenarios/generated/*.json`

## Release Gate pipeline

```text
Pull Request  → Smoke + Coverage Gate + Baseline compare + Affected Matrix shards
Main / Nightly → Full Matrix 332 (all shards × route-off/on) + Release Gate evaluate
Weekly         → Fault + Recovery stability (separate signal)
Release Candidate → Full Matrix consecutive 2× PASS (same commit, lab reset between)
Release        → Evidence commit match + age + RC PASS (validation only; no tag/deploy)
```

Release PASS requires:

- FAIL / BLOCKED / GAP / Missing = 0
- Browser / route-off / route-on complete
- Smoke PASS + Coverage Validation PASS
- NOT_IMPLEMENTED not increased beyond baseline (current expected: 20 with Manifest PARTIAL evidence)
- Evidence commit matches release target; result age within policy

Gate statuses: `PASS` | `FAIL` | `STALE` | `INCOMPLETE`

### Local Release Gate commands

```bash
./e2e/run-full-e2e-lab.sh release-gate evaluate --run-id <run-id>
./e2e/run-full-e2e-lab.sh release-gate validate-evidence --commit <sha> --run-id <run-id>
./e2e/run-full-e2e-lab.sh release-gate compare-baseline
./e2e/run-full-e2e-lab.sh release-gate rc --run-id <attempt1> --run-id <attempt2>
./e2e/run-full-e2e-lab.sh release-gate detect-shards --base origin/main-v2
```

### Baseline refresh (manual only — never auto in CI)

```bash
cd e2e
npm run scenarios:generate
npm run release-gate:build-baseline -- --run-id <latest-pass-run>
# Review diffs under e2e/release-gate/baseline/ then commit intentionally
```

### NOT_IMPLEMENTED change procedure

1. Update Capability Manifest status / limitations / evidence.
2. Regenerate scenarios (`npm run scenarios:generate`).
3. Re-run affected matrix; confirm NI count change is intentional.
4. Refresh `not-implemented-baseline.json` via `release-gate:build-baseline`.
5. Document rationale in PR — CI will fail on unexplained NI increase.

### Failure evidence

- Per scenario: `e2e/reports/<run-id>/<scenario-id>/`
- Merged: `e2e/reports/<run-id>/final/` (`matrix-summary.json`, `scenario-results.json`, `release-gate.json`, `flake-report.json`, `artifact-checksums.json`)

## Layout

| Path | Role |
| ---- | ---- |
| `e2e/lab/` | Compose, fixtures, collectors, reset, fault-inject |
| `e2e/framework/` | Driver, fixtures, evidence, resource registry/cleanup, matrix executor, merge |
| `e2e/scenarios/` | Matrix generator + coverage / execution validation |
| `e2e/release-gate/` | Phase 4 gate evaluation, baseline, flake, checksums |
| `e2e/smoke/` | Phase 2 smoke |
| `e2e/matrix/` | Phase 3 full matrix runner |
| `e2e/reports/` | Evidence + coverage + `final/` merged reports |

## CI

| Workflow | When | Scope |
| -------- | ---- | ----- |
| `full-e2e-lab-smoke.yml` | PR + dispatch | Capability/scenario validation, baseline compare, smoke, affected shards |
| `full-e2e-matrix-nightly.yml` | Nightly + dispatch | Full Matrix shards × route off/on → merge → Release Gate |
| `full-e2e-fault-weekly.yml` | Weekly + dispatch | Fault/runtime recovery stability |
| `full-e2e-release-candidate.yml` | RC branch/tag + dispatch | Consecutive 2× Full Matrix PASS |
| `full-e2e-release-gate.yml` | Dispatch | Commit/age/RC validation only (no tag/deploy) |

## Notes

- Product `GDC_ROUTE_PROCESSING_ENABLED` default is **ON**; lab shards still pin `.env.route-on` / `.env.route-off` explicitly.
- API-seeded paths do not replace required Browser E2E coverage.
- Phase 1 mismatches remain `NOT_IMPLEMENTED` / `KNOWN_PRODUCT_GAP` — product code is out of scope.
- Outcomes: `PASS` | `FAIL` | `BLOCKED` | `NOT_APPLICABLE` | `NOT_IMPLEMENTED` | `KNOWN_PRODUCT_GAP` (no silent skips).
- Infra-only retries are recorded in matrix results; product failures are never retried.
- CI never auto-updates baselines.
