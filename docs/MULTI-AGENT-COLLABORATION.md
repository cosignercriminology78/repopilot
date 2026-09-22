# Multi-Agent collaboration

RepoPilot can assign planning, acceptance-test design, implementation and policy review to separate Codex roles while retaining a deterministic controller and independent runner as the authority for state transitions.

Role separation shipped in v1.5.0. Bounded parallel DAG execution described below is available on the development branch after that release.

## Enable role isolation

Add `collaboration` under `iteration`. Every role can inherit `agent.model` or override it independently:

```json
{
  "agent": {
    "enabled": true,
    "repair": true,
    "model": "DEFAULT_CODEX_MODEL"
  },
  "iteration": {
    "collaboration": {
      "maxParallel": 2,
      "roles": {
        "planner": { "model": "PLANNER_MODEL" },
        "tester": {},
        "developer": {},
        "reviewer": { "model": "REVIEWER_MODEL" }
      }
    }
  }
}
```

The roles have fixed capabilities:

| Role | Output used by the controller | Authority it does not have |
| --- | --- | --- |
| Planner | Dependency-ordered steps covering acceptance IDs | Cannot modify code or mark tests as passed |
| Tester | New frozen tests tied to exact acceptance text | Cannot repair production code |
| Developer | Production-file replacements within the goal scope | Cannot edit frozen tests or repository policy |
| Reviewer | Cited semantic findings against trusted base policy | Cannot approve a failed independent test run |

Each role uses a separate Codex thread and container. GitHub credentials remain in the controller. All roles share the configured per-execution call and token budget, so enabling four roles does not multiply the budget. Unknown usage after interruption remains reserved.

## Durable handoffs and task graph

Every role call records a bounded handoff containing role, action, input/output digests, status, summary and time. Invalid plans, repeated or invalid patches and reviewer vetoes are recorded as `rejected`; transport or schema failures are `failed`. These records describe orchestration and are not proof that code works.

Goal steps maintain explicit `pending`, `running`, `completed`, `rejected` and `blocked` states with attempt counts and report IDs. A rejected dependency blocks downstream steps while unrelated evidence remains available for inspection. The graph is recoverable from the goal state:

```sh
npm run dev -- goals graph GOAL_ID --config config.local.json
```

The controller decides which DAG node may run, verifies dependencies, applies scope rules and persists transitions. The independent runner can veto every candidate. Reviewer and Tester output cannot bypass that veto, and the Coordinator never merges or deploys a PR.

## Bounded parallel execution

Set `iteration.collaboration.maxParallel` to 2–4 to execute independent ready nodes concurrently; the default is 1. The controller reserves a full per-execution Agent budget for every node before starting the wave. Each node receives a separate Agent instance and the same immutable input snapshot. Its tests and repair stay in disposable, isolated execution environments.

The controller accepts a wave only when every node has durable, passing evidence. It rejects overlapping file edits, changes outside the goal scope, protected paths and merged snapshots that violate trusted static policy. The merged candidate must then pass the independent runner and preserve the original and every branch's test identities. No partial changes are committed to the goal on conflict or failed verification.

The saved batch pins its input digest, report references and budget settlement. After an interruption, complete terminal reports can be reused for merge verification without another Agent call. Missing or unfinished reports fail closed; explicitly replan to request new bounded executions. `goals graph` shows the active batch and node states.
