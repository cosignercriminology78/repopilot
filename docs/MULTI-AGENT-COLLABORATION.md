# Multi-Agent collaboration (v1.5 development)

RepoPilot can assign planning, acceptance-test design, implementation and policy review to separate Codex roles while retaining a deterministic controller and independent runner as the authority for state transitions.

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

This development increment executes DAG nodes serially. Candidate code is isolated as immutable snapshots and executed in disposable containers. Bounded parallel scheduling and conflict-aware snapshot merging are the next v1.5 increment.
