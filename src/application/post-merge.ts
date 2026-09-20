import type { GoalState } from '../domain/iteration.js';
import type { AutomationGitHub } from '../ports/automation.js';
import type { IssueGitHub } from '../ports/github.js';
import type { IterationStore } from '../ports/iteration.js';

export interface PostMergeDependencies {
  repository: string;
  requiredChecks: string[];
  requireIssueClosed: boolean;
  goals: IterationStore;
  github: AutomationGitHub & IssueGitHub;
}

function pullNumber(state: GoalState, repository: string): number {
  const match = state.pullRequestUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!match || match[1] !== repository) throw new Error('Goal has no published PR in this repository.');
  return Number(match[2]);
}

export async function trackPostMerge(id: string, d: PostMergeDependencies): Promise<GoalState['postMerge']> {
  const state = await d.goals.read(id);
  if (!state || state.repository !== d.repository || state.status !== 'published') throw new Error('Published goal not found in this repository.');
  const pull = pullNumber(state, d.repository), outcome = await d.github.outcome(pull), pr = outcome.pr;
  if (pr.base.repo.full_name !== d.repository || pr.head.repo?.full_name !== d.repository
    || pr.base.ref !== state.branch || pr.head.ref !== `autofix/goal-${state.id}/${state.publication}`) {
    throw new Error('Published PR no longer matches the owned goal branch.');
  }

  const checkedAt = new Date().toISOString();
  let status: NonNullable<GoalState['postMerge']>['status'];
  const reasons: string[] = [];
  let issueState: string | undefined;
  if (pr.state === 'open') status = 'waiting_for_merge';
  else if (!pr.merged_at || !pr.merge_commit_sha) {
    status = 'closed_unmerged'; reasons.push('The RepoPilot pull request was closed without merging.');
  } else {
    const required = d.requiredChecks.flatMap(name => {
      const matches = outcome.checks.filter(check => check.name === name);
      if (!matches.length) return [{ name, status: 'missing', conclusion: null }];
      return matches;
    });
    const pending = required.filter(check => check.status !== 'completed');
    const failed = required.filter(check => check.status === 'completed' && check.conclusion !== 'success');
    for (const check of required.filter(check => check.status === 'missing')) reasons.push(`Required post-merge check is missing: ${check.name}.`);
    for (const check of failed) reasons.push(`Required post-merge check failed: ${check.name} (${check.conclusion ?? 'no conclusion'}).`);
    if (state.spec.issue) {
      issueState = (await d.github.issue(state.spec.issue)).state;
      if (d.requireIssueClosed && issueState !== 'closed') reasons.push(`Source Issue #${state.spec.issue} remains ${issueState}.`);
    }
    const missing = required.some(check => check.status === 'missing');
    status = failed.length || missing ? 'regressed' : pending.length ? 'observing' : reasons.length ? 'regressed' : 'healthy';
  }
  const previous = state.postMerge?.status;
  state.postMerge = { pull, status, mergeSha: pr.merge_commit_sha ?? undefined, mergedAt: pr.merged_at ?? undefined,
    checkedAt, checks: outcome.checks, issueState, reasons };
  if (status === 'regressed' && previous !== 'regressed') state.notes.push(`Post-merge regression: ${reasons.join(' ')}`);
  state.updatedAt = checkedAt;
  await d.goals.save(state);
  return state.postMerge;
}
