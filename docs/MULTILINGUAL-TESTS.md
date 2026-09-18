# Multi-language test execution

Available in 1.1.0: Node/Vitest plus `pytest`, `go` and `junit` reporters. Adapt [this configuration example](../examples/multilingual.json) to your images, directories and commands.

| Reporter | Command | Evidence |
| --- | --- | --- |
| `node` | `node --test` | Trusted Node JSON reporter |
| `vitest` | Installed `vitest run` | Vitest JSON |
| `pytest` | `python -m pytest` or `pytest` | Controller-owned JUnit XML with source-file attributes |
| `go` | `go test ./...` | Go JSON events; cache disabled |
| `junit` | e.g. `mvn -o test` | Fresh XML from a configured directory/file list |

Reporters work in local checks, PR verification and Issue reproduction. Generated tests may be JavaScript/TypeScript, Python, Go or Java; existing tests remain protected. Disabled/conditional-test constructs receive conservative checks, and runtime evidence must still satisfy every verification gate. AST repository rules remain JS/TS-specific; literal rules and Codex review can cover other languages.

## Images and dependencies

Use trusted images with runtimes, frameworks and dependencies already provisioned. Tests keep non-root, read-only-root, resource and network restrictions. Configure writable temporary caches while preserving preloaded dependency caches. RepoPilot does not install packages during verification.

## Python / pytest

The controller adds `--junitxml=/tmp/repopilot.xml -o junit_family=legacy`, removes stale output and reads the new report. Console logs are retained separately. Collection/setup errors, absent XML, count mismatches and contradictory exit codes cannot pass. Relative `file` attributes resolve from `cwd` to a snapshot file. User-supplied JUnit overrides are rejected.

## Go

The controller adds `-json -count=1`; these flags are controller-owned. Defaults are `GOCACHE=/tmp/go-build`, `GOPATH=/tmp/go` and `GOTOOLCHAIN=local`; trusted `env` can override them. Provision modules/toolchains in the image as needed.

Package paths map through the nearest `go.mod` module declaration; top-level test functions map to `_test.go` files. Subtests retain full names. Run/completion events and package completion are required. Build failures, incomplete streams, ambiguous paths and package failures outside tests block verification. GOPATH-only projects or layouts without an unambiguous module/function mapping need a compatible configuration/adapter.

## Java / JUnit XML

Configure exactly one of:

- `reportDirectory`: directory relative to command `cwd`. Its immediate `*.xml` files are cleared and collected. Recommended for generated Java tests, because new classes' reports are discovered automatically.
- `reportFiles`: explicit XML paths relative to `cwd`. Every file must be newly generated. Suitable for exporters producing a fixed combined report.

For Maven Surefire, a typical directory is `target/surefire-reports`. Use a writable Maven repository with preloaded dependencies; `mvn -o` prevents downloads. Other JUnit exporters can use their own trusted command/directory.

Each testcase needs a valid `file` attribute or a fully qualified Java `classname` mapping to exactly one `.java` snapshot file. Ambiguous classes and unsupported nested/dynamic class mappings fail closed; use a compatible exporter with file attributes if necessary. Parameterized cases need distinct names. DTDs/external entities, duplicate identities, invalid counters and malformed reports are rejected. `<error>` is an execution error; `<failure>` supplies assertion evidence.

Reports remain bounded by process output limits. Framework reports are not tamper-proof attestations: tests share their reporting runtime. See [security](../SECURITY.md).

Format references: [pytest JUnit configuration](https://docs.pytest.org/en/stable/reference/reference.html#confval-junit_family), [Go test2json events](https://pkg.go.dev/cmd/test2json).
