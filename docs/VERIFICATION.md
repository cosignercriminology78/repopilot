# Verification

This revision is validated locally on Windows / Node.js 21.1.0 with strict TypeScript checking (including tests), 52 offline regression tests and compilation.

Coverage includes:

- Layer dependency/cycle enforcement, stable version-three task IDs, and clean-build CLI/Codex/reporter path resolution.

- Trusted policy, nested instructions, AST calls versus comments/strings, contradictory rules and exception expiration.
- Historical occurrence matching, scoped verbatim citations and protected-path rejection.
- Proactive plans, frozen tests, discovery checks, same-case red/green checks and changing failure fingerprints.
- New-behavior requirement citations, the base/head outcome matrix, mixed feature/regression repairs, ambiguous failures and generated-test side effects.
- Zero/skipped/duplicate/outside-root/contradictory reports and Vitest JSON fixtures.
- Real Node test-runner events from a small synthetic local fixture: nested suites, assertions, skips and module-load failures.
- Cancellation of a synthetic child process, freshness monitor and bounded retry timing.
- Task list/show/cancel/resume/rerun CLI on a synthetic repository, cancellation under the controller lock, persistent cancellation, replay identity/budgets and in-flight publication abort.
- Description changes, persistent task execution limits, controller lock and deduplication.
- Mock GitHub stale/draft/fork protection and executable-mode publication.
- Synthetic local Git snapshot and CLI comparison without modifying a real source checkout.

Commands:

```sh
npm run check
npm test
npm run build
```

No real Docker container, Codex inference, or GitHub repair PR is invoked by these tests. The user's requested scope is code completeness and offline verification; live integration acceptance remains separate. See GitHub Actions for commit-specific CI results.
