# Architecture and next milestones

## Data flow

GitHub poller → immutable base/head Git snapshots → trusted base policy → static review → optional Codex semantic review → base/head Docker tests → bounded repair → static + semantic + test recheck → GitHub branch + draft PR.

The controller owns configuration, task persistence, credentials and publication. Containers receive text snapshots or structured review input, not controller state. Repository code never runs on the host.

## Modules

| Module | Responsibility |
| --- | --- |
| `git.ts` | Immutable text exports; reject special files and unsafe paths |
| `policy.ts` | Trusted literal rules; AGENTS scope; historical occurrence matching |
| `runner.ts` | Offline disposable containers, resource limits, timeout cleanup |
| `agent.ts`, `agent-entry.ts` | Containerized Codex SDK, schema validation, proposed edits |
| `pipeline.ts` | Evidence collection, repair gate, bounded attempts, independent verification |
| `github.ts` | Polling, source freshness, separate refs, idempotent draft PR publication |
| `store.ts` | Atomic per-task JSON reports; exclusive controller lock |
| `cli.ts` | Local check and watcher entry points |

## States

`running` → `passed`, `needs_attention`, `verified`, or `error`.
`verified` → `published` or `stale` when the watcher publishes.
Terminal reports deduplicate by repository, PR number, base/head SHAs and configuration. Policy content is pinned by the base SHA. Interrupted running/error jobs may be rerun; after a process crash the operator must remove the stale lock only after verifying the process has exited.

`passed` means configured checks passed, not exhaustive correctness. `verified` means a candidate patch passed configured verification; it has not been merged. Semantic review status is always explicit. Missing tests remain `not_run` and block automatic repair/publication.

## Repair eligibility

- Base suite passes; head suite passes or exhibits a regression.
- At least one new static error or test regression.
- No candidate policy edits and no semantic errors requiring human interpretation.
- Existing tests/configuration/instructions remain unchanged.
- Repaired suite passes and policy checks report no remaining errors.
- Regression fixes also add test files and rerun the original snapshot with those additions.

## Deliberate MVP reductions

Atomic JSON replaces the originally proposed SQLite dependency for this first single-process version. This is not a distributed queue. The CLI uses polling rather than inbound webhooks. Codex proposes files through structured output instead of receiving a writable checkout and GitHub push credentials. The initial test adapter is command-level, not a Vitest test-result parser.

## Next milestones

1. Real Linux Docker acceptance: failed PR → reproduced test → repair branch → draft PR; test Docker Desktop separately.
2. Structured Node/Vitest test results: discoverability, per-test red/green identity, repeated failure fingerprinting and flaky detection.
3. Request/token budgets, cancellation of a running stale task, bounded infrastructure retries.
4. AST rule adapters, trusted exceptions with expiration, policy conflict handling.
5. SQLite leases, dashboard, GitHub App authentication and optional webhooks.
6. Hardened disposable VM workers before considering untrusted fork PRs.
