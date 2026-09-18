# Architecture

## Flow

Pinned base/head and description → trusted policy → static + baseline/head semantic review → existing tests → generated frozen tests → stable failure reproduction → bounded source repair → same-case verification and policy recheck → separate branch and draft PR.

The controller owns configuration, credentials, task records and publication. Target code runs only in test containers. The agent receives bounded text context and proposes replacements.

## Modules

| Module | Responsibility |
| --- | --- |
| git.ts | Immutable text exports, portable paths, executable modes |
| policy.ts | Scoped literal/AST rules, conflicts, historical matching, expiring exceptions |
| context.ts | Changed-file batches, scoped instructions, relative imports, relevant tests |
| agent.ts / agent-entry.ts | Codex SDK, structured citations, frozen plans, protected edits, usage budgets |
| runner.ts / node-reporter.ts / test-results.ts | Offline containers, structured Node/Vitest results, identities and fingerprints |
| control.ts / process.ts | Cancellation, freshness monitor, bounded retries, process-tree termination |
| pipeline.ts | Task state, baseline evidence, test planning, repair gates and independent verification |
| test-assessment.ts | Evidence-based classification of regressions and cited new behavior; original-test preservation |
| github.ts / publication.ts | Read retries, durable publication retries, input freshness, Git modes, collision checks, draft PR publication |
| report.ts / store.ts | Markdown summaries, atomic JSON records, previous-execution archives, exclusive lock |
| cli.ts | Local check and serial GitHub watcher |

## State and recovery

Tasks identify repository, PR, base/head, title/body digest, configuration and report schema version. States: running, passed, needs_attention, verified, published, stale, cancelled, error.

Terminal reports deduplicate. Temporary errors retry only after retryAfter and below maxTaskExecutions; interrupted running/cancelled tasks can resume within the same bound. Earlier evidence is archived before rerun. Permanent errors need corrected configuration or inputs. A single controller owns the data directory; after a crash verify the old process stopped before removing its lock.

A freshness monitor aborts in-flight work when PR input changes. SIGINT/SIGTERM and task timeout propagate to Git subprocesses, Docker clients and adapter calls. Container removal runs independently during cleanup. Process crashes may still leave containers.

GitHub GET calls retry selected rate-limit/server failures with bounded exponential waits. Server retry windows beyond the wait budget defer rather than retry early. Writes are not blindly replayed: publication reconstructs the expected tree and checks existing branch/PR content before reuse. A late source update can still leave an unused branch.

## Verification gates

1. Parse structured results. A successful command with zero/all-skipped tests does not pass.
2. Record original base/head cases. Model-generated tests are additional files with scenario mappings.
3. Execute frozen tests on base/head and check identical discovery. Original baseline tests must stay green. Generated base-pass/head-fail cases are regressions; base-fail/head-pass cases qualify as new behavior only with a validated PR requirement quote and explicit scenario type. Both-fail and execution errors require review. Generated tests cannot alter original test outcomes. Mixed new-behavior/regression plans remain eligible when every case has unambiguous evidence.
4. For regressions, repeat head and require identical failing identities and fingerprints. This detects changing failures; it is not statistical proof of non-flakiness.
5. Repair production source only. Recheck static rules, run tests, preserve original base/head/generated case identities, and repeat semantic review against trusted rules.
6. Publish only verified results on still-current input. Git trees preserve executable bits. A matching existing PR must have the exact expected parent/tree.

Semantic review cites exact scoped rule text and code lines. Baseline/head findings are compared with occurrence counts. Expiring exceptions come only from base policy. AST rules match direct/qualified calls and string property accesses, not aliases or whole-program semantics.

## Budgets and context

Each execution has a wall-clock budget, model call count limit and reported-token threshold. The token check occurs after each call; a single call may exceed it. No currency accounting is claimed.

Context batches contain whole changed files and authoritative scoped rules, with related imports/tests where space allows. Omitted related paths are explicit. Oversized individual files fail rather than silently truncate. Full test evidence is local; model requests and Markdown summaries are bounded.

## Scope

Public text repositories, same-repository PRs, one serial controller, atomic files instead of SQLite. No fork execution, browser E2E, dependency installation, webhook server, dashboard or automatic merge. Containers/reporters are not hostile-code attestation. See SECURITY.md.
