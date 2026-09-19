# Data Relay Control Repository Engineering Rules

This repository follows the canonical Data Relay Labs Engineering System:
https://github.com/datarelay-labs/engineering-system

Adoption baseline: version 1.3.1 at commit `165cc976cae1b6ef30c7bf90800eed289df3c6fa`.

## Minimum context first

Always read:
1. `AGENTS.md`
2. `.engineering/project.yaml`

Then only when relevant:
3. `.engineering/tests.yaml` for implementation/debugging/testing
4. `.engineering/release.yaml` for release/version/artifact work
5. Only the task-relevant product specification, ADR, runbook, or Engineering System standard

Do not preload all standards, archived specifications, historical audits, or Wiki content.

## Repository authority

Distinguish normative product requirements from observed implementation state.

For product intent and required behavior, use:
1. `docs/source-of-truth/PRODUCT-CHARTER-Version-1.2.1-FINAL.txt`
2. `docs/architecture/source-of-truth-index.md` and the current documents it designates
3. Current implementation specs / ADRs / runbooks for the affected contract
4. Current implementation and tests as evidence of what exists now
5. Historical, archived, superseded, or compatibility-only material

Actual code, schema, configuration, runtime state, and test results are authoritative evidence of the current system state, but they do not override an explicit current product requirement merely because the implementation has drifted.

Historical or explicitly retired behavior is not protected by no-regression policy. If an old test conflicts with current Source of Truth, verify whether the test is stale before changing the implementation.

## Data Relay Control invariants

- Delivery architecture: **One Stream → Many Routes → Many Destinations**.
- Route Processing is the only supported product runtime path. Do not resurrect the retired flag-OFF / parallel stream-scoped pipeline as a first-class runtime.
- Prefer the existing operational Runtime Snapshot read path for operational UI/data when it already supplies the required information; do not add duplicate runtime queries or APIs without a contract need.
- Preserve operational visibility required by current Source of Truth, including EPS, delivery success, checkpoint state, route health, and delivery health where those surfaces require them.
- Preserve user-created connectors, streams, sources, destinations, routes, mappings, checkpoints, and persisted configuration. Do not delete, truncate, reset, or overwrite live/operator data unless the user explicitly requests the specific destructive action. Destructive fixtures and resets must target test-only databases.
- Repository artifacts are English by default: source identifiers/comments, user-facing product copy, docs/specs, commit messages, PR descriptions, and repository rules. Chat replies may follow the user's language.
- Do not hard-code temporary release scope into permanent rules. For AI Gateway / AI Proxy or other release-scoped capabilities, read the current Product Charter and current release scope/limitations when the task is relevant.

## Validation

- Use `.engineering/tests.yaml` as the repository validation map.
- Run the cheapest affected deterministic checks first and expand by risk.
- Current-requirement tests must not be weakened merely to get PASS.
- Retired/historical tests may be changed or removed when the current Source of Truth explicitly retired that behavior.
- Changes affecting the Dev Validation Lab, visible E2E seed, seeding/throughput configuration, or equivalent validation runtime must preserve the configured **5–20 EPS** invariant and run the dedicated validation scenario in `.engineering/tests.yaml`.

## Execution rules

- Preserve unrelated user work and dirty worktrees.
- Make the smallest correct change and do not silently expand scope.
- Bug fixes should add durable regression coverage whenever practical.
- Never report skipped, blocked, historical, or different-HEAD evidence as current PASS.
- Runtime behavior may change only when required by the requested task or current Source of Truth; when it changes, run the affected runtime validation defined in `.engineering/tests.yaml`.

## Session continuity

When explicitly resuming work, resolve this repository and branch first, load exactly one matching active repository-scoped AI Work Packet, verify actual HEAD/dirty/PR/CI state, and continue only from its Next Action.

Tool-specific adapters must not weaken these rules.
