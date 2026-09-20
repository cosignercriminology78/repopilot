# Post-merge tracking and Agent evaluation

These features extend a verified goal beyond draft-PR publication. They are opt-in and do not merge or deploy code.

## Track a merged goal

Configure checks that must succeed on the merge commit:

```json
{
  "iteration": {
    "postMerge": {
      "requiredChecks": ["test"],
      "requireIssueClosed": true
    }
  }
}
```

Run one inspection explicitly or include it in the normal iteration loop:

```sh
npm run dev -- goals track GOAL_ID --config config.local.json
npm run dev -- iterate --once --config config.local.json
```

The controller verifies that the PR still belongs to the goal's owned branch and target branch. An open PR is `waiting_for_merge`. After merge, required checks are read from the merge commit: incomplete checks produce `observing`, all configured checks with a `success` conclusion and an optionally closed source Issue produce `healthy`, and missing or failed checks produce `regressed`. A PR closed without merge is `closed_unmerged`.

The latest check evidence, merge SHA, Issue state and reasons are stored atomically in the goal. Terminal results are not polled again automatically. A post-merge regression is exposed by `discover`, where the existing preview/token/apply flow can create a deduplicated Issue for maintainer review. It does not automatically authorize that Issue for execution.

## Define repeatable evaluation cases

Add an evaluation identity to a normal goal specification:

```json
{
  "evaluation": {
    "suite": "core-maintenance",
    "case": "bounded-pagination",
    "profile": "codex-default"
  }
}
```

`suite` identifies the fixed task set, `case` identifies one task, and `profile` identifies the model/prompt/controller configuration being compared. Each value uses a lowercase identifier of up to 40 characters. Keep the goal objective, acceptance criteria, repository commit and runner image fixed when comparing profiles.

Generate a deterministic JSON report from local goal evidence:

```sh
npm run dev -- evals --suite core-maintenance --config config.local.json
```

The report includes a task fingerprint plus each case's outcome, completed steps, rounds, model calls, reported tokens and elapsed time. Per-profile aggregates include completion, verification, publication and observed post-merge pass rates. `digest` covers normalized results without random goal IDs, while `evidenceDigest` also binds the report to the exact stored goal records. Duplicate `suite/profile/case` keys and suite cases whose pinned commit or goal definition differ across profiles are listed explicitly instead of being hidden.

Evaluation is evidence aggregation, not a model-generated score. It does not claim that unmerged work is production-safe, and post-merge health only covers the configured GitHub checks and Issue state.
