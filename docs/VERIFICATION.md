# Verification — initial developer preview

Validated locally on Windows with Node.js 21.1.0:

- TypeScript strict type checking and compilation.
- Policy source pinning and nested instruction scopes.
- Historical finding deduplication and duplicate occurrence detection.
- Unsafe paths, protected-file repair rejection and invalid semantic citations.
- Mocked repair success, missing tests, infrastructure failure, historical failure, attempt limits and task deduplication.
- Controller lock exclusion and release.
- Mocked GitHub stale-head and fork protection.
- Synthetic Git repository snapshot and CLI smoke tests (no real project code).

Not yet validated end to end:

- Docker is absent on the initial development machine; no real test/agent containers were launched.
- No paid Codex inference was invoked.
- No automatic repair branch/PR was published against a live source PR.
- Linux CI results are checked separately after the initial repository push.

Run `npm run check`, `npm test`, and `npm run build`. Passing these checks does not imply the untested Docker/model integration is production-ready.
