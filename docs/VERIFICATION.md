# Verification

This revision is validated locally on Windows / Node.js 21.1.0 with strict TypeScript checking (including tests), 34 offline regression tests and compilation.

Coverage includes:

- Trusted policy, nested instructions, AST calls versus comments/strings, contradictory rules and exception expiration.
- Historical occurrence matching, scoped verbatim citations and protected-path rejection.
- Proactive plans, frozen tests, discovery checks, same-case red/green checks and changing failure fingerprints.
- Zero/skipped/duplicate/outside-root/contradictory reports and Vitest JSON fixtures.
- Real Node test-runner events from a small synthetic local fixture: nested suites, assertions, skips and module-load failures.
- Cancellation of a synthetic child process, freshness monitor and bounded retry timing.
- Description changes, persistent task execution limits, controller lock and deduplication.
- Mock GitHub stale/draft/fork protection and executable-mode publication.
- Synthetic local Git snapshot and CLI comparison without modifying a real source checkout.

Commands:

```sh
npm run check
npm test
npm run build
```

No real Docker container, Codex inference, or GitHub repair PR is invoked by these tests. The user's requested scope is code completeness and offline verification; live integration acceptance remains separate. Initial Linux CI success does not validate this unpushed revision.
