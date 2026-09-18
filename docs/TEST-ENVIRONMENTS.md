# Project test environments

Keep runner configuration in the trusted local controller config. PR content cannot change it. See [the monorepo example](../examples/monorepo.json).

## Commands and subdirectories

The existing `runner.command` configuration remains supported. Add `runner.cwd` for a repository-relative subdirectory, or replace `command` with `commands` for up to eight named steps. Each step accepts `name`, `command`, `cwd`, `reporter`, `image`, `env` and `timeoutSeconds`. Names must be unique lowercase identifiers. Use either `command` or `commands`, never both. Multi-command working directories and reporters belong to each step; its default reporter is `node`.

Commands execute sequentially, each in a fresh writable copy of the same pinned snapshot. Files produced by an earlier command are not available to subsequent commands. Put build/setup and tests in one trusted command when they need to share files; use `vitest` with a trusted wrapper if appropriate. The Node reporter requires a direct `node --test` command. Images must already contain required dependencies; containers never install packages over the network or pull missing images. Provision trusted images in advance, preferably pinned by digest.

`runner.env` supplies explicit test environment values; per-command `env` overrides them. Host environment variables are not forwarded into containers. Controller API token variable names are rejected. Use disposable test credentials only: test code can read its entire environment and logs may include values. The model receives command metadata and environment variable names, not environment values.

Results retain each command's status, duration, working directory and output. Relative test paths are resolved from its working directory back to the repository root. In multi-command mode, command names form part of case identities, so two steps can run the same file without overwriting evidence. A failed command remains failed even if later steps pass. An empty/unstructured result blocks verification; infrastructure errors stop further steps. Policy-only and command-only runs still cannot publish verified repairs.

## Failure classification and retries

Evidence records `failure.kind`: `test_failure` for structured assertions, `environment` for runner/service failures, `test_discovery` for missing execution, and `invalid_report` for unusable evidence. A category describes the observed evidence; it is not proof of the underlying root cause.

`runner.environmentAttempts` limits executions of each verification phase to 1–3 (default 2, including the initial execution). Only explicitly retryable environment errors receive a retry: startup failures, timeouts, killed containers and stopped dependencies. Cleanup failures, malformed reports, command-not-found errors and ordinary assertions do not. Each retry rebuilds the entire phase environment and executes its commands from the original snapshot, retaining all attempts in the report. It does not repeat model review/planning or just rerun a failed command against mutated service state. Delays use the controller retry settings, and task cancellation/time budgets still apply. Set the value to 1 to disable these retries.

Before regression repair, repeated evidence must have matching discovered/executed identities and matching failure fingerprints. A disappearing or changing failure is `unstable`; missing cases or environmental failures are `inconclusive`. Both block repair. If candidate verification exhausts environmental retries or lacks test evidence, the controller stops asking for source patches. JSON and Markdown reports include phase execution numbers, categories and stability assessments. Existing reports without these optional fields remain readable.

## Dependency services configuration

Configure up to four services with `name`, `image`, optional `command` and `env`, plus a required `readiness.command`. Tests connect using service names as DNS names; no host ports are published. Readiness commands run inside the service container and must exit zero when it can accept connections.

Services use non-root numeric `user` (default `65534:65534`), read-only root filesystems, dropped capabilities, CPU/memory/process limits and writable `/tmp`. Add `tmpfs` paths for data/socket directories. Images must support this restricted execution; select a compatible numeric user and writable paths for the chosen image.

Example PostgreSQL service (merge into `runner.services` and provide a test-only connection URL through `runner.env`):

```json
{
  "name": "database",
  "image": "postgres:16-bookworm",
  "user": "999:999",
  "env": {
    "POSTGRES_USER": "repopilot",
    "POSTGRES_DB": "tests",
    "POSTGRES_PASSWORD": "disposable-test-password",
    "PGDATA": "/var/lib/postgresql/data"
  },
  "tmpfs": ["/var/lib/postgresql/data", "/var/run/postgresql"],
  "readiness": {
    "command": ["pg_isready", "-h", "127.0.0.1", "-U", "repopilot", "-d", "tests"],
    "timeoutSeconds": 60
  }
}
```

Each base/head/repeat/repair verification starts fresh services and a unique internal Docker network. Services are shared by sequential commands within that one run, so database mutations can affect later commands. Fixtures must initialize/reset their own state as needed. Service startup and all commands share `runner.timeoutSeconds`; each readiness probe and command also has its own optional tighter budget.

Cleanup runs after success, failure, timeout and cancellation: test containers first, services in reverse order, then the network. Named containers and their anonymous volumes are removed. Cleanup failures invalidate success. Controller process crashes still require operator cleanup of its `repopilot-test-` resources; snapshots and evidence remain in the data directory.

Without services, tests retain `--network none`. With services, an internal Docker network blocks ordinary external routing, but is **not a complete host isolation boundary**: Docker documents access to host gateway services. Use a dedicated worker VM and host firewall restrictions for untrusted code. See [Docker internal network behavior](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal) and [the security model](../SECURITY.md).
