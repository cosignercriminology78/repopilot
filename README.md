# RepoPilot

**Local-first GitHub policy checks, regression testing, and verified repair branches powered by Codex.**

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Security boundaries](SECURITY.md)

RepoPilot watches pull requests, checks the repository's trusted rules, runs base/head tests in disposable containers, and proposes a separate repair branch when a fix passes verification. It never merges repairs automatically.

**Status: early developer preview.** The controller and safety gates have automated tests. The initial implementation has not yet completed a live Docker + Codex + GitHub repair acceptance run. See [verification notes](docs/VERIFICATION.md). Do not connect this preview to sensitive production repositories.

## Included in 0.1

- Local commit comparison and GitHub polling, pinned to base/head SHAs.
- Trusted `.repopilot/policy.json` from the base commit; nested `AGENTS.md` context for semantic review.
- Literal static rules with file-extension and directory scope; historical finding deduplication.
- Offline Docker test runner with resource/time limits and no GitHub credentials.
- Codex SDK adapter inside a separate container; structured review and proposed file replacements.
- Bounded repair attempts, protected-file checks, regression reproduction and independent retesting.
- Separate `autofix/` branches and draft PRs, with stale-head checks and interrupted-publication recovery.
- Atomic JSON task records and a single-controller lock. No database service required.

## Prerequisites

- Node.js 20+ (22 LTS recommended), npm, Git.
- Docker with Linux containers for running tests or Codex.
- `GITHUB_TOKEN` (or `GH_TOKEN`) in the controller environment for authenticated polling/publishing. Publishing requires repository Contents and Pull requests write permissions.
- `OPENAI_API_KEY` for the Codex container. This preview does not mount or reuse desktop ChatGPT login credentials.

GitHub credentials stay in the controller. Only the dedicated agent container receives the OpenAI key. You pay the model provider's API usage charges; this project does not provide credits.

## Quick start

```sh
npm ci
npm run check
npm test
npm run build
cp repopilot.example.json config.local.json
```

Edit `repository` and the trusted test command in `config.local.json`. Keep this controller configuration outside the repository snapshot being reviewed.

```sh
# A test image must contain the runtime and dependencies the repository requires.
docker pull node:22-bookworm-slim

# Compare a local repository without editing its working tree.
npm run dev -- check --config config.local.json --repo /path/to/project --base main --head feature

# Poll open, non-draft, same-repository PRs once or continuously.
npm run dev -- watch --config config.local.json --once
npm run dev -- watch --config config.local.json
```

PowerShell: use `Copy-Item repopilot.example.json config.local.json` instead of `cp` if preferred. Docker Desktop must run Linux containers.

The example uses `node --test` and needs no dependency installation. Tests run **without network access**. For Vitest or other frameworks, prepare a trusted image containing the project's pinned dependencies and configure an explicit command. RepoPilot does not run `npm install` on the host or download dependencies while testing.

For a policy-only run, omit `runner`. The report will say `not_run` for tests and will not claim an overall pass. Reports and exported inputs live under `.repopilot-data/`; retain or remove them according to your data policy.

## Repository rules

Commit `.repopilot/policy.json` to the **target repository's base branch**:

```json
{
  "rules": [
    {
      "id": "no-disabled-tests",
      "extensions": [".ts", ".js"],
      "forbiddenText": "test.skip(",
      "message": "Keep regression tests enabled.",
      "severity": "error"
    }
  ]
}
```

See [example rules](examples/policy.json). Static rules deliberately use literal matching, not arbitrary executable plugins or unbounded regular expressions. They can match comments too; use scoped rules and treat results as a review aid, not a SQL/AST parser. Human-readable `AGENTS.md` rules are reviewed semantically only when the agent is enabled. Parent instructions are supplied before child instructions with their source paths.

A PR that changes its own rules still uses the pinned base rules and requires manual attention. Changed rule files cannot silently authorize auto-repair.

## Enable Codex and repair

```sh
docker build -f Dockerfile.agent -t repopilot-agent:local .
```

Set environment credentials outside tracked files. Enable `agent.enabled` for semantic review; enable `agent.repair` for repair attempts. Set `publish: true` only when you want the watcher to push repair branches and create draft PRs. Local `check` never publishes.

The SDK runs in a separate container and returns proposed full-file replacements. It does not receive the GitHub token or a writable host checkout. The controller rejects changes to existing tests, policies, manifests, configuration, workflows, hidden paths and unsupported file types. It executes accepted candidates in fresh test containers.

Automatic repair requires passing base tests, a new static error or reproducible test regression, no policy changes, and no unresolved semantic error. Ambiguous semantic findings remain for human review. Regression repair requires an additional test file and a failing original candidate run followed by a passing repaired run. This is suite-level evidence, not proof that a specific new test was discovered or failed; test-level adapters are planned.

## Operational limits

- Public, text-only repositories; same-repository PRs only. Fork PRs and `autofix/` branches are skipped.
- Symlinks, submodules, binary/non-UTF8 files are rejected, not silently dropped. Snapshots are limited to 10,000 files / 16 MiB and the agent context to 500 KB.
- One controller and one task at a time. A crashed controller leaves a lock; verify the old process is gone before manually removing it. Interrupted `running` reports rerun on restart; terminal reports deduplicate.
- Model changes are suggestions. Passing the configured command does not guarantee absence of bugs or security issues. Choose a command that fails when no tests are found.
- Repair attempts and time are bounded; per-task token/currency budgets are not implemented yet.
- No web dashboard, automatic dependency setup, webhook ingress, browser E2E adapter, rule exceptions UI or auto-merge in this version.
- GitHub branch creation and PR creation are retriable but not transactional with source updates. A late source update may leave an unused repair branch.

## Development

```sh
npm run check
npm test
npm run build
```

Tests use synthetic repositories and mocked agent/runner/API adapters; they do not need model credits or GitHub writes. Contributions improving verification evidence, isolation, and test adapters are welcome. MIT licensed; independent project, not an official OpenAI product.
