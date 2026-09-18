# RepoPilot

**Local-first GitHub policy checks, test generation and verified repair branches powered by Codex.**

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Verification](docs/VERIFICATION.md)

RepoPilot watches pull requests, checks trusted base-branch rules, generates tests from PR requirements, and proposes a separate repair branch after independent verification. It never merges automatically.

## Implemented

- Pinned base/head SHAs and title/body digest; continuous freshness checks and cancellation.
- Scoped literal rules and JavaScript/TypeScript AST call rules, conflict detection and expiring exceptions.
- Nested AGENTS.md semantic review with verbatim rule/code citations and historical finding comparison.
- Proactive test plans and new test files, frozen before production-code repair.
- Structured Node and Vitest results: test discovery, stable identities, repeated failure fingerprints and same-case verification.
- Monorepo working directories, multiple named test commands and disposable dependency services; see [test environments](docs/TEST-ENVIRONMENTS.md).
- Bounded repair attempts, task retries, publication retries, call/token budgets and process-tree cleanup.
- Separate autofix branches/draft PRs, executable-mode preservation and collision-safe publication recovery.
- Atomic JSON reports, Markdown evidence summaries, previous-execution archives and exclusive controller lock.

This developer preview has offline tests for its controller and verification gates. No live Docker + Codex + GitHub repair acceptance run is claimed.

## Setup

Node.js 22 recommended, npm and Git. Test and agent execution requires Docker with Linux containers.

```sh
npm ci
npm run check
npm test
npm run build
cp repopilot.example.json config.local.json
```

PowerShell can use Copy-Item instead of cp. Set repository and the trusted test command in the local config, outside reviewed snapshots.

```sh
npm run dev -- check --config config.local.json --repo /path/to/project --base main --head feature
npm run dev -- watch --config config.local.json --once
npm run dev -- watch --config config.local.json
```

Local check never publishes or edits the source checkout. Watch polls non-draft same-repository PRs, excluding autofix branches. Publishing requires publish=true.

The default reporter is node with node --test. Build first to produce the trusted reporter. For Vitest, set reporter=vitest and use an explicit vitest run command backed by a trusted image containing pinned dependencies. Tests have no network by default; configured services use a disposable internal Docker network. Images and dependencies must be provisioned beforehand. Reporter flags belong to the controller. reporter=command collects output only and cannot verify or publish.

Omit runner for policy-only review; tests remain not_run. Zero/all-skipped tests, malformed reports and missing test identities never count as passing.

## Trusted rules

Commit .repopilot/policy.json to the target base branch; see [examples](examples/policy.json).

```json
{
  "rules": [
    {
      "id": "no-disabled-tests",
      "kind": "forbid-call",
      "extensions": [".ts", ".js"],
      "callee": "test.skip",
      "message": "Keep regression tests enabled.",
      "severity": "error"
    }
  ],
  "exceptions": []
}
```

Kinds are literal (forbiddenText), forbid-call and require-call (callee). AST rules inspect direct/qualified calls and string property access; they do not resolve aliases or perform whole-program analysis. Literal rules can match comments. Overlapping require/forbid rules conflict and stop review.

Exceptions specify ruleId, exact path, reason, expiresAt (UTC ISO timestamp), and optional exact evidence. They come only from base policy; expired exceptions do not suppress findings. Nested base AGENTS.md rules are supplied by scope for semantic review. Prose conflicts still require human interpretation.

PRs changing trusted rule files require maintainer review and cannot authorize their own repair.

## Codex and repair

```sh
docker build -f Dockerfile.agent -t repopilot-agent:local .
```

Set OPENAI_API_KEY in the controller environment; only the agent container receives it. GITHUB_TOKEN or GH_TOKEN stays in the controller. Publishing requires repository Contents and Pull requests write permissions. Desktop ChatGPT credentials are not reused.

agent.enabled enables semantic review and test planning. agent.repair enables repair proposals. The SDK runs in a separate container with no writable host checkout; the controller applies validated file replacements to independent snapshots.

Automatic repair needs passing original baseline evidence. Generated scenarios are regression (default) or new_behavior, in separate files. New behavior requires an exact requirementQuote from the PR title/body. For the same executed case, base-pass/head-fail is a regression; base-fail/head-pass is accepted only for cited new behavior. Both-fail, skipped/missing cases, execution errors and changes to original test results require review. A model label alone never overrides runner evidence.

A PR may combine verified new behavior with regressions. Regressions must repeat with identical failing identities/fingerprints. Repair candidates must preserve and pass original base/head/generated cases and pass static/semantic rechecks. Missing base exports must be checked inside executing test cases rather than crashing top-level imports. Reports retain intent, requirement quotes and per-case classifications. Existing tests, manifests, configuration, policies and hidden paths are protected.

Publication rechecks SHAs and description. Existing branches/PRs are reusable only when their parent/tree match the verified result. No force push or automatic merge.

## Operations and limits

Task management commands:

```sh
npm run dev -- tasks list --config config.local.json --status running --limit 20 --offset 0
npm run dev -- tasks show TASK_ID --config config.local.json --format markdown
npm run dev -- tasks cancel TASK_ID --config config.local.json
npm run dev -- tasks resume TASK_ID --config config.local.json
npm run dev -- tasks rerun TASK_ID --config config.local.json
```

List/show/cancel work while the controller holds its writer lock. Cancel registers a persistent request checked every 250 ms during verification/publication; the response acknowledges the request, while the report records completion. It cannot undo remote writes already completed. The watcher does not restart a cancelled task while its marker remains. Cancellation applies to that task, not future PR revisions.

Resume/rerun require the controller lock. Resume keeps task identity/configuration and execution limits, reruns verification from the beginning, or continues publication of an already-verified task. Retry delays still apply. Permanent/terminal/exhausted tasks need rerun. Rerun creates a new linked task using the original pinned commits and current configuration; it preserves prior reports and cancellation markers.

Replay needs the recorded local repository or git-cache. PR inputs are rechecked before and during replay; updated PRs need watch. Older reports without replay metadata can be enriched by repeating the original check/watch. Stale crash locks still require checking that the old process stopped before removal.

Reports and snapshots live in .repopilot-data. Each task has JSON and Markdown; retries archive previous evidence as TASK.execution-N.json. JSON holds bounded full outputs and candidate patches; Markdown/PR output is abbreviated.

Task timeout, maxCalls, maxAttempts and maxTaskExecutions are bounded. maxTokens accounts for reported usage after each model call; a single call may exceed it. It is not a hard monetary budget.

Public text-only repositories, up to 10,000 files / 16 MiB. Symlinks, submodules, binaries and case collisions fail closed. Context is batched around changed files plus related imports/tests; oversized individual files fail explicitly. One controller runs serially. After a crash, verify the old process stopped before removing the lock; inspect leftover named containers separately.

No dashboard, webhook server, distributed queue, browser E2E, automatic dependency installation or fork execution. Test execution is evidence, not tamper-proof attestation against malicious code. See SECURITY.md.

## Development

```sh
npm run check
npm test
npm run build
```

Tests use mocked APIs/agents/runners and synthetic local Git/Node fixtures. They do not use model credits, launch Docker or write GitHub content. MIT licensed; independent project, not an official OpenAI product.
