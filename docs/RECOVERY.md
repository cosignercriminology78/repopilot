# Crash recovery and resource cleanup

Available on the development branch after 1.0.0; the existing 1.0.0 download packages do not include this command.

Stop ordinary controller work before recovery. Use the same host, data directory and Docker context as the interrupted controller. Recovery requires a reachable Docker daemon so it can inspect leftovers before changing task state.

## Preview, then apply

```sh
npm run dev -- recover --config config.local.json
npm run dev -- recover --config config.local.json --apply --expected PREVIEW_TOKEN
```

The first command reports lock status, interrupted tasks for the configured repository, and owned Docker container/network IDs. It does not remove resources or change reports. Copy its `token` into the second command. A changed lock, report or resource inventory invalidates the preview. Recovery acquires the same exclusive controller lock used by ordinary runs and checks the inventory again before cleanup.

Cleanup removes owned containers and their anonymous volumes before networks, using exact Docker IDs and rechecking ownership immediately before deletion. A network with remaining endpoints is not forcibly disconnected. Cleanup failures are reported; interrupted reports remain unchanged if resources could not all be cleared. Partial removal is possible: obtain a fresh preview before retrying.

After successful cleanup, running task reports for the selected repository are archived and marked `cancelled`, with persistent cancellation requests to prevent the watcher from immediately restarting them. Existing evidence, patches, snapshots, execution budgets and source repositories are retained. No GitHub writes or model calls occur. Resume or rerun explicitly:

```sh
npm run dev -- tasks resume TASK_ID --config config.local.json
npm run dev -- tasks rerun TASK_ID --config config.local.json
```

Resume retains the original task's configuration and execution limits; use rerun when those limits are exhausted or the configuration has changed. Verified/published/terminal reports are not rewritten by recovery.

## Ownership and lock states

New test containers, dependency services/networks and Codex containers carry `io.repopilot.managed=true` and an owner hash derived from the canonical data-directory path and hostname. Docker resource cleanup is scoped to that entire data directory, even if it contains reports from several repositories. The data directory has one exclusive controller lock. Other directories' resources, images, named volumes, source checkouts, cached snapshots and reports are not deleted.

- `absent`: no controller lock; cleanup can proceed after preview validation.
- `active`: the local lock's PID exists; cleanup is blocked. PID reuse is treated conservatively as active.
- `stale`: the lock belongs to this hostname and its PID is confirmed absent; explicit recovery can replace it.
- `unknown`: legacy/incomplete metadata, another hostname or an inconclusive process check; automatic takeover is blocked.

Age alone never proves that a controller stopped. Version 1.0.0 locks do not contain host/ownership metadata, and its containers lack the new ownership labels, so they require manual inspection. Naming a container `repopilot-*` is not sufficient authorization to remove it. Moving a data directory or changing hostnames also requires manual reconciliation of old resources.

A short-lived `controller.guard` serializes creation, recovery and release of `controller.lock`. If a process crashes inside that critical section, the guard is deliberately not automatically stolen. Inspect its recorded host/PID, verify all controllers and recovery commands using the directory have stopped, then manually remove only that guard. Treat unverifiable controller locks similarly. Do not clear the entire data directory.

Recovery assumes local filesystem locking semantics and a trusted Docker daemon. It is not a distributed lease protocol for shared network storage. Operators must not manually replace lock files while a controller is running.
